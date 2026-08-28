/**
 * Config loading.
 *
 * Everything secret — Owncast stream key, Jellyfin API key, server addresses —
 * lives in config.json, which is gitignored. The repo must stay publishable,
 * so nothing here carries a real default.
 */

import {
  readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync,
} from 'fs';
import { resolve, dirname, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.JELLYSTREAMERR_CONFIG
  ? resolve(process.env.JELLYSTREAMERR_CONFIG)
  : resolve(ROOT, 'config.json');

const DEFAULTS = {
  server: { port: 8099, host: '0.0.0.0' },
  owncast: {
    rtmpUrl: '',
    streamKey: '',
    apiUrl: '',
    accessToken: '',
    // Push the on-air title to Owncast's watch page as episodes change.
    // Needs apiUrl + accessToken; does nothing without them.
    syncTitle: true,
  },
  library: {
    /**
     * One entry per place media lives — a Jellyfin server for the shows, a
     * folder for the music videos, a share for the rest. Each carries only
     * the settings its own provider needs.
     *
     *   { id, name, provider, jellyfin|filesystem|smb: {...}, pathMap: [] }
     *
     * Empty by default; setup writes the first one. A config from before
     * multiple sources existed is converted on load — see
     * normalizeStoredLibrary.
     */
    sources: [],
    /**
     * Ask each Jellyfin source to rescan on a timer, so media added to it
     * turns up without anyone pressing anything. On by default: the cost is
     * two requests a day, and the alternative is wondering why a new episode
     * is missing.
     */
    autoRefresh: { enabled: true, hours: 12 },
  },
  encoder: {
    backend: 'auto',
    device: '/dev/dri/renderD128',
    width: 1920,
    height: 1080,
    fps: 30,
    // 'auto' matches each file's native rate up to `fps` as a cap;
    // 'fixed' always outputs exactly `fps`.
    fpsMode: 'auto',
    videoBitrate: '4500k',
    audioBitrate: '160k',
    gopSeconds: 2,
    // Decode on the GPU. Whether this helps depends entirely on the machine
    // and the source: it is a large win for 10-bit HEVC on a weak CPU, and a
    // loss for 8-bit H.264 on a strong one, because the GPU-to-CPU transfer
    // costs more than the decode saved. Measure with `cli.js benchmark`.
    hwDecode: false,
    /**
     * How the output frame is sized.
     *
     * Defaults to 'native': encoding a 640x480 episode at 1920x1080 costs
     * five times the macroblocks for detail the source does not have, and
     * the viewer's player upscales for free. The cost is that clips of
     * different shapes reconnect the stream — 'fixed' is the choice for
     * anyone who would rather never reconnect.
     *
     *   'fixed'  always width x height, bars padded in. The original
     *            behaviour, and the only one that never reconnects.
     *   'fit'    the content rectangle: the source's shape, scaled to
     *            fill width x height. No bars, but SD is upscaled to fill.
     *   'native' the source's own size, downscaled only when it exceeds
     *            width x height. Never upscales, so a 640x480 file is
     *            encoded at 640x480 rather than five times the macroblocks
     *            for no extra detail.
     *   'source' the same, but with NO ceiling: a 4K file is encoded at 4K
     *            whatever width x height says. Reachable by raising the
     *            resolution instead, but that also enlarges the other two
     *            modes — this asks for it directly.
     *
     * Anything but 'fixed' costs a reconnect when the shape changes: the
     * publisher owns one RTMP session and FLV announces the frame size
     * once, at connect.
     */
    frameSize: 'native',
    // Retained for config compatibility only — the engine now ALWAYS
    // extracts embedded subtitles before their first broadcast. Burning them
    // straight from the container makes ffmpeg read the whole file a second
    // time (+24% cost on remuxes) and never produces a frame at all on very
    // large files, so this must not be disableable: a stale `false` saved by
    // an older build put the engine into an endless startup loop.
    extractSubtitles: true,
    // Chunk-encoding concurrency. Decided per clip by the engine — see
    // _chunkWorkers — because the right answer depends on whether THIS
    // clip can use the GPU compositor, which varies by file and by driver.
    // Left here as an escape hatch: 2 or more forces that many workers.
    parallelChunks: 'auto',
    // Longer chunks mean fewer seams but more latency before playback starts.
    chunkSeconds: 20,
  },
  // Chain scripts live inside `cache` alongside the .ts files they reference —
  // nested .ffconcat scripts resolve relative paths against their own
  // directory and do not inherit -safe 0, so bare sibling filenames are the
  // only reliably portable form.
  /**
   * Studio overlays burnt into the broadcast. Fractions of the frame, not
   * pixels: a 4:3 episode and a widescreen one go out at different sizes in
   * the same broadcast, and pixels would move a caption between them.
   */
  overlay: { items: [] },
  paths: { cache: './cache', run: './run' },
  normalizer: { lookahead: 2, cacheLimitGB: 50 },
  // Run-ahead cache: when the encoders outpace the broadcast, let them
  // keep going and hold the finished chunks in RAM instead of throttling
  // at the bank. Seeks and skips into the cushion are instant. ramMB
  // 'auto' resolves to a recommendation computed from the memory the
  // container actually has.
  runAhead: { enabled: true, ramMB: 'auto' },
  // The floating preview window in the panel. It replays the exact bytes the
  // publisher sends — no second encode — so its only real cost is the
  // stream's own bitrate to each open panel.
  preview: { enabled: true },
  // Shows the read-only Console page in the panel.
  devMode: false,
  ui: {
    // Defer artwork until it scrolls into view. Off by default because for
    // an ordinary library it only makes posters arrive late — the browser
    // will not even start the request until a row is nearly on screen, so
    // scrolling outruns it. Worth turning on for a library big enough that
    // requesting a whole shelf at once is the greater cost.
    lazyImages: false,
  },
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

/**
 * Clamp the encoder values that get interpolated into ffmpeg filtergraphs.
 *
 * The PUT /api/config handler validates these, but a config.json written by
 * an older build — or edited by hand — is merged verbatim at import. These
 * end up inside "scale=W:H" and "color=s=WxH", where a comma starts another
 * filter, so the file is not a trusted source either.
 */
export function normalizeStoredEncoder() {
  const enc = config.encoder;
  if (!enc) return null;
  const fixed = [];
  const clamp = (key, lo, hi, dflt) => {
    const n = Number(enc[key]);
    const safe = Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
    if (enc[key] !== safe) { fixed.push(`${key}=${JSON.stringify(enc[key])}→${safe}`); enc[key] = safe; }
  };
  clamp('width', 16, 7680, 1920);
  clamp('height', 16, 4320, 1080);
  clamp('fps', 1, 240, 30);
  clamp('gopSeconds', 1, 60, 2);
  if (enc.trimBars !== undefined) {
    // Short-lived boolean predecessor; true meant what 'fit' means now.
    fixed.push(`trimBars=${JSON.stringify(enc.trimBars)}→frameSize=${enc.trimBars ? 'fit' : 'fixed'}`);
    enc.frameSize = enc.trimBars ? 'fit' : 'fixed';
    delete enc.trimBars;
  }
  if (enc.frameSize !== undefined && !['fixed', 'fit', 'native', 'source'].includes(enc.frameSize)) {
    fixed.push(`frameSize=${JSON.stringify(enc.frameSize)}→fixed`);
    enc.frameSize = 'fixed';
  }
  if (enc.device !== undefined && !/^\/dev\/dri\/[A-Za-z0-9_-]+$/.test(String(enc.device))) {
    fixed.push(`device=${JSON.stringify(enc.device)}→/dev/dri/renderD128`);
    enc.device = '/dev/dri/renderD128';
  }
  return fixed.length ? fixed : null;
}

/**
 * Convert a single-provider config into the sources list.
 *
 * Older builds stored one provider inline under `library`. Rather than make
 * every reader understand both shapes, the old form is folded into a
 * one-entry list at load; nothing downstream ever sees the legacy layout.
 */
export function normalizeStoredLibrary() {
  const lib = config.library ?? (config.library = {});
  if (Array.isArray(lib.sources) && lib.sources.length) return null;
  if (!lib.provider) { lib.sources = Array.isArray(lib.sources) ? lib.sources : []; return null; }

  const provider = lib.provider;
  const name = provider === 'jellyfin' ? 'Jellyfin'
    : provider === 'filesystem' ? 'Folder'
      : 'SMB share';
  const source = { id: randomUUID().slice(0, 8), name, provider, pathMap: lib.pathMap ?? [] };
  if (provider === 'jellyfin') source.jellyfin = lib.jellyfin ?? {};
  else if (provider === 'filesystem') source.filesystem = lib.filesystem ?? {};
  else source.smb = lib.smb ?? {};

  lib.sources = [source];
  delete lib.provider;
  delete lib.jellyfin;
  delete lib.filesystem;
  delete lib.smb;
  delete lib.pathMap;
  return name;
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
  // Write-then-rename: a kill mid-write must never leave a truncated
  // config.json — it holds every setting and the credential hashes, and a
  // corrupt one bricks the service until someone edits it by hand.
  const tmp = `${CONFIG_PATH}.tmp`;
  // writeFileSync's mode applies only when it CREATES the file. A leftover
  // .tmp from an interrupted save (or from a build before this was 0600)
  // keeps its old permissions and then gets renamed over config.json.
  try { unlinkSync(tmp); } catch { /* nothing to remove */ }
  // 0600: this file holds the Owncast stream key in clear and the panel's
  // password hash. On a shared host the default 0644 hands both to every
  // local account.
  writeFileSync(tmp, JSON.stringify(stripComments(merged), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);

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
 * Reject anything that is not an RTMP address.
 *
 * ffmpeg picks its OUTPUT PROTOCOL from the URL, and `-f flv` only chooses the
 * muxer — so a target of `file:///etc/cron.d/x` makes ffmpeg write a file
 * there instead of opening a socket, as the service user. The container runs
 * as root and bind-mounts the media tree, so that turned "can configure the
 * panel" into "can write anywhere". `http://` is the same primitive pointed at
 * the network. Only rtmp/rtmps ever reach ffmpeg as an output.
 */
export function assertRtmpUrl(url) {
  const s = String(url ?? '').trim();
  if (!/^rtmps?:\/\/[^/\s]+/i.test(s)) {
    throw new Error('The server address must start with rtmp:// or rtmps://');
  }
  return s.replace(/\/+$/, '');
}

/**
 * The full RTMP target. Kept out of logs and API responses — it embeds the
 * stream key, and RTMP carries it in the handshake as plaintext.
 */
export function rtmpTarget(cfg = config) {
  if (!cfg.owncast.rtmpUrl) throw new Error('owncast.rtmpUrl is not configured');
  const base = assertRtmpUrl(cfg.owncast.rtmpUrl);
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
  let out = String(text);
  // The SMB bridge token rides in the URL ffmpeg is spawned with, and every
  // spawn logs its full argv — which lands in the debug ring the panel serves
  // and in `docker logs`. Mask it wherever it appears.
  out = out.replace(/([?&]t=)[0-9a-f]{32,}/gi, `$1${'*'.repeat(8)}`);
  const key = cfg.owncast?.streamKey;
  if (!key || key.length < 4) return out;
  return out.split(key).join('*'.repeat(8));
}

export { CONFIG_PATH, ROOT };
