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
function makeSource(src, cfg) {
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
    // bridge even though both are localhost.
    const bridgeToken = randomBytes(32).toString('hex');
    const smb = new SmbStreamLibrary(src.smb ?? {}, {
      bridgeBase: `http://127.0.0.1:${port}/smbmedia`,
      bridgeToken,
    });
    smb.bridgeToken = bridgeToken;
    return smb;
  }
  if (src.provider === 'smbmount') {
    return new SmbLibrary(src.smb ?? {}, cfg?.paths?.run ?? '/tmp');
  }
  return new FilesystemLibrary({ roots: src.filesystem?.roots ?? [] });
}

/**
 * Always a composite, even for one source: a single code path is worth more
 * than the indirection it costs, and every caller already speaks this
 * interface.
 */
export function makeLibrary(cfg) {
  const sources = (cfg?.library?.sources ?? []).map((src, i) => ({
    key: src.id || String(i),
    name: src.name || src.provider || `Source ${i + 1}`,
    provider: src.provider,
    lib: makeSource(src, cfg),
  }));
  return new CompositeLibrary(sources);
}

export { JellyfinLibrary, FilesystemLibrary };
