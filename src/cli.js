#!/usr/bin/env node
/**
 * Test harness for the engine, before any UI exists.
 *
 *   node src/cli.js probe                    which encoders actually work here
 *   node src/cli.js tracks <file>            audio/subtitle tracks and what we'd pick
 *   node src/cli.js selftest                 gapless chain test, no Owncast needed
 *   node src/cli.js stream <file...>         stream files to the configured Owncast
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, basename as pathBasename } from 'path';
import { config, ensureDirs, rtmpTarget, rtmpTargetRedacted } from './config.js';
import {
  probeAll, selectBackend, ffmpegAvailable, probeConcatCapabilities,
} from './ffmpeg/probe.js';
import { PlayoutEngine, probeDuration } from './ffmpeg/playout.js';
import { probeTracks, listSubtitles, selectTracks } from './ffmpeg/tracks.js';

const [, , cmd, ...args] = process.argv;

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
const basename = (p) => pathBasename(p);

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

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
  return { ...config.encoder, backend: sel.backend };
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
  console.log(`\n→ "auto" would select: ${usable[0].backend} (${usable[0].label})`);

  const caps = await probeConcatCapabilities();
  console.log(`\nffmpeg ${caps.version ?? '(unknown version)'} — concat demuxer:`);
  console.log(`  ${caps.recursionDepth ? '✓' : '✗'} recursion_depth`
    + (caps.recursionDepth ? '' : '   ← chain is capped at 10 clips on this build'));
  console.log(`  ${caps.segmentTimeMetadata ? '✓' : '✗'} segment_time_metadata\n`);
}

// ── tracks ─────────────────────────────────────────────────────────────

async function cmdTracks() {
  const src = args[0] && resolve(args[0]);
  if (!src || !existsSync(src)) die('Usage: cli.js tracks <file>');

  const tracks = await probeTracks(src);
  const subs = await listSubtitles(src, tracks);

  console.log(`\n${basename(src)}\n`);
  console.log('audio:');
  for (const a of tracks.audio) {
    console.log(`  [${a.typeIndex}] ${(a.language ?? '?').padEnd(4)} ${a.codec} `
      + `${a.channels ?? '?'}ch${a.default ? '  (default)' : ''}`
      + `${a.title ? `  "${a.title}"` : ''}`);
  }
  if (!tracks.audio.length) console.log('  (none)');

  console.log('\nsubtitles:');
  for (const s of subs) {
    const flags = [
      s.forced && 'forced', s.hearingImpaired && 'sdh',
      s.external && 'sidecar', s.bitmap && 'bitmap',
    ].filter(Boolean).join(', ');
    const id = s.external ? basename(s.path) : `[${s.typeIndex}]`;
    console.log(`  ${id} ${(s.language ?? '?').padEnd(4)} ${s.codec}`
      + `${flags ? `  (${flags})` : ''}`);
  }
  if (!subs.length) console.log('  (none)');

  const chosen = selectTracks(tracks, subs, config.tracks ?? {});
  console.log(`\n→ would use: ${chosen.reason}\n`);
}

// ── selftest ───────────────────────────────────────────────────────────

/**
 * The claim worth testing before anything is built on top of it: a chain of
 * nested .ffconcat scripts plays through as ONE continuous stream, with the
 * later links written only after ffmpeg has already started, and the total
 * duration comes out exact — from deliberately mismatched sources.
 *
 * Runs entirely locally. No Owncast, no network.
 */
