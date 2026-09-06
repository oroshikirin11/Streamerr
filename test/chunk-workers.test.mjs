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

test('a bitmap subtitle chunks on a GPU-subtitle box', () => {
  const n = workers({ codec: 'hdmv_pgs_subtitle', bitmap: true, text: false });
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
