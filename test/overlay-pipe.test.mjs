/**
 * The overlay pipe: eligibility, geometry agreement, and the feed.
 *
 * Three properties matter and each has its own section:
 *
 *  1. planOverlayPipe must refuse everything the pipe cannot do. A wrong
 *     yes is a dead clip on some driver; every "no" here routes to a path
 *     that already works.
 *  2. The renderer and the main graph must agree on the pipe format down
 *     to the byte — a mismatch shears the picture with no error anywhere.
 *  3. The feed must deliver a continuous frame-aligned stream across
 *     renderer replacements, because the frame count is the only clock.
 *
 * Run: node test/overlay-pipe.test.mjs
 */
import { createReadStream, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  planOverlayPipe, buildRendererSpec, buildSourceArgs,
} from '../src/ffmpeg/pipeline.js';
import { buildSubtitleFilter } from '../src/ffmpeg/tracks.js';
import { OverlayFeed } from '../src/ffmpeg/overlay-feed.js';
import { rendererArgs } from '../src/ffmpeg/overlay-renderer.js';
import { cases } from './fixtures/source-args-cases.mjs';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

const subOf = (params) => buildSubtitleFilter(
  params.selection?.subtitle ?? null, params.srcPath,
  {
    extractedPath: params.extractedPath ?? null,
    fontsDir: params.fontsDir ?? null,
    overlayPath: params.overlayPath ?? null,
  },
);
const planFor = (params, extra = {}) => planOverlayPipe({
  profile: { ...params.profile, overlayPipe: true, ...extra },
  selection: params.selection,
  sub: subOf(params),
  duration: params.duration ?? null,
});

console.log('\neligibility — every no must route somewhere that works');
check('subtitled 16:9 is eligible',
  planFor(cases['subtitled 16:9, gpu canvas']) !== null, true);
check('subtitle-less 16:9 is eligible (that is the feature)',
  planFor(cases['no subtitles, still picture on gpu']) !== null, true);
check('probed pillarbox with subtitles is eligible',
  planFor(cases['subtitled pillarbox, pad-overlay']) !== null, true);
check('pillarbox WITHOUT subtitles is refused — barsGraph is unprobed',
  planFor({ ...cases['no subtitles, fast path'], profile: { ...cases['no subtitles, fast path'].profile, gpuSubs: true } }), null);
check('subtitles with gpuSubs off are refused — alpha unproven',
  planFor(cases['cpu burn path (gpuSubs off)']), null);
check('flag off is refused', planOverlayPipe({
  profile: { ...cases['subtitled 16:9, gpu canvas'].profile, overlayPipe: false },
  selection: cases['subtitled 16:9, gpu canvas'].selection,
  sub: subOf(cases['subtitled 16:9, gpu canvas']),
}), null);
check('bitmap subtitles are refused — they need the video frames',
  planOverlayPipe({
    profile: { ...cases['subtitled 16:9, gpu canvas'].profile, overlayPipe: true },
    selection: cases['subtitled 16:9, gpu canvas'].selection,
    sub: { filter: null, needsComplex: true },
  }), null);
check('non-vaapi is refused', planFor(
  cases['subtitled 16:9, gpu canvas'], { backend: 'x264' }), null);
check('unknown duration is refused — the pipe input cannot be bounded',
  planFor({ ...cases['subtitled 16:9, gpu canvas'], duration: null }), null);
check('barsFailed pillarbox is refused', planFor(
  cases['subtitled pillarbox, pad-overlay'], { barsFailed: true }), null);

