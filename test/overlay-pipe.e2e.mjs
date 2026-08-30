/**
 * End to end: the piped graph on real hardware.
 *
 * One main encoder built by buildSourceArgs runs a 10s clip, paced at 1x.
 * A renderer feeds subtitles through the fifo; four seconds in it is
 * REPLACED by one rendering nothing. If phase 1 works, the encoder never
 * restarts, exits cleanly with the full clip, and the picture carries the
 * overlay early but not late.
 *
 * Needs /dev/dri and a VAAPI driver, so it is not part of `npm test`.
 *
 * Run: node test/overlay-pipe.e2e.mjs [/dev/dri/renderD128]
 */
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSourceArgs, buildRendererSpec } from '../src/ffmpeg/pipeline.js';
import { OverlayFeed } from '../src/ffmpeg/overlay-feed.js';
import { rendererArgs } from '../src/ffmpeg/overlay-renderer.js';

const device = process.argv[2] ?? '/dev/dri/renderD128';
const dir = mkdtempSync(join(tmpdir(), 'jsr-e2e-'));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const run = (args, ms = 60000) => new Promise((resolve) => {
  const c = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, ms);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

const ass = (text) => `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Big,DejaVu Sans,220,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${text ? `Dialogue: 0,0:00:00.00,0:10:00.00,Big,,0,0,0,,${text}` : ''}
`;

const media = join(dir, 'clip.mp4');
const ass1 = join(dir, 'v1.ass');
const ass2 = join(dir, 'v2.ass');
const out = join(dir, 'out.mkv');
const fifo = join(dir, 'overlay-1.fifo');
writeFileSync(ass1, ass('OVERLAY'));
writeFileSync(ass2, ass(''));            // the "apply": everything removed

console.log('\npreparing a 10s clip');
const gen = await run(['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=s=640x360:r=24', '-t', '10',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', media]);
check('clip generated', gen.code === 0, gen.err.slice(-200));

const profile = {
  backend: 'vaapi', device, gpuFull: true, gpuSubs: true, overlayPipe: true,
  width: 1280, height: 720, fps: 30, fpsMode: 'auto',
  videoBitrate: '4000k', audioBitrate: '160k', gopSeconds: 2,
};
const selection = {
  // frameRate in the shape real probes emit; a bare '24' falls back to the
  // profile cap and the whole clip runs at 30fps.
  video: { width: 640, height: 360, codec: 'h264', frameRate: '24000/1001', sar: '1:1' },
  audio: { typeIndex: 0 },
  subtitle: { codec: 'ass', typeIndex: 0, external: false },
};
const specFor = (path, shift) => buildRendererSpec({
  profile, selection, srcPath: media, shift, clipOffset: 0, duration: 10,
  extractedPath: path,
});

const feed = new OverlayFeed({ path: fifo, log: (m) => console.log('   ', m.trim()) });
let main = null;
try {
  const spec1 = specFor(ass1, 0);
  check('clip is pipe-eligible', spec1 !== null);
  feed.resetSync();
  feed.spawnRenderer(rendererArgs(spec1.spec));

  // The real argv, adjusted only at the edges: paced to 1x so the swap
  // lands mid-clip, and writing a file instead of an mpegts pipe.
  const args = buildSourceArgs({
    srcPath: media, offset: 0, profile, selection,
    extractedPath: ass1, duration: 10, overlayPipe: fifo,
  });
  const iMedia = args.indexOf('-i');
  args.splice(iMedia, 0, '-re');
  const iProg = args.indexOf('-progress');
  args.splice(iProg, 4);                       // -progress pipe:3 -stats_period N
  args[args.indexOf('error')] = 'info';        // see WHERE it stops, not just that it did
  // lastIndexOf: the FIRST '-f' is the pipe input's rawvideo declaration,
  // and eating it leaves ffmpeg probing headerless RGBA forever.
  args.splice(args.lastIndexOf('-f'), 3, '-y', out);
  check('main graph reads the fifo', args.includes(fifo));

  console.log('\nrunning: 10s clip, overlay removed at t=4s by replacing the renderer');
  const mainDone = new Promise((resolve) => {
    main = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    main.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { main.kill('SIGKILL'); } catch { /* gone */ } }, 45000);
    main.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
  });

  if (process.env.NOSWAP !== '1') {
    await sleep(4000);
    // The continuation clock is TIME now (the engine uses the encode head);
    // with -re pacing, wall time since start ≈ media time.
    const shift = 4.0;
    await feed.swap(rendererArgs(specFor(ass2, shift).spec));
    console.log(`    swapped at ~${shift.toFixed(1)}s media — encoder untouched`);
  }

  const res = await mainDone;
  main = null;
  check('ONE encoder process survived the swap and exited cleanly',
    res.code === 0, `exit ${res.code}: ${res.err.slice(-600)}`);

  // Brightness of the frame centre: the huge white OVERLAY text pushes it
  // up; after the swap the centre is bare testsrc2.
  const lum = async (at) => {
    const raw = join(dir, 'px.raw');
    await run(['-y', '-v', 'error', '-ss', String(at), '-i', out,
      '-vf', 'crop=300:200:490:260,scale=1:1', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
    return readFileSync(raw)[0];
  };
  const early = await lum(2);
  const late = await lum(8);
  check(`overlay visible before the swap (centre ${early})`, early > 120);
  check(`overlay gone after the swap (centre ${late})`, late < early - 40,
    `early ${early} vs late ${late}`);

  const probe = await new Promise((resolve) => {
    const c = spawn('ffprobe', ['-v', 'error', '-count_frames',
      '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
      '-of', 'csv=p=0', out], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.on('close', () => resolve(o.trim()));
  });
  check(`full clip encoded (${probe} frames of ~240)`,
    Math.abs(Number(probe) - 240) <= 3);
  // The byte odometer died when node left the data path; the VFR economy
  // stays pinned by the filter-chain unit test and the direct measurement
  // (a static canvas keeps 19 frames of 240).
} finally {
  try { main?.kill('SIGKILL'); } catch { /* gone */ }
  feed.stopSync();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
