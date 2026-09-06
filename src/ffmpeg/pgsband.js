/**
 * A band for bitmap subtitles, read from the track itself.
 *
 * The text path renders subtitles into a short canvas at the bottom of the
 * frame instead of a full one (see subband.js): the canvas is uploaded and
 * blended every frame, and nearly all of it is empty. A bitmap track (PGS,
 * DVD) could not be banded because the analysis reads ASS scripts — but a
 * PGS stream declares where every cue may appear: each display set carries
 * a window definition (WDS), a rectangle in the stream's own coordinate
 * space, and the objects are placed inside it. The union of every window
 * in the track is exactly the region the subtitles can ever touch.
 *
 * Reading it means demuxing the whole file once — a 25 GB disc takes
 * minutes over a USB disk — so the scan runs detached, its answer is kept
 * next to the cache keyed by the file's identity, and a clip on air with a
 * full canvas respawns behind the cushion once the answer lands. A track
 * whose windows reach into the upper half of the frame (signs, top
 * dialogue) gets no band: a missed optimisation costs some GPU, a wrong
 * one cuts a cue off the top of a broadcast.
 */
import { spawn } from 'child_process';
import os from 'os';
import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Where the band is allowed to start: cues must live in the lower half. */
const LOWEST_TOP = 0.5;
/** Rows of margin above the highest window, in the stream's own pixels. */
const MARGIN = 8;

