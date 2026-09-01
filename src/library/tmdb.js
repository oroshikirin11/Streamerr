/**
 * TMDB metadata for libraries that have none of their own.
 *
 * The folder (or share) stays the source of truth for STRUCTURE — what
 * exists, how it is grouped, what plays. TMDB enriches what the filename
 * parser extracted: canonical titles, episode names, posters. This is the
 * same division Jellyfin and Sonarr use — parse locally, match against
 * the catalogue by title and year, cache the answer.
 *
 * Nothing here talks to TMDB on the browsing path. Lookups read a JSON
 * cache under the cache directory; the TmdbSweeper fills it in the
 * background, the same posture as the stills sweep. Entering the API key
 * is the whole setup: the sweeper notices, matches the library, and the
 * UI improves as answers land.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
/** A title TMDB does not know is re-asked rarely, not never. */
const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;
/** A matched entry is refreshed occasionally — posters and names drift. */
const STALE_MS = 30 * 24 * 3600 * 1000;

/** Matching key: lowercase, year stripped, punctuation collapsed. */
export function normTitle(s) {
  return String(s ?? '')
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9À-ɏ぀-ヿ一-鿿]+/gi, ' ')
    .trim().replace(/\s+/g, ' ');
}

/** The year inside "Show (2021)", if any. */
export function titleYear(s) {
  return /\((\d{4})\)/.exec(String(s ?? ''))?.[1] ?? null;
}

/**
 * Release-string noise, normalized form. A loose movie file has no folder
 * of its own, so its "title" is the whole release string — and
 * "apocalypto 2006 2160p hdr" queried verbatim is how Tenacious D's
 * Post-Apocalypto special outranked the actual film.
 */
const NOISE = new RegExp('\\b(2160p|1440p|1080p|720p|480p|4k|uhd|bluray|blu ray|brrip|bdrip'
  + '|webdl|web dl|webrip|hdtv|dvdrip|remux|proper|repack|internal|extended|remastered'
  + '|uncut|unrated|imax|x264|x265|h264|h265|hevc|av1|xvid|hdr10|hdr|dovi|dv|sdr'
  + '|10bit|8bit|dts|dd[p+]?[0-9]*|aac|ac3|eac3|truehd|atmos|5 1|7 1|multi|dual audio)\\b', 'i');

/** The searchable part of a title, plus the year it carried, if any. */
export function scrubQuery(title) {
  let year = titleYear(title);
  let t = normTitle(title);
  const noise = NOISE.exec(t);
  if (noise) t = t.slice(0, noise.index);
  // A bare year ends the title and doubles as the hint.
  const y = /(?:^|\s)((?:19|20)\d{2})(?:\s|$)/.exec(t);
  if (y) { year ??= y[1]; t = t.slice(0, y.index); }
  return { q: t.trim().replace(/\s+/g, ' '), year };
}

export class TmdbMeta {
  /** Bumped when scoring/scrubbing changes enough to distrust old answers. */
  static MATCHER_V = 2;

  constructor({ cacheDir, log = () => {} } = {}) {
    this.cacheDir = cacheDir;
    this.log = log;
    this.key = '';
    this._file = cacheDir ? join(cacheDir, 'tmdb.json') : null;
    this._entries = {};
    this._art = new Map();
    this._inflight = new Map();
    this._saveTimer = null;
    this._load();
  }

  setKey(key) { this.key = String(key ?? '').trim(); }
  get enabled() { return Boolean(this.key); }

  _load() {
    if (!this._file) return;
    try {
      const parsed = JSON.parse(readFileSync(this._file, 'utf8'));
      if (parsed?.v === 1 && parsed.entries) this._entries = parsed.entries;
      // The matcher changed: answers it produced are suspect, answers the
      // operator pinned are not. Drop the former; the next sweep re-matches
      // them under the new rules within minutes.
      if ((parsed?.mv ?? 1) !== TmdbMeta.MATCHER_V) {
        for (const [k, e] of Object.entries(this._entries)) {
          if (!e?.pinned) delete this._entries[k];
        }
        this._save();
      }
    } catch { /* first run, or unreadable — refetched by the sweeper */ }
  }

