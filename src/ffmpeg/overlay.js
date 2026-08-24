/**
 * Pre-render subtitles to a transparent overlay video, then composite it on
 * the GPU during playback.
 *
 * Burning subtitles with the `subtitles` filter costs libass rasterisation on
 * every frame, on the CPU, in the live path. Measured on an N100: 4.68x
 * realtime without subtitles, 1.12x with — unstreamable, and not fixable by
 * running more processes, because the H.264 decoder already uses every core.
 *
 * Separating the two halves fixes it:
 *
 *   once, ahead of time   render subtitles onto transparency  (CPU, libass)
 *   during playback       overlay_vaapi composites it         (GPU, ~free)
 *
 * Measured here: 6.29x with no subtitles, 5.32x burning with libass, 5.94x
 * compositing a pre-rendered overlay. On a machine where libass is expensive
 * the gap is far larger — that is the whole point.
 *
 * Rendering decodes no video, so unlike the full pipeline it really is
 * single-core bound — which means chunking it across processes works, and is
 * how a long episode gets prepared in reasonable time.
 *
 * NOT YET WIRED INTO PLAYBACK. What is verified:
 *   - FFV1/rgba round-trips alpha correctly (mean alpha 00, and compositing
 *     gives 7a7e7a against a 7c827d base, i.e. the video shows through).
 *   - FFV1 with yuva420p does NOT — it comes out fully opaque and silently
 *     blacks out the video. Checked by extracting the alpha plane.
 *   - overlay_vaapi ignores per-pixel alpha on this AMD driver; the software
 *     `overlay` filter honours it. Intel/iHD may differ, which is what
 *     Jellyfin relies on.
 *
 * What is NOT solved: file size. FFV1/rgba is 62 MB per 8 seconds, roughly
 * 11 GB for an episode. A lossy alpha codec (VP9 with yuva420p) is the
 * obvious answer and is the next thing to get working.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import {
  existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { escapeFilterPath } from './tracks.js';

/** An overlay is only valid for one file, track and output size. */
export function overlayKey(srcPath, subtitle, profile) {
  const st = statSync(srcPath);
  const id = subtitle.external ? `x:${subtitle.path}` : `i:${subtitle.typeIndex}`;
  return createHash('sha1')
    .update(`${srcPath}:${st.size}:${Math.floor(st.mtimeMs)}:${id}:${profile.width}x${profile.height}:${profile.fps}`)
    .digest('hex')
    .slice(0, 16);
}

export function overlayPath(cacheDir, key) {
  return join(cacheDir, `overlay-${key}.mkv`);
}

