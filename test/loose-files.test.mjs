/**
 * Loose video files at a library's top level are media too.
 *
 * The listing only walked directories, so `Videos/Film.mkv` was invisible
 * while `Videos/Film/Film.mkv` played fine — never noticed against a
 * sorted library, immediate against a plain folder of films. A loose file
 * lists as a Movie whose id IS the file (the shape a one-film folder
 * already produces, so the panel plays it directly), and item() must not
 * title it after the library folder — the generic rule would have named
 * every loose film "Videos".
 *
 * Run: node test/loose-files.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FilesystemLibrary } from '../src/library/filesystem.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

const root = mkdtempSync(join(tmpdir(), 'streamerr-loose-'));
mkdirSync(join(root, 'Show A (2020)', 'Season 01'), { recursive: true });
writeFileSync(join(root, 'Show A (2020)', 'Season 01', 'Show A S01E01.mkv'), 'x');
mkdirSync(join(root, 'Solo Film (2019)'));
writeFileSync(join(root, 'Solo Film (2019)', 'film.mkv'), 'x');
writeFileSync(join(root, 'Loose Movie (2021).mkv'), 'x');
writeFileSync(join(root, 'Loose Movie (2021)-thumb.jpg'), 'x');
writeFileSync(join(root, 'Stray Show S01E05.mkv'), 'x');
writeFileSync(join(root, 'notes.txt'), 'x');

const lib = new FilesystemLibrary({ roots: [root], stills: true });
const libs = await lib.libraries();
check('one library for the root', libs.length, 1);

const { items, total } = await lib.items(libs[0].id);
check('folders AND loose files are listed', total, 4);
check('non-video files are not', items.some((i) => i.title.includes('notes')), false);

const loose = items.find((i) => i.title.startsWith('Loose Movie'));
check('a loose film lists as a Movie', loose?.type, 'Movie');
check('its year is read from the filename', loose?.year, '2021');
check('its sidecar still is its image', typeof loose?.image, 'string');

const looseItem = await lib.item(loose.id);
check('item() resolves the loose file as a Movie', looseItem.type, 'Movie');
check('item() does NOT title it after the library folder',
  looseItem.title.startsWith('Loose Movie'), true);
check('resolvePath opens it', lib.resolvePath(looseItem).endsWith('Loose Movie (2021).mkv'), true);

const stray = items.find((i) => i.title.includes('Stray') || i.title.includes('S01E05'));
const strayItem = await lib.item(stray.id);
check('an episode-named loose file carries no fake series',
  strayItem.seriesName, null);

const solo = items.find((i) => i.title.startsWith('Solo Film'));
check('one-film folders still list as Movies with the FILE id', solo?.type, 'Movie');
check('...and item() still titles those after their folder',
  (await lib.item(solo.id)).title, 'Solo Film (2019)');

const show = items.find((i) => i.title.startsWith('Show A'));
check('series folders are untouched', show?.type, 'Series');

const found = (await lib.items(libs[0].id, { search: 'loose' })).items;
check('search matches loose files', found.length === 1 && found[0].type === 'Movie', true);

// A fresh instance whose libraries() has not run yet — items() rebuilds the
// map itself, and the loose file must survive that path too.
const cold = new FilesystemLibrary({ roots: [root], stills: true });
const coldItems = await cold.items(libs[0].id);
check('a cold items() call still lists loose files', coldItems.total, 4);

rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
