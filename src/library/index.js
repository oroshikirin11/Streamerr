/**
 * Library provider selection.
 *
 * Both implementations expose the same surface, and the playout engine only
 * ever consumes resolvePath() — so it is entirely indifferent to where the
 * metadata came from.
 */

import { randomBytes } from 'crypto';

import { JellyfinLibrary } from './jellyfin.js';
import { FilesystemLibrary } from './filesystem.js';
import { SmbLibrary } from './smb.js';
import { SmbStreamLibrary } from './smbstream.js';
import { CompositeLibrary } from './composite.js';

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

function makeSource(src, cfg, reuseToken = null) {
  const stills = src.generateStills ?? stillsDefault(src.provider);
  if (src.provider === 'jellyfin') {
    return new JellyfinLibrary({
      url: src.jellyfin?.url,
      apiKey: src.jellyfin?.apiKey,
      pathMap: src.pathMap ?? [],
      stills,
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
    const reuse = prev?.provider === src.provider ? prev.lib?.bridgeToken ?? null : null;
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