/** Is a usable overlay already on disk? */
export function haveOverlay(srcPath, subtitle, profile, cacheDir) {
  if (!subtitle || !cacheDir) return null;
  try {
    const p = overlayPath(cacheDir, overlayKey(srcPath, subtitle, profile));
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Render subtitles onto transparency.
 *
 * Emits 'progress' with a 0..1 fraction, because this takes minutes on a slow
 * machine and silence would look like a hang.
 */
export class OverlayRenderer extends EventEmitter {
  constructor({ cacheDir, workers = 3, chunkSeconds = 120 }) {
    super();
    this.cacheDir = cacheDir;
    this.workers = Math.max(1, workers);
    this.chunkSeconds = Math.max(30, chunkSeconds);
    this._active = new Map();  // key -> Promise
    this._procs = new Set();
  }

  cancel() {
    for (const p of this._procs) {
      try { p.kill('SIGKILL'); } catch { /* gone */ }
    }
    this._procs.clear();
  }

  /**
   * @returns {Promise<string|null>} path to the overlay, or null if it could
   *   not be rendered (bitmap subtitles, unreadable file, cancelled).
   */
  async ensure(srcPath, subtitle, profile, duration) {
    if (!subtitle || !this.cacheDir) return null;
    // Bitmap subtitles are already images and composite directly; there is
    // nothing to rasterise.
    if (subtitle.bitmap) return null;

    let key;
    try {
      key = overlayKey(srcPath, subtitle, profile);
    } catch {
      return null;
    }
    const out = overlayPath(this.cacheDir, key);
    if (existsSync(out)) return out;
    if (this._active.has(key)) return this._active.get(key);

    const job = this._render(srcPath, subtitle, profile, duration, out, key)
      .finally(() => this._active.delete(key));
    this._active.set(key, job);
    return job;
  }

  async _render(srcPath, subtitle, profile, duration, out, key) {
    mkdirSync(this.cacheDir, { recursive: true });
    const dir = join(this.cacheDir, `ov-${key}`);
    mkdirSync(dir, { recursive: true });

    const total = duration ?? 0;
    if (!total) {
      // Without a duration we cannot chunk; render in one pass.
      const ok = await this._one(srcPath, subtitle, profile, 0, null, `${out}.partial`);
      if (!ok) return null;
      renameSync(`${out}.partial`, out);
      return out;
    }

    const count = Math.max(1, Math.ceil(total / this.chunkSeconds));
    const parts = [];
    let done = 0;

    // Bounded concurrency: rendering is single-core bound, so more processes
    // genuinely help here — unlike the full pipeline, where decoding already
    // saturates the CPU.
    let next = 0;
    const runNext = async () => {
      while (next < count) {
        const i = next++;
        const start = i * this.chunkSeconds;
        const dur = Math.min(this.chunkSeconds, total - start);
        const part = join(dir, `p${String(i).padStart(4, '0')}.mkv`);
        // eslint-disable-next-line no-await-in-loop
        const ok = await this._one(srcPath, subtitle, profile, start, dur, part);
        if (!ok) return false;
        parts[i] = part;
        done += 1;
        this.emit('progress', { fraction: done / count, key });
      }
      return true;
    };

    const results = await Promise.all(
      Array.from({ length: Math.min(this.workers, count) }, runNext),
    );
    if (results.some((r) => r === false)) {
      cleanup(dir, parts);
      return null;
    }

    // Concatenate: every part shares codec and geometry, so a copy is enough.
    const listFile = join(dir, 'list.txt');
    writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');

    const ok = await this._run([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', `${out}.partial`,
    ]);
    cleanup(dir, parts);
    if (!ok) {
      safeUnlink(`${out}.partial`);
      return null;
    }
    renameSync(`${out}.partial`, out);
    return out;
  }

  _one(srcPath, subtitle, profile, start, dur, out) {
    const filter = subtitle.external
      ? `subtitles=filename='${escapeFilterPath(subtitle.path)}':alpha=1`
      : `subtitles=filename='${escapeFilterPath(srcPath)}':si=${subtitle.typeIndex}:alpha=1`;

    return this._run([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      // A transparent canvas, not the video — decoding it would defeat the
      // whole point of doing this ahead of time.
      '-f', 'lavfi',
      '-i', `color=c=black@0.0:s=${profile.width}x${profile.height}:r=${profile.fps},format=rgba`,
      ...(start > 0 ? ['-ss', Number(start).toFixed(3)] : []),
      ...(dur != null ? ['-t', Number(dur).toFixed(3)] : []),
      '-vf', `${filter},format=rgba`,
      // PNG in Matroska, RGBA. FFV1 with yuva420p was measured to come out
      // fully opaque (mean alpha 255), which silently blacks out the video it
      // is composited onto — verified by extracting the alpha plane. PNG
      // round-trips it correctly, and mostly-empty frames compress well.
      '-c:v', 'png', '-pix_fmt', 'rgba',
      '-f', 'matroska',
      out,
    ]);
  }

  _run(args) {
    return new Promise((resolve) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this._procs.add(p);
      let err = '';
      p.stderr.on('data', (d) => {
        err += d.toString();
        if (err.length > 8000) err = err.slice(-4000);
      });
      p.on('error', () => { this._procs.delete(p); resolve(false); });
      p.on('close', (code) => {
        this._procs.delete(p);
        if (code !== 0) this.emit('warn', lastLines(err, 2));
        resolve(code === 0);
      });
    });
  }
}

function cleanup(dir, parts) {
  for (const p of parts) safeUnlink(p);
  safeUnlink(join(dir, 'list.txt'));
}

function safeUnlink(p) {
  try { if (p) unlinkSync(p); } catch { /* gone */ }
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
