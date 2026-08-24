/**
 * Normalization: transcode each clip once into a single house profile, cache
 * the result, and let playout run at `-c copy`.
 *
 * This is not optional polish. Mixed source files SILENTLY corrupt the concat
 * demuxer: joining 720p/30fps/48kHz with 480p/25fps/44.1kHz yields hundreds of
 * non-monotonic DTS warnings and an output ~8% short, with no error raised.
 * The demuxer takes its parameters from the first file and reinterprets every
 * later one in that timebase — and because the damage happens before any
 * filter sees a frame, re-encoding downstream cannot repair it.
 *
 * Output is MPEG-TS rather than MP4 on purpose: TS is self-framing with
 * repeating PAT/PMT and no global index, so a half-written file still plays.
 * A half-written MP4 has no moov atom and is worthless.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { statSync, existsSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { BACKENDS, audioArgs, scaleFilter } from './encoders.js';
import {
  probeTracks, listSubtitles, selectTracks, buildSubtitleFilter,
} from './tracks.js';

/**
 * Stable id for "this file, at this profile, with these tracks".
 *
 * Track selection belongs in the key because subtitles are burned into the
 * video and the audio track is baked in — the same source file with German
 * subs is a genuinely different output than with English, so they must not
 * collide in the cache.
 */
export function cacheKey(srcPath, profile, selection = null) {
  const st = statSync(srcPath);
  return createHash('sha1').update(JSON.stringify({
    src: srcPath,
    size: st.size,
    mtime: Math.floor(st.mtimeMs),
    p: {
      w: profile.width, h: profile.height, fps: profile.fps,
      vb: profile.videoBitrate, ab: profile.audioBitrate,
      gop: profile.gopSeconds, backend: profile.backend,
    },
    // Only the identifying parts of the selection, so an unrelated metadata
    // difference doesn't invalidate an otherwise identical encode.
    t: selection ? {
      a: selection.audio?.typeIndex ?? null,
      s: selection.subtitle
        ? (selection.subtitle.external
          ? `x:${selection.subtitle.path}`
          : `i:${selection.subtitle.typeIndex}`)
        : null,
    } : null,
  })).digest('hex').slice(0, 16);
}

/**
 * @param {string} srcPath
 * @param {string} outPath
 * @param {object} profile
 * @param {object|null} selection  from selectTracks(): { audio, subtitle }
 */
export function buildNormalizeArgs(srcPath, outPath, profile, selection = null) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath);
  const audioIdx = selection?.audio?.typeIndex ?? 0;

  // Software decode → software scale → subtitles → hwupload → hardware encode.
  // Everything before hwupload must be software: software filters cannot
  // operate on hardware frames, and there is no hardware equivalent of
  // subtitle rendering.
  const base = scaleFilter(profile);
  const upload = be.uploadFilter(profile);

  const filterArgs = sub.needsComplex
    // Bitmap subtitles (PGS/VOBSUB) are images, not text — they cannot go
    // through the `subtitles` filter and must be composited instead.
    ? [
      '-filter_complex',
      `[0:v:0]${base}[base];[base][${sub.overlayInput}]overlay[ov];[ov]${upload}[vout]`,
      '-map', '[vout]',
    ]
    : [
      '-vf', [base, sub.filter, upload].filter(Boolean).join(','),
      '-map', '0:v:0',
    ];

  return [
    '-hide_banner', '-nostdin', '-y',
    ...be.deviceArgs(profile),
    '-i', srcPath,
    ...filterArgs,
    '-map', `0:a:${audioIdx}?`,
    ...be.encoderArgs(profile),
    ...audioArgs(profile),
    '-fps_mode', 'cfr',
    '-video_track_timescale', '90000',
    '-muxdelay', '0', '-muxpreload', '0',
    '-mpegts_flags', '+resend_headers',
    '-f', 'mpegts', outPath,
  ];
}

/**
 * Normalizes clips just ahead of the playhead and caches the results.
 *
 * Events:
 *   'start'   ({ key, src })
 *   'done'    ({ key, src, path, ms })
 *   'error'   ({ key, src, error })
 *   'progress'({ key, outTimeUs })
 */
