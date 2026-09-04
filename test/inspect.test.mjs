import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectVerdict, summaryOf, bitDepthOf, fpsOf } from '../src/inspect.js';

const hevc10 = { codec: 'hevc', width: 1920, height: 1080, hdr: true, pixFmt: 'yuv420p10le', frameRate: '24000/1001' };
const h264 = { codec: 'h264', width: 1920, height: 1080, hdr: false, pixFmt: 'yuv420p', frameRate: '25/1' };
const enc = { codec: 'hevc', width: 1920, height: 1080, fps: 30, fpsMode: 'auto', hdrOutput: true, copyLimitKbps: 30000 };

test('helpers', () => {
  assert.equal(bitDepthOf('yuv420p10le'), 10);
  assert.equal(bitDepthOf('yuv420p'), 8);
  assert.equal(bitDepthOf(null), null);
  assert.equal(fpsOf('24000/1001'), 23.976);
  assert.equal(fpsOf('25/1'), 25);
});

test('passthrough when every gate passes', () => {
  const v = inspectVerdict({ video: hevc10, audio: [{ codec: 'flac', channels: 6, language: 'jpn' }], chosen: { audio: { codec: 'flac' }, subtitle: null }, kbps: 12000, encoder: enc });
  assert.equal(v.passthrough, true);
  assert.match(v.will, /^Passthrough/);
  assert.equal(v.reasons.length, 0);
  assert.ok(v.notes.some((n) => /keyframe/.test(n)));
});

test('each gate names itself', () => {
  const sub = { codec: 'ass', language: 'eng', external: false };
  const v = inspectVerdict({ video: hevc10, chosen: { subtitle: sub }, kbps: 42000, encoder: { ...enc, hdrOutput: false }, overlaysOn: true });
  assert.equal(v.passthrough, false);
  assert.match(v.will, /^Transcode → HEVC 1920×1080/);
  assert.equal(v.reasons.length, 4, v.reasons.join(' | '));
  assert.match(v.reasons[0], /burned in \(ENG ASS, chosen by default\)/);
  assert.match(v.reasons[1], /overlays are on air/);
  assert.match(v.reasons[2], /tone-mapped/);
  assert.match(v.reasons[3], /42000 kbps is above the 30000/);
  assert.ok(v.notes.some((n) => /10-bit decode/.test(n)));
});

test('an H.264 output never passes through; an H.264 source into HEVC does not either', () => {
  assert.match(inspectVerdict({ video: h264, encoder: { ...enc, codec: 'h264' } }).reasons[0], /only for an HEVC output/);
  assert.match(inspectVerdict({ video: h264, encoder: enc }).reasons[0], /source is H264 and the output is HEVC/);
  assert.match(inspectVerdict({ video: null, encoder: enc }).will, /Cannot play/);
});

test('the one-line summary', () => {
  assert.equal(summaryOf({ video: hevc10, audio: [{ codec: 'flac', channels: 6, language: 'jpn' }, { codec: 'aac', channels: 2, language: 'eng' }], subtitles: [{}, {}] }), 'HEVC 10-bit 1080p HDR · JPN 5.1 +1 · 2 subs');
  assert.equal(summaryOf({ video: h264, audio: [{ codec: 'aac', channels: 2, language: 'eng' }], subtitles: [] }), 'H264 1080p · ENG stereo · no subs');
});
