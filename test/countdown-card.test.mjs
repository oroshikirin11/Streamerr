import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCountdownArgs, countdownBackgroundArgs } from '../src/ffmpeg/pipeline.js';

const profile = { backend: 'x264', codec: 'h264', width: 1920, height: 1080, fps: 30, fpsMode: 'auto', videoBitrate: '6000k', audioBitrate: '160k', gopSeconds: 2 };
const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

test('the card carries the lineup: one input and overlay per poster, a box where one is missing', () => {
  const args = buildCountdownArgs({
    profile, seconds: 90, heading: 'STARTING SOON', when: '20:00',
    nextTitle: 'Jujutsu Kaisen — S1E8 — Boredom',
    lineup: [
      { path: '/tmp/a.jpg', title: 'Jujutsu Kaisen — S1E8', at: 1_800_000_000 },
      { path: null, title: 'Jujutsu Kaisen — S1E9', at: null },
      { path: '/tmp/b.jpg', title: 'Mr. Robot — S1E3', at: 1_800_003_600 },
    ],
    endsAt: 1_800_007_200,
  });
  const g = graphOf(args);
  assert.equal(args.filter((a) => a === '-i').length, 4, 'gradient, silence, two posters');
  assert.equal(args[args.indexOf('/tmp/a.jpg') - 1], '-i');
  assert.match(g, /\[3:v\]scale=/, 'posters sit after the silence in the live fallback');
  assert.equal((g.match(/overlay=/g) ?? []).length, 2, 'one overlay per poster present');
  assert.equal((g.match(/drawbox=[^;]*t=fill/g) ?? []).length, 1, 'a placeholder box for the missing one');
  assert.match(g, /\[2:v\]scale=\d+:\d+:force_original_aspect_ratio=increase,crop=\d+:\d+\[p0\]/);
  assert.match(g, /text='Jujutsu Kaisen'/);
  assert.match(g, /text='S1E8 — Boredom'/);
  assert.match(g, /text='S1E8':[^;]*\n?/, 'short title under the first poster');
  assert.match(g, /text='STARTING SOON  ·  LIVE AT 20\\:00'/);
  assert.match(g, /text='UNTIL WE START'/);
  assert.match(g, /ends around \d\d\\:\d\d/);
  assert.match(g, /gradients|\[0:v\]drawgrid/);
  assert.ok(args.includes('-map') && args[args.indexOf('-map') + 1] === '[v]');
  assert.ok(args.includes('1:a'));
  assert.match(args[args.indexOf('-i') + 1], /^gradients=s=1920x1080:.*type=radial:speed=0:r=\d+$/);
});

test('an interval card reads UP NEXT, and no lineup still builds a whole card', () => {
  const args = buildCountdownArgs({ profile, seconds: 300, heading: 'UP NEXT', when: '22:30', nextTitle: 'A Film' });
  const g = graphOf(args);
  assert.match(g, /text='UP NEXT  ·  AT 22\\:30'/);
  assert.match(g, /text='UNTIL NEXT'/);
  assert.match(g, /text='A Film'/);
  assert.doesNotMatch(g, /overlay=/);
  assert.equal(args.filter((a) => a === '-i').length, 2);
});

test('titles cannot break the filter: quotes, colons and percent are stripped or escaped', () => {
  const args = buildCountdownArgs({ profile, seconds: 10, nextTitle: "It's 100% a:b — 'x'", when: '09:05' });
  const g = graphOf(args);
  assert.match(g, /text='Its 100 a\\:b'/);
  assert.match(g, /text='x'/);
  assert.match(g, /LIVE AT 09\\:05/);
});

test('with a rendered background the live card loops the picture and draws only the clock', () => {
  const args = buildCountdownArgs({ profile, seconds: 90, heading: 'STARTING SOON', when: '20:00', nextTitle: 'X — Y', lineup: [{ path: '/tmp/a.jpg', title: 'X — Y', at: 1 }], background: '/cache/card-abc.png' });
  const g = graphOf(args);
  assert.equal(args[args.indexOf('-loop') + 1], '1');
  assert.equal(args[args.indexOf('/cache/card-abc.png') - 1], '-i');
  assert.equal(args.filter((a) => a === '-i').length, 2, 'the picture and the silence, nothing else');
  assert.match(g, /^\[0:v\]drawtext=[^;]*eif[^;]*format=/, 'clock, then upload');
  assert.doesNotMatch(g, /overlay=|drawgrid|vignette|STARTING SOON/);
});

test('the background render draws everything but the clock, once', () => {
  const args = countdownBackgroundArgs({ profile, heading: 'UP NEXT', when: '22:30', nextTitle: 'X — Y', lineup: [{ path: '/tmp/a.jpg', title: 'X — Y', at: 1 }], endsAt: 2 }, '/cache/out.png');
  const g = graphOf(args);
  assert.match(args[args.indexOf('-i') + 1], /^gradients=.*speed=0:r=1$/);
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.equal(args[args.length - 1], '/cache/out.png');
  assert.match(g, /\[1:v\]scale=.*\[p0\]/, 'posters follow the gradient directly');
  assert.match(g, /UP NEXT  ·  AT 22\\:30/);
  assert.match(g, /UNTIL NEXT/);
  assert.doesNotMatch(g, /eif/);
});
