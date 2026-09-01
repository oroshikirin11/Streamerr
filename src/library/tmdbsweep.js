/**
 * Background TMDB matching, in the stills sweep's posture: never on the
 * browsing path, gentle, restartable, generation-guarded. A pass walks
 * every TMDB-enriched source, ensures each series/movie is matched and
 * each seen season's episode names are cached, then — only when the walk
 * covered everything — prunes cache entries for titles that left the
 * library.
 *
 * Network only, no ffmpeg, so it does not yield to a live broadcast; the
 * per-request gap keeps it well under TMDB's rate limits regardless of
 * library size. Cache hits cost nothing, so steady-state passes are a
 * walk of directory listings and no requests at all.
 */

import { TmdbMeta, titleYear, isMovieShelf } from './tmdb.js';

/** Between TMDB requests. ~3/s, far under the ~50/s limit, kind to NAS too. */
const GAP_MS = 350;
/** Between passes. New media is matched within this window of appearing. */
const PASS_IDLE_MS = 30 * 60 * 1000;
/** After a failure (network down, bad key): try again later, not in a loop. */
const RETRY_IDLE_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

export class TmdbSweeper {
  /**
   * @param {object} o
   * @param {() => object} o.library  current composite (rebuilt on config change)
   * @param {(msg: string) => void} [o.log]
   */
  constructor({ library, log = () => {} }) {
    this.getLibrary = library;
    this.log = log;
    this._gen = 0;
    this._timer = null;
    this._running = false;
    this._stopped = false;
    this._state = { running: false, fetched: 0, matched: 0, missed: 0 };
  }

  status() { return { ...this._state }; }

  start() {
    this._gen += 1;
    this._stopped = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._timer = setTimeout(() => { this._timer = null; this._run(); }, 3000);
    this._timer.unref?.();
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _later(ms) {
    if (this._stopped || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._run(); }, ms);
    this._timer.unref?.();
  }

  async _run() {
    if (this._running || this._stopped) return;
    this._running = true;
    this._state = { running: true, fetched: 0, matched: 0, missed: 0 };
    const gen = this._gen;
    let idle = PASS_IDLE_MS;
    try {
      idle = await this._pass(gen);
    } catch (err) {
      this.log(`[tmdb] sweep failed: ${err.message}`);
      idle = RETRY_IDLE_MS;
    } finally {
      this._running = false;
      this._state.running = false;
    }
    this._later(idle);
  }

  async _pass(gen) {
    const lib = this.getLibrary();
    const sources = (lib?.sources ?? []).filter((s) => s.lib?.tmdbMeta?.enabled);
    if (!sources.length) return PASS_IDLE_MS;

    let fetched = 0;
    let complete = true;
    // One meta per process in practice, but keep per-source seen-sets so a
    // shared cache is pruned against the union of every source's titles.
    const seenByMeta = new Map();

    for (const src of sources) {
      const meta = src.lib.tmdbMeta;
      if (!seenByMeta.has(meta)) seenByMeta.set(meta, new Set());
      const seen = seenByMeta.get(meta);
      let libraries = [];
      try { libraries = await src.lib.libraries(); } catch { complete = false; continue; }
      for (const l of libraries) {
        // The shelf's collection type outranks the per-folder heuristic —
        // same rule as the enricher, or the two would key differently.
        const movieLib = isMovieShelf(l);
        let page;
        try { page = await src.lib.media.items(l.id, { startIndex: 0, limit: 5000 }); }
        catch { complete = false; continue; }
        for (const item of page?.items ?? []) {
          if (gen !== this._gen || this._stopped) return PASS_IDLE_MS;
          const asMovie = item.type === 'Movie' || movieLib;
          const kind = asMovie ? 'movie' : 'tv';
          seen.add(TmdbMeta.keyFor(kind, item.title, item.year));
          let entry = meta.lookup(kind, item.title, item.year);
          const cold = !entry;
          if (cold) {
            try {
              entry = await meta.ensure(asMovie ? 'Movie' : 'Series', item.title, item.year);
              fetched += 1;
              this._state.fetched = fetched;
              const st = meta.stats();
              this._state.matched = st.matched;
              this._state.missed = st.missed;
              await sleep(GAP_MS);
            } catch (err) {
              if (err.auth) { this.log(`[tmdb] ${err.message} — check it in Settings`); return PASS_IDLE_MS; }
              complete = false;
              continue;
            }
          }
          if (!entry || asMovie) continue;
          // Episode names, one season fetch per season present on disk.
          let eps = [];
          try { eps = await src.lib.media.episodes(item.id); } catch { complete = false; continue; }
          const seasons = [...new Set(eps.map((e) => e.season).filter((s) => s != null))];
          for (const s of seasons) {
            if (gen !== this._gen || this._stopped) return PASS_IDLE_MS;
            const before = JSON.stringify(entry._seasons ?? {});
            try {
              await meta.ensureSeason(entry, s);
              if (JSON.stringify(entry._seasons ?? {}) !== before) {
                fetched += 1;
                await sleep(GAP_MS);
              }
            } catch { complete = false; }
          }
          // Movies filed inside a series folder still deserve a match.
          for (const ep of eps.filter((e) => e.type === 'Movie')) {
            const k = TmdbMeta.keyFor('movie', ep.title, titleYear(ep.title));
            seen.add(k);
            if (!meta.lookup('movie', ep.title, null)) {
              try { await meta.ensure('Movie', ep.title, null); fetched += 1; await sleep(GAP_MS); }
              catch { complete = false; }
            }
          }
        }
      }
    }

    if (complete && gen === this._gen) {
      for (const [meta, seen] of seenByMeta) {
        const dropped = meta.prune(seen);
        if (dropped) this.log(`[tmdb] pruned ${dropped} cached titles no longer in the library\n`);
      }
    }
    if (fetched) {
      const s = [...seenByMeta.keys()][0]?.stats();
      this.log(`[tmdb] pass done — ${fetched} lookups, `
        + `${s?.matched ?? 0} matched, ${s?.missed ?? 0} unmatched\n`);
    }
    return PASS_IDLE_MS;
  }
}
