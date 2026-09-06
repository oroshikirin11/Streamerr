/**
 * The band for bitmap subtitles: the union of a PGS track's windows decides
 * whether the canvas can be a bottom strip, and the builder crops the
 * subtitle frames to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePgs, pgsBandFor } from '../src/ffmpeg/pgsband.js';
import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';

function seg(type, payload) {
  const h = Buffer.alloc(13); h.write('PG', 0); h.writeUInt32BE(0, 2); h.writeUInt32BE(0, 6); h[10] = type; h.writeUInt16BE(payload.length, 11);
  return Buffer.concat([h, payload]);
}
function pcs(w, h, objects = 1) { const b = Buffer.alloc(11); b.writeUInt16BE(w, 0); b.writeUInt16BE(h, 2); b[4] = 0x10; b.writeUInt16BE(1, 5); b[7] = 0x80; b[10] = objects; return b; }
function wds(windows) {
  const b = Buffer.alloc(1 + 9 * windows.length); b[0] = windows.length;
  windows.forEach(([x, y, w, h], i) => { const o = 1 + i * 9; b[o] = i; b.writeUInt16BE(x, o + 1); b.writeUInt16BE(y, o + 3); b.writeUInt16BE(w, o + 5); b.writeUInt16BE(h, o + 7); });
  return b;
}

test('parsePgs unions the windows and reads the presentation size', () => {
  const buf = Buffer.concat([seg(0x16, pcs(3840, 2160)), seg(0x17, wds([[600, 1900, 2600, 200]])), seg(0x80, Buffer.alloc(0)),
    seg(0x16, pcs(3840, 2160)), seg(0x17, wds([[400, 1850, 3000, 250]])), seg(0x80, Buffer.alloc(0))]);
  // Feed it in two pieces to exercise the carry.
  const a = parsePgs(buf.subarray(0, 20)); const rest = Buffer.concat([buf.subarray(a.rest, 20), buf.subarray(20)]);
  const { acc } = parsePgs(rest, a.acc);
  assert.equal(acc.width, 3840); assert.equal(acc.height, 2160);
  assert.equal(acc.minY, 1850); assert.equal(acc.maxY, 2100); assert.equal(acc.windows, 2); assert.equal(acc.cues, 2);
});

test('a track whose windows sit in the lower half gets a band; one reaching the top does not', () => {
  const low = { width: 3840, height: 2160, minY: 1850, maxY: 2100, windows: 2 };
  const r = pgsBandFor(low, { w: 1920, h: 1080 });
  assert.ok(r.band); assert.ok(r.band.height < 200 && r.band.height >= 64, String(r.band.height));
  assert.equal(r.band.y, 1080 - r.band.height);
  const high = { width: 1920, height: 1080, minY: 80, maxY: 1000, windows: 3 };
  assert.equal(pgsBandFor(high, { w: 1920, h: 1080 }).band, null);
});

test('the builder crops the subtitle frames to the band and composites at its y', () => {
  const profile = { backend: 'vaapi', device: '/dev/dri/renderD128', codec: 'hevc', width: 1920, height: 1080, videoBitrate: '16000k', gpuFull: true, gpuSubs: true, overlay: [], gopSeconds: 1 };
  const video = { codec: 'hevc', pixFmt: 'yuv420p10le', width: 3840, height: 2160, frameRate: '24000/1001', sar: '1:1', dar: '16:9' };
  const band = pgsBandFor({ width: 3840, height: 2160, minY: 1850, maxY: 2100, windows: 2 }, { w: 1920, h: 1080 }).band;
  const args = buildSourceArgs({ srcPath: '/x.mkv', profile, selection: { video, subtitle: { codec: 'hdmv_pgs_subtitle', bitmap: true, typeIndex: 2 } }, duration: 1400, overlayImages: [], overlayLayer: () => null, subBand: band }).join(' ');
  assert.ok(new RegExp(`\\[0:s:2\\]select=.*?,crop=w=iw:h=ih\\*0\\.\\d+:x=0:y=ih\\*0\\.\\d+,scale=1920:${band.height}:`).test(args), args.slice(args.indexOf('[0:s:2]'), args.indexOf('[0:s:2]') + 160));
  assert.ok(args.includes(`s=1920x${band.height}:`), 'canvas is the band');
  assert.ok(args.includes(`overlay_vaapi=x=0:y=${band.y}`), 'composited at the band');
});
