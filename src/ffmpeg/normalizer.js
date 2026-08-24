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

/** Stable id for "this file, at this profile". Changing settings re-keys. */
export function cacheKey(srcPath, profile) {
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
  })).digest('hex').slice(0, 16);
}

export function buildNormalizeArgs(srcPath, outPath, profile) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  return [
    '-hide_banner', '-nostdin', '-y',
    ...be.deviceArgs(profile),
    '-i', srcPath,
    // Software decode + software scale, then hand off to the GPU. Software
    // filters cannot operate on hardware frames, so hwupload must come last.
    '-vf', `${scaleFilter(profile)},${be.uploadFilter(profile)}`,
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
  constructor({ cacheDir, profile, cacheLimitBytes = 50 * 1024 ** 3 }) {
    super();
    this.cacheDir = cacheDir;
    this.profile = profile;
    this.cacheLimitBytes = cacheLimitBytes;

    /** key -> Promise, so two requests for the same clip share one encode. */
    this.inflight = new Map();
    /** Keys that must not be evicted — referenced by an unplayed chain link. */
    this.pinned = new Set();
  }

  pathFor(key) {
    return join(this.cacheDir, `${key}.ts`);
  }

  has(key) {
    return existsSync(this.pathFor(key));
  }

  pin(key) { this.pinned.add(key); }
  unpin(key) { this.pinned.delete(key); }

  /**
   * Get a normalized copy of `srcPath`, encoding it if necessary.
   * Concurrent calls for the same clip share a single ffmpeg run.
   * @returns {Promise<{key: string, path: string, cached: boolean}>}
   */
  async ensure(srcPath) {
    if (!existsSync(srcPath)) {
      throw new Error(`Source file does not exist: ${srcPath}`);
    }
    const key = cacheKey(srcPath, this.profile);
    const out = this.pathFor(key);

    if (existsSync(out)) return { key, path: out, cached: true };
    if (this.inflight.has(key)) return this.inflight.get(key);

    const job = this._encode(srcPath, key, out)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  _encode(srcPath, key, out) {
    // Encode to a temp name and rename on success, so a crashed or killed
    // job can never leave a truncated file that looks like a cache hit.
    const tmp = `${out}.partial`;
    const args = buildNormalizeArgs(srcPath, tmp, this.profile);
    const startedAt = Date.now();

    this.emit('start', { key, src: srcPath });

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
        this.emit('done', { key, src: srcPath, path: out, ms });
        this.evict();
        resolve({ key, path: out, cached: false });
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