  /** Atomic, debounced: the sweeper saves a lot in its first pass. */
  _save() {
    if (!this._file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const tmp = `${this._file}.tmp`;
      try {
        try { unlinkSync(tmp); } catch { /* nothing to remove */ }
        writeFileSync(tmp, JSON.stringify({ v: 1, mv: TmdbMeta.MATCHER_V, entries: this._entries }));
        renameSync(tmp, this._file);
      } catch (err) { this.log(`[tmdb] cache write failed: ${err.message}`); }
    }, 2000);
    this._saveTimer.unref?.();
  }

  static keyFor(type, title, year) {
    return `${type}:${normTitle(title)}|${year ?? titleYear(title) ?? ''}`;
  }

  /** Cache-only: what the browsing path is allowed to ask. */
  lookup(type, title, year) {
    const e = this._entries[TmdbMeta.keyFor(type, title, year)];
    return e && !e.miss ? e : null;
  }

  episodeName(entry, season, episode) {
    return entry?.episodes?.[`${season}:${episode}`] ?? null;
  }

  /** A proxied /api/library/image url for a TMDB poster path. */
  artUrl(posterPath) {
    if (!posterPath) return null;
    const id = `tmdb-${createHash('md5').update(posterPath).digest('hex').slice(0, 16)}`;
    this._art.set(id, `${IMG}${posterPath}`);
    return `/api/library/image/${id}?v=1`;
  }

  artPath(imageId) { return this._art.get(imageId) ?? null; }

  async _get(path, params = {}) {
    const url = new URL(`${API}${path}`);
    const headers = { accept: 'application/json' };
    // A v4 token is a JWT and goes in the header; a v3 key is a query param.
    if (this.key.startsWith('eyJ')) headers.authorization = `Bearer ${this.key}`;
    else url.searchParams.set('api_key', this.key);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401) throw Object.assign(new Error('TMDB rejected the API key'), { auth: true });
    if (!res.ok) throw new Error(`TMDB ${res.status} on ${path}`);
    return res.json();
  }

  /**
   * Best candidate for a parsed title: exact normalized match beats
   * prefix beats substring; a matching year breaks ties; popularity
   * settles what is left. Falling back to the yearless search matters —
   * folder years are release-group opinions, not facts.
   */
  _pick(results, want, year, type) {
    const name = (r) => (type === 'tv' ? r.name : r.title) ?? '';
    const orig = (r) => (type === 'tv' ? r.original_name : r.original_title) ?? '';
    const yearOf = (r) => (type === 'tv' ? r.first_air_date : r.release_date ?? '').slice(0, 4);
    let best = null;
    let bestScore = -1;
    for (const r of results ?? []) {
      const n = normTitle(name(r));
      const o = normTitle(orig(r));
      let score = 0;
      if (n === want || o === want) score = 40;
      else if (n.startsWith(want) || want.startsWith(n)) score = 20;
      else if (n.includes(want) || want.includes(n)) score = 10;
      else continue;
      if (year && yearOf(r) === String(year)) score += 15;
      score += Math.min(5, (r.popularity ?? 0) / 20);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    // A substring hit without a year agreeing is a guess, and a wrong
    // poster is worse than none: below this line the answer is "no match"
    // and the operator's Fix-artwork picker is the way in.
    return bestScore >= 20 ? best : null;
  }

  /**
   * Sweeper-side: cached entry, or fetch-and-match. Concurrent callers
   * for the same key share one flight. Misses are cached with a retry
   * horizon so an unmatchable folder does not hit the API every pass.
   */
  async ensure(kind, title, year) {
    if (!this.enabled) return null;
    const type = kind === 'Movie' ? 'movie' : 'tv';
    const key = TmdbMeta.keyFor(type, title, year);
    const have = this._entries[key];
    const now = Date.now();
    if (have) {
      if (have.miss && now - (have.missAt ?? 0) < MISS_RETRY_MS) return null;
      // A pinned entry is the operator's own pick and never re-matched.
      if (!have.miss && (have.pinned || now - (have.fetchedAt ?? 0) < STALE_MS)) return have;
    }
    if (this._inflight.has(key)) return this._inflight.get(key);
    const flight = (async () => {
      const scrubbed = scrubQuery(title);
      const y = year ?? scrubbed.year;
      const q = scrubbed.q || normTitle(title);
      if (!q) return null;
      const params = { query: q };
      if (y) params[type === 'tv' ? 'first_air_date_year' : 'year'] = y;
      let found = this._pick((await this._get(`/search/${type}`, params)).results, q, y, type);
      if (!found && y) {
        found = this._pick((await this._get(`/search/${type}`, { query: q })).results, q, y, type);
      }
      if (!found) {
        this._entries[key] = { miss: true, missAt: now };
        this._save();
        return null;
      }
      const entry = {
        id: found.id,
        type,
        title: (type === 'tv' ? found.name : found.title) ?? title,
        year: ((type === 'tv' ? found.first_air_date : found.release_date) ?? '').slice(0, 4) || y || null,
        poster: found.poster_path ?? null,
        overview: found.overview ?? null,
        episodes: this._entries[key]?.episodes ?? undefined,
        fetchedAt: now,
      };
      this._entries[key] = entry;
      this._save();
      return entry;
    })().finally(() => this._inflight.delete(key));
    this._inflight.set(key, flight);
    return flight;
  }

  /** Episode names for one season, fetched once per season per refresh. */
  async ensureSeason(entry, season) {
    if (!this.enabled || !entry || entry.type !== 'tv' || season == null) return;
    entry.episodes ??= {};
    const mark = `s${season}`;
    entry._seasons ??= {};
    if (entry._seasons[mark] && Date.now() - entry._seasons[mark] < STALE_MS) return;
    const data = await this._get(`/tv/${entry.id}/season/${season}`);
    for (const ep of data?.episodes ?? []) {
      if (ep.episode_number != null && ep.name) {
        entry.episodes[`${season}:${ep.episode_number}`] = ep.name;
      }
    }
    entry._seasons[mark] = Date.now();
    this._save();
  }

  /**
   * Raw search for the Fix-artwork picker: the operator's own eyes do the
   * matching, so no scoring — just candidates, with direct TMDB thumbnail
   * urls (the picker is transient; proxying would fill the disk cache
   * with posters that were looked at once and rejected).
   */
  async search(kind, query) {
    const type = kind === 'movie' ? 'movie' : 'tv';
    const { q } = scrubQuery(query);
    const data = await this._get(`/search/${type}`, { query: q || normTitle(query) });
    return (data.results ?? []).slice(0, 12).map((r) => ({
      id: r.id,
      title: ((type === 'tv' ? r.name : r.title) ?? '').slice(0, 120),
      year: ((type === 'tv' ? r.first_air_date : r.release_date) ?? '').slice(0, 4) || null,
      poster: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
      overview: (r.overview ?? '').slice(0, 180),
    }));
  }

  /**
   * The operator's correction: this TMDB entry IS that library title.
   * Replaces whatever the matcher had — wrong match or miss — and pins the
   * choice so no refresh second-guesses it. Episode names refetch on the
   * next sweep because the seasons mark is dropped with the old entry.
   */
  async assign(metaKey, tmdbId) {
    if (!/^(movie|tv):/.test(String(metaKey))) throw new Error('Bad metadata key');
    const type = metaKey.startsWith('movie:') ? 'movie' : 'tv';
    const d = await this._get(`/${type}/${Number(tmdbId)}`);
    const entry = {
      id: d.id,
      type,
      title: ((type === 'tv' ? d.name : d.title) ?? '').slice(0, 200),
      year: ((type === 'tv' ? d.first_air_date : d.release_date) ?? '').slice(0, 4) || null,
      poster: d.poster_path ?? null,
      overview: d.overview ?? null,
      fetchedAt: Date.now(),
      pinned: true,
    };
    this._entries[metaKey] = entry;
    this._save();
    return entry;
  }

  /**
   * The edge case pruning exists for: a title that left the library takes
   * its cached metadata with it. Only called after a COMPLETE walk — a
   * partial walk's seen-set would delete metadata for everything the walk
   * never reached.
   */
  prune(seenKeys) {
    let dropped = 0;
    for (const k of Object.keys(this._entries)) {
      if (!seenKeys.has(k)) { delete this._entries[k]; dropped += 1; }
    }
    if (dropped) this._save();
    return dropped;
  }

  stats() {
    const all = Object.values(this._entries);
    return { matched: all.filter((e) => !e.miss).length, missed: all.filter((e) => e.miss).length };
  }
}

