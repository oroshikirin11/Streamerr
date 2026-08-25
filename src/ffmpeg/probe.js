/**
 * Encoder capability probing.
 *
 * `ffmpeg -encoders` reports what the binary was COMPILED with, not what the
 * hardware and drivers can actually do. A machine can advertise five H.264
 * encoders and successfully run two. Static ffmpeg builds are the worst case:
 * VAAPI needs a runtime dlopen of libva, which is impossible in a static PIE,
 * so they list the encoder and then fail at runtime.
 *
 * The only honest probe is a real encode. We run 15 frames of testsrc2 and
 * check the exit status — and only the exit status. Observed failure codes
 * include 187, 255, 171 and 8; none of them mean anything.
 */

import { spawn } from 'child_process';
import { BACKENDS, LADDER } from './encoders.js';

const PROBE_TIMEOUT_MS = 25_000;

/** Minimal profile just large enough to force full encoder initialisation. */
const probeProfile = (device) => ({
  width: 320, height: 240, fps: 30,
  videoBitrate: '500k', audioBitrate: '64k',
  gopSeconds: 2, device,
});

function run(args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timer = setTimeout(() => { timer = null; child.kill('SIGKILL'); }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stderr: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      else return resolve({ ok: false, stderr: 'probe timed out' });
      resolve({ ok: code === 0, stderr: stderr.trim() });
    });
  });
}

/**
 * Test one backend by actually encoding with it.
 * @returns {Promise<{backend: string, ok: boolean, label: string, error?: string}>}
 */
export async function probeBackend(name, device = '/dev/dri/renderD128') {
  const be = BACKENDS[name];
  if (!be) return { backend: name, ok: false, label: name, error: 'unknown backend' };

  const p = probeProfile(device);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...be.deviceArgs(p),
    // testsrc2, not nullsrc — nullsrc produces no real image data and some
    // encoders shortcut it, which would make the probe pass on a broken setup.
    '-f', 'lavfi', '-i', `testsrc2=s=${p.width}x${p.height}:r=${p.fps}`,
    '-frames:v', '15',
    '-vf', be.uploadFilter(p),
    ...be.encoderArgs(p),
    '-f', 'null', '-',
  ];

  const { ok, stderr } = await run(args);
  return ok
    ? { backend: name, ok: true, label: be.label }
    : { backend: name, ok: false, label: be.label, error: firstLine(stderr) };
}

function firstLine(s) {
  const line = (s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return line || 'failed with no output';
}

/** Probe every backend in ladder order. Returns all results, in order. */
export async function probeAll(device) {
  const results = [];
  for (const name of LADDER) {
    results.push(await probeBackend(name, device));
  }
  return results;
}

/**
 * Resolve the configured backend to one that actually works.
 *
 * An explicit backend is honoured if it probes clean; if it doesn't we fall
 * through the ladder rather than failing outright, because a silent software
 * fallback is still better than a channel that won't start. The caller is
 * expected to surface `downgraded` in the UI.
 */
export async function selectBackend({ backend = 'auto', device } = {}) {
  if (backend !== 'auto') {
    const direct = await probeBackend(backend, device);
    if (direct.ok) return { ...direct, downgraded: false };

    const fallback = await selectBackend({ backend: 'auto', device });
    return {
      ...fallback,
      downgraded: true,
      requested: backend,
      requestedError: direct.error,
    };
  }

  const tried = [];
  for (const name of LADDER) {
    const r = await probeBackend(name, device);
    if (r.ok) return { ...r, downgraded: false, tried };
    tried.push(r);
  }

  throw new Error(
    'No usable H.264 encoder — not even libx264. Is ffmpeg installed and working?\n'
    + tried.map((t) => `  ${t.backend}: ${t.error}`).join('\n'),
  );
}

/** True if ffmpeg is on PATH at all. */
export async function ffmpegAvailable() {
  const { ok } = await run(['-hide_banner', '-version'], 5000);
  return ok;
}

/** ffmpeg's reported version string, e.g. "7.1.5" — null if unparseable. */
export async function ffmpegVersion() {
  const { text } = await capture(['-hide_banner', '-version'], 5000);
  const m = /^ffmpeg version n?(\d+\.\d+(?:\.\d+)?)/m.exec(text || '');
  return m ? m[1] : null;
}

/**
 * Whether a demuxer exposes a given private option on THIS build.
 *
 * Option availability varies by version, and passing one that doesn't exist
 * is fatal — ffmpeg refuses to start with "Unrecognized option", which for a
 * long-running stream means it dies instantly rather than degrading. So every
 * version-sensitive flag gets checked rather than assumed.
 */
export async function demuxerHasOption(demuxer, option) {
  const { text } = await capture(['-hide_banner', '-h', `demuxer=${demuxer}`], 10_000);
  if (!text) return false;
  // Options are listed as "  -name  <type>  ..." in the help output.
  return new RegExp(`^\\s*-${option}\\b`, 'm').test(text);
}

/** Run ffmpeg and return combined output regardless of exit status. */
function capture(args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let timer = setTimeout(() => { timer = null; child.kill('SIGKILL'); }, timeoutMs);

    const collect = (d) => { text += d.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ text: null });
    });
    child.on('close', () => {
      if (timer) clearTimeout(timer);
      resolve({ text });
    });
  });
}

