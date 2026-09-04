/**
 * Regression tests for a batch of engine fixes. Each test is a distilled
 * reproduction of a bug that was observed against the real engine:
 *
 *  - a hardware-decode demotion that the retry forgot (looped forever)
 *  - stop() during start()'s awaits leaving the engine 'starting' forever
 *  - the watchdog not re-armed after an offline break
 *  - a sidecar for "Episode 1" claiming "Episode 10.eng.srt"
 *  - the copy-seek landing probe un-pausing a paused broadcast
 *  - forced subtitle mode ignoring language aliases ('en' vs 'eng')
 *  - the "copied anyway because it is HDR" warning that could never fire
 *
 * Run: node --test test/engine-fixes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PipelinePlayout, buildSourceArgs, buildHoldArgs, buildCountdownArgs,
  planOverlayPipe, passthroughEligible,
} from '../src/ffmpeg/pipeline.js';
import { findSidecarSubtitles, selectTracks } from '../src/ffmpeg/tracks.js';

const gpuProfile = {
  backend: 'vaapi', device: '/dev/dri/renderD128', width: 1920, height: 1080,
  fps: 30, fpsMode: 'auto', videoBitrate: '6000k', audioBitrate: '160k',
  gopSeconds: 2, gpuFull: true, gpuSubs: true, tonemap: 'vaapi', codec: 'h264',
  frameSize: 'fixed', overlay: [],
};
const cpuProfile = {
  backend: 'x264', width: 1920, height: 1080, fps: 30, videoBitrate: '6000k',
  audioBitrate: '160k', gopSeconds: 2, codec: 'h264', frameSize: 'fixed', overlay: [],
};
const sdrVideo = { width: 1920, height: 1080, codec: 'vp9', pixFmt: 'yuv420p', frameRate: '24000/1001', sar: '1:1', hdr: false };
const fakePublisher = () => ({ stdin: { writable: true, write() { return true; } } });

/** An engine whose source spawns are recorded instead of run. */
function rig(profile, selection) {
  const e = new PipelinePlayout({ target: 'rtmp://x/y/key123456', profile, selection });
  e.spawned = [];
  e._spawnSource = (args, opts = {}) => { e.spawned.push({ args, kind: opts.kind, status: e.status }); };
  e._prefetchUpcoming = () => {};
  e.publisher = fakePublisher();
  e.status = 'running';
  return e;
}

test('hwaccel demotion survives the retry (it rebuilds the profile from the box)', () => {
  const e = rig(gpuProfile, { video: sdrVideo, audio: { typeIndex: 0 }, subtitle: null });
  const item = { id: 'a', title: 'A', srcPath: '/nonexistent.mkv', duration: 100 };
  e._play(item, 0, { duration: 100 });
  assert.ok(e.spawned[0].args.includes('-hwaccel'), 'first attempt decodes on the GPU');

  // What the source close handler now does on "hwaccel initialisation returned error".
  e._demote({ swDecode: true });
  e._play(item, e.position, { duration: 100 });
  assert.equal(e.profile.swDecode, true);
  assert.ok(!e.spawned[1].args.includes('-hwaccel'), 'retry decodes in software');
  assert.notEqual(JSON.stringify(e.spawned[0].args), JSON.stringify(e.spawned[1].args));

  // A write to the live profile alone (the old handler's action) persists too.
  const f = rig(gpuProfile, { video: sdrVideo, audio: { typeIndex: 0 }, subtitle: null });
  f._play(item, 0, { duration: 100 });
  f.profile.swDecode = true;
  f._play(item, 0, { duration: 100 });
  assert.ok(!f.spawned[1].args.includes('-hwaccel'));

  // Per clip: the next clip gets a clean GPU try.
  e._rearmGpu();
  assert.equal(e.profile.swDecode, undefined);
  assert.equal(e._box.swDecode, undefined);
  e._play({ id: 'b', title: 'B', srcPath: '/b.mkv', duration: 100 }, 0, { duration: 100 });
  assert.ok(e.spawned[2].args.includes('-hwaccel'));
});

