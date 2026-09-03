import test from 'node:test';
import assert from 'node:assert/strict';
import { fillOverlayText, overlayAss } from '../src/ffmpeg/overlay-ass.js';

const cap = (text) => ({ id: 't', type: 'text', text, x: 0.5, y: 0.1, size: 0.06, enabled: true });

test('placeholders fill from the clip and its number', () => {
  const [a] = fillOverlayText([cap('Now: {name} · {series} / {title} · #{count}')],
    { item: { series: 'Mr. Robot', title: 'S1E1 — hellofriend' }, count: 3 });
  assert.equal(a.text, 'Now: Mr. Robot — S1E1 — hellofriend · Mr. Robot / S1E1 — hellofriend · #3');
  const [f] = fillOverlayText([cap('{name}|{series}|{count}')], { item: { title: 'A Film' } });
  assert.equal(f.text, 'A Film||');
  // The queue's own display title already leads with the series.
  const [q] = fillOverlayText([cap('{name} / {title}')],
    { item: { series: 'Death Note', title: 'Death Note — S1E1' } });
  assert.equal(q.text, 'Death Note — S1E1 / S1E1');
});

test('plain captions and other item types are returned as they are', () => {
  const items = [cap('Hello'), { id: 'i', type: 'image', file: 'x.png' }, { id: 'c', type: 'censor', text: '{count}' }];
  const out = fillOverlayText(items, { item: { title: 'T' }, count: 1 });
  assert.equal(out[0], items[0]);
  assert.equal(out[1], items[1]);
  assert.equal(out[2], items[2]);
});

test('a title with braces cannot smuggle an override tag into the script', () => {
  const items = fillOverlayText([cap('{name}')], { item: { title: 'Evil {\\an1}Title' }, count: 1 });
  const ass = overlayAss(items, { width: 1920, height: 1080 });
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  // Everything after the generator's own tag block must be brace-free.
  const body = line.slice(line.indexOf('}') + 1);
  assert.ok(body.includes('Evil') && !/[{}]/.test(body), line);
});
