/**
 * A plain directory as a library, for people not running Jellyfin.
 *
 * Metadata comes from two places, both already on disk: the folder layout
 * (Show / Season 01 / Show - S01E02 - Title.mkv) and the artwork the arr
 * stack writes alongside the media (poster.jpg, folder.jpg, fanart.jpg).
 * That gives a real poster grid with no TMDB key and no scraping.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { createHash } from 'crypto';

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.webm', '.mpg', '.mpeg', '.wmv',
]);
const POSTER_NAMES = ['poster.jpg', 'poster.png', 'folder.jpg', 'folder.png', 'cover.jpg'];

const id = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Image url carrying the file's mtime, so replacing the artwork busts every
 *  cached copy instead of waiting out a max-age. */
function imageUrl(path) {
  let v = 0;
  try { v = Math.floor(statSync(path).mtimeMs); } catch { /* keep 0 */ }
  return `/api/library/image/${id(path)}?v=${v}`;
}

/** Season/episode from the usual naming conventions. */
export function parseEpisode(name, { allowBareNumber = true } = {}) {
  const stem = basename(name, extname(name));

  // S01E02, s01e02, 1x02, S01E02-E03
  let m = /[sS](\d{1,3})[\s._-]*[eE](\d{1,4})(?:[\s._-]*[eE](\d{1,4}))?/.exec(stem);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: m[3] ? Number(m[3]) : null,
      title: cleanTitle(stem, m[0]) ?? `Episode ${Number(m[2])}`,
    };
  }
  m = /(?:^|[\s._-])(\d{1,2})[xX](\d{1,3})(?:[\s._-]|$)/.exec(stem);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: null,
      title: cleanTitle(stem, m[0]) ?? `Episode ${Number(m[2])}`,
    };
  }
  // Bare "- 05 -" or "Ep05", common in anime releases. Only trustworthy
  // when the folder already says these are episodes; see the caller.
  // `(?:v\d)?` covers the anime convention of a re-release: "- 12v2 -".
  m = allowBareNumber
    ? /(?:[\s._-]|^)(?:[eE][pP]?)?(\d{1,3})(?:[vV]\d)?(?:[\s._-]|$)/.exec(stem)
    : null;
  if (m && Number(m[1]) > 0 && Number(m[1]) < 999) {
    return {
      season: 1, episode: Number(m[1]), episodeEnd: null,
      title: cleanTitle(stem, m[0]) ?? `Episode ${Number(m[1])}`,
    };
  }
  return { season: null, episode: null, episodeEnd: null, title: stem };
}

function cleanTitle(stem, matched) {
  const after = stem.slice(stem.indexOf(matched) + matched.length);
  const cleaned = after
    .replace(/^[\s._-]+/, '')
    // Strip the usual release-quality suffixes.
    .replace(/[\s._-]*(WEBDL|WEB-DL|WEBRip|BluRay|BDRip|HDTV|DVDRip|REMUX)[\s._-]*\d{0,4}[pP]?.*$/i, '')
    .replace(/[\s._-]*\d{3,4}[pP].*$/, '')
    // Release groups and tags in brackets: "[1080p]", "(Dual Audio)".
    // Removing the contents used to leave the brackets behind, which is
    // how an episode ended up titled "[".
    .replace(/[[(][^\])]*[\])]?/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Nothing meaningful survives as punctuation alone.
    .replace(/^[\s.\-_·|~[\]()]+|[\s.\-_·|~[\]()]+$/g, '')
    .trim();
  // Too little left to be a title — the caller falls back to "Episode N",
  // which at least tells the viewer which episode they are looking at.
  return cleaned.length >= 2 ? cleaned : null;
}

/** Movies or shows, guessed from the folder name and what is inside. */
function guessCollectionType(dir) {
  const n = basename(dir).toLowerCase();
  if (/movie|film/.test(n)) return 'movies';
  if (/\btv\b|show|serie|anime/.test(n)) return 'tvshows';
  const subs = listDirs(dir);
  const withSeasons = subs.filter((c) => listDirs(join(dir, c)).some((x) => SEASON_DIR.test(x)));
  if (subs.length && withSeasons.length > subs.length / 2) return 'tvshows';
  return 'mixed';
}

function findPoster(dir) {
  for (const name of POSTER_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const STILL_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Episode still sitting next to the video, which is what Jellyfin, Plex and
 * tinyMediaManager all write: `Show - S01E01 - Title.jpg`, sometimes with a
 * `-thumb` suffix. One readdir per directory, cached, because a 25-episode
 * season would otherwise cost a hundred stat calls just to draw a list.
 */
function stillsIn(dir, cache) {
  let found = cache.get(dir);
  if (found) return found;
  found = new Map();
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      if (!STILL_EXTS.includes(ext)) continue;
      const stem = e.name.slice(0, -ext.length).replace(/-(thumb|poster|landscape)$/i, '');
      // A poster for the whole folder is not a still for one episode.
      if (POSTER_NAMES.includes(e.name.toLowerCase())) continue;
      if (!found.has(stem)) found.set(stem, join(dir, e.name));
    }
  } catch { /* unreadable directory — no stills, not an error */ }
  cache.set(dir, found);
  return found;
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(naturalSort);
  } catch {
    return [];
  }
}

