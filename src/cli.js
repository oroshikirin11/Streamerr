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
import { tmpdir, cpus } from 'os';
import { join, resolve, basename as pathBasename } from 'path';
import {
  config, ensureDirs, rtmpTarget, rtmpTargetRedacted, redact, CONFIG_PATH,
} from './config.js';
import {
  probeAll, selectBackend, probeBackend, ffmpegAvailable, probeConcatCapabilities,
} from './ffmpeg/probe.js';
import { PlayoutEngine, probeDuration, testRtmpConnection } from './ffmpeg/playout.js';
import {
  PipelinePlayout, buildSourceArgs, buildChunkArgs,
} from './ffmpeg/pipeline.js';
import { extractSubtitle, extractFonts } from './ffmpeg/subcache.js';
import {
  probeTracks, listSubtitles, selectTracks, escapeFilterPath,
} from './ffmpeg/tracks.js';

const [, , cmd, ...args] = process.argv;

const die = (msg) => { console.error(`\n✗ ${redact(String(msg))}\n`); process.exit(1); };
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

// ── testconnect ────────────────────────────────────────────────────────

async function cmdTestConnect() {
  let target;
  try {
    target = rtmpTarget();
  } catch (err) {
    die(`${err.message}\n  Copy config.example.json and fill it in.`);
  }

  console.log(`\ntarget: ${rtmpTargetRedacted()}`);
  console.log('pushing 2s of colour bars …\n');

  const res = await testRtmpConnection(target);
  if (res.ok) {
    console.log('✓ accepted — the server took the stream.\n');
    console.log('  It should have flickered live for ~2s. If it did not, the');
    console.log('  connection is fine but the server is not publishing it.\n');
    return;
  }

  console.error(`✗ rejected\n\n${redact(res.error)}\n`);
  console.error('Common causes:');
  console.error('  • wrong stream key            → check owncast.streamKey');
  console.error('  • another publisher connected → Owncast allows only one at a time');
  console.error('  • wrong path                  → Owncast requires rtmp://host:1935/live\n');
  process.exitCode = 1;
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




/** Alias for the strict process runner — cmdBenchmark shadows `run` locally. */
const runProc = (bin, argv) => run(bin, argv);

/** Run ffmpeg and capture stdout bytes (for pixel sampling). */
function run3(argv) {
  return new Promise((res) => {
    const c = spawn('ffmpeg', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const bufs = [];
    c.stdout.on('data', (d) => bufs.push(d));
    c.on('error', () => res(null));
    c.on('close', (code) => res(code === 0 ? Buffer.concat(bufs) : null));
  });
}

/**
 * Does overlay_vaapi honour per-pixel alpha on THIS driver?
 *
 * Composite a fully transparent overlay onto a green base and sample the
 * result. Green back means alpha is respected; dark means the driver drew
 * the overlay opaque (AMD radeonsi does this; Intel iHD is what Jellyfin
 * ships on). Everything about the GPU subtitle path hinges on this.
 */
async function vaapiAlphaHonored(dev) {
  const out = join(tmpdir(), `jsr-alpha-${process.pid}.mp4`);
  const ok = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=30,format=nv12',
    '-f', 'lavfi', '-i', 'color=c=black@0.0:s=320x240:r=30,format=rgba',
    '-filter_complex', '[0:v]hwupload[b];[1:v]hwupload[o];[b][o]overlay_vaapi[out]',
    '-map', '[out]', '-frames:v', '1', '-c:v', 'h264_vaapi', '-b:v', '1M', out,
  ]).then(() => true).catch(() => false);
  if (!ok || !existsSync(out)) return { supported: false };

  const px = await run3([
    '-hide_banner', '-loglevel', 'error', '-i', out,
    '-vf', 'scale=1:1', '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  try { rmSync(out); } catch { /* gone */ }
  if (!px || px.length < 3) return { supported: false };
  const [r, g, b] = px;
  return { supported: true, honored: g > 100 && r < 90 && b < 90, rgb: [r, g, b] };
}

// ── benchmark ──────────────────────────────────────────────────────────

/**
 * Measure encode speed on a REAL file, with and without subtitles.
 *
 * Synthetic clips do not reproduce what heavy typesetting costs: anime ASS
 * with embedded fonts, blur and per-sign positioning is far more expensive to
 * render than plain dialogue, and a 10-bit source forces an extra full-frame
 * conversion because libass only works in 8-bit.
 *
 * Anything below 1.0x cannot sustain a live stream.
 */
async function cmdBenchmark() {
  const src = args[0] && resolve(args[0]);
  if (!src || !existsSync(src)) die('Usage: cli.js benchmark <file>');

  const profile = await resolveProfile();
  const tracks = await probeTracks(src);
  const subs = await listSubtitles(src, tracks);
  const chosen = selectTracks(tracks, subs, config.tracks ?? {});

  const v = tracks.video[0];
  console.log(`\n${basename(src)}`);
  console.log(`  video   : ${v?.codec ?? '?'} ${v?.width ?? '?'}x${v?.height ?? '?'}`);
  console.log(`  output  : ${profile.width}x${profile.height}@${profile.fps} via ${profile.backend}`);
  console.log(`  tracks  : ${chosen.reason}\n`);

  const SECONDS = 20;
  const run = async (label, selection, hwDecode = false, extra = {}) => {
    // Announce before measuring: a 20s sample of a heavy file at 0.5x takes
    // 40s+, and silence between result lines reads as a hang.
    console.log(`  measuring: ${label} …`);
    const a = buildSourceArgs({
      srcPath: src, offset: 0, profile, selection, tsOffset: 0, hwDecode, ...extra,
    })
      // Measure encoding throughput, not realtime pacing.
      .filter((x) => x !== '-re')
      .map((x) => (x === 'pipe:1' ? '-' : x));
    const idx = a.lastIndexOf('-f');
    a.splice(idx, 2, '-t', String(SECONDS), '-f', 'null');

    const t0 = Date.now();
    await run2('ffmpeg', a);
    const secs = (Date.now() - t0) / 1000;
    const speed = SECONDS / secs;
    console.log(`  ${label.padEnd(26)} ${speed.toFixed(2)}x realtime`
      + (speed < 1.2 ? '   ← too slow to stream' : ''));
    return speed;
  };

  const noSubs = { audio: chosen.audio, subtitle: null };
  const without = await run('no subtitles', noSubs, false);
  const withHw = await run('no subtitles, GPU decode', noSubs, true);
  const with_ = chosen.subtitle ? await run('subs read from the mkv', chosen, false) : null;

  // Reading subtitles from the media file makes libavfilter demux the whole
  // thing a second time. Extracting the track first should remove that.
  let withExtracted = null;
  let extractedPath = null;
  if (chosen.subtitle) {
    const cacheDir = join(tmpdir(), 'jellystreamerr-subcache');
    const t0 = Date.now();
    extractedPath = await extractSubtitle(src, chosen.subtitle, cacheDir);
    const fontsDir = await extractFonts(src, cacheDir);
    if (extractedPath) {
      console.log(`  (extracted subtitles in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      withExtracted = await run('subs extracted first', chosen, false,
        { extractedPath, fontsDir });
    }
  }

  // Subtitle rendering scales with output pixels, so resolution is the lever
  // that actually moves it.
  let lower = null;
  if (chosen.subtitle && with_ != null && with_ < 1.5) {
    const small = { ...profile, width: 1280, height: 720 };
    const a = buildSourceArgs({
      srcPath: src, offset: 0, profile: small, selection: chosen, tsOffset: 0,
    }).filter((x) => x !== '-re').map((x) => (x === 'pipe:1' ? '-' : x));
    const i = a.lastIndexOf('-f');
    a.splice(i, 2, '-t', String(SECONDS), '-f', 'null');
    const t0 = Date.now();
    await run2('ffmpeg', a);
    lower = SECONDS / ((Date.now() - t0) / 1000);
    console.log(`  720p output + subs         ${lower.toFixed(2)}x realtime`
      + (lower < 1.2 ? '   ← still too slow' : ''));
  }

  // libass is single-threaded, so the fix for slow subtitle burning is more
  // processes rather than less work.
  let parallel = null;
  if (chosen.subtitle && with_ != null && with_ < 2.5) {
    const workers = Math.max(2, Math.min(4, cpus().length - 1));
    const CH = 6;
    const jobs = Array.from({ length: workers }, (_, i) => {
      const out = join(tmpdir(), `jsr-bench-${process.pid}-${i}.ts`);
      return buildChunkArgs({
        srcPath: src, start: i * CH, dur: CH, out, profile, selection: chosen,
        tsOffset: i * CH,
      });
    });
    const t0 = Date.now();
    await Promise.all(jobs.map((a) => run2('ffmpeg', a)));
    parallel = (workers * CH) / ((Date.now() - t0) / 1000);
    for (let i = 0; i < workers; i++) {
      try { rmSync(join(tmpdir(), `jsr-bench-${process.pid}-${i}.ts`)); } catch { /* gone */ }
    }
    console.log(`  ${workers} parallel chunks + subs   ${parallel.toFixed(2)}x realtime`
      + (parallel < 1.2 ? '   ← still too slow' : ''));
  }

  // The Jellyfin configuration: decode, scale, composite and encode all on
  // the GPU, leaving the CPU to do libass and nothing else. Only meaningful
  // if the driver honours per-pixel alpha in overlay_vaapi.
  let gpuPath = null;
  if (!chosen.subtitle && profile.backend === 'vaapi') {
    console.log('  measuring: full-GPU, no subs …');
    const v = tracks.video[0] ?? {};
    const hdr = ['smpte2084', 'arib-std-b67'].includes(v.color_transfer) || v.hdr;
    const sp = hdr
      ? `scale_vaapi=w=${profile.width}:h=${profile.height}:mode=fast,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709`
      : `scale_vaapi=w=${profile.width}:h=${profile.height}:format=nv12:mode=fast`;
    const a = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${config.encoder.device}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va',
      '-extra_hw_frames', '8', '-i', src,
      '-vf', sp, '-c:v', 'h264_vaapi', '-b:v', profile.videoBitrate,
      '-g', '60', '-bf', '0', '-async_depth', '4',
      '-an', '-t', String(SECONDS), '-f', 'null', '-',
    ];
    const t0 = Date.now();
    const err = await runProc('ffmpeg', a).then(() => null).catch((e) => e.message);
    if (err) {
      console.log(`  full-GPU, no subs          FAILED: ${err.split('\n').filter(Boolean).slice(-1)[0]}`);
    } else {
      gpuPath = SECONDS / ((Date.now() - t0) / 1000);
      console.log(`  full-GPU, no subs          ${gpuPath.toFixed(2)}x realtime`
        + (gpuPath < 1.2 ? '   ← too slow' : '   ← now the production path'));
    }
  }
  if (chosen.subtitle && profile.backend === 'vaapi') {
    const dev = config.encoder.device;
    const alpha = await vaapiAlphaHonored(dev);
    if (!alpha.supported) {
      console.log('  GPU composite: overlay_vaapi not usable on this driver');
    } else if (!alpha.honored) {
      console.log(`  GPU composite: driver IGNORES alpha (got rgb ${alpha.rgb}) — path unusable`);
    } else {
      console.log('  GPU composite: driver honours alpha ✓');
      console.log('  measuring: full-GPU pipeline + subs …');
      const subFilter = chosen.subtitle.external
        ? `subtitles=filename=${escapeFilterPath(chosen.subtitle.path)}:alpha=1`
        : `subtitles=filename=${escapeFilterPath(src)}:si=${chosen.subtitle.typeIndex}:alpha=1`;
      const a = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va',
        '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va',
        '-i', src,
        '-f', 'lavfi',
        '-i', `color=c=black@0.0:s=${profile.width}x${profile.height}:r=${profile.fps},format=rgba`,
        '-filter_complex',
        `[1:v]${subFilter},format=rgba,hwupload[ov];`
        + `[0:v]scale_vaapi=w=${profile.width}:h=${profile.height}[b];`
        + `[b][ov]overlay_vaapi[out]`,
        '-map', '[out]', '-c:v', 'h264_vaapi', '-b:v', profile.videoBitrate,
        '-an', '-t', String(SECONDS), '-f', 'null', '-',
      ];
      const t0 = Date.now();
      const err = await runProc('ffmpeg', a).then(() => null).catch((e) => e.message);
      if (err) {
        console.log(`  full-GPU pipeline + subs   FAILED: ${err.split('\n')[0]}`);
      } else {
        gpuPath = SECONDS / ((Date.now() - t0) / 1000);
        console.log(`  full-GPU pipeline + subs   ${gpuPath.toFixed(2)}x realtime`
          + (gpuPath < 1.2 ? '   ← too slow' : '   ← the Jellyfin approach'));
      }
    }
  }

  // QSV variant of the same pipeline, through libvpl. Same GPU, different
  // driver stack — Jellyfin ships this path in production on identical
  // hardware. The number decides whether it beats VAAPI here, not theory.
  let qsvPath = null;
  {
    const q = await probeBackend('qsv', config.encoder.device);
    if (!q.ok) {
      console.log(`  QSV: not usable (${q.error})`);
    } else {
      console.log('  measuring: QSV pipeline …');
      const v = tracks.video[0] ?? {};
      const dec = { hevc: 'hevc_qsv', h264: 'h264_qsv', av1: 'av1_qsv' }[v.codec];
      const subF = !chosen.subtitle ? '' : chosen.subtitle.external
        ? `subtitles=filename=${escapeFilterPath(chosen.subtitle.path)}:alpha=1`
        : `subtitles=filename=${escapeFilterPath(src)}:si=${chosen.subtitle.typeIndex}:alpha=1`;
      const hdr = ['smpte2084', 'arib-std-b67'].includes(v.colorTransfer) || v.hdr;
      const vpp = hdr
        ? `vpp_qsv=w=${profile.width}:h=${profile.height}:format=nv12:tonemap=1`
        : `vpp_qsv=w=${profile.width}:h=${profile.height}:format=nv12`;
      const graph = chosen.subtitle
        ? `[1:v]${subF},format=rgba,hwupload=extra_hw_frames=16[ov];[0:v]${vpp}[b];[b][ov]overlay_qsv[v]`
        : `[0:v]${vpp}[v]`;
      const canvas = chosen.subtitle
        ? ['-f', 'lavfi', '-i', `color=c=black@0.0:s=${profile.width}x${profile.height}:r=30,format=rgba`]
        : [];
      const a = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-init_hw_device', `vaapi=va:${config.encoder.device}`,
        '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs',
        '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv',
        ...(dec ? ['-c:v', dec] : []),
        '-i', src,
        ...canvas,
        '-filter_complex', graph,
        '-map', '[v]', '-c:v', 'h264_qsv',
        '-b:v', profile.videoBitrate, '-g', '60', '-bf', '0',
        '-an', '-t', String(SECONDS), '-f', 'null', '-',
      ];
      const t0 = Date.now();
      const err = await runProc('ffmpeg', a).then(() => null).catch((e) => e.message);
      if (err) {
        console.log(`  QSV pipeline + subs        FAILED: ${err.split('\n').filter(Boolean).slice(-1)[0]}`);
        if (hdr) {
          // tonemap=1 is the most version-sensitive piece; measure without it
          // so a missing tonemap doesn't hide the throughput answer.
          const a2 = a.map((x) => x.replace(':tonemap=1', ''));
          const t1 = Date.now();
          const e2 = await runProc('ffmpeg', a2).then(() => null).catch((e) => e.message);
          if (!e2) {
            qsvPath = SECONDS / ((Date.now() - t1) / 1000);
            console.log(`  QSV, no tonemap            ${qsvPath.toFixed(2)}x realtime  (colours would be wrong — throughput probe only)`);
          }
        }
      } else {
        qsvPath = SECONDS / ((Date.now() - t0) / 1000);
        console.log(`  QSV pipeline + subs        ${qsvPath.toFixed(2)}x realtime`
          + (qsvPath < 1.2 ? '   ← too slow' : ''));
      }
    }
  }

  console.log('');

  if (qsvPath != null && gpuPath != null) {
    console.log(`  QSV is ${(qsvPath / gpuPath).toFixed(2)}x the VAAPI pipeline's speed.`);
  }
  if (gpuPath != null && with_) {
    console.log(`  Full-GPU pipeline is ${(gpuPath / with_).toFixed(1)}x faster than CPU burn-in.`);
  }
  if (parallel != null && with_) {
    console.log(`  Encoding in parallel chunks is ${(parallel / with_).toFixed(1)}x faster.`);
    if (parallel > 1.3) {
      console.log('  Set Settings → Output → parallel chunks to enable it.');
    }
  }
  if (with_ != null) {
    console.log(`  Subtitles cost ${(without / with_).toFixed(1)}x when read from the mkv.`);
  }
  if (lower != null && with_) {
    console.log(`  Dropping to 720p is ${(lower / with_).toFixed(1)}x faster.`);
  }
  if (withExtracted != null && with_ != null) {
    const gain = withExtracted / with_;
    console.log(gain > 1.15
      ? `  Extracting them first is ${gain.toFixed(1)}x faster — this is now automatic.`
      : '  Extracting them first made little difference here.');
  }
  if (withHw > without * 1.15) {
    console.log(`  GPU decode is ${(withHw / without).toFixed(1)}x faster — enable it in Settings.`);
  }
  const streamable = chosen.subtitle
    ? Math.max(with_ ?? 0, withExtracted ?? 0, lower ?? 0, parallel ?? 0, gpuPath ?? 0, qsvPath ?? 0)
    : Math.max(without, withHw, gpuPath ?? 0, qsvPath ?? 0);
  if (streamable < 1.2) {
    console.log('');
    console.log('  Nothing here is fast enough to stream this file as configured.');
    console.log('  Try 720p output, a lighter subtitle track, or subtitles off.');
  } else {
    console.log('');
    console.log(`  Fastest usable configuration: ${streamable.toFixed(2)}x realtime.`);
  }
  console.log('');
}

function run2(bin, argv) {
  return new Promise((res, rej) => {
    const c = spawn(bin, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    // A benchmark step may be slow, but it must never be silently infinite —
    // a 20s measurement at even 0.1x is done inside 200s.
    const t = setTimeout(() => c.kill('SIGKILL'), 240_000);
    c.stderr.on('data', (d) => { e += d.toString(); });
    c.on('error', (err) => { clearTimeout(t); rej(err); });
    c.on('close', () => { clearTimeout(t); res(e); });
  });
}


// ── gputest ────────────────────────────────────────────────────────────

/**
 * Render the same seeked frame three ways — no subs, CPU burn, GPU overlay —
 * and measure how much each subtitle path actually changed the picture.
 * Writes PNGs next to config.json so they can be eyeballed from the host.
 */
async function cmdGputest() {
  const src = args[0] && resolve(args[0]);
  if (!src || !existsSync(src)) die('Usage: cli.js gputest <file>');
  const { dirname } = await import('path');
  const outDir = dirname(CONFIG_PATH);

  const profile = { ...(await resolveProfile()) };
  const tracks = await probeTracks(src);
  const subs = await listSubtitles(src, tracks);
  const sel = selectTracks(tracks, subs, { ...config.tracks, subtitleMode: 'always' });
  if (!sel.subtitle) die('No subtitle track found');
  console.log(`\ntrack: ${sel.reason}`);

  const dur = await probeDuration(src).catch(() => null);
  const OFF = Math.min(90, Math.max(0, (dur ?? 95) - 5));
  const make = async (name, gpuSubs, selection) => {
    const a = buildSourceArgs({
      srcPath: src, offset: OFF, profile: { ...profile, gpuSubs }, selection, tsOffset: 0,
    }).map((x) => (x === 'pipe:1' ? join(outDir, `${name}.ts`) : x));
    const i = a.indexOf('-progress'); a.splice(i, 4);
    a.splice(a.lastIndexOf('-f'), 0, '-t', '2');
    a.splice(1, 0, '-y');
    await run('ffmpeg', a);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', '1', '-i', join(outDir, `${name}.ts`), '-frames:v', '1',
      join(outDir, `${name}.png`)]);
    return join(outDir, `${name}.png`);
  };

  const plain = await make('gputest-nosub', false, { audio: sel.audio, subtitle: null });
  const cpu = await make('gputest-cpu', false, sel);
  const gpu = await make('gputest-gpu', true, sel);

  const diff = (a, b) => new Promise((res) => {
    const c = spawn('ffmpeg', ['-hide_banner', '-i', a, '-i', b,
      '-filter_complex', 'blend=difference,signalstats', '-f', 'null', '-'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    c.stderr.on('data', (d) => { e += d.toString(); });
    c.on('close', () => {
      const m = /YAVG:([0-9.]+)/.exec(e);
      res(m ? parseFloat(m[1]) : -1);
    });
  });

  const cpuDiff = await diff(plain, cpu);
  const gpuDiff = await diff(plain, gpu);
  console.log(`\n  CPU burn changed the frame by  YAVG ${cpuDiff}`);
  console.log(`  GPU path changed the frame by  YAVG ${gpuDiff}`);
  console.log(`\n  PNGs written next to config.json — look at them.`);
  if (cpuDiff > 0.5 && gpuDiff < 0.1) {
    console.log('  → GPU overlay contributes NOTHING: driver drops it silently.');
  } else if (gpuDiff > 0.5) {
    console.log('  → GPU overlay IS rendering; compare the PNGs for correctness.');
  }
}

// ── pipetest ───────────────────────────────────────────────────────────

/**
 * The claim the split-pipeline design rests on: seeking, pausing and changing
 * tracks restart only the SOURCE, while the publisher — and therefore the RTMP
 * connection — keeps running throughout.
 *
 * Asserts the publisher process id never changes across all of those
 * operations, and that the output is continuous.
 */
async function cmdPipetest() {
  if (!(await ffmpegAvailable())) die('ffmpeg is not on PATH.');

  const dir = mkdtempSync(join(tmpdir(), 'jellystreamerr-pipe-'));
  const CLIPS = 3;
  const CLIP_SECONDS = 20;

  try {
    console.log(`\nGenerating ${CLIPS} clips of ${CLIP_SECONDS}s …\n`);
    const sources = [];
    for (let i = 0; i < CLIPS; i++) {
      const p = join(dir, `src${i}.mkv`);
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30`,
        '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 150}:sample_rate=48000`,
        '-t', String(CLIP_SECONDS),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', p,
      ]);
      sources.push(p);
    }

    const profile = {
      ...(await resolveProfile()),
      width: 640, height: 360, fps: 30,
      videoBitrate: '1200k', audioBitrate: '128k', gopSeconds: 2,
    };
    console.log(`Encoding via ${profile.backend} → local flv\n`);

    const out = join(dir, 'out.flv');
    const engine = new PipelinePlayout({ target: out, profile });

    const publisherPids = new Set();
    const sourcePids = new Set();
    const events = [];

    engine.on('warn', (m) => console.warn(`  ! ${m}`));
    engine.on('fatal', (e) => console.error(`  ✗ ${e.message}`));

    const watch = setInterval(() => {
      if (engine.publisher?.pid) publisherPids.add(engine.publisher.pid);
      if (engine.source?.pid) sourcePids.add(engine.source.pid);
    }, 100);

    await engine.start(sources.map((srcPath, i) => ({
      id: `c${i}`, title: `clip ${i}`, srcPath, duration: CLIP_SECONDS,
    })));

    const at = (ms, label, fn) => setTimeout(() => {
      if (engine.status === 'stopped') return;
      events.push(`${label} @ ${engine.position.toFixed(1)}s`);
      console.log(`  ${label}`);
      try { fn(); } catch (err) { console.warn(`  ! ${label}: ${err.message}`); }
    }, ms);

    at(4000,  'seek +8s',  () => engine.seek({ delta: 8 }));
    at(9000,  'pause',     () => engine.pause());
    at(14000, 'resume',    () => engine.resume());
    at(19000, 'seek -5s',  () => engine.seek({ delta: -5 }));
    at(24000, 'stop',      () => engine.stop());

    await new Promise((res) => {
      engine.on('ended', res);
      setTimeout(res, 60_000).unref?.();
    });
    clearInterval(watch);
    await new Promise((r) => setTimeout(r, 500));

    if (!existsSync(out)) die('pipetest produced no output');
    const duration = await probeDuration(out).catch(() => null);

    console.log('\n─────────────────────────────────────');
    console.log(`  operations    : ${events.length} (${events.join(', ')})`);
    console.log(`  publisher pids: ${publisherPids.size}  ${[...publisherPids].join(', ')}`);
    console.log(`  source pids   : ${sourcePids.size}`);
    console.log(`  output        : ${duration ? duration.toFixed(1) + 's' : 'unreadable'}`);
    console.log('─────────────────────────────────────');

    const onePublisher = publisherPids.size === 1;
    const manySources = sourcePids.size >= 4;
    const playable = duration != null && duration > 15;

    if (onePublisher && manySources && playable) {
      console.log('\n✓ PASS — one publisher survived every seek, pause and resume.\n');
    } else {
      console.log('\n✗ FAIL');
      if (!onePublisher) console.log(`  publisher restarted (${publisherPids.size} processes)`);
      if (!manySources) console.log(`  expected several source restarts, saw ${sourcePids.size}`);
      if (!playable) console.log('  output too short or unreadable');
      console.log('');
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

  // Verify the server accepts us BEFORE going live. The fifo muxer retries a
  // rejected connection forever without failing, so without this check a bad
  // stream key produces a perfectly healthy-looking encode that never
  // arrives anywhere.
  process.stdout.write('checking the server accepts us … ');
  const conn = await testRtmpConnection(target);
  if (!conn.ok) {
    console.log('rejected\n');
    die(`Owncast would not accept the stream.\n\n${conn.error}\n\n`
      + '  • wrong stream key            → check owncast.streamKey\n'
      + '  • another publisher connected → Owncast allows only one at a time\n'
      + '  • wrong path                  → Owncast requires rtmp://host:1935/live');
  }
  console.log('ok\n');

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
  engine.on('warn', (m) => console.warn(`! ${redact(String(m))}`));
  // Surface connection trouble. fifo's recovery keeps the encoder alive
  // through a dropped push, which is what we want — but it must not be
  // silent, or a stream that never reaches the server looks perfectly fine.
  engine.on('log', (line) => {
    // Match trouble only. Matching "rtmp" catches ffmpeg's own banner line,
    // which then reads as a warning on a perfectly healthy stream.
    if (/recover|refused|reset by peer|broken pipe|timed out|Error|Failed/i.test(line)) {
      process.stderr.write(`! ${redact(line.trim())}\n`);
    }
  });
  engine.on('fatal', (e) => { console.error(`\n✗ ${redact(e.message)}\n`); engine.cleanup(); process.exit(1); });
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
  testconnect: cmdTestConnect,
  selftest: cmdSelftest,
  pipetest: cmdPipetest,
  gputest: cmdGputest,
  benchmark: cmdBenchmark,
  stream: cmdStream,
};

if (!commands[cmd]) {
  console.log(`
jellystreamerr

  probe                 test which encoders actually work on this machine
  tracks <file>         list audio/subtitle tracks and what would be picked
  testconnect           check Owncast accepts our stream key
  selftest              prove gapless chaining locally (no Owncast needed)
  pipetest              prove seek/pause keep the connection alive
  benchmark <file>      measure encode speed with and without subtitles
  stream <file...>      stream files to the configured Owncast
`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((err) => die(err.stack || err.message));
