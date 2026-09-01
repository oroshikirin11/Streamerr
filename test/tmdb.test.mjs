/**
 * TMDB metadata: matching, enrichment, miss caching, pruning.
 * Network is stubbed — this is about the matching logic and the decorator
 * contract, which is what breaks. Run: node test/tmdb.test.mjs
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TmdbMeta, TmdbLibrary, normTitle, titleYear, scrubQuery } from '../src/library/tmdb.js';

let ok = 0;
let fail = 0;
const check = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? ok += 1 : fail += 1; };

check('normTitle strips year and punctuation',
  normTitle('Shaman King (2021)') === 'shaman king'
  && normTitle("JoJo's Bizarre Adventure!") === 'jojos bizarre adventure');
check('titleYear reads the folder year', titleYear('Backrooms (2026)') === '2026');

// ── stubbed TMDB ──
const calls = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  calls.push(u.pathname + '?' + u.searchParams.toString());
  const body = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.pathname.endsWith('/search/tv')) {
    if (u.searchParams.get('query').includes('unknowable')) return body({ results: [] });
    return body({ results: [
      { id: 1, name: 'Shaman King Flowers', first_air_date: '2024-01-01', popularity: 20, poster_path: '/f.jpg' },
      { id: 2, name: 'SHAMAN KING', first_air_date: '2021-04-01', popularity: 50, poster_path: '/sk.jpg', overview: 'x' },
    ] });
  }
  if (u.pathname.endsWith('/search/movie')) {
    if (u.searchParams.get('query') === 'apocalypto') {
      // Only a substring candidate: the guarded picker must refuse it.
      return body({ results: [
        { id: 7, title: 'Tenacious D: Post-Apocalypto', release_date: '2020-01-01', popularity: 8, poster_path: '/t.jpg' },
      ] });
    }
    return body({ results: [
      { id: 9, title: 'Backrooms', release_date: '2026-05-01', popularity: 3, poster_path: '/b.jpg' },
    ] });
  }
  if (/\/movie\/55$/.test(u.pathname)) {
    return body({ id: 55, title: 'Apocalypto', release_date: '2006-12-08', poster_path: '/a.jpg', overview: 'y' });
  }
  if (/\/tv\/2\/season\/1$/.test(u.pathname)) {
    return body({ episodes: [
      { episode_number: 1, name: 'The Boy Who Dances with Ghosts' },
      { episode_number: 2, name: 'Another Shaman' },
    ] });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const dir = mkdtempSync(join(tmpdir(), 'tmdb-'));
const meta = new TmdbMeta({ cacheDir: dir });
meta.setKey('k3y');

const sk = await meta.ensure('Series', 'Shaman King (2021)', '2021');
check('exact title + year wins over prefix match', sk?.id === 2 && sk.title === 'SHAMAN KING');
check('lookup hits the cache under the folder title',
  meta.lookup('tv', 'Shaman King (2021)', '2021')?.id === 2);

await meta.ensureSeason(sk, 1);
check('episode names cached per season',
  meta.episodeName(sk, 1, 1) === 'The Boy Who Dances with Ghosts');

const before = calls.length;
await meta.ensure('Series', 'Shaman King (2021)', '2021');
check('a fresh entry costs no request', calls.length === before);

const miss = await meta.ensure('Series', 'unknowable show', null);
const missCalls = calls.length;
await meta.ensure('Series', 'unknowable show', null);
check('a miss is cached and not re-asked', miss === null && calls.length === missCalls);

// ── decorator ──
const media = {
  _stills: true,
  async libraries() { return [{ id: 'l' }]; },
  async items() {
    return { total: 2, items: [
      { id: 'a', title: 'Shaman King (2021)', year: '2021', type: 'Series', image: null },
      { id: 'b', title: 'Backrooms (2026)', year: '2026', type: 'Movie', image: '/api/library/image/local' },
    ] };
  },
  async episodes() {
    return [{ id: 'e1', type: 'Episode', title: 'Ep01', seriesName: 'Shaman King (2021)',
      season: 1, episode: 1, image: null }];
  },
  async item() { return { id: 'a', title: 'Shaman King (2021)', type: 'Series' }; },
  async seasons() { return []; },
  async nextEpisode() { return null; },
  imagePath(id) { return id === 'local' ? '/x/poster.jpg' : null; },
  size() { return 1; },
};
const lib = new TmdbLibrary(media, meta);
await meta.ensure('Movie', 'Backrooms (2026)', '2026');

const page = await lib.items('l');
check('series gets canonical title and a proxied poster',
  page.items[0].title === 'SHAMAN KING' && /\/api\/library\/image\/tmdb-/.test(page.items[0].image));
check('items carry the cache key for the fix picker, derived from the RAW title',
  page.items[0].metaKey === TmdbMeta.keyFor('tv', 'Shaman King (2021)', '2021')
  && page.items[0].rawTitle === 'Shaman King (2021)'
  && page.items[0].metaType === 'tv');
check('local artwork wins over TMDB', page.items[1].image === '/api/library/image/local');
check('movie title enriched', page.items[1].title === 'Backrooms');

const eps = await lib.episodes('a');
check('episode gets its TMDB name and canonical series',
  eps[0].title === 'The Boy Who Dances with Ghosts' && eps[0].seriesName === 'SHAMAN KING');

const artId = /image\/(tmdb-[a-f0-9]+)/.exec(page.items[0].image)?.[1];
check('art id resolves to the TMDB url',
  lib.imagePath(artId) === 'https://image.tmdb.org/t/p/w500/sk.jpg');
check('unknown art id falls through to media', lib.imagePath('local') === '/x/poster.jpg');
check('_stills proxies to the media half', lib._stills === true);

// ── scrubbed queries & guarded matching ──
const s1 = scrubQuery('Apocalypto 2006 2160p HDR DV x265-BEN THE MEN');
check('release noise is cut and the bare year becomes the hint',
  s1.q === 'apocalypto' && s1.year === '2006');
check('parenthesised year still wins', scrubQuery('Backrooms (2026)').year === '2026');

const weak = await meta.ensure('Movie', 'Apocalypto 2006 2160p HDR DV x265-BEN THE MEN', null);
check('a substring-only candidate is refused, not guessed', weak === null);

// ── operator correction (assign) ──
const apKey = TmdbMeta.keyFor('movie', 'Apocalypto 2006 2160p HDR DV x265-BEN THE MEN', null);
const pinned = await meta.assign(apKey, 55);
check('assign replaces the miss with the chosen entry',
  pinned.title === 'Apocalypto' && meta._entries[apKey]?.pinned === true);
const reqs = calls.length;
const again = await meta.ensure('Movie', 'Apocalypto 2006 2160p HDR DV x265-BEN THE MEN', null);
check('a pinned entry is never re-matched', again?.id === 55 && calls.length === reqs);
check('assign rejects junk keys',
  await meta.assign('garbage', 55).then(() => false, () => true));

// ── pruning ──
const seen = new Set([TmdbMeta.keyFor('tv', 'Shaman King (2021)', '2021')]);
const dropped = meta.prune(seen);
check('titles gone from the library lose their cache',
  dropped >= 1 && meta.lookup('movie', 'Backrooms (2026)', '2026') === null
  && meta.lookup('tv', 'Shaman King (2021)', '2021')?.id === 2);

// ── movies shelf outranks the per-folder type heuristic ──
const media2 = {
  async libraries() { return [{ id: 'm', type: 'movies' }]; },
  async items() {
    return { total: 1, items: [
      { id: 'g', title: 'Ghost in the Shell (1995)', year: '1995', type: 'Series', image: null },
    ] };
  },
  imagePath() { return null; },
};
const lib2 = new TmdbLibrary(media2, meta);
const p2 = await lib2.items('m');
check('a movies shelf forces the movie key even for Series-typed folders',
  p2.items[0].metaKey === TmdbMeta.keyFor('movie', 'Ghost in the Shell (1995)', '1995')
  && p2.items[0].metaType === 'movie');

// ── operator rejection (clear) ──
const skKey = TmdbMeta.keyFor('tv', 'Shaman King (2021)', '2021');
meta.clear(skKey);
check('clear drops the match', meta.lookup('tv', 'Shaman King (2021)', '2021') === null);
const reqs2 = calls.length;
const after = await meta.ensure('Series', 'Shaman King (2021)', '2021');
check('a cleared title is never re-matched', after === null && calls.length === reqs2);

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