test('stop() while start() is warming ends the broadcast cleanly', async () => {
  const e = new PipelinePlayout({ target: 'rtmp://x/y/key123456', profile: cpuProfile, selection: { video: null, audio: { typeIndex: 0 }, subtitle: null } });
  let sources = 0; let publishers = 0; let ended = false;
  const statuses = [];
  e._spawnSource = () => { sources++; };
  e._spawnPublisher = () => { publishers++; e.publisher = {}; };
  e._measureGop = async () => null;
  e._prepareTcpBridges = async () => {};
  e._prefetchUpcoming = () => {};
  e.on('ended', () => { ended = true; });
  e.on('status', (s) => statuses.push(s));
  const p = e.start([{ id: 'a', title: 'A', srcPath: '/nonexistent.mkv', duration: 100 }]);
  e.stop();   // while start() awaits _warm()
  await p;
  assert.equal(e.status, 'stopped');
  assert.deepEqual(statuses, ['preparing', 'stopped']);
  assert.equal(ended, true);
  assert.equal(sources, 0, 'no source is spawned into a stopped engine');
  assert.equal(publishers, 0);
  assert.equal(e._watch, null, 'no watchdog left ticking');
  assert.equal(e.current, null);
});

test('stop() while start() is stuck preparing ends the broadcast at once', async () => {
  const e = new PipelinePlayout({ target: 'rtmp://x/y/key123456', profile: cpuProfile, selection: { video: null, audio: { typeIndex: 0 }, subtitle: null } });
  let sources = 0; let endedAt = 0;
  e._spawnSource = () => { sources++; };
  e._spawnPublisher = () => { e.publisher = {}; };
  e._measureGop = async () => null;
  e._prepareTcpBridges = async () => {};
  e._prefetchUpcoming = () => {};
  e._warm = () => new Promise(() => {});   // never returns
  e.on('ended', () => { endedAt++; });
  e.start([{ id: 'a', title: 'A', srcPath: '/nonexistent.mkv', duration: 100 }]);
  await new Promise((r) => setTimeout(r, 20));
  e.stop();
  assert.equal(e.status, 'stopped', 'stop() does not wait for start() to notice');
  assert.equal(endedAt, 1);
  assert.equal(sources, 0);
  assert.equal(e.current, null);
  e._abortStart();
  assert.equal(endedAt, 1, 'a late start() checkpoint does not end it twice');
});

test('resuming from an offline break re-arms the watchdog', async () => {
  const e = new PipelinePlayout({ target: 'rtmp://x/y/key123456', profile: cpuProfile, selection: null });
  e._spawnPublisher = () => { e.publisher = {}; };
  e._advance = () => {};
  e._warm = async () => {};
  e.queue = [{ id: 'b', title: 'B', srcPath: '/x.mkv' }];
  // State after the publisher's close handler ran during the break.
  e._watch = null;
  e._break = { until: Date.now() / 1000, timer: null };
  e.status = 'break';
  await e._resumeFromBreak();
  assert.equal(e.status, 'starting');
  assert.ok(e.publisher);
  assert.ok(e._watch != null, 'watchdog armed');
  clearInterval(e._watch);
});

