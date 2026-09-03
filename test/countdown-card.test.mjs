import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCountdownArgs } from '../src/ffmpeg/pipeline.js';

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
  assert.match(args[args.indexOf('-i') + 1], /^gradients=s=1920x1080:.*type=radial$/);
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
