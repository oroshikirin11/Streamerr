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

/** One 188-byte TS packet: PUSI, given pid, PES header carrying `pts90k`. */
function packet(pid, pts90k, { pusi = true, af = false } = {}) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  p[3] = (af ? 0x30 : 0x10);
  let o = 4;
  if (af) { p[4] = 1; p[5] = 0x00; o = 6; }
  // PES: start code, stream id, length, marker, PTS-only flags, header len
  p[o] = 0; p[o + 1] = 0; p[o + 2] = 1; p[o + 3] = 0xe0;
  p[o + 4] = 0; p[o + 5] = 0;
  p[o + 6] = 0x80; p[o + 7] = 0x80; p[o + 8] = 5;
  const T = pts90k;
  p[o + 9] = 0x21 | (((T / 2 ** 30) & 7) << 1);
  p[o + 10] = (T / 2 ** 22) & 0xff;
  p[o + 11] = ((((T / 2 ** 15) & 0x7f) << 1) | 1) & 0xff;
  p[o + 12] = (T / 2 ** 7) & 0xff;
  p[o + 13] = (((T & 0x7f) << 1) | 1) & 0xff;
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

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