console.log('\ngeometry — both ends of the pipe from one authority');
for (const name of ['subtitled 16:9, gpu canvas', 'subtitled pillarbox, pad-overlay',
  'subtitled pillarbox, wide-canvas', 'subtitled pillarbox, bg-composite']) {
  const params = cases[name];
  const piped = {
    ...params,
    profile: { ...params.profile, overlayPipe: true },
    overlayPipe: '/tmp/x.fifo',
  };
  const args = buildSourceArgs(piped);
  const i = args.indexOf('/tmp/x.fifo');
  check(`${name}: main graph consumes the pipe`, i > 0, true);
  const spec = buildRendererSpec({
    profile: piped.profile, selection: piped.selection, srcPath: piped.srcPath,
    shift: piped.offset, duration: piped.duration,
    extractedPath: piped.extractedPath ?? null, fontsDir: piped.fontsDir ?? null,
  });
  // Parse by flag, not by offset — offsets broke twice as options grew.
  const before = args.slice(0, i);
  check(`${name}: sizes agree`,
    before[before.lastIndexOf('-s') + 1], `${spec.width}x${spec.height}`);
  check(`${name}: rates agree`,
    before[before.lastIndexOf('-r') + 1], String(spec.rate));
  check(`${name}: no canvas remains in the main graph`,
    args.join(' ').includes('alpha=1'), false);
  check(`${name}: the pipe input is bounded so the process can exit`,
    before[before.lastIndexOf('-t')] === '-t'
      && Number(before[before.lastIndexOf('-t') + 1]) > 0, true);
}

console.log('\nwide-canvas carries the padded frame');
const wc = cases['subtitled pillarbox, wide-canvas'];
const wcSpec = buildRendererSpec({
  profile: { ...wc.profile, overlayPipe: true }, selection: wc.selection,
  srcPath: wc.srcPath, shift: 0, duration: wc.duration,
  extractedPath: wc.extractedPath,
});
check('pipe is output-frame sized', `${wcSpec.width}x${wcSpec.height}`, '1920x1080');
check('renderer pads the canvas itself',
  /pad=1920:1080/.test(wcSpec.spec.filters.join(';')), true);

console.log('\ncontinuation — the renderer keys off the shift');
const jjk = cases['subtitled 16:9, gpu canvas'];
const at = (shift) => buildRendererSpec({
  profile: { ...jjk.profile, overlayPipe: true }, selection: jjk.selection,
  srcPath: jjk.srcPath, shift, duration: jjk.duration,
  extractedPath: jjk.extractedPath, fontsDir: jjk.fontsDir,
});
check('subtitle clock shifts', at(123.456).spec.filters[0].includes('PTS+123.456/TB'), true);
check('base cap shrinks with the shift',
  Number(at(100).spec.inputs[at(100).spec.inputs.indexOf('-t') + 1])
    < Number(at(0).spec.inputs[at(0).spec.inputs.indexOf('-t') + 1]), true);
check('no shift means clip start', at(0).spec.filters[0].includes('PTS+0.000/TB'), true);

console.log('\nperformance interior — the regression that hit the N100');
/**
 * A subtitle-only clip must not pay for capabilities it is not using: the
 * pipe's FORMAT stays full-rect (a later picture must fit anywhere without
 * a restart), but the rate halves when nothing moves and the rasterise
 * happens at band height when a band applies. Full-rect at full rate is
 * what took Mr. Robot on the N100 from 1.03x to 0.62x.
 */
{
  const mr = cases['subtitled 16:9, gpu canvas'];
  const band = { rect: { w: 1920, h: 1080 }, height: 420, y: 660,
    filter: "subtitles=filename='/cache/band.ass'" };
  const prof = { ...mr.profile, overlayPipe: true };
  const quiet = buildRendererSpec({
    profile: prof, selection: mr.selection, srcPath: mr.srcPath,
    shift: 0, duration: mr.duration, extractedPath: mr.extractedPath,
    subBand: band,
  });
  check('no motion -> the pipe runs at HALF rate', quiet.rate, '24000/2002');
  check('band applies -> rasterise at band height',
    quiet.spec.inputs.join(' ').includes('s=1920x420'), true);
  check('band interior pads into the full-rect format',
    quiet.spec.filters.join(';').includes('pad=1920:1080:0:660'), true);
  check('but the pipe FORMAT stays full-rect',
    `${quiet.width}x${quiet.height}`, '1920x1080');

  // An apply that adds a picture: format pinned, interior re-planned.
  const pin = { rect: quiet.rect, eff: quiet.eff, wide: quiet.wide,
    width: quiet.width, height: quiet.height, rate: quiet.rate, fps: quiet.fps };
  const withPic = buildRendererSpec({
    profile: prof, selection: mr.selection, srcPath: mr.srcPath,
    shift: 120, duration: mr.duration, extractedPath: mr.extractedPath,
    subBand: band,
    overlayImages: [{ path: '/o/logo.png', x: 0.1, y: 0.1, size: 0.2, opacity: 1, enabled: true }],
    pin,
  });
  check('apply holds the pinned format',
    `${withPic.width}x${withPic.height}@${withPic.rate}`, '1920x1080@24000/2002');
  check('the band yields to the picture inside the renderer', withPic.band, false);
  check('the picture lands on the full canvas',
    /overlay/.test(withPic.spec.filters.join(';')), true);

  // Motion present at spawn plans full rate.
  const moving = buildRendererSpec({
    profile: prof, selection: mr.selection, srcPath: mr.srcPath,
    shift: 0, duration: mr.duration, extractedPath: mr.extractedPath,
    overlayImages: [{ path: '/o/logo.png', x: 0.1, y: 0.1, size: 0.2,
      opacity: 1, enabled: true, motion: 'bounce', speed: 0.1 }],
  });
  check('motion at spawn -> full rate', moving.rate, '24000/1001');
}