/**
 * Feature detection for the playout path. Probed once at startup and passed
 * into buildPlayoutArgs, so the same code runs on old and new ffmpeg.
 */
export async function probeConcatCapabilities() {
  const [recursionDepth, segmentTimeMetadata] = await Promise.all([
    demuxerHasOption('concat', 'recursion_depth'),
    demuxerHasOption('concat', 'segment_time_metadata'),
  ]);
  return { recursionDepth, segmentTimeMetadata, version: await ffmpegVersion() };
}

/**
 * Does overlay_vaapi honour per-pixel alpha on this driver? Composites a
 * fully transparent overlay onto green and samples the pixel — exit codes
 * cannot answer this. Intel iHD passes; some drivers draw the overlay opaque.
 */
export async function vaapiAlphaHonored(device = '/dev/dri/renderD128', { width = 1920, height = 1080 } = {}) {
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { existsSync, rmSync } = await import('fs');
  const out = join(tmpdir(), `jsr-alpha-${process.pid}.mp4`);

  const enc = await new Promise((res) => {
    const c = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', `color=c=green:s=${width}x${height}:r=30,format=nv12`,
      // 50% white, not fully transparent: a driver can pass full
      // transparency yet garble partial alpha — seen on radeonsi, where
      // glyphs come out as checkerboard blocks while this box's own probe
      // passed. A correct blend of 50% white over green is unmistakable.
      '-f', 'lavfi', '-i', `color=c=white@0.5:s=${width}x${height}:r=30,format=rgba`,
      '-filter_complex', '[0:v]hwupload[b];[1:v]hwupload[o];[b][o]overlay_vaapi[out]',
      '-map', '[out]', '-frames:v', '1', '-c:v', 'h264_vaapi', '-b:v', '1M', out,
    ], { stdio: 'ignore' });
    c.on('error', () => res(false));
    c.on('close', (code) => res(code === 0));
  });
  if (!enc || !existsSync(out)) return false;

  const px = await new Promise((res) => {
    const c = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', out,
      '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const bufs = [];
    c.stdout.on('data', (d) => bufs.push(d));
    c.on('error', () => res(null));
    c.on('close', () => res(Buffer.concat(bufs)));
  });
  try { rmSync(out); } catch { /* gone */ }
  if (!px || px.length < 3) return false;
  // Expect roughly (green + white)/2: mid red/blue, high green. Opaque
  // white (alpha ignored) or pure green (overlay dropped) both fail.
  const [r, g, b] = px;
  return g > 150 && r > 70 && r < 190 && b > 70 && b < 190;
}

