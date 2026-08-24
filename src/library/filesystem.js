/**
 * A plain directory as a library, for people not running Jellyfin.
 *
 * Metadata comes from two places, both already on disk: the folder layout
 * (Show / Season 01 / Show - S01E02 - Title.mkv) and the artwork the arr
 * stack writes alongside the media (poster.jpg, folder.jpg, fanart.jpg).
 * That gives a real poster grid with no TMDB key and no scraping.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';

const VIDEO_EXTS = new Set([
  '.mkv', '.mp4', '.avi', '.m4v', '.mov', '.ts', '.webm', '.mpg', '.mpeg', '.wmv',
]);
const POSTER_NAMES = ['poster.jpg', 'poster.png', 'folder.jpg', 'folder.png', 'cover.jpg'];

const id = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Season/episode from the usual naming conventions. */
export function parseEpisode(name) {
  const stem = basename(name, extname(name));

  // S01E02, s01e02, 1x02, S01E02-E03
  let m = /[sS](\d{1,3})[\s._-]*[eE](\d{1,4})(?:[\s._-]*[eE](\d{1,4}))?/.exec(stem);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: m[3] ? Number(m[3]) : null,
      title: cleanTitle(stem, m[0]),
    };
  }
  m = /(?:^|[\s._-])(\d{1,2})[xX](\d{1,3})(?:[\s._-]|$)/.exec(stem);
  if (m) {
    return {
      season: Number(m[1]),
      episode: Number(m[2]),
      episodeEnd: null,
      title: cleanTitle(stem, m[0]),
    };
  }
  // Bare "- 05 -" or "Ep05", common in anime releases
  m = /(?:[\s._-]|^)(?:[eE][pP]?)?(\d{1,3})(?:[\s._-]|$)/.exec(stem);
  if (m && Number(m[1]) > 0 && Number(m[1]) < 999) {
    return { season: 1, episode: Number(m[1]), episodeEnd: null, title: cleanTitle(stem, m[0]) };
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
    .replace(/[._]/g, ' ')
    .trim();
  return cleaned || stem;
}

function findPoster(dir) {
  for (const name of POSTER_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
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

export class FilesystemLibrary {
  /** @param {object} opts @param {string[]} opts.roots */
  constructor({ roots = [] } = {}) {
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

  async libraries() {
    return this.roots.map((r) => {
      this._paths.set(id(r), r);
      return { id: id(r), name: basename(r) || r, type: 'mixed', locations: [r] };
    });
  }

  async items(libraryId, { startIndex = 0, limit = 100, search } = {}) {
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
      return {
        id: id(dir),
        title: name,
        year: /\((\d{4})\)/.exec(name)?.[1] ?? null,
        type: 'Series',
        childCount: null,
        image: poster ? `/api/library/image/${id(poster)}` : null,
      };
    });

    return { total: names.length, items: page };
  }

  async seasons(seriesId) {
    const dir = this._paths.get(seriesId);
    if (!dir) throw new Error('Unknown item');

    const subdirs = listDirs(dir);
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
        image: poster ? `/api/library/image/${id(poster)}` : null,
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

    const dirs = seasonId ? [dir] : [dir, ...listDirs(dir).map((d) => join(dir, d))];
    const out = [];

    for (const d of dirs) {
      for (const file of listVideos(d)) {
        const full = join(d, file);
        this._paths.set(id(full), full);
        const parsed = parseEpisode(file);
        out.push({
          id: id(full),
          type: 'Episode',
          title: parsed.title,
          seriesId,
          seriesName: basename(dir),
          season: parsed.season,
          episode: parsed.episode,
          duration: null, // ffprobe on every file would make browsing slow
          path: full,
          sourcePath: full,
          image: null,
        });
      }
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
    const parsed = parseEpisode(basename(p));
    return {
      id: itemId, type: 'Episode', title: parsed.title,
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