console.log('\nthe feed — continuous frame-aligned bytes across renderers');
const fifo = join(tmpdir(), `jsr-feed-test-${process.pid}.fifo`);
const feed = new OverlayFeed({ path: fifo, log: (m) => console.log('   ', m.trim()) });
/**
 * Reads are async with a deadline, never readSync: a blocking read on the
 * main thread cannot be interrupted by any timer, so a renderer that fails
 * to start would hang the whole test silently — which it did, when
 * -frames:v (an output option) was passed as an input option.
 */
const pull = (stream, n, ms = 20000) => new Promise((resolve, reject) => {
  const chunks = [];
  let got = 0;
  const t = setTimeout(() => {
    stream.off('data', onData);
    reject(new Error(`timed out waiting for ${n} bytes (got ${got})`));
  }, ms);
  const onData = (d) => {
    chunks.push(d);
    got += d.length;
    if (got >= n) {
      clearTimeout(t);
      stream.off('data', onData);
      stream.pause();
      resolve(Buffer.concat(chunks).subarray(0, n));
    }
  };
  stream.on('data', onData);
  stream.resume();
});
// `-t` bounds a lavfi INPUT; -frames:v does not exist on the input side.
const paint = (colour, frames) => rendererArgs({
  width: 4, height: 2, rate: 10, out: 'out',
  inputs: ['-f', 'lavfi', '-t', (frames / 10).toFixed(1), '-i',
    `color=c=${colour}:s=4x2:r=10,format=rgba`],
  filters: ['[0:v]null[out]'],
});
try {
  // 4x2 RGBA = 32 bytes per frame; three frames = 96 bytes.
  feed.resetSync({ width: 4, height: 2 });
  const rd = createReadStream(fifo, { highWaterMark: 1024 });
  feed.spawnRenderer(paint('red', 3));
  const first = await pull(rd, 96);
  check('renderer v1 delivers 3 aligned frames', first.length, 96);
  check('and they are red', first[0] > 200 && first[2] < 60, true);
  await feed.swap(paint('blue', 3));
  const second = await pull(rd, 96);
  check('swap appends v2 with no EOF between', second.length, 96);
  check('and v2 is blue', second[2] > 200 && second[0] < 60, true);
  check('the shared clock counts every frame', feed.frames, 6);
  rd.destroy();

  // Frame alignment across a mid-frame death: a renderer emitting 4x2
  // frames (32B) into a feed sized for 28B frames leaves a 4B overhang —
  // after it exits the feed must pad to the 28B boundary or every later
  // frame is sheared by the shortfall.
  feed.resetSync({ width: 1, height: 7 });
  const rd2 = createReadStream(fifo, { highWaterMark: 1024 });
  feed.spawnRenderer(paint('red', 1));   // 32 bytes into 28-byte frames
  const padded = await pull(rd2, 56);
  check('a misaligned renderer death is padded to the frame boundary',
    padded.length, 56);
  check('and the clock lands on whole frames', feed.frames, 2);
  check('the pad is transparent, not garbage',
    padded.subarray(32).every((b) => b === 0), true);
  rd2.destroy();
} finally {
  feed.stopSync();
  rmSync(fifo, { force: true });
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
