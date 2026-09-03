import test from 'node:test';
import assert from 'node:assert/strict';
import { censorBoxes, censorStage } from '../src/ffmpeg/censor.js';
import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';
import { overlayAss } from '../src/ffmpeg/overlay-ass.js';
import { cases } from './fixtures/source-args-cases.mjs';

const box = { id: 'c', type: 'censor', x: 0.5, y: 0.5, w: 0.25, h: 0.2, strength: 5, enabled: true };
const F = { width: 1920, height: 1080 };

test('censorBoxes keeps only enabled censor items, clamped and typed', () => {
  const out = censorBoxes([
    box, { ...box, enabled: false }, { ...box, type: 'text' }, null,
    { ...box, x: 2, y: -1, w: 5, h: 0.5, strength: '99' }, { ...box, w: 0 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { x: 0.5, y: 0.5, w: 0.25, h: 0.2, strength: 5 });
  assert.deepEqual(out[1], { x: 1, y: 0, w: 1, h: 0.5, strength: 10 });
});

test('GPU stage: crop, shrink, blow up, overlay at the same origin', () => {
  const g = censorStage(censorBoxes([box]), { ...F, inLabel: 'b0', outLabel: 'b', gpu: true });
  assert.equal(g,
    '[b0]split=2[cz0a][cz0b];'
    + '[cz0b]crop=480:216:720:432,scale_vaapi=w=12:h=5,scale_vaapi=w=480:h=216[cz0z];'
    + '[cz0a][cz0z]overlay_vaapi=x=720:y=432[b]');
});

test('CPU stage uses the software scaler and overlay', () => {
  const g = censorStage(censorBoxes([box]), { ...F, inLabel: 'o0', outLabel: 'o', gpu: false });
  assert.equal(g,
    '[o0]split=2[cz0a][cz0b];'
    + '[cz0b]crop=480:216:720:432,scale=12:5,scale=480:216[cz0z];'
    + '[cz0a][cz0z]overlay=720:432[o]');
});

test('boxes chain, and every edge stays even', () => {
  const g = censorStage(censorBoxes([box, { ...box, x: 0.1, y: 0.1, w: 0.101, h: 0.077 }]),
    { ...F, inLabel: 'i', outLabel: 'o', gpu: true });
  assert.match(g, /\[i\]split=2\[cz0a\]\[cz0b\];.*\[cz0o\];\[cz0o\]split=2\[cz1a\]\[cz1b\];.*\[o\]$/);
  for (const m of g.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
    for (const v of m.slice(1)) assert.equal(Number(v) % 2, 0, g);
  }
});

test('a pillarboxed stage shifts and clips the box to the content rect', () => {
  // 4:3 content in a 16:9 frame: rect 1440x1080 at x=240.
  const stage = { x: 240, y: 0, w: 1440, h: 1080 };
  const g = censorStage(censorBoxes([{ ...box, x: 0.05, w: 0.3 }]),
    { ...F, stage, inLabel: 'b0', outLabel: 'b', gpu: true });
  // Left edge is off the picture at -192px in frame space, so it clips to
  // 0 after the shift; the right edge lands at 384-240=144.
  assert.match(g, /crop=144:216:0:432/);
  assert.match(g, /overlay_vaapi=x=0:y=432/);
  // Entirely in the bars: nothing to do, labels still join.
  assert.equal(censorStage(censorBoxes([{ ...box, x: 0.02, w: 0.04 }]),
    { ...F, stage, inLabel: 'b0', outLabel: 'b', gpu: true }), '[b0]null[b]');
});

test('a censor box is not an ASS event', () => {
  const ass = overlayAss([box, { ...box, type: 'text', text: 'hi' }], { width: 1920, height: 1080 });
  assert.equal((ass.match(/^Dialogue:/gm) ?? []).length, 1);
});

test('every source graph carries the stage and none passes through', () => {
  let n = 0;
  for (const [name, params] of Object.entries(cases)) {
    const p = structuredClone(params);
    p.profile.overlay = [...(p.profile.overlay ?? []), box];
    const args = buildSourceArgs(p);
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.ok(args.includes('-filter_complex'), `${name}: no filter_complex`);
    assert.ok(!args.includes('-vf'), `${name}: -vf beside a censor box`);
    assert.match(graph, /crop=\d+:\d+:\d+:\d+,scale(_vaapi)?=/, `${name}: no censor stage`);
    assert.equal(args.filter((a) => a === 'copy').length, 0, `${name}: copied video`);
    // Labels must pair up: every [x] written is read exactly once, except
    // the mapped output.
    const labels = graph.match(/\[[a-z0-9:]+\]/g);
    for (const l of new Set(labels)) {
      if (/^\[\d/.test(l)) continue;
      const k = labels.filter((x) => x === l).length;
      assert.ok(k === 2 || (l === '[v]' && k === 1), `${name}: label ${l} used ${k}x in ${graph}`);
    }
    n++;
  }
  assert.ok(n > 3);
});