/**
 * The enriching decorator: a media provider (folder or share) with TMDB
 * answers layered over its listings. Structure, ids, paths and streaming
 * are the media half's, untouched; titles, episode names and missing
 * posters come from the cache when it has them. Every method the
 * composite calls must be proxied — see PairedLibrary for why.
 */
export class TmdbLibrary {
  constructor(media, meta) {
    this.media = media;
    this.tmdbMeta = meta;
  }

  libraries(...a) { return this.media.libraries(...a); }
  seasons(...a) { return this.media.seasons(...a); }
  nextEpisode(...a) { return this.media.nextEpisode(...a); }
  shows(...a) { return this.media.shows?.(...a); }
  search(...a) { return this.media.search?.(...a); }
  allPaths(...a) { return this.media.allPaths?.(...a); }
  resolvePath(...a) { return this.media.resolvePath?.(...a); }
  resolveMapped(...a) { return this.media.resolveMapped?.(...a); }
  size(...a) { return this.media.size(...a); }
  status(...a) { return this.media.status?.(...a) ?? { ok: true }; }
  refresh(...a) { return this.media.refresh?.(...a); }

  get _stills() { return this.media._stills; }
  get bridgeToken() { return this.media?.bridgeToken; }
  set bridgeToken(v) { if (this.media) this.media.bridgeToken = v; }
  get stream() {
    return typeof this.media?.stream === 'function'
      ? (...a) => this.media.stream(...a)
      : undefined;
  }

