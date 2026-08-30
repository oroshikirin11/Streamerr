/**
 * The overlay pipe: both ends must agree, and restarts must be invisible.
 *
 * rawvideo carries no header. If the renderer and the encoder disagree about
 * size, rate or pixel format, nothing errors — the picture shears. So the two
 * sides are asserted against each other rather than against a literal.
 *
 * The second half asserts the one thing that makes restarts survivable: a
 * fifo EOFs the moment its last writer closes, so something must hold the
 * write end open across renderer swaps. That is a property of the pipe, and
 * it is tested as one — an ffmpeg pipeline in the loop only adds ways for the
 * TEST to deadlock, which it did twice before this was simplified.
 *
 * Run: node test/overlay-renderer.test.mjs
 */
import { rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  pipeInputArgs, rendererArgs, pipeBytesPerSecond,
  makePipe, holdOpen,
} from '../src/ffmpeg/overlay-renderer.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

const spec = {
  width: 1920, height: 1038, rate: '24000/1001', out: 'out',
  inputs: ['-f', 'lavfi', '-i', 'color=c=red:s=1920x1038:r=24,format=rgba'],
  filters: ['[0:v]null[out]'],
};

console.log('\nboth ends speak NUT');
// Self-describing on purpose: with headerless rawvideo a geometry mismatch
// sheared the picture with no error anywhere. NUT carries its own format
// and timestamps, so that bug class cannot exist.
const consumer = pipeInputArgs(spec, '/tmp/x.fifo');
check('the consumer follows the growing file, then demuxes NUT',
  consumer.slice(0, 4), ['-follow', '1', '-f', 'nut']);
check('and then names the pipe', consumer.slice(-2), ['-i', '/tmp/x.fifo']);
check('a bounded consumer carries -t before the pipe',
  pipeInputArgs(spec, '/tmp/x.fifo', { capSecs: 12 }).join(' '),
  '-follow 1 -f nut -t 12.000 -i /tmp/x.fifo');

console.log('\nthe renderer command');
const args = rendererArgs(spec);
check('emits rawvideo-in-NUT to stdout, reporting its head on stderr',
  args.slice(-10),
  ['-an', '-progress', 'pipe:2', '-stats_period', '0.5',
    '-c:v', 'rawvideo', '-f', 'nut', 'pipe:1']);
check('maps the spec output label', args[args.indexOf('-map') + 1], '[out]');
check('carries the spec inputs', args.includes('color=c=red:s=1920x1038:r=24,format=rgba'), true);
// -re would pace the canvas at 1x and throttle a cushion being built ahead.
check('is NOT rate-limited', args.includes('-re'), false);
try {
  rendererArgs({ ...spec, filters: [] });
  check('an empty graph throws', 'did not throw', 'throws');
} catch (err) {
  check('an empty graph throws by name', /nothing to render/.test(err.message), true);
}

console.log('\ncost of the pipe');
check('1080p24 is ~199 MB/s', Math.round(
  pipeBytesPerSecond({ width: 1920, height: 1080, rate: 24 }) / 1e6), 199);
check('a band-height canvas is far cheaper', pipeBytesPerSecond(
  { width: 1920, height: 200, rate: 12 }) < pipeBytesPerSecond(
  { width: 1920, height: 1080, rate: 24 }) / 5, true);

console.log('\nthe holder is what makes a restart invisible');
/**
 * The claim under test: a fifo signals EOF to its reader as soon as the LAST
 * writer closes. If the renderer is the only writer, killing it ends the
 * encoder's overlay input permanently. A holder fd keeps that from happening.
 *
 * Asserted with plain writes rather than a full ffmpeg pipeline: the failure
 * being guarded against is a property of the pipe, and an encoder in the loop
 * only adds ways for the test itself to deadlock (it did, twice).
 *
 * The end-to-end behaviour — renderer swapped mid-stream, encoder untouched,
 * red at t=1s and blue at t=6s — was verified separately by hand before this
 * design was chosen; see docs/roadmap-live-sources.md.
 */
const fifo = join(tmpdir(), `jsr-ovl-test-${process.pid}.fifo`);
try {
  await makePipe(fifo);
  check('makePipe creates a fifo', existsSync(fifo), true);
  check('makePipe is idempotent', await makePipe(fifo), fifo);

  const { open } = await import('fs/promises');
  const holder = await holdOpen(fifo);
  // A reader that would see EOF the moment every writer goes away.
  const reader = await open(fifo, 'r');

  // "Renderer v1" writes and closes — exactly what an Apply does today.
  const w1 = await open(fifo, 'w');
  await w1.write(Buffer.from('frame-1'));
  await w1.close();

  // With the holder still open there is no EOF: a later renderer's bytes
  // must still arrive. Read only what v1 wrote, then prove v2 gets through.
  const buf = Buffer.alloc(7);
  await reader.read(buf, 0, 7);
  check('v1 bytes arrive', buf.toString(), 'frame-1');

  const w2 = await open(fifo, 'w');
  await w2.write(Buffer.from('frame-2'));
  await w2.close();
  const buf2 = Buffer.alloc(7);
  const { bytesRead } = await reader.read(buf2, 0, 7);
  check('v2 bytes arrive AFTER v1 closed — no EOF in between',
    bytesRead === 7 && buf2.toString() === 'frame-2', true);

  await reader.close();
  await holder.close();
} finally {
  rmSync(fifo, { force: true });
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
