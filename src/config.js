/**
 * Config loading.
 *
 * Everything secret — Owncast stream key, Jellyfin API key, server addresses —
 * lives in config.json, which is gitignored. The repo must stay publishable,
 * so nothing here carries a real default.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.JELLYSTREAMERR_CONFIG
  ? resolve(process.env.JELLYSTREAMERR_CONFIG)
  : resolve(ROOT, 'config.json');

const DEFAULTS = {
  server: { port: 8099, host: '0.0.0.0' },
  owncast: { rtmpUrl: '', streamKey: '', apiUrl: '', accessToken: '' },
  library: {
    provider: 'filesystem',
    jellyfin: { url: '', apiKey: '' },
    filesystem: { roots: [] },
    pathMap: [],
  },
  encoder: {
    backend: 'auto',
    device: '/dev/dri/renderD128',
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: '4500k',
    audioBitrate: '160k',
    gopSeconds: 2,
  },
  // Chain scripts live inside `cache` alongside the .ts files they reference —
  // nested .ffconcat scripts resolve relative paths against their own
  // directory and do not inherit -safe 0, so bare sibling filenames are the
  // only reliably portable form.
  paths: { cache: './cache', run: './run' },
  normalizer: { lookahead: 2, cacheLimitGB: 50 },
};

/** Shallow-by-section merge — enough for this config's one-level-deep shape. */
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (k.startsWith('_')) continue; // strip _comment keys
    out[k] = v && typeof v === 'object' && !Array.isArray(v)
      ? merge(base[k] ?? {}, v)
      : v;
  }
  return out;
}

function loadRaw() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
}

export const config = merge(DEFAULTS, loadRaw());

// Resolve runtime dirs against the repo root so relative paths in config
// don't depend on the process working directory.
for (const key of Object.keys(config.paths)) {
  const p = config.paths[key];
  config.paths[key] = isAbsolute(p) ? p : resolve(ROOT, p);
}

export function ensureDirs() {
  for (const dir of Object.values(config.paths)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function saveConfig(next) {
  const clean = merge(config, next);
  writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

/**
 * The full RTMP target. Kept out of logs and API responses — it embeds the
 * stream key, and RTMP carries it in the handshake as plaintext.
 */
export function rtmpTarget(cfg = config) {
  const base = (cfg.owncast.rtmpUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('owncast.rtmpUrl is not configured');
  if (!cfg.owncast.streamKey) throw new Error('owncast.streamKey is not configured');
  return `${base}/${cfg.owncast.streamKey}`;
}

/** Same string with the key masked, safe for logs and the UI. */
export function rtmpTargetRedacted(cfg = config) {
  const base = (cfg.owncast.rtmpUrl || '').replace(/\/+$/, '');
  return base ? `${base}/${'*'.repeat(8)}` : '(unconfigured)';
}

export { CONFIG_PATH, ROOT };
