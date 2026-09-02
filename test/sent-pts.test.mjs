/**
 * The sent-frontier parser: lastVideoPtsIn reads the last video PES pts
 * out of drained TS bytes, and every flush/cut splice now anchors its
 * -output_ts_offset on what it returns. A wrong read here is a backward
 * pts jump on the wire — the pause/resume discontinuity storm — so the
 * bit-level decode is pinned against hand-built packets.
 *
 * Run: node test/sent-pts.test.mjs
 */
import { lastVideoPtsIn } from '../src/ffmpeg/pipeline.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

/** Write one 33-bit timestamp field at `at`. */
function putTs(p, at, T, marker) {
  p[at] = marker | (((T / 2 ** 30) & 7) << 1);
  p[at + 1] = (T / 2 ** 22) & 0xff;
  p[at + 2] = ((((T / 2 ** 15) & 0x7f) << 1) | 1) & 0xff;
  p[at + 3] = (T / 2 ** 7) & 0xff;
  p[at + 4] = (((T & 0x7f) << 1) | 1) & 0xff;
}

/**
 * One 188-byte TS packet: PUSI, given pid, PES header carrying `pts90k`
 * and — when `dts90k` is given — a DTS field too, exactly as a reordered
 * (B-frame) stream carries both.
 */
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
  putTs(p, o + 9, pts90k, both ? 0x31 : 0x21);
  if (both) putTs(p, o + 14, dts90k, 0x11);
  return p;
}

console.log('\nsent-frontier pts parsing');

const sec = (s) => Math.round(s * 90000);

check('a lone video PES yields its pts',
  lastVideoPtsIn(packet(0x100, sec(123.456))),
  123.456);

check('the LAST of several wins',
  lastVideoPtsIn(Buffer.concat([
    packet(0x100, sec(10)), packet(0x100, sec(11)), packet(0x100, sec(12.5)),
  ])),
  12.5);

check('audio pids are not the video frontier',
  lastVideoPtsIn(Buffer.concat([packet(0x100, sec(20)), packet(0x101, sec(99))])),
  20);

check('adaptation-field packets parse too',
  lastVideoPtsIn(packet(0x100, sec(7), { af: true })),
  7);

check('a misaligned grid with the offset passed in',
  lastVideoPtsIn(Buffer.concat([Buffer.alloc(41, 0xab), packet(0x100, sec(30))]), 41),
  30);

check('a broken grid ends the scan at the last verified read',
  lastVideoPtsIn(Buffer.concat([packet(0x100, sec(40)), Buffer.alloc(188, 0x00)])),
  40);

check('no video PES at all is an honest null',
  lastVideoPtsIn(Buffer.concat([packet(0x101, sec(5)), packet(0x100, sec(6), { pusi: false })])),
  null);

check('an empty buffer is null', lastVideoPtsIn(Buffer.alloc(0)), null);

console.log('\nreordered streams (passthrough B-frames)');

// The frontier means "how far the stream has been WRITTEN", and only DTS
// says that: PTS is presentation order and B-frames reorder it (measured
// on a real passthrough capture, 166 of 399 successive PTS steps ran
// BACKWARD). Reading pts under-reads the frontier and can move it
// backward, splicing the next source behind bytes already sent — which
// stalls the publisher's pacer and rewinds the playhead with it.
check('a reordered PES yields its DTS, not its PTS',
  lastVideoPtsIn(packet(0x100, sec(10.5), { dts90k: sec(10.25) })),
  10.25);

{
  const frames = [[0, 0], [0.292, 0.041], [0.208, 0.083], [0.125, 0.125],
    [0.166, 0.166], [0.25, 0.208], [0.5, 0.25], [0.417, 0.292]];
  const run = Buffer.concat(frames.map(([pts, dts]) =>
    packet(0x100, sec(pts), { dts90k: sec(dts) })));
  check('a reordered run reports the LAST dts (the true frontier)',
    lastVideoPtsIn(run), 0.292);
  let last = -1; let monotonic = true;
  for (let n = 1; n <= frames.length; n += 1) {
    const v = lastVideoPtsIn(Buffer.concat(
      frames.slice(0, n).map(([pts, dts]) => packet(0x100, sec(pts), { dts90k: sec(dts) }))));
    if (v < last) monotonic = false;
    last = v;
  }
  check('the frontier never moves backward as the run grows', monotonic, true);
}

check('an adaptation field does not shift the dts read',
  lastVideoPtsIn(packet(0x100, sec(9), { dts90k: sec(8.75), af: true })),
  8.75);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
