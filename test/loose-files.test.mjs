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

// ── Collection roots: `media/` holding `movies/` and `tv/` ─────────────
// A loose file dropped into the collection ROOT must neither vanish nor
// demote the whole root to a single library (which would turn the
// Movies/Shows shelves into two tiles named "movies" and "tv").
const media = mkdtempSync(join(tmpdir(), 'streamerr-coll-'));
mkdirSync(join(media, 'movies', 'Film X (2018)'), { recursive: true });
writeFileSync(join(media, 'movies', 'Film X (2018)', 'film.mkv'), 'x');
mkdirSync(join(media, 'tv', 'Show B (2022)', 'Season 01'), { recursive: true });
writeFileSync(join(media, 'tv', 'Show B (2022)', 'Season 01', 'Show B S01E01.mkv'), 'x');
writeFileSync(join(media, 'Concert Rip (2024) 1080p.mkv'), 'x');

console.log('\ncollection roots');
const clib = new FilesystemLibrary({ roots: [media], stills: true });
const clibs = await clib.libraries();
check('collections survive a loose file in the root',
  clibs.map((l) => l.name).sort(), ['movies', mediaName(media), 'tv'].sort());
function mediaName(p) { return p.split('/').pop(); }

const rootShelf = clibs.find((l) => l.name === mediaName(media));
const rootItems = await clib.items(rootShelf.id);
check('the root shelf lists ONLY the loose files',
  rootItems.items.map((i) => [i.title, i.type]), [['Concert Rip (2024)', 'Movie']]);

const movies = clibs.find((l) => l.name === 'movies');
const movieItems = await clib.items(movies.id);
check('the movies shelf is untouched',
  movieItems.items.map((i) => [i.title, i.type]), [['Film X (2018)', 'Movie']]);

// A loose file dropped INSIDE `movies/` lands on the Movies shelf.
writeFileSync(join(media, 'movies', 'Bare Film (2017).mkv'), 'x');
const clib2 = new FilesystemLibrary({ roots: [media], stills: true });
const movies2 = (await clib2.libraries()).find((l) => l.name === 'movies');
const movieItems2 = await clib2.items(movies2.id);
check('a loose file inside movies/ joins that shelf',
  movieItems2.items.map((i) => i.title).sort(), ['Bare Film (2017)', 'Film X (2018)']);

// ── Paired (Jellyfin-catalogue) setups ─────────────────────────────────
// The catalogue only lists what it indexes; the media half's loose
// shelves must union into the listing and route back to the media half.
console.log('\npaired union');
const { PairedLibrary } = await import('../src/library/paired.js');
const catalogue = {
  configured: true,
  libraries: async () => [{ id: 'jf-movies', name: 'Movies' }, { id: 'jf-shows', name: 'Shows' }],
  // Paths as the catalogue reports them (identity rules here): one row
  // whose folder exists, one whose file was deleted from the disk.
  items: async (libId) => (libId === 'jf-movies'
    ? { total: 2,
      items: [
        { id: 'jf-1', title: 'Catalogue Film', path: join(media, 'movies', 'Film X (2018)') },
        { id: 'jf-2', title: 'Deleted Film', path: join(media, 'movies', 'Gone (2001)', 'gone.mkv') },
      ] }
    : { total: 0, items: [] }),
  item: async (id) => { if (id !== 'jf-1') throw new Error(`Jellyfin has no item ${id}`); return { id, title: 'Catalogue Film', path: '/data/movies/x.mkv' }; },
  imagePath: () => null,
};
const pmedia = new FilesystemLibrary({ roots: [media], stills: true });
const paired = new PairedLibrary(catalogue, pmedia, []);

const plibs = await paired.libraries();
check('catalogue shelves plus the media loose shelf',
  plibs.map((l) => l.name).sort(), ['Movies', 'Shows', mediaName(media)].sort());

const pShelf = plibs.find((l) => l.loose);
const pItems = await paired.items(pShelf.id);
check('the loose shelf routes to the media half',
  pItems.items.map((i) => [i.title, i.fromMedia]), [['Concert Rip (2024)', true]]);

const pItem = await paired.item(pItems.items[0].id);
check('item() falls through to the media half, tagged',
  [pItem.title, pItem.fromMedia], ['Concert Rip (2024)', true]);
check('resolvePath serves it from the media half, unmapped',
  paired.resolvePath(pItem).endsWith('Concert Rip (2024) 1080p.mkv'), true);
// Disk truth on the catalogue's own shelf: the deleted row is hidden,
// the unindexed loose file inside movies/ joins the shelf, and the
// indexed folder-film stays exactly the catalogue's row.
const pMovies = await paired.items('jf-movies');
check('deleted catalogue rows are hidden by disk truth',
  pMovies.items.some((i) => i.title === 'Deleted Film'), false);
check('unindexed loose files join the catalogue shelf, tagged',
  pMovies.items.filter((i) => i.fromMedia).map((i) => i.title), ['Bare Film (2017)']);
check('the surviving catalogue row is untouched',
  pMovies.items[0], { id: 'jf-1', title: 'Catalogue Film', path: join(media, 'movies', 'Film X (2018)') });
check('the total reflects both reconciliations', pMovies.total, 2);

// Without loose files, no extra shelf appears at all.
rmSync(join(media, 'Concert Rip (2024) 1080p.mkv'));
const clib3 = new FilesystemLibrary({ roots: [media], stills: true });
check('no loose files, no extra shelf',
  (await clib3.libraries()).map((l) => l.name).sort(), ['movies', 'tv']);
const paired3 = new PairedLibrary(catalogue, clib3, []);
check('paired listing is catalogue-only again without strays',
  (await paired3.libraries()).map((l) => l.name).sort(), ['Movies', 'Shows']);

rmSync(media, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
