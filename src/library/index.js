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
    // The bridge cannot use the panel's session cookie — its client is
    // ffmpeg, not a browser — so it carries an unguessable token instead.
    // The peer-address check alone was not a control: behind a reverse
    // proxy on the same host EVERY request arrives from 127.0.0.1, which
    // would have made the whole share world-readable without a password.
    const bridgeToken = randomBytes(32).toString('hex');
    const smb = new SmbStreamLibrary(lib.smb ?? {}, {
      bridgeBase: `http://127.0.0.1:${port}/smbmedia`,
      bridgeToken,
    });
    smb.bridgeToken = bridgeToken;
    return smb;
  }
  if (lib.provider === 'smbmount') {
    return new SmbLibrary(lib.smb ?? {}, cfg?.paths?.run ?? '/tmp');
  }
  return new FilesystemLibrary({ roots: lib.filesystem?.roots ?? [] });
}

export { JellyfinLibrary, FilesystemLibrary };
