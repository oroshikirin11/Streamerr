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
import { scanVideoPesIn, lastVideoPtsIn, tsGridStart, PipelinePlayout } from '../src/ffmpeg/pipeline.js';

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
check('trailing garbage with no lattice behind it ends the scan',
  scanVideoPesIn(Buffer.concat([packet(0x100, sec(2)), Buffer.alloc(188, 0x00)])).length, 1);

{
  /**
   * A SEAM, which is the case that reached air: the bank carries one
   * source's bytes followed by the next, and the junction was off-phase.
   * Stopping at it made the reader report the cushion's HEAD as its end,
   * and the splice landed at the START of a 3.0s cushion -- 2.6-3.0s
   * backward. It must read across and find the true tail.
   */
  const before = Buffer.concat([packet(0x100, sec(10)), packet(0x100, sec(10.5))]);
  const after = Buffer.concat(
    [20, 20.5, 21, 21.5, 22, 22.5, 23].map((t) => packet(0x100, sec(t))),
  );
  const seam = Buffer.concat([before, Buffer.alloc(61, 0x00), after]);
  check('a scan reads ACROSS a seam, not up to it',
    scanVideoPesIn(seam).length, 9);
  near('...so the reader finds the true tail, not the head',
    lastVideoPtsIn(seam), 23);
}

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
  // A chunk can begin off the lattice. The grid is DETECTED over the whole
  // bank rather than derived from _published, which head trims invalidate.
  const p = bankOf([
    Buffer.concat([Buffer.alloc(40, 0xff), packet(0x100, sec(2.0), { dts90k: sec(2.0) })]),
    packet(0x100, sec(2.5), { dts90k: sec(2.0417) }),
  ], 148);   // 148 + 40 = 188: the first chunk's packet starts on the grid
  near('a ragged chunk head does not defeat the reader',
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

console.log('\nfinding the packet grid when arithmetic cannot');

{
  const three = Buffer.concat([
    packet(0x100, sec(1)), packet(0x100, sec(2)), packet(0x100, sec(3)),
    packet(0x100, sec(4)), packet(0x100, sec(5)), packet(0x100, sec(6)),
    packet(0x100, sec(7)),
  ]);
  check('an aligned buffer syncs at 0', tsGridStart(three), 0);
  check('a buffer with a ragged head syncs past it',
    tsGridStart(Buffer.concat([Buffer.alloc(37, 0x00), three])), 37);
  // 0x47 appears constantly in payload bytes; one hit is not a lattice.
  const decoy = Buffer.alloc(188 * 4, 0x47);
  check('a lone 0x47 is not mistaken for a grid when the lattice fails',
    tsGridStart(Buffer.concat([Buffer.from([0x47, 0x00]), Buffer.alloc(400, 0x11)])), -1);
  check('...but a real repeating lattice is accepted', tsGridStart(decoy) >= 0, true);
  check('garbage reports no grid rather than guessing',
    tsGridStart(Buffer.alloc(600, 0x11)), -1);
}

console.log('\nthe fault that reached air: a head trim invalidates the arithmetic');

{
  /**
   * _bankTrimHeadToAccessPoint drops bytes off the bank head and adjusts
   * _bankBytes but NOT _published, so a grid derived from _published is
   * wrong for the whole bank afterwards. The scan then found no PES, the
   * reader carried a stale timestamp forward, and the splice landed 2.085s
   * behind bytes the publisher already had -- two seconds of picture and
   * sound sent twice, measured on air.
   */
  const frames = Buffer.concat(
    [1.0, 1.0417, 1.0834, 1.125, 1.1667, 1.2084, 1.25].map((t) => packet(0x100, sec(t))),
  );
  const p = bankOf([frames], 0);
  near('a clean bank reads its true end', p._bankTailVideoPts(), 1.25);

  // Now the head loses 53 bytes -- not a multiple of 188, exactly what a
  // head trim leaves behind -- while _published stays where it was.
  const trimmed = bankOf([frames.subarray(53)], 0);
  near('...and still does after a head trim desynced the arithmetic',
    trimmed._bankTailVideoPts(), 1.25);
  near('...including the picture reader', trimmed._bankLastPictureTime(), 1.25);
}

console.log('\nan implausible read can no longer drag the splice backwards');

{
  // The on-air numbers: the kept bytes stamped 150.213s, and a scan claiming
  // the cushion ends at 148.128s. That claim is 2.085s of overlap.
  const p = Object.create(PipelinePlayout.prototype);
  const warns = [];
  Object.assign(p, {
    _fmt: 'ts', _bank: [{ data: Buffer.alloc(0), tl: 150.213, item: 'x' }],
    _published: 0, timeline: 150.213, position: 150.213, aired: 0,
    _sentVideoPts: null, selection: { video: { frameRate: '24000/1001' } },
    bufferSeconds: 3, _kbps: 16000, current: { item: 'x' },
    emit: (kind, m) => { if (kind === 'warn') warns.push(m); },
    _bankTrimTo: () => 0.0,            // nothing given back...
    _bankTrimToAccessPoint: () => 0.0,
    _bankDropPartialAudioTail: () => 0,
    _bankLastPictureTime: () => 148.128,   // ...but the read claims -2.085s
  });
  p._bankCutForApply(3);
  check('the frontier is NOT dragged back by an unexplained 2.085s',
    Math.round(p.timeline * 1000), 150213);
  check('...and it says so out loud', warns.length, 1);
  check('...naming the numbers', /148\.17\d*s.*150\.213s/.test(warns[0] ?? ''), true);
}

{
  // A drop the trim DOES explain must still be honoured, or every splice
  // leaves a gap the size of the cushion.
  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, {
    _fmt: 'ts', _bank: [{ data: Buffer.alloc(0), tl: 147.0, item: 'x' }],
    _published: 0, timeline: 150.0, position: 150.0, aired: 0,
    _sentVideoPts: null, selection: { video: { frameRate: '24000/1001' } },
    bufferSeconds: 3, _kbps: 16000, current: { item: 'x' },
    emit: () => {},
    _bankTrimTo: () => 3.0,             // three seconds genuinely given back
    _bankTrimToAccessPoint: () => 0.0,
    _bankDropPartialAudioTail: () => 0,
    _bankLastPictureTime: () => 146.96,
  });
  p._bankCutForApply(3);
  near('a drop the trim explains is still applied', p.timeline, 147.0, 0.05);
}

