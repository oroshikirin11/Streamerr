/**
 * A live track switch belongs to the work it was made for.
 *
 * Switching Death Note to English subtitles is a statement about Death
 * Note. Carried further it became a decision about the film queued
 * behind it — which has its own languages and its own releases, and
 * which lost HDR outright, since a clip with subtitles to draw cannot
 * take the passthrough path. Episodes of one series share a work and
 * keep the choice between them; every film is its own work.
 *
 * Run: node test/track-scope.test.mjs
 */
import { workKeyOf } from '../src/ffmpeg/tracks.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const same = (a, b) => workKeyOf(a) === workKeyOf(b) && workKeyOf(a) !== '';

const dn1 = { id: 'a1', series: 'Death Note', title: 'Death Note — S1E1' };
const dn2 = { id: 'a2', series: 'Death Note', title: 'Death Note — S1E2' };
const frieren = { id: 'b1', series: 'Frieren', title: 'Frieren — S1E1' };
const backrooms = { id: 'm1', series: null, title: 'Backrooms' };
const otherFilm = { id: 'm2', series: null, title: 'Apocalypto' };

console.log('\nwhat a live switch applies to');

check('another episode of the same series keeps it', same(dn1, dn2), true);
check('a different series does NOT', same(dn1, frieren), false);
check('a film after a series does NOT', same(dn1, backrooms), false);
check('a series after a film does NOT', same(backrooms, dn1), false);
check('one film never speaks for another', same(backrooms, otherFilm), false);
check('the same film does keep its own choice', same(backrooms, { ...backrooms }), true);

// The series NAME is the key, because one show can be queued from two
// sources in a single broadcast and the ids would not match.
check('the same series from another source still matches',
  same(dn1, { id: 'zzz-other-source', series: 'Death Note', title: 'DN — S1E3' }), true);
check('...case and stray spacing do not split a series',
  same(dn1, { id: 'x', series: '  death note ' }), true);

// A queue row with neither is not a work: it must not silently match
// every other unidentified row.
check('an item with no series and no id has no work', workKeyOf({}), '');
check('...and two such rows do not match each other', same({}, {}), false);
check('a null item is safe', workKeyOf(null), '');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