function listVideos(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && VIDEO_EXTS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort(naturalSort);
  } catch {
    return [];
  }
}

/** "Episode 2" before "Episode 10" — plain string sort gets this wrong. */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Folder names the arr stack uses for seasons, in a few languages. */
const SEASON_DIR = /^(season|staffel|saison|temporada|s)[\s._-]*\d+$|^(specials|extras|ova|ovas)$/i;

/** Every video under `dir`, at any sensible depth, with its folder. */
function listVideosDeep(dir, maxDepth = 3, depth = 0) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isFile()) {
      if (VIDEO_EXTS.has(extname(e.name).toLowerCase())) out.push({ file: e.name, dir, full });
    } else if (e.isDirectory() && depth < maxDepth) {
      out.push(...listVideosDeep(full, maxDepth, depth + 1));
    }
  }
  return out;
}

function hasVideosDeep(dir, maxDepth = 3) {
  return listVideosDeep(dir, maxDepth).length > 0;
}

/**
 * Does this folder hold ONE title — a film, or a show with its seasons?
 *
 * The distinction matters because a media tree has one more level than the
 * poster grid does: `media/tv/Berserk/Season 1/*.mkv`. Pointing the library
 * at `media` should still put Berserk on the grid, not "tv".
 */
function isTitleDir(dir) {
  if (listVideos(dir).length) return true;
  const subs = listDirs(dir);
  if (subs.some((n) => SEASON_DIR.test(n))) return true;
  return false;
}

/** A folder of collections (`media` holding `movies` and `tv`). */
function isCollectionDir(dir) {
  const subs = listDirs(dir);
  if (!subs.length || listVideos(dir).length) return false;
  if (subs.some((n) => isTitleDir(join(dir, n)))) return false;
  return subs.some((n) => hasVideosDeep(join(dir, n)));
}

export class FilesystemLibrary {
  /** @param {object} opts @param {string[]} opts.roots */
  constructor({ roots = [], stills = true } = {}) {
    this._stills = stills;
    this.roots = roots.filter(Boolean);
    this._paths = new Map(); // synthetic id -> real path
  }

  get configured() {
    return this.roots.length > 0;
  }

  async test() {
    const missing = this.roots.filter((r) => !existsSync(r));
    if (missing.length) {
      throw new Error(`These directories do not exist: ${missing.join(', ')}`);
    }
    return { ok: true, roots: this.roots.length };
  }

