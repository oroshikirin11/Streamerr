/**
 * Jellyfin as a read-only library backend.
 *
 * Jellyfin has already scraped the posters, the series/season/episode
 * hierarchy and the episode ordering, so we read that rather than rebuilding
 * it. We only ever need the on-disk path — playback is ours.
 */

import { makeMapper, mapAndVerify } from './pathmap.js';

/**
 * Auth header. `X-Emby-Token` and `?api_key=` still work on 10.11 but a
 * migration in 12.0 force-disables legacy auth and they start returning 401
 * silently, so only the modern form is used.
 */
function authHeader(apiKey) {
  return `MediaBrowser Token="${apiKey}", Client="Streamerr", `
    + `Device="streamerr", DeviceId="streamerr", Version="0.1.0"`;
}

export class JellyfinLibrary {
  /**
   * @param {object} opts
   * @param {string} opts.url      e.g. http://192.168.1.10:8096
   * @param {string} opts.apiKey
   * @param {Array<{from,to}>} [opts.pathMap]
   */
  constructor({ url, apiKey, pathMap = [] }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.pathMap = pathMap;
    this.map = makeMapper(pathMap);
  }

  get configured() {
    return Boolean(this.url && this.apiKey);
  }

  async _get(path, params = {}) {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }

    const res = await fetch(u, {
      headers: { Authorization: authHeader(this.apiKey), Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401) {
      throw new Error('Jellyfin rejected the API key (401).');
    }
    if (!res.ok) {
      throw new Error(`Jellyfin ${path} returned ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Ask Jellyfin to rescan its libraries — the proper reconciliation when
   * a catalogued path turns out stale (Sonarr upgraded a file and nothing
   * told Jellyfin). Debounced hard: one stale EPISODE means the whole
   * season probably moved, and 25 rescan requests help nobody. Fire and
   * forget — the substitution already kept the broadcast running; this
   * just repairs the source of truth in the background.
   */
  requestRescan() {
    const now = Date.now();
    if ((this._rescanAt ?? 0) > now - 10 * 60 * 1000) return;
    this._rescanAt = now;
    const u = new URL(`${this.url}/Library/Refresh`);
    fetch(u, {
      method: 'POST',
      headers: { Authorization: authHeader(this.apiKey) },
      signal: AbortSignal.timeout(20_000),
    }).then((res) => {
      console.warn(res.ok
        ? '[library] stale catalogue path — asked Jellyfin to rescan; listings refresh as it finishes'
        : `[library] asked Jellyfin to rescan but it answered ${res.status}`);
    }).catch((err) => {
      console.warn(`[library] could not ask Jellyfin to rescan: ${err.message}`);
    });
  }

  /** Verify credentials and report who we are talking to. */
  async test() {
    const info = await this._get('/System/Info');
    return {
      ok: true,
      serverName: info.ServerName ?? null,
      version: info.Version ?? null,
    };
  }

  /**
   * Library roots, including the paths Jellyfin sees for them — which is what
   * makes automatic path-mapping suggestions possible.
   */
  async libraries() {
    const folders = await this._get('/Library/VirtualFolders');
    return folders
      .filter((f) => ['tvshows', 'movies', 'mixed', null, undefined].includes(f.CollectionType))
      .map((f) => ({
        id: f.ItemId,
        name: f.Name,
        type: f.CollectionType ?? 'mixed',
        locations: f.Locations ?? [],
      }));
  }

  /**
   * Top-level entries in a library. Paged.
   *
   * Both types are requested by default because the caller does not
   * necessarily know the library's kind — asking only for Series makes a
   * Movies library look empty, which is exactly as confusing as it sounds.
   */
  async items(libraryId, { type = 'Series,Movie', startIndex = 0, limit = 100, search } = {}) {
    // Deliberately light on fields: MediaSources invokes GetStaticMediaSources
    // per item and dominates the cost of a grid listing.
    const data = await this._get('/Items', {
      ParentId: libraryId,
      IncludeItemTypes: type,
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      StartIndex: startIndex,
      Limit: limit,
      SearchTerm: search || undefined,
      Fields: 'ProductionYear,ChildCount',
      EnableImageTypes: 'Primary,Backdrop',
      ImageTypeLimit: 1,
      EnableUserData: false,
    });

    return {
      total: data.TotalRecordCount ?? data.Items?.length ?? 0,
      items: (data.Items ?? []).map((i) => this._summary(i)),
    };
  }

  async seasons(seriesId) {
    const data = await this._get(`/Shows/${seriesId}/Seasons`, {
      EnableImageTypes: 'Primary',
      ImageTypeLimit: 1,
      EnableUserData: false,
    });
    return (data.Items ?? []).map((s) => ({
      id: s.Id,
      name: s.Name,
      index: s.IndexNumber ?? null,
      image: this.imageUrl(s.Id, 'Primary', s.ImageTags?.Primary),
    }));
  }

  /**
   * Episodes in canonical play order.
   *
   * Omitting both `season` and `seasonId` returns the whole series flat, and
   * that order already crosses season boundaries correctly — it is the order
   * to use for auto-advance.
   *
   * `isMissing=false` is not optional: with an API key Jellyfin always
   * includes virtual/missing episodes (a hardcoded `|| User.GetIsApiKey()`),
   * which have no file and a null path.
   */
  /**
   * Every episode path in the catalogue, in one request.
   *
   * Used only to line the catalogue up against the media we can open. Going
   * series by series would be one round trip per show — hundreds for a real
   * library — where a recursive query returns the lot. Capped, because the
   * answer is a sample either way: a few thousand paths settle a prefix rule
   * as well as fifty thousand would.
   */
  async allPaths({ limit = 5000 } = {}) {
    const data = await this._get('/Items', {
      IncludeItemTypes: 'Episode,Movie',
      Recursive: true,
      Fields: 'Path',
      Limit: limit,
      EnableImages: false,
      EnableUserData: false,
    });
    return (data?.Items ?? []).map((i) => i.Path).filter(Boolean);
  }

  async episodes(seriesId, { seasonId } = {}) {
    const data = await this._get(`/Shows/${seriesId}/Episodes`, {
      SeasonId: seasonId || undefined,
      IsMissing: false,
      Fields: 'Path,MediaSources,Overview',
      EnableImageTypes: 'Primary',
      ImageTypeLimit: 1,
      EnableUserData: false,
    });

    return (data.Items ?? [])
      .filter((e) => e.LocationType === 'FileSystem' || e.Path)
      .map((e) => this._episode(e));
  }

  /**
   * One item, by id.
   *
   * Deliberately NOT `GET /Items/{id}`: that route lives on Jellyfin's
   * user-library controller and expects a real user, but an API key resolves
   * to an empty user id, so it answers 400. The query form works with a bare
   * API key and lets us ask for exactly the fields we need instead of the
   * implicit all-fields that route returns.
   */
  async item(id) {
    const data = await this._get('/Items', {
      Ids: id,
      Fields: 'Path,MediaSources,Overview',
      EnableUserData: false,
    });
    const e = (data.Items ?? [])[0];
    if (!e) throw new Error(`Jellyfin has no item ${id}`);

    // A movie is a playable file just like an episode, so it needs the same
    // path resolution — only a series or season is a container.
    return e.Type === 'Episode' || e.Type === 'Movie'
      ? this._episode(e)
      : this._summary(e);
  }

  /**
   * The episode after this one, crossing season boundaries.
   *
   * `/Shows/NextUp` is deliberately not used: it is watch-state driven, needs
   * a real user, and returns nothing once a series is fully watched. It is a
   * homescreen feature, not a queue.
   */
  async nextEpisode(seriesId, currentId) {
    const data = await this._get(`/Shows/${seriesId}/Episodes`, {
      StartItemId: currentId,
      Limit: 2,
      IsMissing: false,
      Fields: 'Path,MediaSources',
      EnableUserData: false,
    });
    const items = (data.Items ?? []).filter((e) => e.Id !== currentId);
    return items.length ? this._episode(items[0]) : null;
  }

  /** Absolute path this machine can open, verified to exist. */
  resolvePath(episode) {
    const reported = episode.sourcePath ?? episode.path;
    if (!reported) throw new Error(`No path for "${episode.title}"`);
    return mapAndVerify(reported, this.pathMap);
  }

  /**
   * Image URLs need no auth — the item-image endpoints carry no [Authorize]
   * attribute, so these go straight into an <img> tag. The tag is a content
   * hash, which makes it a natural cache key.
   */
  /**
   * Artwork goes through our own image route rather than straight to
   * Jellyfin.
   *
   * Pointing the browser at Jellyfin meant one request per poster to a second
   * host on every visit, at whatever size and speed that host felt like —
   * eighty-nine episode stills took over a second to trickle in, every time.
   * Proxying lets them be scaled once, cached on disk, and served with an
   * immutable url, so the second visit costs nothing. It also means artwork
   * still appears when the browser cannot reach Jellyfin directly but the
   * server can, which is the ordinary case for a remote panel.
   *
   * The tag is the version: Jellyfin changes it when the image changes, so
   * it doubles as the cache-buster.
   */
  imageUrl(id, type = 'Primary', tag, { maxHeight = 450 } = {}) {
    if (!tag) return null;
    const remote = `${this.url}/Items/${id}/Images/${type}?tag=${tag}&maxHeight=${maxHeight}`;
    const key = `${id}-${type}-${tag}`;
    this._art ??= new Map();
    this._art.set(key, remote);
    return `/api/library/image/${key}?v=${tag}`;
  }

  /** Resolves an art id back to its Jellyfin url for the image route. */
  imagePath(imageId) {
    return this._art?.get(imageId) ?? null;
  }

  _summary(i) {
    return {
      id: i.Id,
      title: i.Name,
      year: i.ProductionYear ?? null,
      type: i.Type,
      childCount: i.ChildCount ?? null,
      image: this.imageUrl(i.Id, 'Primary', i.ImageTags?.Primary),
    };
  }

  _episode(e) {
    const source = (e.MediaSources ?? []).find((m) => m.Protocol === 'File') ?? null;
    return {
      id: e.Id,
      type: 'Episode',
      title: e.Name,
      seriesId: e.SeriesId ?? null,
      seriesName: e.SeriesName ?? null,
      season: e.ParentIndexNumber ?? null,
      episode: e.IndexNumber ?? null,
      // 100ns ticks.
      duration: e.RunTimeTicks ? e.RunTimeTicks / 1e7 : null,
      overview: e.Overview ?? null,
      // MediaSources is authoritative: it enumerates the real files for
      // multi-version items, where Path points at the folder.
      path: e.Path ?? null,
      sourcePath: source?.Path ?? null,
      // No generated fallback here on purpose: Jellyfin is the one source
      // that supplies stills of its own, and where it has none the file is
      // usually as far from us as it is from Jellyfin. Making pictures is
      // for sources that have no artwork at all.
      image: this.imageUrl(e.Id, 'Primary', e.ImageTags?.Primary, { maxHeight: 200 }),
    };
  }

}