export class Normalizer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir
   * @param {object} opts.profile   encoder profile incl. resolved `backend`
   * @param {number} opts.cacheLimitBytes
   */
  constructor({ cacheDir, profile, cacheLimitBytes = 50 * 1024 ** 3, trackPrefs = {} }) {
    super();
    this.cacheDir = cacheDir;
    this.profile = profile;
    this.cacheLimitBytes = cacheLimitBytes;
    /** Default audio/subtitle language preferences; see tracks.js. */
    this.trackPrefs = trackPrefs;
    /** srcPath -> resolved selection, so we probe each file only once. */
    this._selections = new Map();

    /** key -> Promise, so two requests for the same clip share one encode. */
    this.inflight = new Map();
    /** Keys that must not be evicted — referenced by an unplayed chain link. */
    this.pinned = new Set();
  }

  pathFor(key) {
    return join(this.cacheDir, `${key}.ts`);
  }

  /**
   * The cache key a clip will encode to, resolving track selection first.
   * Callers that need to know "is this ready?" must go through here rather
   * than calling cacheKey() directly, or they compute a different key than
   * ensure() does and every lookup misses.
   */
  async keyFor(srcPath, override = null) {
    const selection = await this.resolveSelection(srcPath, override);
    return cacheKey(srcPath, this.profile, selection);
  }

  has(key) {
    return existsSync(this.pathFor(key));
  }

  pin(key) { this.pinned.add(key); }
  unpin(key) { this.pinned.delete(key); }

  /**
   * Resolve which audio and subtitle tracks a file should be encoded with.
   * Cached per path — ffprobe on a large file over a network mount is not
   * free, and the queue asks repeatedly.
   *
   * @param {object} [override] per-item choice from the UI, merged over defaults
   */
  async resolveSelection(srcPath, override = null) {
    if (!override && this._selections.has(srcPath)) {
      return this._selections.get(srcPath);
    }
    const tracks = await probeTracks(srcPath);
    const subtitles = await listSubtitles(srcPath, tracks);
    const selection = selectTracks(tracks, subtitles, {
      ...this.trackPrefs,
      ...(override ?? {}),
    });
    selection.tracks = tracks;
    selection.subtitles = subtitles;

    if (!override) this._selections.set(srcPath, selection);
    return selection;
  }

  /**
   * Get a normalized copy of `srcPath`, encoding it if necessary.
   * Concurrent calls for the same clip share a single ffmpeg run.
   * @returns {Promise<{key: string, path: string, cached: boolean, selection: object}>}
   */
  async ensure(srcPath, override = null) {
    if (!existsSync(srcPath)) {
      throw new Error(`Source file does not exist: ${srcPath}`);
    }
    const selection = await this.resolveSelection(srcPath, override);
    const key = cacheKey(srcPath, this.profile, selection);
    const out = this.pathFor(key);

    if (existsSync(out)) return { key, path: out, cached: true, selection };
    if (this.inflight.has(key)) return this.inflight.get(key);

    const job = this._encode(srcPath, key, out, selection)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  _encode(srcPath, key, out, selection = null) {
    // Encode to a temp name and rename on success, so a crashed or killed
    // job can never leave a truncated file that looks like a cache hit.
    const tmp = `${out}.partial`;
    const args = buildNormalizeArgs(srcPath, tmp, this.profile, selection);
    const startedAt = Date.now();

    this.emit('start', { key, src: srcPath, selection });

    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [...args, '-progress', 'pipe:1'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      });
      child.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(d.toString());
        if (m) this.emit('progress', { key, outTimeUs: Number(m[1]) });
      });

      child.on('error', (err) => {
        safeUnlink(tmp);
        this.emit('error', { key, src: srcPath, error: err.message });
        reject(err);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          safeUnlink(tmp);
          const err = new Error(
            `Normalizing failed (exit ${code}) for ${srcPath}\n${lastLines(stderr, 6)}`,
          );
          this.emit('error', { key, src: srcPath, error: err.message });
          return reject(err);
        }
        try {
          renameSync(tmp, out);
        } catch (err) {
          return reject(err);
        }
        const ms = Date.now() - startedAt;
        this.emit('done', { key, src: srcPath, path: out, ms, selection });
        this.evict();
        resolve({ key, path: out, cached: false, selection });
      });
    });
  }

  /** LRU eviction by atime, skipping anything pinned or still being written. */
  evict() {
    let entries;
    try {
      entries = readdirSync(this.cacheDir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => {
          const p = join(this.cacheDir, f);
          const st = statSync(p);
          return { key: f.replace(/\.ts$/, ''), path: p, size: st.size, atime: st.atimeMs };
        });
    } catch {
      return;
    }

    let total = entries.reduce((n, e) => n + e.size, 0);
    if (total <= this.cacheLimitBytes) return;

    for (const e of entries.sort((a, b) => a.atime - b.atime)) {
      if (total <= this.cacheLimitBytes) break;
      if (this.pinned.has(e.key)) continue;
      if (safeUnlink(e.path)) total -= e.size;
    }
  }
}

function safeUnlink(p) {
  try { unlinkSync(p); return true; } catch { return false; }
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
