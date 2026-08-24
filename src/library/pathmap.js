/**
 * Translating paths between what a library reports and what we can open.
 *
 * Jellyfin reports paths as ITS process sees them. A Jellyfin container with
 * `-v /extHdd:/media` reports `/media/Shows/...`, while this service — a
 * different container with its own mounts — needs `/extHdd/Shows/...`.
 * Nothing in the API tells you the mapping, and a wrong one looks exactly
 * like a missing file on an item that plays fine in Jellyfin.
 *
 * The substitution is done here rather than through Jellyfin's own
 * `PathSubstitutions` server config, which is global and would change what
 * every client sees, including Jellyfin's own transcoder inputs.
 */

import { existsSync } from 'fs';

/**
 * @param {Array<{from: string, to: string}>} rules
 * @returns {(path: string) => string}
 */
export function makeMapper(rules = []) {
  // Longest prefix first, so a specific rule beats a general one regardless
  // of the order they were entered in.
  const sorted = [...rules]
    .filter((r) => r && r.from)
    .sort((a, b) => b.from.length - a.from.length);

  return (path) => {
    if (!path) return path;
    for (const { from, to } of sorted) {
      if (path.startsWith(from)) return to + path.slice(from.length);
    }
    return path;
  };
}

/**
 * Map a path and confirm it exists, failing loudly with BOTH paths.
 *
 * Handing an unmapped path to ffmpeg produces a far more confusing failure
 * than saying which translation was attempted.
 */
export function mapAndVerify(path, rules) {
  const mapped = makeMapper(rules)(path);
  if (existsSync(mapped)) return mapped;

  throw new Error(
    `Cannot open the media file.\n`
    + `  library reports : ${path}\n`
    + `  mapped to       : ${mapped}\n`
    + (path === mapped
      ? '  No path mapping rule matched. Add one in Settings → Library.'
      : '  That mapped path does not exist. Check the rule in Settings → Library.'),
  );
}

/**
 * Suggest mapping rules by pairing library roots against local directories.
 * Used by onboarding so the user picks from real options instead of typing
 * prefixes.
 */
export function suggestRules(libraryRoots = [], localRoots = []) {
  const out = [];
  for (const lib of libraryRoots) {
    const leaf = lib.split('/').filter(Boolean).pop();
    const match = localRoots.find((l) => l.split('/').filter(Boolean).pop() === leaf);
    if (match && match !== lib) out.push({ from: lib, to: match });
  }
  return out;
}