  imagePath(imageId) {
    return this.tmdbMeta.artPath(imageId) ?? this.media.imagePath(imageId);
  }

  _enrichSummary(it) {
    const type = it.type === 'Movie' ? 'movie' : 'tv';
    // The key travels with the item so the Fix-artwork picker can name
    // exactly which cache slot it is correcting — the ENRICHED title
    // must never be used to re-derive it, or fixing a wrong match would
    // write the fix under the wrong match's name.
    const tagged = this.tmdbMeta.enabled
      ? { ...it, metaKey: TmdbMeta.keyFor(type, it.title, it.year), metaType: type, rawTitle: it.title }
      : it;
    const e = this.tmdbMeta.lookup(type, it.title, it.year);
    if (!e) return tagged;
    return {
      ...tagged,
      title: e.title || it.title,
      year: e.year ?? it.year,
      // Local artwork is the operator's own choice and wins; TMDB fills
      // the gaps, which for a bare folder is every poster.
      image: it.image ?? this.tmdbMeta.artUrl(e.poster),
    };
  }

  _enrichEpisode(ep) {
    if (ep.type === 'Movie') {
      const e = this.tmdbMeta.lookup('movie', ep.title, null);
      return e ? { ...ep, title: e.title || ep.title } : ep;
    }
    const series = this.tmdbMeta.lookup('tv', ep.seriesName ?? '', null);
    if (!series) return ep;
    const name = this.tmdbMeta.episodeName(series, ep.season, ep.episode);
    return {
      ...ep,
      seriesName: series.title || ep.seriesName,
      title: name ?? ep.title,
    };
  }

  async items(...a) {
    const page = await this.media.items(...a);
    return { ...page, items: (page?.items ?? []).map((it) => this._enrichSummary(it)) };
  }

  async episodes(...a) {
    const eps = await this.media.episodes(...a);
    return (eps ?? []).map((ep) => this._enrichEpisode(ep));
  }

  async item(...a) {
    const it = await this.media.item(...a);
    if (!it) return it;
    if (it.type === 'Episode' || it.type === 'Movie') return this._enrichEpisode(it);
    return this._enrichSummary(it);
  }
}
