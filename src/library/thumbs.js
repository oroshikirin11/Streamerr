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
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { extname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

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

export const isRemote = (src) => /^https?:\/\//i.test(src);

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.webm', '.mpg', '.mpeg', '.wmv',
]);
/** Whether a resolved artwork path is really a video to take a frame from.
 *  The query is stripped first: SMB media is a bridge url carrying a token,
 *  and `.mkv?t=...` is not an extension. */
const noQuery = (src) => String(src ?? '').split('?')[0];
export const isVideoFile = (src) => VIDEO_EXTS.has(extname(noQuery(src)).toLowerCase());

/** Keyed on size and mtime as well as path: re-scraped artwork replaces the
 *  old thumbnail instead of being masked by it. A remote url carries its own
 *  version — Jellyfin's image tag — so the url alone is the key. */
function keyFor(src) {
  if (isRemote(src)) {
    return createHash('sha1').update(`${src}:${MAX_W}`).digest('hex').slice(0, 16);
  }
  const st = statSync(src);
  return createHash('sha1')
    .update(`${src}:${st.size}:${Math.floor(st.mtimeMs)}:${MAX_W}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Pull a remote image down once so ffmpeg scales a local file.
 * Letting ffmpeg fetch the url itself would refetch on every miss and give no
 * control over the timeout.
 */
async function fetchToDisk(url, dest) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok || !res.body) return false;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return existsSync(dest) && statSync(dest).size > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
      let input = src;
      let downloaded = null;
      if (isRemote(src)) {
        downloaded = `${out}.${process.pid}.src`;
        if (!await fetchToDisk(src, downloaded)) { safeUnlink(downloaded); return null; }
        input = downloaded;
      }
      const ok = await run([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', input,
        // Never upscale: min() keeps a small source at its own size.
        '-vf', `scale='min(${MAX_W},iw)':-2:flags=lanczos`,
        '-frames:v', '1', '-q:v', '4',
        '-f', 'mjpeg', tmp,
      ]);
      if (downloaded) safeUnlink(downloaded);
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

/** Seconds of media, or null. One ffprobe per file ever: the frame it
 *  positions is cached, so this never runs twice for the same episode. */
function probeSeconds(src) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', src,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

/**
 * A still for media that has none, taken from the media itself.
 *
 * Sidecar artwork and Jellyfin covers win wherever they exist; this is the
 * fallback that stops a folder or SMB library looking bare beside a Jellyfin
 * one. Generated on first request and cached like any other thumbnail, so
 * browsing never waits on it and a season costs one frame per episode, once.
 *
 * The frame is chosen, not merely taken: a fixed offset lands on fades,
 * black and title cards often enough to look broken, so `thumbnail` picks
 * the most representative of the following hundred frames. A fifth of the
 * way in clears the titles without reaching anything worth spoiling.
 *
 * @returns {Promise<string|null>} path to the still, or null if none could be
 *   made. Callers must NOT fall back to the source on null — serving a video
 *   file where an image belongs is worse than serving nothing.
 */
/** Where a still for this source would live, or null if unanswerable. */
function framePath(src, cacheDir) {
  if (!cacheDir) return null;
  try {
    const key = isRemote(src)
      ? createHash('sha1').update(`${noQuery(src)}:${MAX_W}`).digest('hex').slice(0, 16)
      : keyFor(src);
    return join(cacheDir, 'thumbs', `${key}-frame.jpg`);
  } catch {
    return null;                       // vanished between listing and request
  }
}

/**
 * An already-made still, or null. Never generates.
 *
 * This is what the image route uses: making a still inside a request put
 * ffmpeg on the browsing path, and a season's worth of cold network seeks
 * with it. The sweeper fills the cache behind the scenes instead.
 */
export function cachedFrame(src, cacheDir) {
  const p = framePath(src, cacheDir);
  return p && existsSync(p) ? p : null;
}

export async function frameGrab(src, cacheDir) {
  if (!cacheDir) return null;
  let out;
  try {
    // Keyed without the query: an SMB bridge url carries a token that is
    // minted fresh every restart, and keying on it would regenerate every
    // still each time the service came back.
    const key = isRemote(src)
      ? createHash('sha1').update(`${noQuery(src)}:${MAX_W}`).digest('hex').slice(0, 16)
      : keyFor(src);
    out = join(cacheDir, 'thumbs', `${key}-frame.jpg`);
  } catch {
    return null;                       // vanished between listing and request
  }
  if (existsSync(out)) return out;
  if (inFlight.has(out)) return inFlight.get(out);

  const work = (async () => {
    await slot();
    try {
      mkdirSync(join(cacheDir, 'thumbs'), { recursive: true });
      const dur = await probeSeconds(src);
      // Clamped: 30s is past most cold opens, 10 minutes is deep enough for
      // a feature without wandering into the plot.
      const at = dur ? Math.min(Math.max(dur * 0.2, 30), 600) : 60;
      const tmp = `${out}.${process.pid}.partial`;
      const ok = await run([
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        // Input-side seek: a seek rather than decoding everything before it,
        // which is what keeps this affordable over SMB.
        '-ss', at.toFixed(2),
        '-i', src,
        '-vf', `thumbnail=100,scale='min(${MAX_W},iw)':-2:flags=lanczos`,
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
