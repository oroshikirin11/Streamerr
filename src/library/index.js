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
    return new SmbLibrary(lib.smb ?? {}, cfg?.paths?.run ?? '/tmp');
  }
  return new FilesystemLibrary({ roots: lib.filesystem?.roots ?? [] });
}

export { JellyfinLibrary, FilesystemLibrary };
