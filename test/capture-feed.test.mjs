/**
 * The WebM scanner and the capture feed, against real WebM from ffmpeg.
 *
 * A browser's MediaRecorder writes one endless WebM; ffmpeg's matroska muxer
 * in -live mode writes the same shape (unknown-size Segment and Clusters).
 * Every emitted stream here is handed back to ffprobe/ffmpeg to prove that a
 * reader can start on it, that it decodes without error, and that the first
 * picture is a keyframe.
 *
 * Run: node --test test/capture-feed.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { PassThrough } from 'stream';
import { WebmScanner } from '../src/ffmpeg/webm.js';
import { CaptureFeed } from '../src/ffmpeg/capture-feed.js';

const FPS = 30;
const GOP = 30;   // one keyframe a second

/** A live-shaped WebM/Matroska stream, as bytes. */
function makeStream({ codec = 'vp9', seconds = 6, container = null } = {}) {
  const fmt = container ?? (codec === 'h264' ? 'matroska' : 'webm');
  const venc = codec === 'h264'
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0', '-pix_fmt', 'yuv420p']
    : codec === 'vp8'
      ? ['-c:v', 'libvpx', '-g', String(GOP), '-deadline', 'realtime', '-cpu-used', '8']
      : ['-c:v', 'libvpx-vp9', '-g', String(GOP), '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'];
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${FPS}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    ...venc,
    '-c:a', 'libopus', '-b:a', '64k',
    '-f', fmt, '-live', '1', '-cluster_time_limit', '500', '-cluster_size_limit', '2000000',
    'pipe:1',
  ], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`);
  return r.stdout;
}

/** ffprobe a stream from memory: frames of the video, keyframe flags, pts. */
function probeFrames(buf) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=key_frame,pts_time,pkt_pts_time,best_effort_timestamp_time',
    '-of', 'json', '-f', 'matroska', 'pipe:0',
  ], { input: buf, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.status, 0, `ffprobe failed: ${r.stderr}`);
  const frames = JSON.parse(r.stdout).frames ?? [];
  return frames.map((f) => ({
    key: Number(f.key_frame) === 1,
    t: Number(f.best_effort_timestamp_time ?? f.pts_time ?? f.pkt_pts_time),
  }));
}

/** Decode everything; the stderr must be empty. */
function decodeClean(buf) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'matroska', '-i', 'pipe:0', '-f', 'null', '-',
  ], { input: buf, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0 && r.stderr.length === 0, stderr: r.stderr.toString() };
}

function collect() {
  const pt = new PassThrough();
  const chunks = [];
  pt.on('data', (d) => chunks.push(d));
  return { pt, bytes: () => Buffer.concat(chunks) };
}

/** Push in irregular chunks, the way a socket delivers. */
function pushChunked(feed, buf, seed = 7) {
  let p = 0;
  let s = seed;
  while (p < buf.length) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = 1 + (s % 777);
    feed.push(buf.subarray(p, Math.min(buf.length, p + n)));
    p += n;
  }
}

const src = makeStream({ codec: 'vp9', seconds: 6 });
const srcFrames = probeFrames(src);

test('the scanner finds the header, the tracks, the clusters and the keyframes', () => {
  let init = null;
  let meta = null;
  let clusters = 0;
  const blocks = [];
  const sc = new WebmScanner({
    onInit: (b, m) => { init = b; meta = m; },
    onCluster: () => { clusters += 1; },
    onBlock: (b) => blocks.push(b),
  });
  sc.push(src);
  assert.ok(init && init.length > 100, 'init segment captured');
  assert.equal(sc.damaged, 0);
  const v = meta.tracks.find((t) => t.type === 1);
  const a = meta.tracks.find((t) => t.type === 2);
  assert.equal(v.codec, 'V_VP9');
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.equal(a.codec, 'A_OPUS');
  assert.ok(clusters >= 6, `clusters: ${clusters}`);
  const vkeys = blocks.filter((b) => b.track === v.number && b.keyframe).length;
  const vall = blocks.filter((b) => b.track === v.number).length;
  assert.equal(vall, srcFrames.length, 'every video frame seen as a block');
  assert.equal(vkeys, srcFrames.filter((f) => f.key).length, 'keyframe flags agree with ffprobe');
});

test('chunking does not change what the scanner sees', () => {
  const seen = [];
  const sc = new WebmScanner({ onBlock: (b) => seen.push(b.bytes) });
  let p = 0;
  while (p < src.length) { const n = 1 + ((p * 31) % 513); sc.push(src.subarray(p, p + n)); p += n; }
  const whole = [];
  new WebmScanner({ onBlock: (b) => whole.push(b.bytes) }).push(src);
  assert.deepEqual(seen, whole);
  assert.equal(sc.damaged, 0);
});

test('a feed attached from the start reproduces every frame, decodable, first frame a keyframe', () => {
  const feed = new CaptureFeed();
  const { pt, bytes } = collect();
  feed.attach(pt);
  pushChunked(feed, src);
  feed.end();
  const out = bytes();
  assert.equal(feed.video.codec, 'vp9');
  assert.equal(feed.audio.codec, 'opus');
  const frames = probeFrames(out);
  assert.equal(frames.length, srcFrames.length);
  assert.ok(frames[0].key);
  assert.ok(Math.abs(frames[0].t) < 0.05, `starts at zero (${frames[0].t})`);
  assert.ok(decodeClean(out).ok);
  assert.ok(feed.keyGapSeconds() > 0.9 && feed.keyGapSeconds() < 1.1, `keyframe gap ${feed.keyGapSeconds()}`);
});

test('a reader attached mid-stream starts on a keyframe at zero and loses at most one GOP', () => {
  const feed = new CaptureFeed();
  // First half goes to a reader that is then replaced (a respawn).
  const a = collect();
  feed.attach(a.pt);
  const half = Math.floor(src.length / 2);
  pushChunked(feed, src.subarray(0, half));
  feed.detach();
  // The rest arrives with nothing attached, then the successor connects and
  // must CONTINUE from where the first reader stopped, not from now.
  pushChunked(feed, src.subarray(half), 3);
  feed.end();
  const b = collect();
  feed.attach(b.pt, { maxBacklogSeconds: 60 });
  const fa = probeFrames(a.bytes());
  const fb = probeFrames(b.bytes());
  assert.ok(fa.length > 0 && fb.length > 0);
  assert.ok(fb[0].key, 'successor starts on a keyframe');
  assert.ok(Math.abs(fb[0].t) < 0.05, `successor starts at zero (${fb[0].t})`);
  // Nothing duplicated, at most one GOP skipped at the seam.
  const lost = srcFrames.length - fa.length - fb.length;
  assert.ok(lost >= 0 && lost <= GOP, `frames lost at the seam: ${lost}`);
  assert.ok(decodeClean(b.bytes()).ok);
});

test('a fresh attach drops the backlog and airs only the newest keyframe onward', () => {
  const feed = new CaptureFeed();
  pushChunked(feed, src);     // six seconds buffered, nobody reading
  feed.end();
  const { pt, bytes } = collect();
  feed.attach(pt, { fresh: true });
  const frames = probeFrames(bytes());
  assert.ok(frames[0].key);
  assert.ok(frames.length <= GOP + 2, `only the last GOP airs (${frames.length} frames)`);
  assert.ok(feed.dropped > 0);
  assert.ok(decodeClean(bytes()).ok);
});

test('a long backlog is jumped over even without fresh', () => {
  const feed = new CaptureFeed();
  pushChunked(feed, src);
  feed.end();
  const { pt, bytes } = collect();
  feed.attach(pt, { maxBacklogSeconds: 2 });
  const frames = probeFrames(bytes());
  assert.ok(frames.length <= GOP + 2, `${frames.length} frames`);
  assert.ok(frames[0].key);
});

test('over budget, the oldest content goes and the output stays continuous and decodable', () => {
  // Enough for roughly two seconds; the stream is six.
  const perSecond = src.length / 6;
  const feed = new CaptureFeed({ maxBytes: Math.round(perSecond * 2) });
  pushChunked(feed, src);
  feed.end();
  assert.ok(feed.dropped > 0, 'something was dropped');
  const { pt, bytes } = collect();
  feed.attach(pt, { maxBacklogSeconds: 60 });
  const frames = probeFrames(bytes());
  assert.ok(frames.length > 0 && frames.length < srcFrames.length);
  assert.ok(frames[0].key);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].t > frames[i - 1].t, `timestamps monotonic at ${i}`);
  }
  assert.ok(decodeClean(bytes()).ok);
});

test('a drop while a reader is attached closes the seam: no gap, timestamps monotonic', () => {
  const perSecond = src.length / 6;
  const feed = new CaptureFeed({ maxBytes: Math.round(perSecond * 1.5) });
  const { pt, bytes } = collect();
  // A reader that never drains: writes return false, the ring fills, trims.
  const stuck = new PassThrough({ highWaterMark: 16 });
  feed.attach(stuck);
  pushChunked(feed, src.subarray(0, Math.floor(src.length * 0.7)));
  assert.ok(feed.dropped > 0, 'the stuck reader forced a trim');
  // Now a reader that does drain takes over.
  feed.detach();
  feed.attach(pt, { maxBacklogSeconds: 60 });
  pushChunked(feed, src.subarray(Math.floor(src.length * 0.7)));
  feed.end();
  const frames = probeFrames(bytes());
  assert.ok(frames.length > 0);
  assert.ok(frames[0].key);
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    assert.ok(dt > 0 && dt < 0.5, `step ${dt.toFixed(3)}s at frame ${i} (a seam must be a cut, not a gap)`);
  }
  assert.ok(decodeClean(bytes()).ok);
});

test('H.264 in Matroska (what Chrome sends as video/x-matroska;codecs=avc1) works the same', () => {
  const h = makeStream({ codec: 'h264', seconds: 4 });
  const feed = new CaptureFeed();
  pushChunked(feed, h.subarray(0, Math.floor(h.length / 2)));
  const { pt, bytes } = collect();
  feed.attach(pt, { maxBacklogSeconds: 60 });
  pushChunked(feed, h.subarray(Math.floor(h.length / 2)));
  feed.end();
  assert.equal(feed.video.codec, 'h264');
  const frames = probeFrames(bytes());
  assert.ok(frames[0].key);
  assert.equal(frames.length, probeFrames(h).length);
  assert.ok(decodeClean(bytes()).ok);
});

test('VP8 (Firefox) parses and restarts too', () => {
  const v8 = makeStream({ codec: 'vp8', seconds: 3 });
  const feed = new CaptureFeed();
  pushChunked(feed, v8);
  feed.end();
  const { pt, bytes } = collect();
  feed.attach(pt, { fresh: true });
  assert.equal(feed.video.codec, 'vp8');
  const frames = probeFrames(bytes());
  assert.ok(frames[0].key);
  assert.ok(decodeClean(bytes()).ok);
});

test('end() after everything is written ends the sink', async () => {
  const feed = new CaptureFeed();
  const pt = new PassThrough();
  let ended = false;
  pt.on('end', () => { ended = true; });
  pt.resume();
  feed.attach(pt);
  pushChunked(feed, src);
  feed.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(ended);
  assert.equal(feed.sink, null);
});