export function pgsCacheKey(srcPath, typeIndex) {
  let stamp = '';
  try { const st = statSync(srcPath); stamp = `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { /* remote */ }
  return createHash('sha1').update(`${srcPath}|${typeIndex}|${stamp}`).digest('hex').slice(0, 16);
}

/**
 * Parse a PGS (.sup) byte stream: segments of 'PG', pts, dts, type, size.
 * Collects the presentation size (PCS) and the union of all windows (WDS).
 */
export function parsePgs(buf, acc = { width: 0, height: 0, minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, windows: 0, cues: 0 }) {
  let i = 0;
  while (i + 13 <= buf.length) {
    if (buf[i] !== 0x50 || buf[i + 1] !== 0x47) { i += 1; continue; }
    const type = buf[i + 10];
    const size = buf.readUInt16BE(i + 11);
    const p = i + 13;
    if (p + size > buf.length) break;
    if (type === 0x16 && size >= 11) {
      acc.width = buf.readUInt16BE(p); acc.height = buf.readUInt16BE(p + 2);
      if (buf[p + 10] > 0) acc.cues += 1;
    } else if (type === 0x17 && size >= 1) {
      const n = buf[p];
      for (let w = 0; w < n && p + 1 + w * 9 + 9 <= p + size; w++) {
        const o = p + 1 + w * 9;
        const x = buf.readUInt16BE(o + 1), y = buf.readUInt16BE(o + 3);
        const ww = buf.readUInt16BE(o + 5), hh = buf.readUInt16BE(o + 7);
        acc.minX = Math.min(acc.minX, x); acc.maxX = Math.max(acc.maxX, x + ww);
        acc.minY = Math.min(acc.minY, y); acc.maxY = Math.max(acc.maxY, y + hh);
        acc.windows += 1;
      }
    }
    i = p + size;
  }
  return { acc, rest: i };
}

/**
 * Demux the track to a PGS stream and parse it as it flows. Resolves to the
 * accumulated geometry; null when the file has no such track or ffmpeg
 * failed. Never throws.
 */
export function scanPgsWindows(srcPath, typeIndex, { signal = null, onProgress = null, readrate = 0 } = {}) {
  return new Promise((resolve) => {
    // readrate caps the demux at a multiple of the file's own rate: while a
    // clip is on air the scan shares its disk with the live read, and an
    // unthrottled 25 GB pass through a USB disk stalls the source it was
    // meant to help. Idle, it runs flat out.
    const args = ['-hide_banner', '-nostdin', '-v', 'error',
      ...(readrate > 0 ? ['-readrate', String(readrate)] : []),
      '-i', srcPath, '-map', `0:s:${typeIndex}`, '-c', 'copy', '-f', 'sup', 'pipe:1'];
    let child;
    try { child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve(null); }
    try { os.setPriority(child.pid, 19); } catch { /* not ours to lower */ }
    let acc = { width: 0, height: 0, minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, windows: 0, cues: 0 };
    let carry = Buffer.alloc(0);
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const r = parsePgs(buf, acc);
      acc = r.acc;
      carry = buf.subarray(r.rest);
      onProgress?.(bytes);
    });
    const done = (code) => resolve(code === 0 && acc.windows > 0 ? acc : null);
    child.on('error', () => resolve(null));
    child.on('close', done);
    signal?.addEventListener?.('abort', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, { once: true });
  });
}

/**
 * The band for a scanned track at a given output rectangle, or null with a
 * reason. Height is in output rows; y is where the band sits.
 */
export function pgsBandFor(scan, rect) {
  if (!scan || !scan.width || !scan.height || !Number.isFinite(scan.minY)) {
    return { band: null, reason: 'no window geometry in the track' };
  }
  const top = Math.max(0, scan.minY - MARGIN) / scan.height;
  if (top < LOWEST_TOP) {
    return { band: null, reason: `cues reach ${Math.round(top * 100)}% from the top` };
  }
  const height = Math.min(rect.h, Math.max(64, Math.ceil((1 - top) * rect.h)));
  return {
    band: { height, y: rect.h - height, topFrac: top, bitmap: true, rect: { w: rect.w, h: rect.h } },
    reason: null,
  };
}

/** Persisted scan results, keyed by file identity. */
export function readPgsScan(cacheDir, key) {
  try {
    const p = join(cacheDir, `pgsband-${key}.json`);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return null; }
}

export function writePgsScan(cacheDir, key, scan) {
  try {
    const p = join(cacheDir, `pgsband-${key}.json`);
    writeFileSync(`${p}.partial`, JSON.stringify(scan));
    renameSync(`${p}.partial`, p);
  } catch { /* the cache is an optimisation */ }
}

/**
 * Scans in flight, by cache key. Module-level on purpose: a scan outlives
 * the engine that started it. Stopping a broadcast does not lose minutes
 * of reading, and the moment nothing is on air a throttled scan is
 * restarted flat out — a disc that takes half an hour beside a live clip
 * takes a few minutes alone.
 */
const inFlight = new Map();

/**
 * Start (or join) the scan for a track. `readrate` > 0 throttles; the
 * returned promise resolves to the scan (or null) and is shared by every
 * caller. `onDone` runs once with the result; `onLog` receives lines.
 */
export function ensureScan(srcPath, typeIndex, cacheDir, { readrate = 0, onLog = null } = {}) {
  const key = pgsCacheKey(srcPath, typeIndex);
  const stored = readPgsScan(cacheDir, key);
  if (stored) return { key, promise: Promise.resolve(stored), joined: true };
  const have = inFlight.get(key);
  if (have) return { key, promise: have.promise, joined: true };
  const entry = { srcPath, typeIndex, cacheDir, readrate, controller: new AbortController(), promise: null, resolve: null, log: onLog ?? ((l) => console.log(l)) };
  entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
  inFlight.set(key, entry);
  runScan(key, entry);
  return { key, promise: entry.promise, joined: false };
}

function runScan(key, entry) {
  const started = Date.now();
  scanPgsWindows(entry.srcPath, entry.typeIndex, { signal: entry.controller.signal, readrate: entry.readrate })
    .then((scan) => {
      if (entry.restarting) { entry.restarting = false; return; } // a restart took over
      inFlight.delete(key);
      if (scan) writePgsScan(entry.cacheDir, key, scan);
      entry.log(`[band] ${entry.srcPath.split('/').pop()} scanned in ${((Date.now() - started) / 1000).toFixed(0)}s`
        + (scan ? '' : ': no PGS windows found'));
      entry.resolve(scan);
    });
}

/** Nothing is on air: every throttled scan restarts at full speed. */
export function unthrottleScans() {
  for (const [key, entry] of inFlight) {
    if (!(entry.readrate > 0)) continue;
    entry.restarting = true;
    entry.controller.abort();
    entry.controller = new AbortController();
    entry.readrate = 0;
    entry.log(`[band] nothing on air — scanning ${entry.srcPath.split('/').pop()} at full speed`);
    runScan(key, entry);
  }
}

export function scanInFlight(srcPath, typeIndex) {
  return inFlight.has(pgsCacheKey(srcPath, typeIndex));
}