test('a sidecar must match the whole stem, not a prefix of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  try {
    for (const f of ['Episode 1.mkv', 'Episode 1.srt', 'Episode 1.eng.forced.srt', 'Episode 1-de.srt',
      'Episode 10.mkv', 'Episode 10.eng.srt', 'Episode 1-2.srt', 'Episode 12.srt']) {
      writeFileSync(join(dir, f), '');
    }
    const names = findSidecarSubtitles(join(dir, 'Episode 1.mkv')).map((s) => s.path.split('/').pop()).sort();
    assert.deepEqual(names, ['Episode 1-de.srt', 'Episode 1.eng.forced.srt', 'Episode 1.srt']);
    const ten = findSidecarSubtitles(join(dir, 'Episode 10.mkv')).map((s) => `${s.path.split('/').pop()}:${s.language}`);
    assert.deepEqual(ten, ['Episode 10.eng.srt:eng']);
    // Language order no longer lands on the wrong episode's file.
    const subs = findSidecarSubtitles(join(dir, 'Episode 1.mkv'));
    const sel = selectTracks({ video: [], audio: [{ typeIndex: 0, language: 'jpn' }], subtitle: [] }, subs,
      { subtitleMode: 'auto', subtitleLanguages: ['eng'] });
    assert.equal(sel.subtitle.path.split('/').pop(), 'Episode 1.eng.forced.srt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forced subtitle mode normalises language aliases like every other mode', () => {
  const tracks = { video: [], audio: [{ typeIndex: 0, language: 'jpn' }], subtitle: [] };
  const embedded = [{ typeIndex: 0, language: 'eng', forced: true, external: false, codec: 'ass' }];
  for (const mode of ['always', 'forced']) {
    const r = selectTracks(tracks, embedded, { subtitleMode: mode, subtitleLanguages: ['en'] });
    assert.equal(r.subtitle?.language, 'eng', `mode=${mode}`);
  }
});

test('a pause during the copy-seek landing probe does not respawn the clip', async () => {
  const profile = { ...gpuProfile, codec: 'hevc', hdrWanted: false, videoBitrate: '4000k' };
  const video = { ...sdrVideo, codec: 'hevc' };
  const e = rig(profile, { video, audio: { typeIndex: 0 }, subtitle: null });
  let landed;
  e._probeCopyLanding = () => new Promise((r) => { landed = r; });
  const item = { id: 'a', title: 'A', srcPath: '/x.mkv', duration: 1000 };
  e.current = { item, offset: 0, duration: 1000 }; e.position = 100;
  e.seek({ position: 300 });    // probe in flight, nothing spawned yet
  e.pause();                    // hold card goes up
  landed(299.5);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(e.spawned.map((s) => s.kind), ['hold']);
  assert.equal(e.status, 'paused');
  assert.equal(e.holding, true);
  // The landing is kept for the resume at that offset.
  assert.deepEqual(e._copyAlignFor, { req: 300, landing: 299.5 });
  assert.equal(e._pauseResume, 300);
});

test('an HDR clip copied despite sparse keyframes says so', () => {
  const profile = { ...gpuProfile, codec: 'hevc', hdrWanted: true, hdrOut: true };
  const video = { ...sdrVideo, codec: 'hevc', pixFmt: 'yuv420p10le', hdr: true };
  const e = rig(profile, { video, audio: { typeIndex: 0 }, subtitle: null });
  const warns = [];
  e.on('warn', (w) => warns.push(String(w)));
  e._gopByPath = new Map([['/hdr.mkv', 8]]);
  e._play({ id: 'a', title: 'Planet HDR', srcPath: '/hdr.mkv', duration: 1000 }, 0, { duration: 1000 });
  assert.ok(e.spawned[0].args.includes('copy'), 'still copied');
  assert.ok(warns.some((w) => /Planet HDR keyframes only every 8\.0s.*copied anyway because it is HDR/s.test(w)), warns.join('\n'));

  // Keyframes that fit live: copied, no warning.
  const f = rig(profile, { video, audio: { typeIndex: 0 }, subtitle: null });
  const quiet = [];
  f.on('warn', (w) => quiet.push(String(w)));
  f._gopByPath = new Map([['/hdr.mkv', 2]]);
  f._play({ id: 'a', title: 'Planet HDR', srcPath: '/hdr.mkv', duration: 1000 }, 0, { duration: 1000 });
  assert.ok(f.spawned[0].args.includes('copy'));
  assert.ok(!quiet.some((w) => /copied anyway/.test(w)));
});

// ── a hidden studio must not block HEVC passthrough ──────────────────────

const hevcProfile = {
  ...gpuProfile, codec: 'hevc', hdrWanted: false, overlayPipe: true, overlayConfigured: true,
};
const hevcVideo = { ...sdrVideo, codec: 'hevc' };
const hevcSel = { video: hevcVideo, audio: { typeIndex: 0 }, subtitle: null };
const copyOf = (args) => args[args.indexOf('-c:v') + 1] === 'copy';
const PIPE = '/dev/shm/overlay-test.fifo';

test('hidden studio + pipe + eligible HEVC passes through with no pipe attached', () => {
  const args = buildSourceArgs({
    srcPath: '/m.mkv', profile: hevcProfile, selection: hevcSel, duration: 1000,
    overlayPipe: PIPE, srcKbps: 5000,
  });
  assert.ok(copyOf(args), 'copied');
  assert.ok(!args.includes(PIPE), 'no pipe input');
  assert.equal(planOverlayPipe({
    profile: hevcProfile, selection: hevcSel, sub: {}, duration: 1000, srcKbps: 5000,
  }), null, 'the plan agrees: nothing armed');
  assert.equal(passthroughEligible({ profile: hevcProfile, selection: hevcSel, srcKbps: 5000 }), true);
});

test('one ENABLED text item: no copy, pipe input present', () => {
  const profile = { ...hevcProfile, overlay: [{ type: 'text', text: 'hi', enabled: true }] };
  const args = buildSourceArgs({
    srcPath: '/m.mkv', profile, selection: hevcSel, duration: 1000, overlayPipe: PIPE, srcKbps: 5000,
  });
  assert.ok(!copyOf(args), 'encoded');
  assert.ok(args.includes(PIPE), 'pipe input attached');
});

test('an ineligible clip (H.264 source) with a hidden studio still arms the pipe idle', () => {
  const sel = { ...hevcSel, video: { ...hevcVideo, codec: 'h264' } };
  const args = buildSourceArgs({
    srcPath: '/m.mkv', profile: hevcProfile, selection: sel, duration: 1000, overlayPipe: PIPE, srcKbps: 5000,
  });
  assert.ok(!copyOf(args));
  assert.ok(args.includes(PIPE), 'idle arm preserved');
  // Over the copy ceiling the HEVC clip is ineligible too — pipe armed.
  const heavy = buildSourceArgs({
    srcPath: '/m.mkv', profile: hevcProfile, selection: hevcSel, duration: 1000, overlayPipe: PIPE, srcKbps: 50000,
  });
  assert.ok(!copyOf(heavy) && heavy.includes(PIPE));
});

test('the engine spawns a hidden-studio HEVC clip as passthrough without a renderer', () => {
  const e = rig(hevcProfile, hevcSel);
  e.cacheDir = mkdtempSync(join(tmpdir(), 'jsr-pt-'));
  let rendered = 0;
  e._ovFeed = { active: false, spawnRenderer() { rendered++; }, stopSync() {}, resetSync() {}, path: PIPE };
  e._play({ id: 'a', title: 'A', srcPath: '/nonexistent.mkv', duration: 1000 }, 0, { duration: 1000 });
  assert.ok(copyOf(e.spawned[0].args), 'copied');
  assert.equal(rendered, 0, 'no renderer spawned');
  assert.equal(e._pipedClip, false);
  rmSync(e.cacheDir, { recursive: true, force: true });
});

// ── cards follow what is on air, not the encoder's HDR capability ────────

test('pause and countdown cards stay SDR while an SDR clip is on air', () => {
  const profile = { ...gpuProfile, codec: 'hevc', hdrWanted: true, hdrOut: true };
  const sdrSel = { video: hevcVideo, audio: { typeIndex: 0 }, subtitle: { codec: 'ass', typeIndex: 0, external: false } };
  for (const args of [
    buildHoldArgs({ profile, selection: sdrSel }),
    buildCountdownArgs({ profile, selection: sdrSel, seconds: 30 }),
  ]) {
    const str = args.join(' ');
    assert.ok(!/p010/.test(str), 'no p010 upload');
    assert.ok(!args.includes('smpte2084'), 'no PQ tags');
  }
  // A tone-mapped HDR clip (subtitles drawn on it) is SDR on air too.
  const hdrVideo = { ...hevcVideo, pixFmt: 'yuv420p10le', hdr: true };
  const toneMapped = buildHoldArgs({ profile, selection: { ...sdrSel, video: hdrVideo } });
  assert.ok(!toneMapped.includes('smpte2084'));
  // An HDR clip with nothing drawn on it goes out HDR — so does its card.
  const hdrSel = { video: hdrVideo, audio: { typeIndex: 0 }, subtitle: null };
  const hold = buildHoldArgs({ profile, selection: hdrSel });
  assert.ok(/p010/.test(hold.join(' ')) && hold.includes('smpte2084'));
  const cd = buildCountdownArgs({ profile, selection: hdrSel, seconds: 30 });
  assert.ok(cd.includes('smpte2084'));
  // No selection at all: the capability decides.
  assert.ok(buildHoldArgs({ profile }).includes('smpte2084'));
  assert.ok(!buildHoldArgs({ profile: { ...profile, hdrOut: false }, selection: hdrSel }).includes('smpte2084'));
});

// ── the chunked path consumes the splice lock itself ─────────────────────

test('a cushion-kept seek on the chunked path releases the frontier lock without a warning', async () => {
  const profile = { ...gpuProfile, gpuSubs: false, parallelChunks: 4 };
  const video = { ...sdrVideo, codec: 'h264' };
  const e = rig(profile, { video, audio: { typeIndex: 0 }, subtitle: { codec: 'ass', typeIndex: 0, external: false } });
  let chunked = 0;
  e._playChunked = () => { chunked++; };
  const warns = [];
  e.on('warn', (w) => warns.push(String(w)));
  e.current = { item: { id: 'a', title: 'A', srcPath: '/x.mkv', duration: 1000 }, offset: 0, duration: 1000 };
  e.position = 120; e.timeline = 120;
  e._bank = [{ data: Buffer.alloc(188 * 4), pos: 118, tl: 118, item: e.current.item, gen: 1 }];
  e._bankBytes = 188 * 4;
  e.seek({ position: 300 });
  assert.equal(chunked, 1);
  assert.equal(e.spawned.length, 0, 'chunks never _spawnSource');
  assert.equal(e._tlLocked, false, 'lock released by the chunked flow');
  assert.equal(e._audioClose, null);
  assert.equal(e._tlLockTimer?._destroyed ?? true, true, 'release valve disarmed');
  assert.ok(!warns.some((w) => /never spawned/.test(w)), warns.join('\n'));
});

// ── skip acts on the clip ON AIR, not the clip being encoded ─────────────

test('skip while the encoder is already on the next episode restarts that episode instead of skipping it', () => {
  const e = rig(gpuProfile, { video: sdrVideo, audio: { typeIndex: 0 }, subtitle: null });
  const ep1 = { id: 'e1', title: 'S1E1', srcPath: '/e1.mkv', duration: 32 };
  const ep2 = { id: 'e2', title: 'S1E2', srcPath: '/e2.mkv', duration: 32 };
  const ep3 = { id: 'e3', title: 'S1E3', srcPath: '/e3.mkv', duration: 32 };
  e.queue = [ep3];
  e.current = { item: ep2, offset: 0, duration: 32 };
  e.position = 8; e.timeline = 40;
  e.airedItem = ep1; e.aired = 19.9;
  const plays = [];
  e._play = (item, offset, opts) => { plays.push({ item, offset, opts }); };
  let advanced = 0;
  e._advance = () => { advanced++; };
  const logs = [];
  e.on('log', (l) => logs.push(String(l)));
  assert.equal(e.skip(), true);
  assert.equal(advanced, 0, 'did not advance past the unplayed episode');
  assert.equal(e.queue[0], ep3, 'queue head untouched');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].item, ep2);
  assert.equal(plays[0].offset, 0);
  assert.equal(plays[0].opts.duration, 32);
  assert.ok(logs.some((l) => /\[skip\] S1E1 \(encoder was already on S1E2\)/.test(l)), logs.join(''));

  // Same situation with an EMPTY queue: the current clip is still what follows.
  const f = rig(gpuProfile, { video: sdrVideo, audio: { typeIndex: 0 }, subtitle: null });
  f.queue = [];
  f.current = { item: ep2, offset: 0, duration: 32 };
  f.airedItem = ep1; f.aired = 19.9;
  const fp = [];
  f._play = (item, offset) => { fp.push({ item, offset }); };
  assert.equal(f.skip(), true);
  assert.deepEqual(fp, [{ item: ep2, offset: 0 }]);
});

test('skip with the encoder on the clip on air advances as before', () => {
  const e = rig(gpuProfile, { video: sdrVideo, audio: { typeIndex: 0 }, subtitle: null });
  const ep1 = { id: 'e1', title: 'S1E1', srcPath: '/e1.mkv', duration: 32 };
  const ep2 = { id: 'e2', title: 'S1E2', srcPath: '/e2.mkv', duration: 32 };
  e.queue = [ep2];
  e.current = { item: ep1, offset: 0, duration: 32 };
  e.airedItem = ep1; e.aired = 10; e.position = 20; e.timeline = 20;
  const plays = [];
  e._play = (item, offset) => { plays.push({ item, offset }); };
  let advanced = 0;
  e._advance = () => { advanced++; };
  assert.equal(e.skip(), true);
  assert.equal(advanced, 1);
  assert.equal(plays.length, 0);
  // Nothing queued and nothing ahead: still refused.
  e.queue = [];
  assert.equal(e.skip(), false);
});
