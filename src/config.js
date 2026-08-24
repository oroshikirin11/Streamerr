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
    // Decode on the GPU. Whether this helps depends entirely on the machine
    // and the source: it is a large win for 10-bit HEVC on a weak CPU, and a
    // loss for 8-bit H.264 on a strong one, because the GPU-to-CPU transfer
    // costs more than the decode saved. Measure with `cli.js benchmark`.
    hwDecode: false,
    // Pull the subtitle track and fonts out to small files before burning.
    // Measured on an SMB-mounted episode this took 120s and gained 6%, so it
    // is off by default — the second demux it avoids is not the bottleneck.
    // Worth trying if `cli.js benchmark` says otherwise on your storage.
    extractSubtitles: false,
    // Encode this many chunks of a clip at once when burning subtitles.
    // libass is single-threaded, so one process cannot use the rest of the
    // CPU; several can. 1 disables it. Only engages when subtitles are on,
    // since that is the only thing that pins the pipeline to one core.
    parallelChunks: 1,
    // Longer chunks mean fewer seams but more latency before playback starts.
    chunkSeconds: 20,
  },
  // Chain scripts live inside `cache` alongside the .ts files they reference —
  // nested .ffconcat scripts resolve relative paths against their own
  // directory and do not inherit -safe 0, so bare sibling filenames are the
  // only reliably portable form.
  paths: { cache: './cache', run: './run' },
  normalizer: { lookahead: 2, cacheLimitGB: 50 },
  tracks: {
    // What the user understands. Used both to decide whether a dub is wanted
    // and to choose a subtitle language.
    languages: ['eng'],
    // 'original' keeps the source language — for anime that means Japanese,
    // and is what most people want. 'dubbed' prefers a track in `languages`.
    audioMode: 'original',
    // auto | always | forced | off. 'auto' shows subtitles only when the
    // audio is in a language the user does not understand, which gives
    // subtitled anime and un-subtitled English films from one setting.
    subtitleMode: 'auto',

    // Low-level form the engine consumes. Derived from the above when saved
    // through the panel; still settable directly for unusual cases.
    audioLanguages: [],
    subtitleLanguages: ['eng'],
  },
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

/**
 * Repair a stored bitrate that ffmpeg would read as bits per second.
 * An existing config written before normalization existed can still hold a
 * bare number, which would silently encode at 1/1000 the intended rate.
 */
export function normalizeStoredBitrates(normalize) {
  const before = [config.encoder?.videoBitrate, config.encoder?.audioBitrate];
  if (config.encoder?.videoBitrate !== undefined) {
    config.encoder.videoBitrate = normalize(config.encoder.videoBitrate, '4500k');
  }
  if (config.encoder?.audioBitrate !== undefined) {
    config.encoder.audioBitrate = normalize(config.encoder.audioBitrate, '160k');
  }
  const after = [config.encoder?.videoBitrate, config.encoder?.audioBitrate];
  return before[0] !== after[0] || before[1] !== after[1]
    ? { before, after }
    : null;
}

export function ensureDirs() {
  for (const dir of Object.values(config.paths)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Persist a partial config update and apply it to the live object.
 *
 * The exported `config` is mutated in place rather than replaced, because
 * modules that imported it hold a reference — returning a new object would
 * leave every one of them on stale settings.
 */
export function saveConfig(patch) {
  const merged = merge(config, patch);
  writeFileSync(CONFIG_PATH, JSON.stringify(stripComments(merged), null, 2) + '\n');

  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, merged);

  // Runtime dirs may have changed with it.
  for (const key of Object.keys(config.paths ?? {})) {
    const p = config.paths[key];
    config.paths[key] = isAbsolute(p) ? p : resolve(ROOT, p);
  }
  return config;
}

function stripComments(obj) {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return obj;
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

/**
 * Remove the stream key from arbitrary text.
 *
 * ffmpeg prints the full output URL in its own diagnostics, so any error
 * message that quotes it leaks live credentials into terminals, logs and
 * pasted bug reports. Every path that can surface ffmpeg output — not just
 * the streaming engine — has to go through this.
 */
export function redact(text, cfg = config) {
  if (!text) return text;
  const key = cfg.owncast?.streamKey;
  if (!key || key.length < 4) return text;
  return String(text).split(key).join('*'.repeat(8));
}

export { CONFIG_PATH, ROOT };