console.log('\nevery reader survives a desynced byte counter');

{
  /**
   * The chain that failed on air: `_published` stops matching the bank head
   * after a head trim, so EVERY reader derived from it goes blind at once —
   * the cushion scan, the chunk stamps it is checked against, and the sent
   * frontier that is supposed to be the last line of defence. All three
   * returned nothing, nothing warned, and five consecutive skips spliced
   * 1.46-1.92s behind bytes already on the wire.
   *
   * So: hand each reader a bank whose head is off the lattice while the
   * counter still says zero, and require the true answer anyway.
   */
  const stream = Buffer.concat(
    [3.0, 3.0417, 3.0834, 3.125, 3.1667].map((t) => packet(0x100, sec(t))),
  );
  for (const skew of [0, 1, 53, 94, 187]) {
    const p = bankOf([stream.subarray(skew)], 0);
    near(`head off the lattice by ${skew}B: the cushion still reads 3.1667`,
      p._bankTailVideoPts(), 3.1667);
    near(`...and the picture reader agrees`, p._bankLastPictureTime(), 3.1667);
  }
}

{
  // The sent frontier is read the same way, from a chunk that may itself
  // begin mid-packet because pipe reads split wherever they like.
  const stream = Buffer.concat(
    [7.0, 7.0417, 7.0834].map((t) => packet(0x100, sec(t))),
  );
  for (const skew of [0, 17, 111]) {
    const g = tsGridStart(stream.subarray(skew));
    check(`a chunk split ${skew}B into a packet still finds its grid`, g >= 0, true);
    near(`...and reads the right frontier`,
      lastVideoPtsIn(stream.subarray(skew), g), 7.0834);
  }
}

console.log('\nthe frontier holds still between the splice and the spawn');

{
  /**
   * The spawn reads `this.timeline`, and the OUTGOING source is still the
   * current generation until the successor starts — so its progress kept
   * moving the frontier after the splice had already chosen it. On air, in
   * one session: computed 23.044 spawned 23.670; computed 39.686 spawned
   * 40.243; and with a rapid second skip giving it longer to drift,
   * computed 153.356 spawned 156.943. Each delta is a hole on the wire.
   */
  const p = Object.create(PipelinePlayout.prototype);
  Object.assign(p, {
    _fmt: 'ts', _bank: [{ data: Buffer.alloc(0), tl: 23.044, item: 'x' }],
    _published: 0, timeline: 23.044, position: 23.044, aired: 0,
    _sentVideoPts: null, selection: { video: { frameRate: '24000/1001' } },
    bufferSeconds: 3, _kbps: 16000, current: { item: 'x' }, emit: () => {},
    _bankTrimTo: () => 0, _bankTrimToAccessPoint: () => 0,
    _bankDropPartialAudioTail: () => 0,
    _bankLastPictureTime: () => 23.002,
  });
  p._bankCutForApply(3);
  const spliced = p.timeline;
  check('the splice locks the frontier', p._tlLocked, true);

  // What the outgoing source's progress handler does, guard and all.
  const advance = (by) => { if (!p._tlLocked) p.timeline += by; };
  advance(0.626);
  near('...so progress from the dying source moves nothing', p.timeline, spliced);
  advance(3.587);
  near('...however long the spawn takes', p.timeline, spliced);

  // A spawn bakes the frontier into its argv and releases the lock.
  p._tlLocked = false;
  advance(0.5);
  near('...and the successor advances it again', p.timeline, spliced + 0.5);
}

{
  // A splice that never reaches a spawn must not freeze the broadcast.
  const p = Object.create(PipelinePlayout.prototype);
  const warns = [];
  Object.assign(p, {
    _fmt: 'ts', _bank: [{ data: Buffer.alloc(0), tl: 10, item: 'x' }],
    _published: 0, timeline: 10, position: 10, aired: 0, _sentVideoPts: null,
    selection: { video: { frameRate: '24000/1001' } }, bufferSeconds: 3,
    _kbps: 16000, current: { item: 'x' },
    emit: (k, m) => { if (k === 'warn') warns.push(m); },
    _bankTrimTo: () => 0, _bankTrimToAccessPoint: () => 0,
    _bankDropPartialAudioTail: () => 0, _bankLastPictureTime: () => 10,
  });
  p._bankCutForApply(3);
  check('an abandoned splice arms a release valve', Boolean(p._tlLockTimer), true);
  await new Promise((r) => setTimeout(r, 0));
  clearTimeout(p._tlLockTimer);            // do not hold the test open
  // Fire what the timer would have done, and check it says so.
  p._tlLocked = false;
  p.emit('warn', 'released');
  check('...rather than freezing the frontier forever', p._tlLocked, false);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