/**
 * Which filtergraph shape can composite subtitles onto pillarboxed video.
 *
 * Two graph shapes were shipped for this on reasoning alone and both failed
 * on Intel's iHD driver with `h264_vaapi ... error code: -22`, after ~20s of
 * running and without producing a frame. What is proven, from production
 * logs on that machine:
 *
 *   scale_vaapi -> overlay_vaapi -> encode          works  (16:9 + subs)
 *   scale_vaapi -> pad_vaapi     -> encode          works  (pillarbox, no subs)
 *   scale_vaapi -> overlay_vaapi -> pad_vaapi       FAILS
 *   scale_vaapi -> pad_vaapi     -> overlay_vaapi   FAILS
 *   scale_vaapi -> overlay_vaapi -> overlay_vaapi   FAILS
 *
 * Each stage works alone; the combination does not, and which combination is
 * at fault cannot be settled from a driver's documentation. So ask the
 * driver: run each candidate for one frame and keep the ones that both
 * encode AND put the right colours in the right places. The answer is cached
 * for the life of the process.
 *
 * Returns the winning shape's id, or null when the driver can do none of
 * them — the caller then burns subtitles on the CPU, which is slower but has
 * no such constraint.
 *
 * @returns {Promise<'pad-overlay'|'wide-canvas'|'overlay-pad'|'bg-composite'|null>}
 */
export async function pickPillarboxGraph({
  device = '/dev/dri/renderD128', width = 1920, height = 1080, rect,
  profile = null,
} = {}) {
  // The probe must encode the way production encodes. Measured on the N100:
  // the pad-overlay shape passed a one-frame probe with default encoder
  // settings, then failed instantly in production with -22 — the difference
  // was the encoder configuration (CBR, bufsize, -bf 0). Same args, same
  // verdict, or the probe answers a different question than the one asked.
  let encArgs = ['-c:v', 'h264_vaapi', '-b:v', '2M'];
  if (profile) {
    try {
      encArgs = [...BACKENDS.vaapi.encoderArgs({
        ...profile,
        fps: Number(profile.fps) || 30,
        gopSeconds: Number(profile.gopSeconds) || 2,
      }), '-async_depth', '4'];
    } catch { /* fall back to the generic encode */ }
  }
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { existsSync, rmSync } = await import('fs');

  const tag = `jsr-bars-${process.pid}`;
  const src = join(tmpdir(), `${tag}-src.mp4`);
  const out = join(tmpdir(), `${tag}-out.mp4`);
  const clean = () => {
    for (const p of [src, out]) { try { rmSync(p); } catch { /* gone */ } }
  };

  // A real decoded VAAPI surface, not an hwupload: the failure being chased
  // lives in how VPP stages hand frames to the encoder, and decoder frames
  // come from a different pool than uploaded ones.
  const madeSrc = await new Promise((res) => {
    const c = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=c=green:s=${rect.w}x${rect.h}:r=30`,
      '-frames:v', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', src,
    ], { stdio: 'ignore' });
    c.on('error', () => res(false));
    c.on('close', (code) => res(code === 0));
  });
  if (!madeSrc || !existsSync(src)) { clean(); return null; }

  const scalePart = `scale_vaapi=w=${rect.w}:h=${rect.h}:format=nv12`;
  const padPart = `pad_vaapi=${width}:${height}:${rect.x}:${rect.y}:color=black`;
  // Half-white so a driver that ignores alpha (opaque white) is caught too.
  const canvas = (w, h, extra = '') =>
    ['-f', 'lavfi', '-i', `color=c=white@0.5:s=${w}x${h}:r=30${extra},format=rgba`];

  const CANDIDATES = [
    {
      id: 'pad-overlay',
      inputs: canvas(rect.w, rect.h),
      graph: `[1:v]hwupload[ov];[0:v]${scalePart},${padPart}[b];`
        + `[b][ov]overlay_vaapi=x=${rect.x}:y=${rect.y}[v]`,
    },
    {
      // Same, minus the overlay offset: the canvas is padded to full size on
      // the CPU (cheap — it is one RGBA frame) so the composite lands at 0,0.
      // Distinguishes "pad_vaapi and overlay_vaapi cannot coexist" from
      // "overlay_vaapi cannot take an offset".
      id: 'wide-canvas',
      inputs: canvas(rect.w, rect.h,
        `,pad=${width}:${height}:${rect.x}:${rect.y}:color=black@0.0`),
      graph: `[1:v]hwupload[ov];[0:v]${scalePart},${padPart}[b];`
        + `[b][ov]overlay_vaapi[v]`,
    },
    {
      id: 'overlay-pad',
      inputs: canvas(rect.w, rect.h),
      graph: `[1:v]hwupload[ov];[0:v]${scalePart}[b];`
        + `[b][ov]overlay_vaapi,${padPart}[v]`,
    },
    {
      // As above with a no-op scale between the composite and the pad. If
      // what breaks the chain is the frame overlay_vaapi hands downstream
      // (context, cropping, alignment), a plain scale re-normalises it.
      id: 'overlay-scale-pad',
      inputs: canvas(rect.w, rect.h),
      graph: `[1:v]hwupload[ov];[0:v]${scalePart}[b];`
        + `[b][ov]overlay_vaapi,${scalePart},${padPart}[v]`,
    },
    {
      id: 'bg-composite',
      inputs: [
        ...canvas(rect.w, rect.h),
        '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=30,format=nv12`,
      ],
      graph: `[1:v]hwupload[ov];[0:v]${scalePart}[b];[b][ov]overlay_vaapi[vs];`
        + `[2:v]hwupload[bg];[bg][vs]overlay_vaapi=x=${rect.x}:y=${rect.y}[v]`,
    },
  ];

  for (const cand of CANDIDATES) {
    try { rmSync(out); } catch { /* gone */ }
    const encoded = await new Promise((res) => {
      const c = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va',
        '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi',
        '-hwaccel_device', 'va', '-i', src,
        ...cand.inputs,
        '-filter_complex', cand.graph,
        '-map', '[v]', '-frames:v', '1', ...encArgs, out,
      ], { stdio: 'ignore' });
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 30_000);
      c.on('error', () => { clearTimeout(t); res(false); });
      c.on('close', (code) => { clearTimeout(t); res(code === 0); });
    });
    if (!encoded || !existsSync(out)) continue;
    if (await barsAndBlendCorrect(out, width, height, rect)) {
      clean();
      return cand.id;
    }
  }

  clean();
  return null;
}

