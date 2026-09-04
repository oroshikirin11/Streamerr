/**
 * Several libraries behind one.
 *
 * A Jellyfin server for the shows, a folder for the music videos, a NAS share
 * for the rest — the panel should not care. This wraps any number of
 * providers and speaks exactly the interface a single one does, so nothing
 * downstream of it changed when multiple sources arrived.
 *
 * Ids are namespaced on the way out and stripped on the way back in, as
 * "<sourceKey>~<id>". That keeps routing stateless: any id the panel hands
 * back says which source it came from, so a page left open across a restart
 * still works, and two sources cannot collide even if they somehow mint the
 * same underlying id.
 */

const SEP = '~';

const tagId = (key, id) => (id == null ? id : `${key}${SEP}${id}`);

/** @returns {[string, string] | null} [sourceKey, bareId] */
function splitId(id) {
  const s = String(id ?? '');
  const i = s.indexOf(SEP);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + 1)];
}

/** Artwork urls carry an id of their own; namespace that too. */
function tagImage(key, url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/\/api\/library\/image\/([^/?#]+)/, (_, id) => `/api/library/image/${tagId(key, id)}`);
}

/** Every id-bearing field on the way out. */
function tagItem(key, item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  if (out.id != null) out.id = tagId(key, out.id);
  if (out.seriesId != null) out.seriesId = tagId(key, out.seriesId);
  if (out.image) out.image = tagImage(key, out.image);
  return out;
}

/** …and back in, so the provider only ever sees ids it minted. */
function bareItem(item) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };
  const a = splitId(out.id);
  if (a) [, out.id] = a;
  const b = splitId(out.seriesId);
  if (b) [, out.seriesId] = b;
  return out;
}

export class CompositeLibrary {
  /** @param {{key: string, name: string, provider: string, lib: object}[]} sources */
  constructor(sources) {
    this.sources = sources;
    this.provider = sources.length === 1 ? sources[0].provider : 'multi';
  }

  /**
   * Configured when any source is.
   *
   * The API asks every library for this before probing, and the composite
   * never had it — so `probe.configured` was undefined, which is falsy, and
   * /api/check/library answered "Not configured" for every provider and
   * every shape. The Test buttons in both the wizard and settings could
   * never succeed.
   */
  get configured() {
    return this.sources.some((s) => s.lib?.configured);
  }

  _find(key) {
    return this.sources.find((s) => s.key === key) ?? null;
  }

  /** Route a namespaced id to the source that minted it. */
  _route(id) {
    const parts = splitId(id);
    if (!parts) return null;
    const src = this._find(parts[0]);
    return src ? { src, id: parts[1] } : null;
  }

  async test() {
    // Report the first failure rather than an aggregate: the operator fixes
    // one source at a time, and naming it is more use than a count.
    for (const s of this.sources) {
      const r = await s.lib.test?.();
      if (r && r.ok === false) return { ...r, error: `${s.name}: ${r.error ?? 'unavailable'}` };
    }
    return { ok: true };
  }

  /**
   * Every library from every source, in source order. A source that is down
   * contributes nothing rather than breaking the page — one unreachable
   * Jellyfin should not hide a working folder.
   */
  async libraries() {
    const per = await Promise.all(this.sources.map(async (s) => {
      try {
        const libs = await s.lib.libraries();
        return (libs ?? []).map((l) => ({
          ...l,
          id: tagId(s.key, l.id),
          source: s.name,
          sourceKey: s.key,
        }));
      } catch {
        return [];
      }
    }));
    return per.flat();
  }

  async items(libraryId, opts = {}) {
    const r = this._route(libraryId);
    if (!r) return { total: 0, items: [] };
    const res = await r.src.lib.items(r.id, opts);
    return { total: res?.total ?? 0, items: (res?.items ?? []).map((i) => tagItem(r.src.key, i)) };
  }

  async seasons(seriesId) {
    const r = this._route(seriesId);
    if (!r) return [];
    const out = await r.src.lib.seasons(r.id);
    return (out ?? []).map((s) => tagItem(r.src.key, s));
  }

  async episodes(seriesId, opts = {}) {
    const r = this._route(seriesId);
    if (!r) return [];
    // seasonId is namespaced too when the panel passes one back.
    const o = { ...opts };
    if (o.seasonId) {
      const sr = splitId(o.seasonId);
      if (sr) [, o.seasonId] = sr;
    }
    const out = await r.src.lib.episodes(r.id, o);
    return (out ?? []).map((e) => tagItem(r.src.key, e));
  }

  async item(id) {
    const r = this._route(id);
    if (!r) throw new Error('Unknown item');
    return tagItem(r.src.key, await r.src.lib.item(r.id));
  }

  async nextEpisode(seriesId, currentId) {
    const r = this._route(seriesId);
    if (!r) return null;
    const cur = splitId(currentId);
    const next = await r.src.lib.nextEpisode(r.id, cur ? cur[1] : currentId);
    return next ? tagItem(r.src.key, next) : null;
  }

  resolvePath(episode) {
    const r = this._route(episode?.id);
    if (!r) throw new Error('Unknown media path');
    return r.src.lib.resolvePath(bareItem(episode));
  }

  imagePath(imageId) {
    const r = this._route(imageId);
    return r ? (r.src.lib.imagePath?.(r.id) ?? null) : null;
  }

  async resolveImage(imageId) {
    const r = this._route(imageId);
    if (!r) return null;
    if (r.src.lib.resolveImage) return (await r.src.lib.resolveImage(r.id)) ?? null;
    return r.src.lib.imagePath?.(r.id) ?? null;
  }

  // ── the SMB bridge ───────────────────────────────────────────────────
  // Its urls are minted by whichever SMB source produced them, and carry
  // that source's own token, so the bridge asks the composite to find the
  // source a token belongs to rather than assuming there is only one.

  /** @returns {{key: string, lib: object} | null} */
  sourceForToken(token) {
    if (!token) return null;
    return this.sources.find((s) => s.lib?.bridgeToken && s.lib.bridgeToken === token) ?? null;
  }

  /** True when any source serves media over the bridge. */
  get hasBridge() {
    return this.sources.some((s) => typeof s.lib?.stream === 'function');
  }
}
