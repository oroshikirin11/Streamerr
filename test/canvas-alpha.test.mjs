/**
 * Every subtitles filter on a transparent canvas carries :alpha=1 — each
 * one, not the chain's tail.
 *
 * A subtitles filter without alpha=1 leaves the canvas's alpha channel
 * untouched; on an all-transparent canvas that is glyphs with alpha zero,
 * drawn and invisible once composited. The canvas builders used to append
 * `:alpha=1` to the COMBINED string, so the moment a Studio text overlay
 * chained a second filter on, only the overlay kept alpha and the actual
 * subtitles vanished from the stream — "activate overlays and subtitles
 * disappear", on air. Pixel-measured with ffmpeg: srt-then-overlay with a
 * tail alpha renders 0 visible subtitle pixels; alpha on each, 1776.
 *
 * Run: node test/canvas-alpha.test.mjs
 */
import { buildSubtitleFilter } from '../src/ffmpeg/tracks.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const alphaOnEvery = (chain) => chain != null
  && chain.split(/,(?=subtitles=)/).every((f) => f.includes(':alpha=1'));

const srt = { codec: 'subrip', typeIndex: 0 };

console.log('\nthe canvas chain, with and without a Studio overlay');
{
  const plain = buildSubtitleFilter(srt, '/m/x.mkv', { extractedPath: '/c/x.srt' });
  check('no overlay: one filter, alpha on it', alphaOnEvery(plain.canvasFilter), true);
  check('...and the burn-in variant carries none (opaque video needs none)',
    plain.filter.includes(':alpha=1'), false);

  const chained = buildSubtitleFilter(srt, '/m/x.mkv',
    { extractedPath: '/c/x.srt', overlayPath: '/c/overlay-1.ass' });
  check('overlay chained: TWO filters', chained.canvasFilter.split('subtitles=').length - 1, 2);
  check('...alpha on EVERY one of them', alphaOnEvery(chained.canvasFilter), true);
  check('...the real subs first, the overlay after',
    chained.canvasFilter.indexOf('x.srt') < chained.canvasFilter.indexOf('overlay-1.ass'), true);
  check('...while the burn-in variant still carries no alpha at all',
    chained.filter.includes(':alpha=1'), false);
}

console.log('\nan overlay with no subtitles at all still renders visibly');
{
  const only = buildSubtitleFilter(null, '/m/x.mkv', { overlayPath: '/c/overlay-1.ass' });
  check('the lone overlay filter has alpha on the canvas', alphaOnEvery(only.canvasFilter), true);
  check('and none burned in', only.filter.includes(':alpha=1'), false);
}

console.log('\nin-band and external sources get the same treatment');
{
  const inband = buildSubtitleFilter(srt, '/m/x.mkv', { overlayPath: '/c/ov.ass' });
  check('in-band chain: alpha on every filter', alphaOnEvery(inband.canvasFilter), true);
  const ext = buildSubtitleFilter({ ...srt, external: true, path: '/s/x.srt' }, '/m/x.mkv',
    { overlayPath: '/c/ov.ass' });
  check('external chain: alpha on every filter', alphaOnEvery(ext.canvasFilter), true);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
