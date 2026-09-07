/**
 * The live source kind: the args a screen share spawns with, and the
 * engine's handling of it — publisher gate, fresh re-attach after a pause,
 * no seeking, the share's end advancing the queue.
 *
 * Run: node --test test/live-source.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import {
  PipelinePlayout, buildLiveArgs, livePassthroughEligible, LIVE_INPUT_ARGS,
} from '../src/ffmpeg/pipeline.js';
import { CaptureSession, parseHello, sanitizeCapture } from '../src/capture.js';

const gpuProfile = {
  backend: 'vaapi', device: '/dev/dri/renderD128', width: 1920, height: 1080,
  fps: 30, fpsMode: 'auto', videoBitrate: '6000k', audioBitrate: '160k',
  gopSeconds: 2, gpuFull: true, gpuSubs: true, tonemap: 'vaapi', codec: 'h264',
  frameSize: 'native', overlay: [], copyMaxGopSeconds: 4,
};
const cpuProfile = { ...gpuProfile, backend: 'x264', device: null };
const h264 = { codec: 'h264', width: 1920, height: 1080, frameRate: '30/1', pixFmt: 'yuv420p', sar: '1:1', hdr: false };
const vp9 = { ...h264, codec: 'vp9' };
const sel = (video) => ({ video, audio: { typeIndex: 0, codec: 'opus', channels: 2 }, subtitle: null });

const argsAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('browser H.264 with nothing drawn ships untouched', () => {
  const args = buildLiveArgs({ profile: gpuProfile, selection: sel(h264) });
  assert.equal(argsAfter(args, '-c:v'), 'copy');
  assert.equal(argsAfter(args, '-i'), 'pipe:0');
  assert.ok(args.includes('aac'), 'audio still conforms to AAC');
  assert.ok(!args.includes('-ss'));
  assert.ok(!args.includes('-re'));
  for (const f of LIVE_INPUT_ARGS) assert.ok(args.includes(f), `carries ${f}`);
  assert.ok(args.indexOf('-probesize') < args.indexOf('-i'), 'input flags precede the input');
});

test('anything drawn, another codec, or the switch off means a transcode through the ordinary graph', () => {
  const drawn = { ...gpuProfile, overlay: [{ id: 't', type: 'text', text: 'hi', enabled: true }] };
  assert.notEqual(argsAfter(buildLiveArgs({ profile: drawn, selection: sel(h264) }), '-c:v'), 'copy');
  assert.notEqual(argsAfter(buildLiveArgs({ profile: gpuProfile, selection: sel(vp9) }), '-c:v'), 'copy');
  assert.notEqual(argsAfter(buildLiveArgs({ profile: { ...gpuProfile, livePassthrough: false }, selection: sel(h264) }), '-c:v'), 'copy');
  assert.notEqual(argsAfter(buildLiveArgs({ profile: { ...gpuProfile, codec: 'hevc' }, selection: sel(h264) }), '-c:v'), 'copy');
  // A disabled item is not drawn.
  const off = { ...gpuProfile, overlay: [{ id: 't', type: 'text', text: 'hi', enabled: false }] };
  assert.equal(argsAfter(buildLiveArgs({ profile: off, selection: sel(h264) }), '-c:v'), 'copy');
});

test('the transcode graph reads the pipe with the live input flags and never seeks', () => {
  for (const profile of [gpuProfile, cpuProfile]) {
    const args = buildLiveArgs({ profile, selection: sel(vp9) });
    const i = args.indexOf('-i');
    assert.equal(args[i + 1], 'pipe:0');
    assert.ok(!args.includes('-ss'));
    assert.ok(!args.includes('-t'), 'no duration cap on an endless input');
    assert.ok(args.indexOf('-probesize') < i);
    assert.ok(args.includes('-output_ts_offset'));
    assert.equal(args[args.length - 1], 'pipe:1');
  }
});

test('sparse browser keyframes refuse the copy; close ones allow it', () => {
  const feedWith = (gap) => ({ keyGapSeconds: () => gap });
  assert.equal(livePassthroughEligible({ profile: gpuProfile, video: h264, feed: feedWith(2.0) }), true);
  assert.equal(livePassthroughEligible({ profile: gpuProfile, video: h264, feed: feedWith(null) }), true, 'unknown yet: optimistic');
  assert.equal(livePassthroughEligible({ profile: gpuProfile, video: h264, feed: feedWith(7.5) }), false);
});

test('hello parsing bounds every field and settings sanitise', () => {
  const h = parseHello(JSON.stringify({ type: 'hello', mime: 'video/webm;codecs=h264,opus', width: 2560, height: 1440, fps: 30, audio: true, title: 'x'.repeat(200), surface: 'monitor', kbps: 8000 }));
  assert.equal(h.width, 2560);
  assert.equal(h.title.length, 80);
  assert.equal(parseHello('{"type":"health"}'), null);
  assert.equal(parseHello('not json'), null);
  const s = sanitizeCapture({ delaySeconds: 99, quality: 'weird', fps: '60', audio: 'mic', onEnd: 'hold', holdMinutes: 500 }, undefined, { bufferSeconds: 15 });
  assert.equal(s.delaySeconds, 15);
  assert.equal(s.quality, 'balanced');
  assert.equal(s.fps, 60);
  assert.equal(s.audio, 'mic');
  assert.equal(s.onEnd, 'hold');
  assert.equal(s.holdMinutes, 60);
});

/** A fake feed that records attaches. */
function fakeFeed() {
  const f = new EventEmitter();
  f.ended = false;
  f.ring = [{}];
  f.init = Buffer.alloc(1);
  f.attaches = [];
  f.keyGapSeconds = () => 2;
  f.attach = (w, o) => { f.attaches.push({ w, ...o }); };
  f.detach = () => {};
  f.end = () => { f.ended = true; };
  f.stats = () => ({});
  return f;
}