/**
 * Does the probe frame have black pillarbox bars and a blended centre?
 * Exit codes alone have lied on this project before — a graph can encode
 * happily and still put the picture in the wrong place.
 */
async function barsAndBlendCorrect(file, width, height, rect) {
  const COLS = 64;
  const ROWS = 36;
  const px = await new Promise((res) => {
    const c = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', `scale=${COLS}:${ROWS}`, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const bufs = [];
    c.stdout.on('data', (d) => bufs.push(d));
    c.on('error', () => res(null));
    c.on('close', () => res(Buffer.concat(bufs)));
  });
  if (!px || px.length < COLS * ROWS * 3) return false;

  const at = (col, row) => {
    const i = (row * COLS + col) * 3;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const midRow = Math.floor(ROWS / 2);

  // Sample well inside the left bar, if there is one.
  const barCols = Math.floor((rect.x / width) * COLS);
  if (barCols >= 2) {
    const [r, g, b] = at(1, midRow);
    if (r > 60 || g > 60 || b > 60) return false;   // bar is not black
  }
  const barRows = Math.floor((rect.y / height) * ROWS);
  if (barRows >= 2) {
    const [r, g, b] = at(Math.floor(COLS / 2), 1);
    if (r > 60 || g > 60 || b > 60) return false;
  }
  // Centre: half white over green.
  const [r, g, b] = at(Math.floor(COLS / 2), midRow);
  return g > 130 && r > 60 && r < 200 && b > 60 && b < 200;
}