  /**
   * Every media path under the configured roots.
   *
   * The other half of the catalogue match: these are the files we can
   * actually open, so they are the truth a reported path has to line up
   * with. Capped for the same reason as the catalogue side.
   */
  async allPaths({ limit = 5000 } = {}) {
    const out = [];
    const walk = (dir, depth) => {
      if (out.length >= limit || depth > 6) return;
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (VIDEO_EXTS.has(extname(e.name).toLowerCase())) out.push(full);
      }
    };
    for (const r of this.roots) walk(r, 0);
    return out;
  }

  async libraries() {
    const out = [];
    for (const r of this.roots) {
      // A root that holds collections rather than titles (`media` with
      // `movies` and `tv` inside) becomes one library per collection, so
      // the grid shows films and shows instead of the words "movies" and
      // "tv". Picking the obvious folder in the browser then just works.
      const dirs = isCollectionDir(r) ? listDirs(r).map((n) => join(r, n)) : [r];
      for (const d of dirs) {
        this._paths.set(id(d), d);
        out.push({
          id: id(d),
          name: basename(d) || d,
          type: guessCollectionType(d),
          locations: [d],
        });
      }
    }
    return out;
  }

  async items(libraryId, { startIndex = 0, limit = 100, search } = {}) {
    // The id map is filled by libraries(), so a client that asks for items
    // first — a tab left open across a restart, or a rebuild after a refresh
    // — would otherwise be told the library does not exist. Rebuilding the
    // map costs one readdir per root.
    if (!this._paths.has(libraryId)) await this.libraries();
    const root = this._paths.get(libraryId);
    if (!root) throw new Error('Unknown library');

    let names = listDirs(root);
    if (search) {
      const q = search.toLowerCase();
      names = names.filter((n) => n.toLowerCase().includes(q));
    }

    const page = names.slice(startIndex, startIndex + limit).map((name) => {
      const dir = join(root, name);
      this._paths.set(id(dir), dir);
      const poster = findPoster(dir);
      if (poster) this._paths.set(id(poster), poster);
      const videos = listVideosDeep(dir);
      // One file and no season folders is a film: the panel can queue it
      // straight away instead of asking which episode.
      const isMovie = videos.length === 1
        && !listDirs(dir).some((n) => SEASON_DIR.test(n));
      if (isMovie) this._paths.set(id(videos[0].full), videos[0].full);
      return {
        id: isMovie ? id(videos[0].full) : id(dir),
        title: name,
        year: /\((\d{4})\)/.exec(name)?.[1] ?? null,
        type: isMovie ? 'Movie' : 'Series',
        childCount: isMovie ? null : videos.length || null,
        image: poster ? imageUrl(poster) : null,
      };
    });

    return { total: names.length, items: page };
  }

  async seasons(seriesId) {
    const dir = this._paths.get(seriesId);
    if (!dir) throw new Error('Unknown item');

    // Only actual season folders. Any other subdirectory (extras, artwork,
    // a stray sample) is not a season and listing it as one turned the
    // season picker into a directory browser.
    const subdirs = listDirs(dir).filter((n) => SEASON_DIR.test(n));
    if (!subdirs.length) return [];

    return subdirs.map((name) => {
      const sub = join(dir, name);
      this._paths.set(id(sub), sub);
      const poster = findPoster(sub);
      if (poster) this._paths.set(id(poster), poster);
      return {
        id: id(sub),
        name,
        index: /(\d+)/.exec(name)?.[1] ? Number(/(\d+)/.exec(name)[1]) : null,
        image: poster ? imageUrl(poster) : null,
      };
    });
  }

  /**
   * Episodes in play order. Files directly in the series folder are included
   * alongside those in season subfolders, since both layouts are common.
   */
  async episodes(seriesId, { seasonId } = {}) {
    const dir = this._paths.get(seasonId || seriesId);
    if (!dir) throw new Error('Unknown item');

    const seriesDir = this._paths.get(seriesId) ?? dir;
    const out = [];
    const stillCache = new Map();

    // Recursive: episodes live in `Show/Season 1/`, and a scan one level
    // deep found nothing at all for every show organised that way.
    for (const { file, dir: fileDir, full } of listVideosDeep(dir)) {
      this._paths.set(id(full), full);
      // A bare number is only an episode number inside a season folder.
      // Applied to `Apocalypto 2006 2160p ... H265-BEN THE MEN.mkv` it
      // matched a fragment of the release name and titled the film after
      // whatever followed it.
      const inSeason = SEASON_DIR.test(basename(fileDir));
      const parsed = parseEpisode(file, { allowBareNumber: inSeason });
      const isEpisode = parsed.episode != null;
      // Films are named after their folder — `Backrooms (2026)` — because
      // the filename is a release string, not a title.
      const folder = basename(fileDir);
      const title = isEpisode
        ? parsed.title
        : (folder && !SEASON_DIR.test(folder) ? folder : parsed.title);
      out.push({
        id: id(full),
        type: isEpisode ? 'Episode' : 'Movie',
        title,
        seriesId,
        seriesName: basename(seriesDir),
        season: parsed.season,
        episode: parsed.episode,
        duration: null, // ffprobe on every file would make browsing slow
        path: full,
        sourcePath: full,
        image: (() => {
          const still = stillsIn(fileDir, stillCache).get(file.slice(0, -extname(file).length));
          if (still) {
            this._paths.set(id(still), still);
            return imageUrl(still);
          }
          // No sidecar: point at the media itself, and the image route
          // takes a frame from it. Nothing is decoded here — this is a
          // url, and the work happens only if it is requested.
          return this._stills ? imageUrl(full) : null;
        })(),
      });
    }

    // Season then episode, with unparsed names falling back to natural order.
    return out.sort((a, b) =>
      (a.season ?? 0) - (b.season ?? 0)
      || (a.episode ?? 0) - (b.episode ?? 0)
      || naturalSort(a.path, b.path));
  }

  async item(itemId) {
    const p = this._paths.get(itemId);
    if (!p) throw new Error('Unknown item');
    const st = statSync(p);
    if (st.isDirectory()) {
      return { id: itemId, title: basename(p), type: 'Series', path: p };
    }
    // Same naming rules as the listing, or a film queued straight from the
    // grid would go on air titled after its release string.
    const folder = basename(dirname(p));
    const inSeason = SEASON_DIR.test(folder);
    const parsed = parseEpisode(basename(p), { allowBareNumber: inSeason });
    const isEpisode = parsed.episode != null;
    return {
      id: itemId,
      type: isEpisode ? 'Episode' : 'Movie',
      title: isEpisode || !folder || inSeason ? parsed.title : folder,
      // The show this episode belongs to — one level up from a Season dir,
      // otherwise the containing folder. Without it an episode queued
      // straight from the grid went on air as a bare "Ep02", with no show
      // name in the title and nothing to group the schedule by.
      seriesName: isEpisode
        ? basename(inSeason ? dirname(dirname(p)) : dirname(p))
        : null,
      season: parsed.season, episode: parsed.episode,
      path: p, sourcePath: p,
    };
  }

  async nextEpisode(seriesId, currentId) {
    const list = await this.episodes(seriesId);
    const i = list.findIndex((e) => e.id === currentId);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  }

  /** Already a local path — no mapping needed, but confirm it's still there. */
  resolvePath(episode) {
    const p = episode.sourcePath ?? episode.path;
    if (!p || !existsSync(p)) throw new Error(`File not found: ${p}`);
    return p;
  }

  /** Local artwork is served through our own API rather than by URL. */
  imagePath(imageId) {
    return this._paths.get(imageId) ?? null;
  }
}