async function cmdSelftest() {
  if (!(await ffmpegAvailable())) die('ffmpeg is not on PATH.');

  const dir = mkdtempSync(join(tmpdir(), 'jellystreamerr-selftest-'));
  const CLIPS = 4;
  const CLIP_SECONDS = 6;

  try {
    console.log(`\nGenerating ${CLIPS} test clips of ${CLIP_SECONDS}s each …`);
    console.log('Deliberately mismatched: different sizes, framerates, sample rates.\n');

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
    const testProfile = {
      ...profile, width: 640, height: 360, fps: 30,
      videoBitrate: '1200k', audioBitrate: '128k', gopSeconds: 2,
    };
    console.log(`\nEncoding live to ${testProfile.width}x${testProfile.height}@`
      + `${testProfile.fps} via ${testProfile.backend} …`);

    const engine = new PlayoutEngine({
      workDir: dir,
      // A local .flv rather than an RTMP URL. Everything else — the concat
      // chain, the filters, the codec tags, the fifo muxer — is identical to
      // production, so the destination is the ONLY difference. An earlier
      // version bypassed the fifo muxer and missed two bugs living there.
      target: join(dir, 'out.flv'),
      profile: testProfile,
      endBehavior: 'end',
      // Keep the startup burst well under one clip, or ffmpeg consumes the
      // whole chain before the lookahead can extend it.
      initialBurst: 2,
      caps: await probeConcatCapabilities(),
    });

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

    const t0 = Date.now();
    console.log('\nStreaming through the chain …');
    console.log('(links after the first are written while ffmpeg is already running)\n');

    await engine.start();
    const startupMs = Date.now() - t0;

    await new Promise((res) => {
      engine.on('ended', res);
      engine.on('fatal', (e) => { console.error(`  ✗ ${e.message}`); res(); });
      setTimeout(res, 180_000).unref?.();
    });

    const outPath = join(dir, 'out.flv');
    if (!existsSync(outPath)) die('selftest produced no output');

    const actual = await probeDuration(outPath);
    const expected = CLIPS * CLIP_SECONDS;
    const drift = actual - expected;
    const pct = Math.abs(drift / expected) * 100;

    console.log('\n─────────────────────────────────────');
    console.log(`  clips chained : ${committed.length}/${CLIPS}`);
    console.log(`  time to air   : ${(startupMs / 1000).toFixed(1)}s`);
    console.log(`  expected      : ${expected.toFixed(2)}s`);
    console.log(`  actual        : ${actual.toFixed(2)}s`);
    console.log(`  drift         : ${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s (${pct.toFixed(1)}%)`);
    console.log('─────────────────────────────────────');

    if (pct < 2 && committed.length === CLIPS) {
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
    die(`${err.message}\n  Copy config.example.json and fill it in.`);
  }

  ensureDirs();
  const profile = await resolveProfile();

  const paths = args.map((a) => resolve(a));
  for (const p of paths) if (!existsSync(p)) die(`No such file: ${p}`);

  // Track choice applies to the whole session: -map and the subtitles filter
  // are set once for the ffmpeg process, not per clip. Resolved from the
  // first file, which within a series is representative.
  const tracks = await probeTracks(paths[0]);
  const subs = await listSubtitles(paths[0], tracks);
  const selection = selectTracks(tracks, subs, config.tracks ?? {});

  console.log(`\ntarget  : ${rtmpTargetRedacted()}`);
  console.log(`encoder : ${profile.backend}`);
  console.log(`output  : ${profile.width}x${profile.height}@${profile.fps} `
    + `${profile.videoBitrate}  GOP ${profile.gopSeconds}s`);
  console.log(`tracks  : ${selection.reason}\n`);

  const engine = new PlayoutEngine({
    workDir: config.paths.cache,
    target,
    profile,
    selection,
    endBehavior: 'end',
    caps: await probeConcatCapabilities(),
  });

  for (const p of paths) {
    engine.enqueue({ id: p, title: basename(p), srcPath: p });
  }

  const t0 = Date.now();
  engine.on('committed', ({ item, duration }) =>
    console.log(`▶ ${item.title}  (${fmtTime(duration)})`));
  engine.on('warn', (m) => console.warn(`! ${m}`));
  engine.on('fatal', (e) => { console.error(`\n✗ ${e.message}\n`); engine.cleanup(); process.exit(1); });
  engine.on('ended', () => {
    console.log('\nstream ended');
    engine.cleanup();
    process.exit(0);
  });

  let lastLog = 0;
  let announced = false;
  engine.on('progress', (b) => {
    if (!announced) {
      announced = true;
      console.log(`\n  live after ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    }
    const now = Date.now();
    if (now - lastLog < 5000) return;
    lastLog = now;
    console.log(`  t=${fmtTime(b.outTimeUs / 1e6)}  speed=${b.speed ?? '?'}x  `
      + `drops=${b.dropFrames}`);
  });

  process.on('SIGINT', () => { console.log('\nstopping …'); engine.stop(); });

  await engine.start();
}

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
  tracks: cmdTracks,
  selftest: cmdSelftest,
  stream: cmdStream,
};

if (!commands[cmd]) {
  console.log(`
jellystreamerr

  probe                 test which encoders actually work on this machine
  tracks <file>         list audio/subtitle tracks and what would be picked
  selftest              prove gapless chaining locally (no Owncast needed)
  stream <file...>      stream files to the configured Owncast
`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((err) => die(err.stack || err.message));
