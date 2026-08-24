#!/usr/bin/env node
/**
 * Test harness for the engine, before any UI exists.
 *
 *   node src/cli.js probe                    which encoders actually work here
 *   node src/cli.js normalize <file>         normalize one file into the cache
 *   node src/cli.js selftest                 gapless chain test, no Owncast needed
 *   node src/cli.js stream <file...>         stream files to the configured Owncast
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { config, ensureDirs, rtmpTarget, rtmpTargetRedacted } from './config.js';
import { probeAll, selectBackend, ffmpegAvailable } from './ffmpeg/probe.js';
import { Normalizer } from './ffmpeg/normalizer.js';
import { PlayoutEngine, probeDuration, buildPlayoutArgs } from './ffmpeg/playout.js';

const [, , cmd, ...args] = process.argv;

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

async function resolveProfile() {
  const sel = await selectBackend({
    backend: config.encoder.backend,
    device: config.encoder.device,
  });
  if (sel.downgraded) {
    console.warn(
      `! requested "${sel.requested}" is not usable here (${sel.requestedError})\n`
      + `  falling back to ${sel.backend}`,
    );
  }
  return { ...config.encoder, backend: sel.backend, lookahead: config.normalizer.lookahead };
}

// ── probe ──────────────────────────────────────────────────────────────

async function cmdProbe() {
  if (!(await ffmpegAvailable())) die('ffmpeg is not on PATH.');

  console.log(`\nProbing encoders (device ${config.encoder.device})`);
  console.log('Each test runs a real 15-frame encode — the -encoders list lies.\n');

  const results = await probeAll(config.encoder.device);
  for (const r of results) {
    console.log(r.ok
      ? `  ✓ ${r.backend.padEnd(14)} ${r.label}`
      : `  ✗ ${r.backend.padEnd(14)} ${r.error}`);
  }

  const usable = results.filter((r) => r.ok);
  if (!usable.length) die('No usable H.264 encoder found.');
  console.log(`\n→ "auto" would select: ${usable[0].backend} (${usable[0].label})\n`);
}

// ── normalize ──────────────────────────────────────────────────────────

async function cmdNormalize() {
  const src = args[0] && resolve(args[0]);
  if (!src || !existsSync(src)) die('Usage: cli.js normalize <file>');

  ensureDirs();
  const profile = await resolveProfile();
  console.log(`\nbackend: ${profile.backend}  →  ${profile.width}x${profile.height}@${profile.fps}`);

  const norm = new Normalizer({
    cacheDir: config.paths.cache,
    profile,
    cacheLimitBytes: config.normalizer.cacheLimitGB * 1024 ** 3,
  });

  norm.on('start', ({ key }) => console.log(`encoding ${key} …`));

  const t0 = Date.now();
  const res = await norm.ensure(src);
  const secs = (Date.now() - t0) / 1000;

  if (res.cached) {
    console.log(`\n✓ already cached: ${res.path}\n`);
  } else {
    const dur = await probeDuration(res.path);
    console.log(`\n✓ ${res.path}`);
    console.log(`  ${dur.toFixed(1)}s of video in ${secs.toFixed(1)}s `
      + `(${(dur / secs).toFixed(1)}× realtime)\n`);
  }
}

// ── selftest ───────────────────────────────────────────────────────────

/**
 * The claim worth testing before anything is built on top of it:
 * a chain of nested .ffconcat scripts plays through as ONE continuous
 * stream, with the later links written only after ffmpeg has already
 * started — and the total duration comes out exact.
 *
 * Runs entirely locally. No Owncast, no network, no hardware required.
 */
