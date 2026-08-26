/**
 * Library provider selection.
 *
 * Both implementations expose the same surface, and the playout engine only
 * ever consumes resolvePath() — so it is entirely indifferent to where the
 * metadata came from.
 */

import { JellyfinLibrary } from './jellyfin.js';
import { FilesystemLibrary } from './filesystem.js';
import { SmbLibrary } from './smb.js';
import { SmbStreamLibrary } from './smbstream.js';

export function makeLibrary(cfg) {
  const lib = cfg?.library ?? {};

  if (lib.provider === 'jellyfin') {
    return new JellyfinLibrary({
      url: lib.jellyfin?.url,
      apiKey: lib.jellyfin?.apiKey,
      pathMap: lib.pathMap ?? [],
    });
  }
  if (lib.provider === 'smb') {
    // Userspace by default: no kernel mount, no privileges, works in any
    // container. 'smbmount' keeps the kernel-CIFS variant for setups that
    // want it (it needs CAP_SYS_ADMIN / the Proxmox mount feature).
    const port = cfg?.server?.port ?? 8099;
    return new SmbStreamLibrary(lib.smb ?? {}, {
      bridgeBase: `http://127.0.0.1:${port}/smbmedia`,
    });
  }
  if (lib.provider === 'smbmount') {
    return new SmbLibrary(lib.smb ?? {}, cfg?.paths?.run ?? '/tmp');
  }
  return new FilesystemLibrary({ roots: lib.filesystem?.roots ?? [] });
}

export { JellyfinLibrary, FilesystemLibrary };
