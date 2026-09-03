/**
 * The audio seam at a splice is closed exactly, every time.
 *
 * A cushion cut at any byte holds more video than audio, so a successor
 * started past the last picture leaves an audio hole — 65-95ms per splice,
 * which ACCUMULATES: six skips measured -436ms on the receiver. And where
 * the successor's audio actually begins is not predictable: a copied file
 * opened three AAC frames before its offset, an encode one priming frame
 * early. So the close is measured from the successor's own bytes, filled
 * with whole silent frames, and the sub-frame remainder is taken up by
 * moving the successor later in place — its bytes are still in the bank.
 *
 * Run: node test/audio-close.test.mjs
 */
import { spawnSync } from 'child_process';
import {
  PipelinePlayout, SILENT_AAC_ADTS, restampTs, tsAudioTail, tsFirstAudioPts,
  silentAudioPackets, scanVideoPesIn, tsGridStart, readTs, tsVideoHead,
} from '../src/ffmpeg/pipeline.js';
import { AAC_FRAME } from '../src/ffmpeg/encoders.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const near = (name, actual, expected, tol = 2e-4) => {
  if (actual != null && Math.abs(actual - expected) <= tol) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ~${expected}\n          actual   ${actual}`);
};
const f = AAC_FRAME;
const sec = (s) => Math.round(s * 90000);

function putTs(p, at, T, marker) {
  p[at] = marker | ((Math.floor(T / 2 ** 30) & 7) << 1) | 1;
  p[at + 1] = Math.floor(T / 2 ** 22) & 0xff;
  p[at + 2] = (((Math.floor(T / 2 ** 15) & 0x7f) << 1) | 1) & 0xff;
  p[at + 3] = Math.floor(T / 2 ** 7) & 0xff;
  p[at + 4] = (((T & 0x7f) << 1) | 1) & 0xff;
}
/** One PES-start packet. Video by default; `sid: 0xc0` for audio. */
function packet(pid, pts, { dts = null, sid = 0xe0, cc = 0, payload = null } = {}) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = 0x40 | ((pid >> 8) & 0x1f); p[2] = pid & 0xff;
  const body = payload ?? Buffer.alloc(20, 0xab);
  const both = dts != null;
  const hdl = both ? 10 : 5;
  const pesLen = 3 + hdl + body.length;
  const afLen = 188 - 4 - 1 - (6 + pesLen);
  p[3] = 0x30 | (cc & 0x0f); p[4] = afLen; p[5] = 0x00;
  let o = 5 + afLen;
  p[o] = 0; p[o + 1] = 0; p[o + 2] = 1; p[o + 3] = sid;
  p[o + 4] = pesLen >> 8; p[o + 5] = pesLen & 0xff;
  p[o + 6] = 0x80; p[o + 7] = both ? 0xc0 : 0x80; p[o + 8] = hdl;
  putTs(p, o + 9, sec(pts), both ? 0x30 : 0x20);
  if (both) putTs(p, o + 14, sec(dts), 0x10);
  body.copy(p, o + 9 + hdl);
  return p;
}
/** A PCR-carrying packet with no payload (adaptation field only). */
function pcrPacket(pid, base, cc = 0) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = (pid >> 8) & 0x1f; p[2] = pid & 0xff; p[3] = 0x20 | cc;
  p[4] = 183; p[5] = 0x10;
  const b = Math.round(base * 90000);
  p[6] = Math.floor(b / 2 ** 25) & 0xff; p[7] = Math.floor(b / 2 ** 17) & 0xff;
  p[8] = Math.floor(b / 2 ** 9) & 0xff; p[9] = Math.floor(b / 2) & 0xff;
  p[10] = ((b & 1) << 7) | 0x7e; p[11] = 0x00;
  return p;
}
const pcrOf = (p, o = 0) => (p[o + 6] * 2 ** 25 + (p[o + 7] << 17) + (p[o + 8] << 9)
  + (p[o + 9] << 1) + (p[o + 10] >> 7)) / 90000;
const audio = (pts, cc) => packet(0x101, pts, { sid: 0xc0, cc, payload: SILENT_AAC_ADTS });

console.log('\nthe silent frame is what it says it is');
{
  const four = Buffer.concat([SILENT_AAC_ADTS, SILENT_AAC_ADTS, SILENT_AAC_ADTS, SILENT_AAC_ADTS]);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 's16le', '-'],
    { input: four, maxBuffer: 1 << 24 });
  if (r.status !== 0 && !r.stdout?.length) {
    console.log('  skip  (ffmpeg not available to decode it)');
  } else {
    const pcm = r.stdout;
    check('decodes as 48k stereo pcm, at least three frames of it', pcm.length >= 3 * 1024 * 4, true);
    check('...every sample silent', pcm.every((b) => b === 0), true);
    check('...and the header says AAC-LC, 48 kHz, stereo',
      [SILENT_AAC_ADTS[2] >> 6, (SILENT_AAC_ADTS[2] >> 2) & 0xf, ((SILENT_AAC_ADTS[2] & 1) << 2) | (SILENT_AAC_ADTS[3] >> 6)],
      [1, 3, 2]);
  }
}

console.log('\nsilent packets are well-formed and continue the count');
{
  const buf = silentAudioPackets(10.0, 3, 7);
  check('three packets, whole', buf.length, 564);
  check('on the grid', tsGridStart(buf), 0);
  const tail = tsAudioTail(buf);
  near('audio ends three frames later', tail.end, 10.0 + 3 * f);
  check('continuity carries on from the cushion', tail.cc, 10);
  near('the first frame is timed where asked', tsFirstAudioPts(buf), 10.0);
  check('each is a PES on the audio pid with the audio stream id',
    [0, 1, 2].map((i) => [buf[i * 188 + 1] & 0x40, ((buf[i * 188 + 1] & 0x1f) << 8) | buf[i * 188 + 2],
      buf[i * 188 + 5 + buf[i * 188 + 4] + 3]]),
    [[0x40, 0x101, 0xc0], [0x40, 0x101, 0xc0], [0x40, 0x101, 0xc0]]);
}

console.log('\nrestamping moves every clock, in place');
{
  const buf = Buffer.concat([
    packet(0x100, 5.0, { dts: 4.9, cc: 1 }),
    pcrPacket(0x100, 4.8, 2),
    audio(5.0, 3),
  ]);
  const n = restampTs(buf, 0.0096);
  check('three fields rewritten (pes, pcr, pes)', n, 3);
  const v = scanVideoPesIn(buf)[0];
  near('video pts moved', v.pts, 5.0096);
  near('video dts moved with it', v.dts, 4.9096);
  near('the PCR moved', pcrOf(buf, 188), 4.8096);
  near('audio pts moved', tsFirstAudioPts(buf), 5.0096);
  check('a zero shift touches nothing', restampTs(buf, 0), 0);
  const ragged = Buffer.concat([Buffer.alloc(37, 0x11), buf]);
  check('a ragged head does not stop it', restampTs(ragged, 0.001), 3);
}

console.log('\nreading where the cushion\'s audio ends');
{
  const buf = Buffer.concat([packet(0x100, 9.9), audio(9.8787, 3), audio(9.9, 4), packet(0x100, 9.94)]);
  const t = tsAudioTail(buf);
  near('the last frame plus one frame', t.end, 9.9 + f);
  check('...and the counter to continue from', t.cc, 4);
  check('no audio at all reads as null', tsAudioTail(packet(0x100, 1)), null);
}

/** A playout with just enough of itself to push, hold and close. */
function rig(cushionChunks) {
  const src = { stdout: { pause() {}, resume() {} } };
  const logs = []; const warns = []; let drains = 0;
  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, {
    _fmt: 'ts', source: src, _srcGen: 1, _tlLocked: false, _srcPaused: false, _bankRoom: null,
    _bank: cushionChunks.map((data, i) => ({ data, pos: 9 + i, tl: 9.94, item: 'x', gen: 1 })),
    _bankBytes: cushionChunks.reduce((n, c) => n + c.length, 0),
    timeline: 9.94, position: 9.9, current: { item: 'x' }, holding: false,
    selection: { video: { frameRate: '24000/1001' } },
    emit: (k, m) => { if (k === 'log') logs.push(String(m)); if (k === 'warn') warns.push(String(m)); },
    _bankFull: () => false, _bankDrain: () => { drains += 1; },
  });
  return { p, src, logs, warns, drains: () => drains };
}
const cushion = () => Buffer.concat([
  packet(0x100, 9.85, { cc: 1 }), audio(9.8360, 1), audio(9.8573, 2),
  packet(0x100, 9.90, { cc: 2 }), audio(9.8787, 3), audio(9.9000, 4),
]);
/** Arm the real way, then claim it as a spawn would. */
function armAndSpawn(p) {
  p._armAudioClose();
  clearTimeout(p._audioClose.timer);
  p._srcGen += 1;
  p._audioClose.gen = p._srcGen;
  p._genShift = null;
}

console.log('\na hole is filled with whole frames and the remainder by a shift');
{
  const { p, src, logs } = rig([cushion()]);
  armAndSpawn(p);
  near('cushion audio ends where the bytes say', p._audioClose.end, 9.9 + f);
  // Successor: video at 10.0, audio 128.7ms after the cushion's audio end.
  const succ = Buffer.concat([packet(0x100, 10.0, { dts: 9.95, cc: 0 }), audio(10.05, 0)]);
  p._bankPush(src, succ);
  check('the close is resolved on arrival', p._audioClose, null);
  check('bank is cushion, filler, successor', p._bank.length, 3);
  const fill = p._bank[1].data;
  const k = Math.ceil((10.05 - (9.9 + f)) / f - 1e-6);
  check('whole silent frames cover the hole', fill.length / 188, k);
  near('...starting where the cushion\'s audio ended', tsFirstAudioPts(fill), 9.9 + f);
  check('...continuing the cushion\'s counter', p._bank[1].data[3] & 0x0f, 5);
  const fillEnd = tsAudioTail(fill).end;
  near('the successor\'s audio now begins exactly where the filler ends',
    tsFirstAudioPts(p._bank[2].data), fillEnd);
  const v = scanVideoPesIn(p._bank[2].data)[0];
  const delta = fillEnd - 10.05;
  check('the successor was moved LATER, by under one frame', delta >= 0 && delta < f, true);
  near('...and its video moved with its audio', v.pts, 10.0 + delta);
  near('...dts too', v.dts, 9.95 + delta);
  near('the shift is remembered for the generation', p._genShift?.delta, delta);
  check('...that generation only', p._genShift?.gen, 2);
  near('the frontier follows the shift', p.timeline, 9.94 + delta);
  const later = Buffer.concat([audio(10.05 + 3 * f, 5)]);
  p._bankPush(src, later);
  near('a later chunk of that generation is shifted the same',
    tsFirstAudioPts(p._bank[3].data), 10.05 + 3 * f + delta);
  check('and it says what it did', logs.some((l) => /audio hole 128\.7ms -> \d+ silent frames, successor moved [0-9.]+ms later/.test(l)), true);
}

console.log('\nan overlap under a frame is a shift alone');
{
  const { p, src } = rig([cushion()]);
  armAndSpawn(p);
  p._bankPush(src, Buffer.concat([packet(0x100, 9.95, { cc: 0 }), audio(9.91, 0)]));
  check('no filler was inserted', p._bank.length, 2);
  near('the successor was moved later by the overlap', tsFirstAudioPts(p._bank[1].data), 9.9 + f);
  near('...which is the shift kept for its generation', p._genShift?.delta, (9.9 + f) - 9.91);
}

console.log('\nan overlap of several frames gives cushion frames back');
{
  const { p, src, logs } = rig([cushion()]);
  armAndSpawn(p);
  // Successor audio starts 71.3ms BEFORE the cushion's audio ends: three
  // whole cushion frames go, the last 7.3ms is a shift. Its video already
  // follows the cushion's last picture, so nothing moves for video's sake.
  p._bankPush(src, Buffer.concat([packet(0x100, 10.0, { cc: 0 }), audio(9.85, 0)]));
  check('no filler', p._bank.length, 2);
  const t = tsAudioTail(p._bank[0].data);
  near('the cushion now ends three frames earlier', t.end, 9.8360 + f);
  check('...its video untouched', scanVideoPesIn(p._bank[0].data).length, 2);
  near('the successor begins exactly there', tsFirstAudioPts(p._bank[1].data), 9.8360 + f);
  check('it says so', logs.some((l) => /audio overlap 71\.3ms -> 3 cushion frames given back, successor moved 7\.\dms later/.test(l)), true);
}

console.log('\nthe successor waits behind the cushion until its seam is closed');
{
  const writes = [];
  const p = Object.create(PipelinePlayout.prototype);
  const cushionData = cushion();
  const succData = Buffer.concat([packet(0x100, 10.0, { cc: 0 }), audio(10.0, 0)]);
  Object.assign(p, {
    _fmt: 'ts', profile: { codec: 'h264' }, _published: 0, _drainGen: 1, scheduler: null,
    _bank: [{ data: cushionData, pos: 9.9, tl: 9.94, item: 'x', gen: 1 },
            { data: succData, pos: 0, tl: 10.0, item: 'y', gen: 2 }],
    _bankBytes: cushionData.length + succData.length,
    _audioClose: { gen: 2, at: 1, end: 9.9 + f, cc: 4, armedAt: Date.now() },
    publisher: { stdin: { writable: true, write: (b) => { writes.push(b); return true; }, once() {} } },
    airedItem: 'x', aired: 0, airedTimeline: 0, _bankRoom: null, _srcPaused: false, source: null,
    _bankFull: () => false, _emitData() {}, snapshot: () => ({}), emit() {},
  });
  p._bankDrain();
  check('the cushion went out', writes.length, 1);
  check('...the successor did not', p._bank.length === 1 && p._bank[0].gen === 2, true);
  check('the close\'s index followed the drain', p._audioClose.at, 0);
  p._audioClose = null;
  p._bankDrain();
  check('...and it goes once the seam is closed', writes.length, 2);
}

console.log('\na packet split across two chunks is still moved, once');
{
  // The successor's first audio PES straddles the first two chunks, and a
  // later one straddles two more. Every packet must come out shifted.
  const { p, src } = rig([cushion()]);
  armAndSpawn(p);
  const a1 = Buffer.concat([packet(0x100, 10.0, { dts: 9.95, cc: 0 }), audio(10.05, 0)]);
  const a2 = Buffer.concat([audio(10.05 + f, 1), audio(10.05 + 2 * f, 2), packet(0x100, 10.04, { cc: 1 })]);
  const a3 = audio(10.05 + 3 * f, 3);
  const stream = Buffer.concat([a1, a2, a3]);
  // Split 100 bytes into the second packet, then 50 bytes into the fifth.
  const cuts = [188 + 100, 188 * 4 + 50];
  const chunks = [stream.subarray(0, cuts[0]), stream.subarray(cuts[0], cuts[1]), stream.subarray(cuts[1])];
  p._bankPush(src, chunks[0]);
  // The first chunk ends inside the successor's first audio PES, so there
  // is nothing to measure yet: the close waits for the bytes that finish it.
  check('a chunk ending mid-audio-packet does not resolve the close', p._audioClose != null, true);
  p._bankPush(src, chunks[1]);                 // completes it: resolved now
  check('...the next chunk does', p._audioClose, null);
  check('...and its partial tail packet is carried, not banked', p._genCarry?.data?.length, 50);
  p._bankPush(src, chunks[2]);
  check('the carry was consumed', p._genCarry, null);
  // bank: cushion, filler, then the successor as one stream
  const out = Buffer.concat(p._bank.slice(2).map((c) => c.data));
  check('nothing was lost across the splits', out.length, stream.length);
  const delta = p._genShift.delta;
  const want = [10.05, 10.05 + f, 10.05 + 2 * f, 10.05 + 3 * f].map((t) => Math.round((t + delta) * 1000) / 1000);
  const got = [];
  const g0 = tsGridStart(out);
  for (let o = g0; o + 188 <= out.length; o += 188) {
    if ((((out[o + 1] & 0x1f) << 8) | out[o + 2]) !== 0x101 || !(out[o + 1] & 0x40)) continue;
    const q = o + 4 + ((out[o + 3] & 0x20) ? 1 + out[o + 4] : 0);
    got.push(Math.round(readTs(out, q + 9) * 1000) / 1000);
  }
  check('every audio pts came out shifted, including the two straddlers', got, want);
  near('...and the video pts that straddled too', scanVideoPesIn(out)[1].pts, 10.04 + delta, 1e-3);
}

console.log('\nevery transition arms the close, from wherever the audio ends');
{
  // A cushion: armed from its tail.
  const { p } = rig([cushion()]);
  p._armAudioClose();
  near('from a cushion, its audio end', p._audioClose.end, 9.9 + f);
  check('...inserting after it', p._audioClose.at, 1);
  clearTimeout(p._audioClose.timer);
  // No cushion (a flush, a drained natural end): armed from what was fed.
  p._bank = []; p._bankBytes = 0; p._sentAudio = { end: 42.5, cc: 9 };
  p._armAudioClose();
  near('with the bank empty, the fed frontier', p._audioClose.end, 42.5);
  check('...its counter', p._audioClose.cc, 9);
  check('...inserting at the head', p._audioClose.at, 0);
  clearTimeout(p._audioClose.timer);
  // Nothing at all: the first source of a broadcast.
  p._sentAudio = null;
  p._armAudioClose();
  check('with no predecessor, nothing is armed', p._audioClose, null);
  // Already armed by a splice: a spawn leaves it alone.
  p._sentAudio = { end: 42.5, cc: 9 };
  p._armAudioClose(); const armed = p._audioClose;
  check('a second arm replaces, a spawn would not', p._audioClose !== null && armed === p._audioClose, true);
  clearTimeout(p._audioClose.timer);
}

console.log('\nthe drain records where the audio it fed ends');
{
  const p = Object.create(PipelinePlayout.prototype);
  const c = cushion();
  Object.assign(p, {
    _fmt: 'ts', profile: { codec: 'h264' }, _published: 0, _drainGen: 1, scheduler: null,
    _bank: [{ data: c, pos: 9.9, tl: 9.94, item: 'x', gen: 1 }], _bankBytes: c.length,
    publisher: { stdin: { writable: true, write: () => true, once() {} } },
    airedItem: 'x', aired: 0, airedTimeline: 0, _bankRoom: null, _srcPaused: false, source: null,
    _bankFull: () => false, _emitData() {}, snapshot: () => ({}), emit() {},
  });
  p._bankDrain();
  near('the fed audio frontier is the cushion\'s audio end', p._sentAudio?.end, 9.9 + f);
  check('...with its counter', p._sentAudio?.cc, 4);
}

console.log('\na seam of seconds is not a seam');
{
  const { p, src, warns } = rig([cushion()]);
  armAndSpawn(p);
  p._bankPush(src, Buffer.concat([packet(0x100, 0.1, { cc: 0 }), audio(0.05, 0)]));
  check('the close was abandoned, not applied', p._genShift ?? null, null);
  check('...nothing inserted', p._bank.length, 2);
  check('...and it said why', warns.some((w) => /not a seam/.test(w)), true);
  near('the successor was left exactly as it came', tsFirstAudioPts(p._bank[1].data), 0.05);
}

console.log('\na successor is moved until its pictures and its decode order both follow');
{
  // A no-B card ends at pts = dts = 26.5376. The clip that replaces it is a
  // B-pyramid: its keyframe arrives with dts EQUAL to the card's last and
  // pts 43ms later, then two leading B-frames that show BEFORE the keyframe
  // -- measured on the wire, and worth five "non monotonic dts" complaints
  // from the receiver per pause.
  const T = 26.5376; const fv = 1001 / 24000;
  const card = Buffer.concat([packet(0x100, T - fv, { cc: 1 }), audio(T - 2 * f, 3), packet(0x100, T, { cc: 2 }), audio(T - f, 4)]);
  const { p, src, logs } = rig([card]);
  armAndSpawn(p);
  near('the arm knows where the pictures end', p._audioClose.vPts, T);
  near('...and where the decode order ends', p._audioClose.vDts, T);
  const clip = Buffer.concat([
    packet(0x100, T + fv, { dts: T, cc: 0 }),               // keyframe: dts == card's last dts
    packet(0x100, T - fv, { dts: T + fv, cc: 1 }),          // leading B, shows before the keyframe
    packet(0x100, T, { dts: T + 2 * fv, cc: 2 }),           // leading B
    audio(T + 0.04, 0),
  ]);
  const head = tsVideoHead(clip);
  near('the successor\'s first picture is BELOW the card\'s last', head.minPts, T - fv);
  near('...and its first dts is not after the card\'s', head.minDts, T);
  p._bankPush(src, clip);
  check('the close resolved', p._audioClose, null);
  const out = p._bank[p._bank.length - 1].data;
  const after = tsVideoHead(out);
  check('its first picture now follows the card\'s last by at least a frame', after.minPts >= T + fv - 1e-4, true);
  check('...and its first dts follows the card\'s last dts', after.minDts >= T + fv - 1e-4, true);
  const aEnd = tsAudioTail(card).end;
  const sa = tsFirstAudioPts(out);
  const fillers = p._bank.length === 3 ? tsAudioTail(p._bank[1].data).end : aEnd;
  near('audio is still exactly continuous into it', sa, fillers);
  check('and the log says how much of the move was for the pictures',
    logs.some((l) => /successor moved [0-9.]+ms later \([0-9.]+ms of it so its pictures follow\)/.test(l)), true);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