/** An engine whose source spawns are recorded, with a stdin to attach to. */
function rig(profile, selection, { publisher = true } = {}) {
  const e = new PipelinePlayout({ target: 'rtmp://x/y/key123456', profile, selection, buffer: { seconds: 15 } });
  e.spawned = [];
  e._spawnSource = (args, opts = {}) => {
    e.spawned.push({ args, kind: opts.kind, stdin: opts.stdin, gate: e._pubGate });
    const s = new EventEmitter();
    s.stdin = new PassThrough();
    s.kill = () => {};
    e.source = s;
    // The real _spawnSource spawns the publisher unless gated.
    if (!e.publisher && !(opts.kind === 'live' && e._pubGate > 0)) e.publisher = { stdin: { writable: true, write() { return true; } } };
  };
  e._spawnPublisher = () => { e.publisher = { stdin: { writable: true, write() { return true; } } }; };
  e._prefetchUpcoming = () => {};
  if (publisher) e.publisher = { stdin: { writable: true, write() { return true; } } };
  e.status = 'running';
  return e;
}

function liveItem(feed, extra = {}) {
  const item = { id: 'capture:1', title: 'Screen', live: true, duration: null, delaySeconds: 0, ...extra };
  Object.defineProperty(item, 'feed', { value: feed, enumerable: false });
  return item;
}

test('a live item spawns kind live with a stdin pipe and attaches the feed', () => {
  const feed = fakeFeed();
  const e = rig(gpuProfile, sel(h264));
  e._play(liveItem(feed), 0);
  assert.equal(e.spawned.length, 1);
  assert.equal(e.spawned[0].kind, 'live');
  assert.equal(e.spawned[0].stdin, true);
  assert.equal(argsAfter(e.spawned[0].args, '-c:v'), 'copy');
  assert.equal(feed.attaches.length, 1);
  assert.equal(feed.attaches[0].fresh, false);
  assert.equal(feed.attaches[0].maxBacklogSeconds, 2);
  assert.equal(e.current.duration, null);
  assert.ok(!Object.keys(e.snapshot().playing).includes('feed'), 'the feed never rides into a snapshot');
  assert.equal(e.snapshot().playing.live, true);
});

