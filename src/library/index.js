/**
 * Library provider selection.
 *
 * Both implementations expose the same surface, and the playout engine only
 * ever consumes resolvePath() — so it is entirely indifferent to where the
 * metadata came from.
 */

import { randomBytes } from 'crypto';

import { JellyfinLibrary } from './jellyfin.js';
import { PairedLibrary } from './paired.js';
import { FilesystemLibrary } from './filesystem.js';
import { SmbLibrary } from './smb.js';
import { SmbStreamLibrary } from './smbstream.js';
import { CompositeLibrary } from './composite.js';
import { TmdbMeta, TmdbLibrary } from './tmdb.js';

/** One TMDB cache per process; every enriched source shares it. */
let tmdbMeta = null;
function sharedTmdbMeta(cfg) {
  tmdbMeta ??= new TmdbMeta({ cacheDir: cfg?.paths?.cache, log: console.log });
  return tmdbMeta;
}

/** The shared instance, for the search/assign endpoints. Null until a
 *  TMDB-enriched source has been built. */
export function currentTmdbMeta() { return tmdbMeta; }

/** One provider instance for one configured source. */
/**
 * Whether this source should make stills for media that has none.
 *
 * Defaults follow what it costs, not what looks nicest. A local folder
 * grabs a frame in a fifth of a second, so it is on. An SMB share pays a
 * cold network seek per episode — 37 of them to open one season — so it is
 * off until asked for. Jellyfin is off because it is the one source that
 * already supplies stills; where it has none, the file is usually remote to
 * us as well.
 */
export const stillsDefault = (provider) => provider === 'filesystem' || !provider;

/** Sources that can make their own stills. Jellyfin supplies its own. */
export const stillsApply = (provider) => provider !== 'jellyfin';

function makeSource(src, cfg, reuseToken = null) {
  const stills = src.generateStills ?? stillsDefault(src.provider);
  /**
   * A metadata block pairs a catalogue with this source's media.
   *
   * The source stays what it is — a folder or a share, somewhere bytes
   * actually live — and the catalogue is layered on top. Built by recursing
   * without the metadata block, so the media half is constructed exactly as
   * it would be on its own.
   */
  if (src.metadata?.provider === 'jellyfin' && src.provider !== 'jellyfin') {
    const media = makeSource({ ...src, metadata: null }, cfg, reuseToken);
    const catalogue = new JellyfinLibrary({
      url: src.metadata.url,
      apiKey: src.metadata.apiKey,
    });
    return new PairedLibrary(catalogue, media, src.metadata.pathMap ?? []);
  }
  /**
   * TMDB is an ENRICHER, not a catalogue: it has no notion of the files on
   * disk, so the folder keeps defining structure and TMDB layers canonical
   * titles, episode names and posters over it, answered from the on-disk
   * cache the background sweeper fills. One shared cache per process — the
   * same title in two sources is one TMDB answer.
   */
  if (src.metadata?.provider === 'tmdb' && src.provider !== 'jellyfin') {
    const media = makeSource({ ...src, metadata: null }, cfg, reuseToken);
    const meta = sharedTmdbMeta(cfg);
    meta.setKey(src.metadata.apiKey);
    return new TmdbLibrary(media, meta);
  }
  if (src.provider === 'jellyfin') {
    return new JellyfinLibrary({
      url: src.jellyfin?.url,
      apiKey: src.jellyfin?.apiKey,
      pathMap: src.pathMap ?? [],
    });
  }
  if (src.provider === 'smb') {
    // Userspace by default: no kernel mount, no privileges, works in any
    // container. 'smbmount' keeps the kernel-CIFS variant for setups that
    // want it (it needs CAP_SYS_ADMIN / the Proxmox mount feature).
    const port = cfg?.server?.port ?? 8099;
    // Per source, so two shares cannot read each other's media through the
    // bridge even though both are localhost. Carried across a rebuild when
    // the source is the same one: an ffmpeg already reading a bridge url
    // holds the old token, and minting a fresh one would 403 it mid-clip and
    // take the broadcast down with it.
    const bridgeToken = reuseToken ?? randomBytes(32).toString('hex');
    const smb = new SmbStreamLibrary(src.smb ?? {}, {
      bridgeBase: `http://127.0.0.1:${port}/smbmedia`,
      bridgeToken,
      stills,
    });
    smb.bridgeToken = bridgeToken;
    return smb;
  }
  if (src.provider === 'smbmount') {
    return new SmbLibrary(src.smb ?? {}, cfg?.paths?.run ?? '/tmp');
  }
  return new FilesystemLibrary({ roots: src.filesystem?.roots ?? [], stills });
}

/**
 * Always a composite, even for one source: a single code path is worth more
 * than the indirection it costs, and every caller already speaks this
 * interface.
 */
export function makeLibrary(cfg, previous = null) {
  const before = new Map((previous?.sources ?? []).map((s) => [s.key, s]));
  const sources = (cfg?.library?.sources ?? []).map((src, i) => {
    const key = src.id || String(i);
    const prev = before.get(key);
    // Only carry the token when the source is genuinely the same one; a
    // provider change should not inherit credentials of another shape.
    // `prev &&` matters: with no previous source, undefined === undefined
    // let a provider-less entry through to `prev.lib` and 500'd every
    // config save and refresh until the file was hand-repaired.
    const reuse = prev && prev.provider === src.provider ? prev.lib?.bridgeToken ?? null : null;
    return {
      key,
      name: src.name || src.provider || `Source ${i + 1}`,
      provider: src.provider,
      lib: makeSource(src, cfg, reuse),
    };
  });
  return new CompositeLibrary(sources);
}

export { JellyfinLibrary, FilesystemLibrary };
