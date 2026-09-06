/**
 * _chunkWorkers mirrors the builder: the GPU composite takes text
 * subtitles only, so a bitmap (PGS) subtitle must chunk even on a box
 * whose alpha probe passed. The regression: a live subtitle switch
 * re-tuned gpuSubs=true (1 Sep) and PGS clips fell to one CPU process
 * with no buffer. Measured on the N100: 0.99x alone, 1.40x chunked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelinePlayout, availableCores } from '../src/ffmpeg/pipeline.js';

const video = { codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, frameRate: '24000/1001', sar: '1:1', dar: '16:9' };
const workers = (subtitle, profile = {}) =>
  PipelinePlayout.prototype._chunkWorkers.call({
    profile: { codec: 'hevc', backend: 'vaapi', gpuSubs: true, width: 1920, height: 1080, ...profile },
    selection: { video, subtitle },
  });

test('a bitmap subtitle rides the GPU canvas on a GPU-subtitle box: one process', () => {
  assert.equal(workers({ codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 0 }), 1);
});

test('a bitmap subtitle chunks once the GPU path is out', () => {
  const n = workers({ codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 0 }, { gpuSubs: false });
  assert.equal(n, Math.max(1, availableCores()));
});

test('a text subtitle stays on the GPU composite', () => {
  assert.equal(workers({ codec: 'ass', bitmap: false, text: true }), 1);
});

test('no subtitle means one process', () => {
  assert.equal(workers(null), 1);
});

test('a text subtitle chunks once the GPU path is out', () => {
  const n = workers({ codec: 'ass', bitmap: false, text: true }, { gpuSubs: false });
  assert.equal(n, Math.max(1, availableCores()));
});

import { ChunkScheduler } from '../src/ffmpeg/chunker.js';

test('a chunked successor keeps the whole cushion as its runway', () => {
  const runway = (subtitle, gpuSubs) => PipelinePlayout.prototype._applyRunway.call({
    applySeconds: 15, bufferSeconds: 15, _spawnMs: 300,
    profile: { codec: 'hevc', backend: 'vaapi', gpuSubs, gopSeconds: 1, width: 1920, height: 1080 },
    selection: { video, subtitle },
    _chunkWorkers: PipelinePlayout.prototype._chunkWorkers,
  });
  // Bitmap subtitle with no GPU path: chunks, so the runway is the cap.
  assert.equal(runway({ codec: 'hdmv_pgs_subtitle', bitmap: true, typeIndex: 0 }, false), 15);
  // Text subtitle on a GPU box: one process, spawn-sized runway.
  assert.ok(runway({ codec: 'ass', bitmap: false, text: true }, true) < 15);
});

test('the chunker takes a shorter opener when asked', () => {
  const mk = (firstSeconds) => new ChunkScheduler({ srcPath: '/x', chunkSeconds: 20, workers: 2, workDir: '/tmp', buildArgs: () => [], firstSeconds });
  assert.ok(Math.abs(mk(undefined)._firstSize() - 5) < 0.05);
  assert.ok(Math.abs(mk(3)._firstSize() - 3) < 0.05);
  assert.equal(mk(3)._rampCount(), 7);
});

test('a moving picture keeps a bitmap-subtitled clip on one process', () => {
  const pgs = { codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 0 };
  const bounce = [{ type: 'image', enabled: true, file: 'logo.png', motion: 'bounce' }];
  const still = [{ type: 'image', enabled: true, file: 'logo.png', motion: 'none' }];
  const off = [{ type: 'image', enabled: false, file: 'logo.png', motion: 'bounce' }];
  // No GPU path: moving pictures keep one process, still ones chunk.
  assert.equal(workers(pgs, { overlay: bounce, gpuSubs: false }), 1);
  assert.equal(workers(pgs, { overlay: still, gpuSubs: false }), Math.max(1, availableCores()));
  assert.equal(workers(pgs, { overlay: off, gpuSubs: false }), Math.max(1, availableCores()));
});

import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';

test('a bitmap subtitle on a GPU box takes the composite: video stays on the GPU', () => {
  const profile = { backend: 'vaapi', device: '/dev/dri/renderD128', codec: 'hevc', width: 1920, height: 1080, videoBitrate: '16000k', gpuFull: true, gpuSubs: true, overlay: [], hdrOutput: false, gopSeconds: 1 };
  const selection = { video, subtitle: { codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 2 } };
  const args = buildSourceArgs({ srcPath: '/x/dn.mkv', profile, selection, duration: 1400, overlayImages: [], overlayLayer: () => null }).join(' ');
  assert.ok(args.includes('-hwaccel vaapi'), 'decodes on the GPU');
  assert.ok(/\[0:s:2\]select=isnan\(prev_selected_t\)\+gte\(t-prev_selected_t\\,0\.\d+\),scale=1920:1080[^;]*\[sf\];\[c0\]\[sf\]overlay=eof_action=pass/.test(args), 'subtitle frames are gated by select, then scaled onto the canvas');
  assert.ok(/\[b\]\[ov\]overlay_vaapi/.test(args), 'one GPU composite of the finished canvas');
  assert.ok(!/\[0:s:2\][^;]*hwupload/.test(args), 'the subtitle frames are never uploaded unscaled');
  assert.ok(!/\[0:v:0\]\[0:s:2\]overlay/.test(args), 'never blended onto the video on the CPU');
});