test('the delay line gates the publisher only when the share starts the broadcast', () => {
  const feed = fakeFeed();
  const e = rig(gpuProfile, sel(h264), { publisher: false });
  e._play(liveItem(feed, { delaySeconds: 5 }), 0);
  assert.equal(e.spawned[0].gate, 5, 'gate armed');
  assert.equal(e.publisher, null, 'no publisher yet');
  assert.equal(feed.attaches[0].maxBacklogSeconds, 5, 'a backlog up to the delay refills the line');
  // The bank reaching the gate opens it.
  e._bankSeconds = () => 5.2;
  e._bankPush(e.source, Buffer.alloc(188));
  assert.ok(e.publisher, 'publisher connected once the delay was banked');
  assert.equal(e._pubGate, null);

  // With a publisher already up there is nothing to gate.
  const e2 = rig(gpuProfile, sel(h264));
  e2._play(liveItem(fakeFeed(), { delaySeconds: 5 }), 0);
  assert.equal(e2.spawned[0].gate, null);
});

test('no delay: the publisher connects on the first spawn', () => {
  const e = rig(gpuProfile, sel(h264), { publisher: false });
  e._play(liveItem(fakeFeed(), { delaySeconds: 0 }), 0);
  assert.ok(e.publisher);
});

test('a pause makes the next attach fresh; seeking a share does nothing', () => {
  const feed = fakeFeed();
  const e = rig(gpuProfile, sel(h264));
  e._spawnHold = () => { e.holding = true; };
  e._bankFlush = () => {};
  e._setPending = () => {};
  e._play(liveItem(feed), 0);
  e.position = 42;
  assert.equal(e.seek({ delta: 30 }), 42);
  e.pause();
  assert.equal(e.status, 'paused');
  e._bankCutForApply = () => ({ rewound: 0, gop: 0, resume: 42 });
  e.resume();
  assert.equal(feed.attaches.length, 2);
  assert.equal(feed.attaches[1].fresh, true, 'what happened behind the card does not air');
  assert.equal(e.current.offset, 42, 'elapsed time carries across the respawn');
});

test('an apply respawns and continues (not fresh)', () => {
  const feed = fakeFeed();
  const e = rig(gpuProfile, sel(h264));
  e._play(liveItem(feed), 0);
  e.position = 10;
  e._play(e.current.item, e.position);
  assert.equal(feed.attaches.length, 2);
  assert.equal(feed.attaches[1].fresh, false);
});

test('a share that already ended with nothing left advances instead of spawning', () => {
  const feed = fakeFeed();
  feed.ended = true;
  feed.ring = [];
  const e = rig(gpuProfile, sel(h264));
  let advanced = 0;
  e._advance = () => { advanced += 1; };
  e._play(liveItem(feed), 0);
  assert.equal(advanced, 1);
  assert.equal(e.spawned.length, 0);
});

test('a session builds a queue item with an invisible feed and a synthetic selection', () => {
  const hello = parseHello(JSON.stringify({ type: 'hello', mime: 'video/webm;codecs=vp9,opus', width: 1280, height: 720, fps: 30, audio: true, title: 'Demo' }));
  const s = new CaptureSession({ ws: null, hello, sender: { ip: '1.2.3.4', ua: 'test' }, settings: sanitizeCapture({ onEnd: 'hold' }) });
  const item = s.liveItem({ delaySeconds: 3, bufferSeconds: 15 });
  assert.equal(item.live, true);
  assert.equal(item.title, 'Demo');
  assert.equal(item.delaySeconds, 3);
  assert.equal(item.onEnd, 'hold');
  assert.equal(JSON.parse(JSON.stringify(item)).feed, undefined);
  assert.equal(item.feed, s.feed);
  const selection = s.selection();
  assert.equal(selection.video.width, 1280);
  assert.equal(selection.video.frameRate, '30/1');
  assert.equal(selection.subtitle, null);
  s.end('operator');
  assert.equal(s.state, 'ended');
  assert.equal(s.feed.ended, true);
});
