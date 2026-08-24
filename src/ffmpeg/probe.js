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
