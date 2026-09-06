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

import { ensureScan, scanInFlight, unthrottleScans } from '../src/ffmpeg/pgsband.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('a scan is shared by every caller, survives an unthrottle, and settles to null for a file that is not there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgsband-'));
  try {
    const a = ensureScan('/nowhere/missing.mkv', 0, dir, { readrate: 3, onLog: () => {} });
    const b = ensureScan('/nowhere/missing.mkv', 0, dir, { readrate: 3, onLog: () => {} });
    assert.equal(a.key, b.key); assert.equal(a.joined, false); assert.equal(b.joined, true);
    assert.equal(scanInFlight('/nowhere/missing.mkv', 0), true);
    unthrottleScans();
    assert.equal(await a.promise, null); assert.equal(await b.promise, null);
    assert.equal(scanInFlight('/nowhere/missing.mkv', 0), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { pgsWindowsViaCues } from '../src/ffmpeg/mkvcues.js';
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';

function segAt(pts, type, payload) {
  const h = Buffer.alloc(13); h.write('PG', 0); h.writeUInt32BE(Math.round(pts * 90000), 2); h.writeUInt32BE(0, 6); h[10] = type; h.writeUInt16BE(payload.length, 11);
  return Buffer.concat([h, payload]);
}

test('the windows of a muxed PGS track are read through the cue index without a demux', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mkvcues-'));
  try {
    // Three cues, windows at the bottom of a 1280x720 frame, one second apart.
    const parts = [];
    for (let i = 0; i < 3; i++) {
      const t = i * 1.2;
      parts.push(segAt(t, 0x16, Buffer.concat([pcs(1280, 720, 1), Buffer.from([0, 1, 0, 0, 0x01, 0x40, 0x02, 0x3a])])),
        segAt(t, 0x17, wds([[320, 570, 640, 90]])), segAt(t, 0x80, Buffer.alloc(0)),
        segAt(t + 1, 0x16, pcs(1280, 720, 0)), segAt(t + 1, 0x17, wds([[320, 570, 640, 90]])), segAt(t + 1, 0x80, Buffer.alloc(0)));
    }
    const sup = join(dir, 't.sup'); writeFileSync(sup, Buffer.concat(parts));
    const mkv = join(dir, 't.mkv');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24', '-i', sup, '-t', '5', '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:s', 'copy', mkv], { stdio: ['ignore', 'ignore', 'pipe'] });
    assert.equal(r.status, 0, String(r.stderr));
    const scan = await pgsWindowsViaCues(mkv, 0);
    assert.ok(scan, 'windows found through the cues');
    assert.equal(scan.width, 1280); assert.equal(scan.height, 720);
    assert.equal(scan.minY, 570); assert.equal(scan.maxY, 660);
    assert.ok(scan.blocks >= 3);
    assert.equal(await pgsWindowsViaCues(mkv, 1), null, 'no second subtitle track');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
