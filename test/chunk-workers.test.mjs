/**
 * Bitmap subtitles ride the GPU canvas: on a box whose alpha probe passed
 * a PGS track is one GPU process like a text track, and the builder puts
 * the decoded subtitle frames onto the canvas, rate-gated, never onto
 * the video on the CPU. Chunking stays the fallback for boxes without
 * the composite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelinePlayout, availableCores, buildSourceArgs } from '../src/ffmpeg/pipeline.js';

const video = { codec: 'hevc', pixFmt: 'yuv420p', width: 1920, height: 1080, frameRate: '24000/1001', sar: '1:1', dar: '16:9' };
const workers = (subtitle, profile = {}) =>
  PipelinePlayout.prototype._chunkWorkers.call({
    profile: { codec: 'hevc', backend: 'vaapi', gpuSubs: true, width: 1920, height: 1080, ...profile },
    selection: { video, subtitle },
  });

test('a bitmap subtitle on a GPU-subtitle box is one process', () => {
  assert.equal(workers({ codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 0 }), 1);
});

test('a text subtitle stays on the GPU composite', () => {
  assert.equal(workers({ codec: 'ass', bitmap: false, text: true }), 1);
});

test('no subtitle means one process', () => {
  assert.equal(workers(null), 1);
});

test('a subtitle chunks once the GPU path is out', () => {
  assert.equal(workers({ codec: 'ass', bitmap: false, text: true }, { gpuSubs: false }), Math.max(1, availableCores()));
  assert.equal(workers({ codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 0 }, { gpuSubs: false }), Math.max(1, availableCores()));
});

test('a bitmap subtitle on a GPU box takes the composite: video stays on the GPU', () => {
  const profile = { backend: 'vaapi', device: '/dev/dri/renderD128', codec: 'hevc', width: 1920, height: 1080, videoBitrate: '16000k', gpuFull: true, gpuSubs: true, overlay: [], hdrOutput: false, gopSeconds: 1 };
  const selection = { video, subtitle: { codec: 'hdmv_pgs_subtitle', bitmap: true, text: false, typeIndex: 2 } };
  const args = buildSourceArgs({ srcPath: '/x/dn.mkv', profile, selection, duration: 1400, overlayImages: [], overlayLayer: () => null }).join(' ');
  assert.ok(args.includes('-hwaccel vaapi'), 'decodes on the GPU');
  assert.ok(/\[0:s:2\]select=isnan\(prev_selected_t\)\+gte\(t-prev_selected_t\\,0\.\d+\),scale=1920:1080[^;]*\[sf\];\[c0\]\[sf\]overlay=eof_action=pass/.test(args), 'subtitle frames are gated by select, then scaled onto the canvas');
  assert.ok(/\[b\]\[ov\]overlay_vaapi/.test(args), 'one GPU composite of the finished canvas');
  assert.ok(!/\[0:v:0\]\[0:s:2\]overlay/.test(args), 'never blended onto the video on the CPU');
  assert.ok(!/\[0:s:2\][^;]*hwupload/.test(args), 'the subtitle frames are never uploaded unscaled');
});
