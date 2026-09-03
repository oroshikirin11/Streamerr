/**
 * A splice must start past every PICTURE the cushion holds, not past the
 * last frame it DECODED.
 *
 * Those are different instants whenever the source carries B-frames. A
 * cushion cut just after a reference frame holds pictures scheduled later
 * than anything decoded in it — measured on a real passthrough capture,
 * pts-dts ran to +0.25s. Anchoring the successor on the last DTS therefore
 * put it two frames INSIDE pictures already banked: pts 21.897 and 21.939
 * went out twice, which a receiver remuxes as "non monotonically increasing
 * dts to muxer" and settles by dropping or repeating pictures. That is the
 * unclean manual skip.
 *
 * Whether a given cut lands mid-pyramid is chance, which is exactly why the
 * fault was intermittent and why one skip in a test could look perfect.
 *
 * Run: node test/splice-base.test.mjs
 */
import { scanVideoPesIn, lastVideoPtsIn, PipelinePlayout } from '../src/ffmpeg/pipeline.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const near = (name, actual, expected, tol = 1e-4) => {
  if (actual != null && Math.abs(actual - expected) <= tol) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ~${expected}\n          actual   ${actual}`);
};

function putTs(p, at, T, marker) {
  p[at] = marker | (((T / 2 ** 30) & 7) << 1);
  p[at + 1] = (T / 2 ** 22) & 0xff;
  p[at + 2] = ((((T / 2 ** 15) & 0x7f) << 1) | 1) & 0xff;
  p[at + 3] = (T / 2 ** 7) & 0xff;
  p[at + 4] = (((T & 0x7f) << 1) | 1) & 0xff;
}

function packet(pid, pts90k, { pusi = true, af = false, dts90k = null } = {}) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = (af ? 0x30 : 0x10);
  let o = 4;
  if (af) { p[4] = 1; p[5] = 0x00; o = 6; }
  const both = dts90k != null;
  p[o] = 0; p[o + 1] = 0; p[o + 2] = 1; p[o + 3] = 0xe0;
  p[o + 4] = 0; p[o + 5] = 0;
  p[o + 6] = 0x80; p[o + 7] = both ? 0xc0 : 0x80; p[o + 8] = both ? 10 : 5;
  putTs(p, o + 9, pts90k, both ? 0x31 : 0x11);
  if (both) putTs(p, o + 14, dts90k, 0x11);
  return p;
}
const sec = (s) => Math.round(s * 90000);

console.log('\nreading both orders out of the bytes');

{
  const buf = Buffer.concat([
    packet(0x100, sec(1.0), { dts90k: sec(1.0) }),
    packet(0x100, sec(1.25), { dts90k: sec(1.0417) }),   // reference, shown later
    packet(0x100, sec(1.0834), { dts90k: sec(1.0834) }),
  ]);
  const f = scanVideoPesIn(buf);
  check('every video PES is reported, in byte order', f.map((x) => Math.round(x.pts * 1000)),
    [1000, 1250, 1083]);
  check('...each with its own decode time', f.map((x) => Math.round(x.dts * 1000)),
    [1000, 1042, 1083]);
  check('...and the offset it starts at', f.map((x) => x.at), [0, 188, 376]);
  // The two readers answer different questions, and both answers are needed.
  near('lastVideoPtsIn gives the DECODE frontier', lastVideoPtsIn(buf), 1.0834);
}

check('audio is not video', scanVideoPesIn(packet(0x101, sec(9))).length, 0);
check('a PTS-only PES reports pts as its own dts',
  scanVideoPesIn(packet(0x100, sec(4))).map((x) => [Math.round(x.pts), Math.round(x.dts)]),
  [[4, 4]]);
check('a torn grid ends the scan rather than guessing',
  scanVideoPesIn(Buffer.concat([packet(0x100, sec(2)), Buffer.alloc(188, 0x00)])).length, 1);

console.log('\nwhere the successor is allowed to start');

/** A playout carrying `chunks` as its cushion, published-aligned. */
const bankOf = (chunks, published = 0) => {
  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, { _fmt: 'ts', _bank: chunks.map((data) => ({ data })), _published: published });
  return p;
};

{
  // The shape that broke it: the cushion ends on a frame decoded at 1.0834,
  // but it is carrying a picture scheduled at 1.25.
  const cushion = Buffer.concat([
    packet(0x100, sec(1.0), { dts90k: sec(1.0) }),
    packet(0x100, sec(1.25), { dts90k: sec(1.0417) }),
    packet(0x100, sec(1.0834), { dts90k: sec(1.0834) }),
  ]);
  const p = bankOf([cushion]);
  near('the decode frontier under-reads by the reorder depth',
    p._bankTailVideoPts(), 1.0834);
  near('the last PICTURE is what the splice must clear',
    p._bankLastPictureTime(), 1.25);
}

{
  // No reordering: the two must agree exactly, or every unreordered stream
  // pays a gap it does not owe.
  const p = bankOf([Buffer.concat([
    packet(0x100, sec(5.0)), packet(0x100, sec(5.0417)), packet(0x100, sec(5.0834)),
  ])]);
  near('an unreordered stream is unaffected', p._bankLastPictureTime(), 5.0834);
  check('...and agrees with the decode frontier',
    p._bankLastPictureTime() === p._bankTailVideoPts(), true);
}

{
  // A splice can leave the bank with an internal 188-boundary step, so the
  // grid is computed per chunk. One offset for the whole concat read 314
  // frames out of a 3.5s cushion.
  const p = bankOf([
    Buffer.concat([Buffer.alloc(40, 0xff), packet(0x100, sec(2.0), { dts90k: sec(2.0) })]),
    packet(0x100, sec(2.5), { dts90k: sec(2.0417) }),
  ], 148);   // 148 + 40 = 188: the first chunk's packet starts on the grid
  near('the grid is taken per chunk from the published offset',
    p._bankLastPictureTime(), 2.5);
}

{
  // A chunk whose grid was torn scans as nothing. Understating here would
  // splice BEHIND bytes the publisher already holds, so the decode frontier
  // is the floor, never a lower guess.
  const p = bankOf([Buffer.alloc(376, 0x00)]);
  check('an unreadable cushion falls back rather than under-reads',
    p._bankLastPictureTime(), null);
}

{
  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, { _fmt: 'nut', _bank: [{ data: Buffer.alloc(10) }], _published: 0 });
  check('a NUT bank is not scanned as TS', p._bankLastPictureTime(), null);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
