/**
 * Downscaled copies of library artwork.
 *
 * Posters and episode stills are written by media managers at source
 * resolution — a 1920x1080 still is routine, and roughly 1 MB. The panel
 * draws stills into a 96x54 tile and posters a couple of hundred pixels
 * wide, so serving the original ships around 400x more pixels than any of
 * them displays: a 25-episode season cost 24 MB to browse.
 *
 * Each source is scaled once into the cache directory and served from there
 * forever after. Generation is lazy — only artwork someone actually looks at
 * is ever converted — so a library of ten thousand episodes costs nothing
 * until it is browsed.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/** Wide enough for a 2x poster; stills need far less and simply come out
 *  smaller, since the scale filter only ever shrinks. */
const MAX_W = 480;

/** ffmpeg is not free. More than a few at once on an N100 would compete with
 *  the encoders that are keeping a broadcast alive. */
const MAX_PARALLEL = 3;

let running = 0;
const queue = [];
/** source key -> promise, so twenty rows asking for the same poster convert
 *  it once instead of racing twenty ffmpegs at the same output file. */
const inFlight = new Map();

function slot() {
  if (running < MAX_PARALLEL) { running += 1; return Promise.resolve(); }
  return new Promise((res) => queue.push(res));
}
function release() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

/** Keyed on size and mtime as well as path: re-scraped artwork replaces the
 *  old thumbnail instead of being masked by it. */
function keyFor(src) {
  const st = statSync(src);
  return createHash('sha1')
    .update(`${src}:${st.size}:${Math.floor(st.mtimeMs)}:${MAX_W}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * @returns {Promise<string|null>} path to a scaled copy, or null when one
 *   cannot be made — callers should fall back to serving the original.
 */
export async function thumbnail(src, cacheDir) {
  if (!cacheDir) return null;
  let out;
  try {
    out = join(cacheDir, 'thumbs', `${keyFor(src)}.jpg`);
  } catch {
    return null;                       // vanished between listing and request
  }
  if (existsSync(out)) return out;
  if (inFlight.has(out)) return inFlight.get(out);

  const work = (async () => {
    await slot();
    try {
      mkdirSync(join(cacheDir, 'thumbs'), { recursive: true });
      // Write-then-rename: a kill mid-encode must not leave a truncated JPEG
      // that then looks like a valid cache entry forever.
      const tmp = `${out}.${process.pid}.partial`;
      const ok = await run([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', src,
        // Never upscale: min() keeps a small source at its own size.
        '-vf', `scale='min(${MAX_W},iw)':-2:flags=lanczos`,
        '-frames:v', '1', '-q:v', '4',
        '-f', 'mjpeg', tmp,
      ]);
      if (!ok || !existsSync(tmp)) { safeUnlink(tmp); return null; }
      renameSync(tmp, out);
      return out;
    } catch {
      return null;
    } finally {
      release();
      inFlight.delete(out);
    }
  })();

  inFlight.set(out, work);
  return work;
}

function safeUnlink(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 20_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