async function cmdSelftest() {
  if (!(await ffmpegAvailable())) die('ffmpeg is not on PATH.');

  const dir = mkdtempSync(join(tmpdir(), 'jellystreamerr-selftest-'));
  const CLIPS = 4;
  const CLIP_SECONDS = 6;

  try {
    console.log(`\nGenerating ${CLIPS} test clips of ${CLIP_SECONDS}s each …`);
    console.log('Deliberately mismatched: different sizes, framerates, sample rates.\n');

    // Each clip differs in exactly the ways real library files differ.
    const variants = [
      { s: '640x480',   r: 25, ar: 44100, label: '480p25 44.1k' },
      { s: '1280x720',  r: 30, ar: 48000, label: '720p30 48k' },
      { s: '854x480',   r: 24, ar: 48000, label: '480p24 48k' },
      { s: '1920x1080', r: 30, ar: 44100, label: '1080p30 44.1k' },
    ];

    const sources = [];
    for (let i = 0; i < CLIPS; i++) {
      const v = variants[i % variants.length];
      const p = join(dir, `src${i}.mkv`);
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=s=${v.s}:r=${v.r}`,
        '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 120}:sample_rate=${v.ar}`,
        '-t', String(CLIP_SECONDS),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', String(v.ar),
        p,
      ]);
      sources.push(p);
      console.log(`  clip ${i}: ${v.label}`);
    }

    const profile = await resolveProfile();
    // Keep the selftest quick and hardware-independent.
    const testProfile = {
      ...profile, width: 640, height: 360, fps: 30,
      videoBitrate: '1200k', audioBitrate: '128k', gopSeconds: 2,
    };
    console.log(`\nNormalizing to ${testProfile.width}x${testProfile.height}@${testProfile.fps} `
      + `via ${testProfile.backend} …`);

    const norm = new Normalizer({ cacheDir: dir, profile: testProfile });
    const engine = new PlayoutEngine({
      cacheDir: dir,
      normalizer: norm,
      // A plain file rather than RTMP, so this needs no server. The concat
      // and copy path under test is otherwise identical.
      target: join(dir, 'out.ts'),
      fileOutput: true,
      endBehavior: 'end',
      // Keep the startup burst well under one clip, or ffmpeg consumes the
      // whole chain before the lookahead can extend it.
      initialBurst: 2,
    });

    // Normalize everything up front. This test is about whether the chain
    // plays through as one continuous stream — not about encode throughput.
    // (In production the just-in-time queue handles this, and commits filler
    // rather than blocking if a clip isn't ready.)
    for (const src of sources) await norm.ensure(src);
    console.log('  all clips normalized\n');

    for (let i = 0; i < CLIPS; i++) {
      engine.enqueue({ id: `c${i}`, title: `clip ${i}`, srcPath: sources[i] });
    }

    const committed = [];
    engine.on('committed', ({ item }) => {
      committed.push(item.title);
      console.log(`  → chain link written for ${item.title} `
        + `(t=${engine.outTimeSec.toFixed(1)}s)`);
    });
    engine.on('warn', (m) => console.warn(`  ! ${m}`));

    console.log('\nStreaming through the chain …');
    console.log('(links after the first are written while ffmpeg is already running)\n');

    await engine.start();
    await new Promise((res) => {
      engine.on('ended', res);
      engine.on('fatal', (e) => { console.error(`  ✗ ${e.message}`); res(); });
      setTimeout(res, 120_000).unref?.();
    });

    const outPath = join(dir, 'out.ts');
    if (!existsSync(outPath)) die('selftest produced no output');

    const actual = await probeDuration(outPath);
    const expected = CLIPS * CLIP_SECONDS;
    const drift = actual - expected;
    const pct = Math.abs(drift / expected) * 100;

    console.log('\n─────────────────────────────────────');
    console.log(`  clips chained : ${committed.length}/${CLIPS}`);
    console.log(`  expected      : ${expected.toFixed(2)}s`);
    console.log(`  actual        : ${actual.toFixed(2)}s`);
    console.log(`  drift         : ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s (${pct.toFixed(1)}%)`);
    console.log('─────────────────────────────────────');

    // Un-normalized concat loses ~8% silently; normalized should be well
    // under 1%. A sub-frame wobble is expected from AAC frame quantization.
    if (pct < 1 && committed.length === CLIPS) {
      console.log('\n✓ PASS — gapless chaining works, duration is exact.\n');
    } else {
      console.log('\n✗ FAIL — chain did not play through cleanly.\n');
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── stream ─────────────────────────────────────────────────────────────

async function cmdStream() {
  if (!args.length) die('Usage: cli.js stream <file> [file...]');

  let target;
  try {
    target = rtmpTarget();
  } catch (err) {
    die(`${err.message}\n  Copy config.example.json to config.json and fill it in.`);
  }

  ensureDirs();
  const profile = await resolveProfile();

  console.log(`\ntarget  : ${rtmpTargetRedacted()}`);
  console.log(`encoder : ${profile.backend}`);
  console.log(`output  : ${profile.width}x${profile.height}@${profile.fps} `
    + `${profile.videoBitrate}  GOP ${profile.gopSeconds}s\n`);

  const norm = new Normalizer({
    cacheDir: config.paths.cache,
    profile,
    cacheLimitBytes: config.normalizer.cacheLimitGB * 1024 ** 3,
  });
  norm.on('start', ({ src }) => console.log(`  normalizing ${basename(src)} …`));
  norm.on('done', ({ src, ms }) => console.log(`  ready ${basename(src)} (${(ms / 1000).toFixed(1)}s)`));

  const engine = new PlayoutEngine({
    cacheDir: config.paths.cache,
    normalizer: norm,
    target,
  });

  for (const a of args) {
    const p = resolve(a);
    if (!existsSync(p)) die(`No such file: ${p}`);
    engine.enqueue({ id: p, title: basename(p), srcPath: p });
  }

  engine.on('committed', ({ item }) => console.log(`▶ ${item.title}`));
  engine.on('filler', ({ seconds }) => console.log(`… filler (${seconds}s)`));
  engine.on('warn', (m) => console.warn(`! ${m}`));
  engine.on('fatal', (e) => { console.error(`\n✗ ${e.message}\n`); process.exit(1); });
  engine.on('ended', () => { console.log('\nstream ended\n'); process.exit(0); });

  let lastLog = 0;
  engine.on('progress', (b) => {
    const now = Date.now();
    if (now - lastLog < 5000) return;
    lastLog = now;
    console.log(`  t=${(b.outTimeUs / 1e6).toFixed(0)}s  speed=${b.speed ?? '?'}x  `
      + `drops=${b.dropFrames}`);
  });

  process.on('SIGINT', () => { console.log('\nstopping …'); engine.stop(); });

  await engine.start();
}

const basename = (p) => p.split('/').pop();

function run(bin, argv) {
  return new Promise((res, rej) => {
    const c = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    c.stderr.on('data', (d) => { e += d.toString(); });
    c.on('error', rej);
    c.on('close', (code) => code === 0 ? res() : rej(new Error(e.trim() || `exit ${code}`)));
  });
}

// ── dispatch ───────────────────────────────────────────────────────────

const commands = {
  probe: cmdProbe,
  normalize: cmdNormalize,
  selftest: cmdSelftest,
  stream: cmdStream,
};

if (!commands[cmd]) {
  console.log(`
jellystreamerr

  probe                 test which encoders actually work on this machine
  normalize <file>      normalize one file into the cache
  selftest              prove gapless chaining locally (no Owncast needed)
  stream <file...>      stream files to the configured Owncast
`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((err) => die(err.stack || err.message));
