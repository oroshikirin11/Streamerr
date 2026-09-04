/**
 * The panel: REST API, WebSocket status feed, and the built UI.
 *
 * Everything configurable lives behind this — the goal is that nothing ever
 * requires hand-editing config.json.
 */

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import {
  existsSync, createReadStream, readdirSync, mkdirSync, statSync, writeFileSync, unlinkSync,
  readFileSync, rmSync,
} from 'fs';
import { spawn, spawnSync } from 'child_process';
import { timingSafeEqual } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  config, saveConfig, ensureDirs, rtmpTarget, rtmpTargetRedacted, redact, assertRtmpUrl,
  publishDestinations, publishTargetsRedacted, publishConfig,
  normalizeStoredBitrates, normalizeStoredEncoder, normalizeStoredLibrary, ROOT, CONFIG_DIR,
} from './config.js';
import { createScheduleStore } from './schedules.js';
import { redactPublish, restorePublishSecrets, targetUrl } from './publish.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  validSession, tokenFromRequest, requireAuth, sessionCookie, SESSION_COOKIE,
  throttleCheck, throttleFail, throttleReset, destroyOtherSessions,
} from './auth.js';
import {
  probeAll, selectBackend, probeConcatCapabilities, vaapiAlphaHonored,
  vaapiTonemapPresent, cpuTonemapAvailable, vaapiMain10Present,
  TONEMAP_CURVES, pickPillarboxGraph,
} from './ffmpeg/probe.js';
import { normalizeBitrate, codecBitrate, BACKENDS } from './ffmpeg/encoders.js';
import { renderNodes } from './ffmpeg/gpuinfo.js';
import { LANGUAGES } from './ffmpeg/tracks.js';
import { StillSweeper } from './library/stillsweep.js';
import { TmdbSweeper } from './library/tmdbsweep.js';
import { testRtmpConnection, probeDuration } from './ffmpeg/playout.js';
import { PipelinePlayout, contentRect, effectiveFps, recommendedCacheBytes } from './ffmpeg/pipeline.js';
import { probeTracks, listSubtitles, selectTracks, workKeyOf } from './ffmpeg/tracks.js';
import { sweepCache } from './ffmpeg/subcache.js';
import { makeLibrary, JellyfinLibrary, currentTmdbMeta } from './library/index.js';
import { deriveMapping, describeMatch } from './library/match.js';
import { SmbStreamLibrary } from './library/smbstream.js';
import { thumbnail, isRemote, isVideoFile, cachedFrame } from './library/thumbs.js';
import { suggestRules } from './library/pathmap.js';
import { dpush, dlist, teeConsole } from './debuglog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '../web/build');

teeConsole();

/**
 * Never let one fault take the service down.
 *
 * Almost nothing here runs inside a request: the engine lives in timers,
 * child-process events and promise chains, none of which the route wrapper
 * covers. Node ends the process on an unhandled rejection, so a single
 * throw in any of that killed the broadcast AND the panel at once — the
 * browser was left showing a bare "NetworkError" with no way to find out
 * what happened, because the log died with the process.
 *
 * Staying up is strictly better here: a wedged broadcast can be stopped
 * and restarted from the panel, an absent server cannot.
 */
process.on('unhandledRejection', (err) => {
  const msg = `unhandled rejection: ${err?.stack ?? err}`;
  dpush('error', msg);
  console.error(msg);
});
process.on('uncaughtException', (err) => {
  const msg = `uncaught exception: ${err?.stack ?? err}`;
  dpush('error', msg);
  console.error(msg);
  // The broadcast is the part most likely to be in an unknown state; end it
  // so the panel shows the truth rather than a stream that is not running.
  try { engine?.stop(); } catch { /* already down */ }
});

const app = express();
const server = http.createServer(app);

/**
 * Baseline response headers.
 *
 * The one with real teeth here is `frame-ancestors 'none'`: the panel has
 * buttons that start and stop a live broadcast, and nothing otherwise stopped
 * a page from framing it invisibly and borrowing the operator's clicks.
 *
 * The script/style directives have to allow 'unsafe-inline' — SvelteKit's
 * static build inlines its hydration bootstrap, and Svelte injects component
 * styles — so CSP is not the XSS backstop here; the frontend having no
 * raw-HTML sink is. img-src stays wide because Jellyfin posters are fetched
 * straight from whatever host the user configured.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '1mb' }));

// ── state ──────────────────────────────────────────────────────────────

/** The single active broadcast. One publisher is all Owncast accepts. */
let engine = null;
/**
 * The last engine built, alive or not. A finished broadcast keeps its
 * publisher for a few seconds to air what it had buffered, but the engine
 * slot is freed as soon as it ends — so without this handle the next
 * broadcast could open a second RTMP connection while the previous one is
 * still draining, and Owncast would go on showing the old programme.
 */
let lastEngine = null;
/**
 * What the viewer asked for, in terms that survive crossing files: a
 * language and a mode, never a track index. Indices are per-file — episode
 * 1 as a WEBDL and episode 2 as a Bluray number their audio differently —
 * so a remembered index either picks the wrong language or nothing at all.
 * Reset when a broadcast starts, updated when tracks are switched live.
 */
let trackIntent = {};
// A config written before multiple sources existed is folded into the
// sources list first, so nothing below ever sees the legacy shape.
const movedLibrary = normalizeStoredLibrary();
if (movedLibrary) {
  console.warn(`! migrated the ${movedLibrary} library into the new sources list`);
  saveConfig({ library: config.library });
}
let library = makeLibrary(config);

/**
 * Decide which GPU paths this clip can use.
 *
 * Must run per CLIP, not once per broadcast: whether subtitles are burned
 * at all, and whether the picture needs pillarbox bars, are properties of
 * the file. A queue that opens with a 16:9 episode and continues with a 4:3
 * one would otherwise carry the first episode's answer into a graph shape
 * the driver was never asked about. Probe results are cached per geometry,
 * so this costs nothing after the first clip of each shape.
 */
async function tuneProfile(profile, selection, srcPath = null) {
  if (profile.backend !== 'vaapi') return;

  /**
   * Which HDR route this device can take.
   *
   * Set unconditionally, not just for HDR clips, because `_box` is a COPY
   * of this profile taken when the engine is built: a value written here
   * during a later clip never reaches the graph. Deciding it once, up
   * front, is the only placement that survives.
   *
   * This is only the cheap opening guess. It answers "does this driver
   * have an HDR tone mapper at all", which is a real yes/no on Mesa. It
   * deliberately does NOT try to answer "will it map this file" — iHD
   * accepts the filter and then refuses frames without mastering-display
   * metadata, and a driver nobody has tested will refuse in some third
   * way. That question is settled by attempting it and believing the
   * result; see the tonemap demotion in pipeline.js.
   */
  const wanted = config.encoder?.tonemap ?? 'auto';
  if (wanted !== 'auto') {
    // Taken at face value. If the hardware disagrees the demotion ladder
    // catches it and says whose choice failed, rather than quietly
    // overriding it here where nobody would ever see.
    profile.tonemap = wanted;
    profile.tonemapForced = true;
  } else {
    globalThis.__tonemapCap ??= await vaapiTonemapPresent(profile.device);
    if (globalThis.__tonemapCap) {
      profile.tonemap = 'vaapi';
    } else {
      globalThis.__tonemapCpu ??= await cpuTonemapAvailable();
      profile.tonemap = globalThis.__tonemapCpu ? 'cpu' : 'none';
    }
    profile.tonemapForced = false;
  }
  // Said once, and only when there is HDR content to say it about.
  if (selection?.video?.hdr && !globalThis.__tonemapSaid && !profile.tonemapForced) {
    globalThis.__tonemapSaid = true;
    console.log(profile.tonemap === 'vaapi'
      ? '[hdr] tone mapping on the GPU'
      : profile.tonemap === 'cpu'
        ? '[hdr] this driver has no VAAPI tone-map filter — doing it on the CPU. '
          + 'That costs real headroom at 4K; a 1080p output frame size gives '
          + 'it back.'
        : '[hdr] nothing here can tone map — HDR titles will look washed out. '
          + 'Colours wrong; the broadcast runs.');
  }
  if (selection?.video?.hdr && profile.tonemapForced && !globalThis.__tonemapSaid) {
    globalThis.__tonemapSaid = true;
    console.log(`[hdr] tone mapping set to "${wanted}" in settings — not auto-detected`);
  }

  /**
   * HDR OUTPUT: keep HDR sources HDR instead of tone-mapping them down.
   * Three gates, each honest: the operator asked (hdrOutput), the codec
   * can carry it (H.264 has no usable 10-bit profile — HDR means HEVC),
   * and the driver encodes main10 (probed once, believed). What it does
   * NOT gate here: drawing. That is per-clip — buildSourceArgs demotes any
   * clip that must draw (subtitles, studio) to the tone-mapped SDR path,
   * because SDR RGBA blended into a PQ surface looks broken.
   */
  profile.hdrOut = false;
  // Intent, separate from capability: passthrough needs no encoder, so an
  // HDR-native HEVC file may ship untouched on the operator's say-so even
  // where the driver could not ENCODE main10.
  profile.hdrWanted = Boolean(config.encoder?.hdrOutput);
  if (config.encoder?.hdrOutput && (config.encoder?.codec ?? 'h264') === 'hevc') {
    globalThis.__main10Cap ??= await vaapiMain10Present(profile.device);
    profile.hdrOut = Boolean(globalThis.__main10Cap);
    if (!profile.hdrOut && !globalThis.__main10Said) {
      globalThis.__main10Said = true;
      console.log('[hdr] HDR output is on, but this driver cannot encode '
        + '10-bit HEVC — HDR titles fall back to tone-mapped SDR');
    }
  }

  if (config.encoder.gpuSubs === false) return;
  profile.gpuFull = true;
  profile.gpuSubs = false;
  profile.barsGraph = undefined;

  /**
   * The overlay pipe needs the same driver honesty subtitles do — an
   * overlay_vaapi that blends alpha correctly — whether or not this clip
   * HAS subtitles, because in pipe mode every clip carries the composite.
   * So the probe runs for every clip when the pipe is enabled, not only
   * for subtitled ones. The answer is cached for the process.
   */
  profile.overlayPipe = false;
  if (config.encoder.overlayPipe !== false) {
    if (globalThis.__alphaOk === undefined) {
      globalThis.__alphaOk = await vaapiAlphaHonored(profile.device,
        { width: profile.width, height: profile.height });
    }
    profile.overlayPipe = globalThis.__alphaOk;
    /**
     * "always" is OBS semantics: the compositor is part of the output
     * graph on every eligible clip, empty studio included, so even the
     * FIRST add of a broadcast is a renderer swap rather than a splice.
     * The cost is the always-on composite pass, which is why it is an
     * opt-in for boxes with headroom — the default arms on studio
     * content only, and the slow handler's noIdleArm shed still guards
     * a title that cannot afford the pass either way.
     */
    profile.overlayAlways = config.encoder.overlayPipe === 'always'
      && profile.overlayPipe;
  }

  if (!selection?.subtitle) return;

  if (globalThis.__alphaOk === undefined) {
    globalThis.__alphaOk = await vaapiAlphaHonored(profile.device,
      { width: profile.width, height: profile.height });
  }
  profile.gpuSubs = globalThis.__alphaOk;
  if (!profile.gpuSubs) return;

  // Pillarboxed content needs a graph shape this driver actually
  // supports; which one that is has to be measured, not assumed.
  const rect = contentRect(selection.video, profile);
  if (!rect.bars) return;

  // Keyed by rate as well: the same geometry at a different frame rate is a
  // different question for the driver, and caching across them is how a
  // 30fps pass came to vouch for 23.976fps material.
  const eff = effectiveFps(selection.video, profile);
  const key = `${rect.w}x${rect.h}@${rect.x},${rect.y}#${eff.rate}`;
  globalThis.__barsGraph ??= {};
  if (globalThis.__barsGraph[key] === undefined) {
    globalThis.__barsGraph[key] = await pickPillarboxGraph({
      device: profile.device,
      width: profile.width, height: profile.height, rect,
      profile, rate: eff.rate,
    });
    console.log(`pillarbox+subtitle graph for ${key}: `
      + `${globalThis.__barsGraph[key] ?? 'none — burning on the CPU'}`);
  }
  profile.barsGraph = globalThis.__barsGraph[key];
  // No working GPU composite for this shape: the CPU path burns
  // subtitles between scale and pad, which every driver can do.
  if (!profile.barsGraph) profile.gpuSubs = false;
}

/**
 * The flags tuneProfile decides, in one place. Everything a live re-tune
 * must carry into the engine's box — writing them to a profile object
 * alone is not enough, because _play rebuilds the profile from the box
 * (see retune in pipeline.js).
 */
function tunedFields(p) {
  return {
    tonemap: p.tonemap,
    tonemapForced: p.tonemapForced,
    hdrOut: p.hdrOut,
    hdrWanted: p.hdrWanted,
    gpuFull: p.gpuFull,
    gpuSubs: p.gpuSubs,
    barsGraph: p.barsGraph,
    overlayPipe: p.overlayPipe,
    overlayAlways: p.overlayAlways,
  };
}

/**
 * Track preferences for one clip, honouring any live switch made for the
 * SAME work.
 *
 * A switch belongs to what was playing when it was made. Carrying it
 * further turned "give Death Note English subtitles" into a decision
 * about the film queued behind it — which had its own languages, and
 * which lost HDR entirely, because a clip with subtitles to draw cannot
 * take the passthrough path. Episodes of one series share a work and
 * keep the choice between them; each film is its own.
 */
function trackPrefs(item = null) {
  const prefs = { ...(config.tracks ?? {}) };
  if (!trackIntent.work || trackIntent.work !== workKeyOf(item)) return prefs;
  if (trackIntent.audioLanguage) {
    prefs.audioLanguages = [trackIntent.audioLanguage, ...(prefs.audioLanguages ?? [])];
  }
  if (trackIntent.subtitleLanguage) {
    prefs.subtitleLanguages = [trackIntent.subtitleLanguage, ...(prefs.subtitleLanguages ?? [])];
  }
  if (trackIntent.subtitleMode) prefs.subtitleMode = trackIntent.subtitleMode;
  if (trackIntent.subtitleLike) prefs.subtitleLike = trackIntent.subtitleLike;
  return prefs;
}

/** Re-pick tracks against a specific file's own streams. */
async function selectionFor(item, profile = null) {
  const tracks = await probeTracks(item.srcPath);
  const subs = await listSubtitles(item.srcPath, tracks);
  const selection = selectTracks(tracks, subs, trackPrefs(item));
  selection.video = tracks.video[0] ?? null;
  if (profile) {
    await tuneProfile(profile, selection, item.srcPath);
    // Into the box, or the tune dies at the next _play. Also rescues the
    // advance path after a reshape, which orphans the closure's profile
    // object entirely.
    engine?.retune?.(tunedFields(profile));
  }
  return selection;
}

/** Remember a live switch as language + mode, for the clips that follow. */
function rememberIntent(selection, subtitleMode, item = null) {
  const sub = selection.subtitle ?? null;
  trackIntent = {
    // What this choice is ABOUT. Everything below applies only while the
    // queue stays inside it.
    work: workKeyOf(item),
    audioLanguage: selection.audio?.language ?? null,
    subtitleLanguage: sub?.language ?? null,
    subtitleMode: subtitleMode ?? trackIntent.subtitleMode,
    // Language alone does not identify a track. A release with a full
    // English subtitle and a signs-only one offers two "eng" tracks, so
    // switching to the good one only to have the next episode pick the
    // other is the default behaviour unless the choice is remembered in
    // enough detail to find its counterpart. Indices are useless across
    // files; title and forced-ness travel.
    subtitleLike: sub
      ? {
        title: sub.title ?? null,
        forced: Boolean(sub.forced),
        hearingImpaired: Boolean(sub.hearingImpaired),
        codec: sub.codec ?? null,
      }
      : null,
  };
}

/** Rebuild the library client whenever its settings change. */
/** Set once the engine wiring below exists; see the note there. */
let stillSweeper = null;
let tmdbSweeper = null;

function refreshLibrary() {
  // Hand over the old instance so unchanged SMB sources keep their bridge
  // token; see makeLibrary.
  library = makeLibrary(config, library);
  // New media, or the setting just changed: look again.
  stillSweeper?.start();
  tmdbSweeper?.start();
}

/** Exit code of a short synchronous command, -1 on spawn failure. */
function spawnSyncSafe(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 8000 }).status ?? -1;
  } catch { return -1; }
}

const clients = new Set();
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Owncast title sync ─────────────────────────────────────────────────
//
// Owncast's watch page shows one static stream title unless something sets
// it. This pushes the on-air title (via the integrations API and the access
// token from Settings) whenever the aired clip changes, so viewers see
// "Show — S1E4" instead of whatever the stream was called last month.
// Fire-and-forget: a failed sync is a log line, never a broken broadcast.

let owncastTitleSent = null;
function syncOwncastTitle() {
  const oc = config.owncast ?? {};
  if (!oc.apiUrl || !oc.accessToken || oc.syncTitle === false) return;
  const title = streamStatus().playing?.title ?? null;
  if (!title || title === owncastTitleSent) return;
  owncastTitleSent = title;
  fetch(`${String(oc.apiUrl).replace(/\/+$/, '')}/api/integrations/streamtitle`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oc.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value: title }),
  }).then((r) => {
    if (!r.ok) dpush('warn', `Owncast title sync: HTTP ${r.status}`);
  }).catch((err) => {
    dpush('warn', `Owncast title sync failed: ${err.message}`);
  });
}

// ── Streamingestarr metadata ───────────────────────────────────────────
//
// Structured now-playing/up-next/schedule pushes to our own receiver —
// the un-flattened version of the Owncast title sync, riding the SAME
// engine events (never a second clip-change source). Fire-and-forget
// with short timeouts: a dead receiver is a log line, never a stall.

/**
 * Every active receiver. Two shapes coexist: the original single
 * url/token pair (kept working untouched) and the receivers list that
 * replaced it in the UI when the second instance appeared. Metadata
 * fans out to all of them independently — one dead receiver never
 * costs another its pushes.
 */
function sgReceivers() {
  const sg = config.streamingestarr ?? {};
  if (sg.enabled === false) return [];
  const list = Array.isArray(sg.receivers) && sg.receivers.length
    ? sg.receivers
    : (sg.url && sg.accessToken ? [{ id: 'legacy', url: sg.url, accessToken: sg.accessToken }] : []);
  return list.filter((r) => r && r.enabled !== false && r.url && r.accessToken);
}
const sgActive = () => (sgReceivers().length ? true : null);

/** One receiver, one POST; resolves to whether the receiver truly took it.
 *  The receiver answers 200 with {success:false} for a rejected payload,
 *  so HTTP status alone is not an ack. */
async function sgPostOne(rc, path, body) {
  const label = rc.name || new URL(String(rc.url)).host;
  try {
    const r = await fetch(`${String(rc.url).replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rc.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      dpush('warn', `Streamingestarr [${label}] ${path}: HTTP ${r.status}`);
      return false;
    }
    const data = await r.json().catch(() => null);
    if (data?.success === false) {
      dpush('warn', `Streamingestarr [${label}] ${path}: ${data.message ?? 'rejected'}`);
      return false;
    }
    return true;
  } catch (err) {
    dpush('warn', `Streamingestarr [${label}] ${path} failed: ${err.cause?.message ?? err.message}`);
    return false;
  }
}

function sgPost(path, body) {
  for (const rc of sgReceivers()) void sgPostOne(rc, path, body);
}

/** Fan out and wait: true only when EVERY enabled receiver acked. Used
 *  where a lost push must be retried later (artwork is pushed once per
 *  id); re-sending to a receiver that already has it is a cheap
 *  overwrite, so all-or-retry is safe. */
async function sgPostAcked(path, body) {
  const receivers = sgReceivers();
  if (!receivers.length) return false;
  const acks = await Promise.all(receivers.map((rc) => sgPostOne(rc, path, body)));
  return acks.every(Boolean);
}

/** series/episode un-flattened: title = the show or film, subtitle = the
 *  episode line. A movie has no series and no subtitle. */
const sgSplit = (it) => (it?.series
  ? { title: it.series, subtitle: it.title }
  : { title: it?.title });

/**
 * Posters for the theater tray and lobby. One ffmpeg still-image pass
 * downscales any source — a local poster.jpg or Jellyfin's image URL —
 * to a 300x450 jpeg (~30KB, far under the receiver's 1MiB cap); the id
 * is a content hash so viewers cache it immutable. Prepared once per
 * distinct source and pushed once per receiver session; the pushed-set
 * clears on reconnect because the receiver's cache is in-memory.
 */
const sgArtCache = new Map(); // image source -> Promise<{id,type,data}|null>
const sgArtPushed = new Set();
function sgArtPrepare(imageSrc) {
  if (!imageSrc) return Promise.resolve(null);
  if (!sgArtCache.has(imageSrc)) {
    const prep = (async () => {
      let src = imageSrc;
      if (src.startsWith('/api/library/image/')) {
        const id = decodeURIComponent(src.split('/').pop().split('?')[0]);
        src = library.imagePath?.(id) ?? (library.resolveImage ? await library.resolveImage(id).catch(() => null) : null);
        if (!src) {
          dpush('warn', `artwork: image id ${id} no longer resolves — poster skipped`);
          return null;
        }
        if (!isRemote(src) && !existsSync(src)) return null;
        if (isVideoFile(src)) {
          // artless media resolves to the video file; a sweeper still is
          // fine as a poster, but never decode video on this path.
          src = cachedFrame(src, config.paths?.cache);
          if (!src) return null;
        }
      }
      const out = join(config.paths.cache, `sg-art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
      await new Promise((resolve, reject) => {
        const c = spawn('ffmpeg', ['-y', '-v', 'error', '-i', src,
          '-vf', 'scale=300:450:force_original_aspect_ratio=increase,crop=300:450',
          '-frames:v', '1', '-q:v', '5', out], { stdio: 'ignore' });
        const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 10000);
        c.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)); });
        c.on('error', reject);
      });
      const { readFile, rm } = await import('fs/promises');
      const buf = await readFile(out);
      rm(out, { force: true }).catch(() => {});
      if (buf.length > 1024 * 1024) return null;
      const { createHash } = await import('crypto');
      return {
        id: createHash('sha1').update(buf).digest('hex').slice(0, 16),
        type: 'image/jpeg',
        data: buf.toString('base64'),
      };
    })().catch((err) => {
      dpush('warn', `artwork: preparing ${imageSrc} failed: ${err.message}`);
      return null;
    }).then((art) => {
      // A failure must never be remembered: the first prep attempt rides
      // the go-live burst (spawn, subtitle extraction, run-ahead fill) and
      // a miss there used to blank the episode's poster for the rest of
      // the process. Concurrent callers still share the in-flight promise;
      // only the settled null is forgotten.
      if (!art) sgArtCache.delete(imageSrc);
      return art;
    });
    sgArtCache.set(imageSrc, prep);
  }
  return sgArtCache.get(imageSrc);
}
async function sgArtId(it) {
  if (!it?.image || !sgActive()) return undefined;
  const art = await sgArtPrepare(it.image).catch(() => null);
  if (!art) return undefined;
  if (!sgArtPushed.has(art.id)) {
    // Marked pushed only on a confirmed store. The old fire-and-forget
    // marked it immediately, so one dropped POST meant every later push
    // referenced a poster the receiver never held — until the next
    // publisher restart cleared the set. Unacked = this push goes out
    // without an artworkId and the next one retries the upload.
    if (!(await sgPostAcked('/api/integrations/metadata/artwork', art))) return undefined;
    sgArtPushed.add(art.id);
  }
  return art.id;
}

let sgAnnounced = null;
let sgRestateTimer = null;
/**
 * Drift watch. The receiver shows the last push plus the time since it,
 * and a seek's own push can read a position the wire has not reached yet
 * — the aired stamp is still draining the old spot when the 'seeked'
 * event fires — so viewers were re-anchored to the pre-seek position
 * until the next push. Each progress tick compares what they would be
 * showing with what is on air and re-pushes when the two part by more
 * than a beat. Catches seeks, stalls and recoveries alike, and costs
 * nothing while the clock simply runs.
 */
let sgLastPush = null;   // { position, at, paused } of the last now-playing
let sgDriftAt = 0;
function sgDriftCheck(s) {
  if (!sgLastPush || sgLastPush.paused || !(sgLastPush.position >= 0)) return;
  if (s.status !== 'running' || !(s.position >= 0) || s.playing?.countdown) return;
  if (!sgActive() || Date.now() - sgDriftAt < 2000) return;
  const expected = sgLastPush.position + (Date.now() - sgLastPush.at) / 1000;
  if (Math.abs(s.position - expected) > 1.5) {
    sgDriftAt = Date.now();
    sgQueue({ now: true });
  }
}
/** Restate schedule, metadata and artwork after a beat, debounced. */
function sgRestate() {
  if (sgRestateTimer) return;
  sgRestateTimer = setTimeout(() => {
    sgRestateTimer = null;
    sgArtPushed.clear();
    sgQueue({ now: true, schedule: true });
  }, 2000);
}
// A low-rate heartbeat. The receiver extrapolates from the last push, so a
// push lost to a reconnect or a receiver restart otherwise stays lost
// until the next clip. One now-playing every 30s is nothing on the wire,
// and it never announces — that flag is only true for a fresh clip.
setInterval(() => {
  if (sgActive() && engine?.snapshot?.()?.playing) sgQueue({ now: true });
}, 30_000).unref?.();
let sgOnAirKey = null;
/**
 * The distinct Streamingestarr rooms among the destinations the LIVE
 * broadcast is actually feeding — captured at start, like the destinations
 * themselves, so a settings edit mid-broadcast changes neither. The
 * receiver has no broadcast-to-all: one now-playing push per room, same
 * payload. '' means the receiver's default room and is sent as 'main',
 * which keeps a no-rooms setup byte-identical to before rooms existed.
 */
let sgChannels = [''];

/** The stream key a destination authenticates with, for room resolution.
 *  SRT smuggles it in the stream id, conventionally publish-prefixed. */
function sgDestKey(d) {
  if (d.protocol === 'srt') {
    return String(d.creds?.streamId ?? '').replace(/^publish[:/]/i, '').trim();
  }
  return String(d.creds?.key ?? '').trim();
}

/**
 * Which rooms these destinations feed, resolved once per broadcast start.
 *
 * A manual Room field wins verbatim — it exists as the override. Otherwise
 * the receiver is asked to resolve the destination's stream key. The three
 * answers mean three different things:
 *   a room        → that room.
 *   success:false → this key is no room on this receiver (a Twitch or
 *                   Owncast extra, say) — the destination contributes NO
 *                   room rather than a wrong one.
 *   error/timeout → '' (main): network trouble must degrade to the
 *                   pre-rooms behavior, never to silence.
 * An empty final set falls back to [''] for the same reason.
 */
async function sgResolveChannels(dests) {
  const receivers = sgReceivers();
  const resolved = await Promise.all((dests ?? []).map(async (d) => {
    const manual = String(d.channel ?? '').trim();
    if (manual) return manual;
    const key = sgDestKey(d);
    if (!key || !receivers.length) return '';
    let trouble = false;
    for (const rc of receivers) {
      try {
        const r = await fetch(
          `${String(rc.url).replace(/\/+$/, '')}/api/integrations/metadata/resolve-channel`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${rc.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ key }),
            signal: AbortSignal.timeout(3000),
          },
        );
        const data = await r.json().catch(() => null);
        if (data && data.success !== false && typeof data.channel === 'string') {
          return data.channel.trim();
        }
        // A definite "not mine" moves on to the next receiver; anything
        // unintelligible counts as trouble.
        if (!(data && data.success === false)) trouble = true;
      } catch { trouble = true; }
    }
    return trouble ? '' : null;
  }));
  const rooms = resolved.filter((v) => v !== null);
  return rooms.length ? [...new Set(rooms)] : [''];
}
/**
 * Transitions fan out through several engine events, and each used to
 * push — 11-14 POSTs per skip, counted live. Coalesce: pushes requested
 * within a beat collapse into one nowplaying + one schedule, keeping the
 * strongest flags (announce survives coalescing).
 */
let sgFlushTimer = null;
let sgWantNow = false;
let sgWantAnnounce = false;
let sgWantSched = false;
function sgQueue({ now = false, announce = false, schedule = false } = {}) {
  sgWantNow = sgWantNow || now || announce;
  sgWantAnnounce = sgWantAnnounce || announce;
  sgWantSched = sgWantSched || schedule;
  if (sgFlushTimer) return;
  sgFlushTimer = setTimeout(() => {
    sgFlushTimer = null;
    const doNow = sgWantNow; const doAnn = sgWantAnnounce; const doSched = sgWantSched;
    sgWantNow = sgWantAnnounce = sgWantSched = false;
    if (doNow) sgNowPlaying({ announce: doAnn });
    if (doSched) sgSchedule();
  }, 300);
}
/**
 * The invariant, enforced at one choke point: ANYTHING that changes what
 * is on air emits a push. Event coverage proved unreliable — a direct
 * library switch reached air without any of the wired events firing a
 * push — so instead of trusting paths to announce themselves, this
 * watches the on-air identity itself and runs from every engine event,
 * including the half-second progress tick. A clip change can therefore
 * outrun it by at most one tick.
 */
function sgSync() {
  if (!sgActive()) return;
  const it = engine?.snapshot?.()?.playing;
  const key = it?.title && !it.countdown
    ? `${it.id ?? ''}\u0000${it.series ?? ''}\u0000${it.title}` : null;
  if (key === sgOnAirKey) return;
  sgOnAirKey = key;
  if (key) sgQueue({ announce: true, schedule: true });
}
async function sgNowPlaying({ announce = false } = {}) {
  if (!sgActive()) return;
  const snap = engine?.snapshot?.();
  const it = snap?.playing;
  if (!it?.title || it.countdown) return;
  const head = sgSplit(it);
  const key = `${head.title}\u0000${head.subtitle ?? ''}`;
  // announce only once per clip, however many events fire around a start
  const fresh = key !== sgAnnounced;
  if (announce) sgAnnounced = key;
  const next = snap.queue?.[0];
  // Artwork lands before the push that references it; any failure just
  // means a push without a poster. Never on the engine's stack.
  const [artworkId, nextArt] = await Promise.all([
    sgArtId(it), next ? sgArtId(next) : undefined,
  ]).catch(() => [undefined, undefined]);
  const payload = {
    ...head,
    ...(artworkId ? { artworkId } : {}),
    position: snap.position ?? undefined,
    duration: it.duration ?? undefined,
    paused: snap.status === 'paused',
    // Declared per clip so the receiver can badge HDR honestly — and
    // 'sdr' is sent explicitly, because a tone-mapped clip after an HDR
    // one must RESET the receiver's range, not inherit it.
    videoRange: snap.hdrOnAir ? 'pq' : 'sdr',
    ...(next ? { upNext: { ...sgSplit(next), ...(nextArt ? { artworkId: nextArt } : {}) } } : {}),
    announce: Boolean(announce && fresh),
  };
  // Artwork is id-addressed and room-agnostic (pushed once above); the
  // now-playing itself goes once per room the broadcast feeds.
  for (const ch of sgChannels) {
    sgPost('/api/integrations/metadata/nowplaying', { ...payload, channel: ch || 'main' });
  }
  sgLastPush = { position: payload.position, at: Date.now(), paused: payload.paused };
}

async function sgSchedule() {
  if (!sgActive()) return;
  const snap = engine?.snapshot?.();
  const raw = [];
  // A countdown card on air IS the next showing.
  if (snap?.playing?.countdown && snap?.queue?.[0]?.at) {
    raw.push({ q: snap.queue[0], at: snap.queue[0].at });
  }
  for (const q of snap?.queue ?? []) {
    if (q.startAt) raw.push({ q, at: q.startAt });
  }
  const items = await Promise.all(raw.map(async ({ q, at }) => {
    const artworkId = await sgArtId(q);
    return { ...sgSplit(q),
      ...(artworkId ? { artworkId } : {}),
      startsAt: new Date(at * 1000).toISOString() };
  })).catch(() => []);
  // The receiver replaces its whole (in-memory) list on every push, so an
  // empty list is meaningful too: it clears a cancelled schedule.
  sgPost('/api/integrations/metadata/schedule', { items });
}

/** Whether panels should offer the floating preview window at all. */
const previewEnabled = () => config.preview?.enabled !== false;

/**
 * The overlays that should actually be on air.
 *
 * Hiding and switching an item off are editor states, not engine ones: the
 * engine is handed the list to draw and nothing else. Resolving both here
 * means a hidden overlay is indistinguishable from no overlay downstream —
 * and, because the engine compares the list it is given, toggling something
 * that was already off costs no restart of the encoder.
 */
const overlayDir = () => config.paths.overlays
  ?? join(config.paths.cache, 'overlays');

const visibleOverlay = () => (config.overlay?.hidden
  ? []
  : (config.overlay?.items ?? []).filter((i) => i?.enabled !== false));

/**
 * Whether the studio has anything the operator might SHOW — hidden or not.
 * The overlay pipe arms on this, not on visibility: a broadcast that spawns
 * with the studio hidden must still carry the pipe, or the first "show"
 * needs a source respawn — a splice, and at sub-1x titles a visible stall.
 */
const overlayConfigured = () => (config.overlay?.items ?? [])
  .some((i) => i?.enabled !== false);

function streamStatus() {
  if (!engine) {
    return { status: 'stopped', playing: null, queue: [], preview: previewEnabled() };
  }
  const s = engine.snapshot();
  return {
    status: s.status,
    // Where this broadcast is going, already redacted. Shown on hover of the
    // on-air badge: with a fan-out the operator otherwise has no way to see
    // which destinations are live without reading the startup log.
    targets: publishTargetsRedacted(),
    playing: s.playing
      ? {
        id: s.playing.id,
        title: s.playing.title,
        series: s.playing.series ?? null,
        seg: s.playing.seg ?? null,
        clipNo: s.clipNo ?? null,
        duration: s.playing.duration,
        image: s.playing.image ?? null,
        ...(s.playing.countdown ? { countdown: true } : {}),
      }
      : null,
    breakUntil: s.breakUntil ?? null,
    queue: s.queue.map((q) => ({
      id: q.id,
      title: q.title,
      series: q.series ?? null,
      seg: q.seg ?? null,
      breakBefore: q.breakBefore ?? null,
      duration: q.duration ?? null,
      // Projected air time, and the pin that fixed it (both epoch seconds).
      at: q.at ?? null,
      startAt: q.startAt ?? null,
      breakOffline: q.breakOffline ?? false,
    })),
    position: s.position,
    cachedAhead: s.cachedAhead ?? 0,
    cachedBehind: s.cachedBehind ?? 0,
    rebuilding: s.rebuilding ?? false,
    tracks: s.tracks ?? null,
    preview: previewEnabled(),
  };
}

// ── preview fan-out ────────────────────────────────────────────────────
//
// Preview windows receive the publisher's input verbatim — the same MPEG-TS
// the RTMP session carries, no second encode. Two rules keep this safe:
// the fan-out may NEVER apply backpressure to the bank (a slow panel gets
// cut off and resynced, the broadcast never waits), and a client must only
// ever start reading at a TS packet boundary, because mpegts.js probes the
// very first byte for the 0x47 sync marker rather than scanning for it.

const previewSockets = new Set();
// A panel on a link slower than the stream's bitrate accumulates unsent
// bytes here in the server; past this we stop feeding it and resync when it
// catches up. ~14s of a 4.5 Mbps stream.
const PREVIEW_BUFFER_MAX = 8_000_000;

function wirePreview(e) {
  // Byte offset within THIS publisher session's TS stream. Timestamps and
  // packet phase both restart with the engine, so anyone still connected
  // from the previous broadcast is cut off to reconnect into clean state.
  let tsBytes = 0;
  for (const ws of previewSockets) {
    try { ws.close(1000, 'stream restarted'); } catch { /* closing */ }
  }
  // A source swap splices the TS stream. The publisher survives it; a
  // browser's MSE decoder does not — it freezes without raising any event.
  // Cutting the sockets here makes every client rebuild its player against
  // the post-splice stream, which is the only reliable way back to a moving
  // picture. The first spawn of a broadcast has no one mid-stream to cut.
  e.on('discontinuity', () => {
    if (tsBytes === 0) return;
    for (const ws of previewSockets) {
      try { ws.close(1000, 'stream splice'); } catch { /* closing */ }
    }
  });

  // The publisher itself was replaced — a frame-shape change starts a new
  // RTMP session, so the byte stream restarts at zero. Without resetting
  // the counter here, every later rejoin computes its packet boundary from
  // the previous session's total and starts mid-packet.
  /**
   * Schedule bookkeeping. What is on air is watched by its tag; when the
   * tag changes or the broadcast ends, the previous item is settled as
   * aired or skipped by how much of it went out, and its schedule's
   * memory advances. Ad-hoc plays are settled too, for the history.
   */
  const track = { key: null, item: null, max: 0, dur: null };
  const finish = (reason = 'left') => {
    if (!track.item) return;
    const it = track.item;
    const ratio = track.dur > 0 ? track.max / track.dur : 1;
    // Stopped under it before it counted as watched: not a skip, just
    // not played yet.
    if (reason === 'stopped' && ratio < sched.settings().watchedAt) {
      sched.release(it.seg ?? null);
      track.item = null; track.key = null; track.max = 0; track.dur = null;
      return;
    }
    sched.settle(it.seg ?? null, {
      id: it.id, title: it.title, series: it.series ?? null, duration: track.dur,
      seconds: track.max, outcome: ratio >= sched.settings().watchedAt ? 'aired' : 'skipped',
    });
    track.item = null; track.key = null; track.max = 0; track.dur = null;
  };
  const observe = () => {
    if (engine !== e) return;
    const s = e.snapshot();
    // A stopped engine reports its last clip at the end: not a sample,
    // and whatever was on air was stopped under, not played out.
    if (s.status === 'stopped') { finish('stopped'); return; }
    const p = s.playing;
    if (!p || p.countdown || !p.title) {
      // A break card took the air: the clip before it is done. A pause
      // card is not the end of anything — the same clip comes back.
      if (s.status !== 'paused') finish();
      return;
    }
    const key = p.seg?.item ?? `adhoc:${p.id}:${s.clipNo ?? ''}`;
    if (key !== track.key) {
      finish();
      track.key = key; track.item = p; track.max = 0; track.dur = p.duration ?? null;
      sched.onAir(p.seg?.item ?? null);
    }
    if (s.position > track.max) track.max = s.position;
    if (p.duration) track.dur = p.duration;
  };
  e.on('progress', observe);
  e.on('nowplaying', observe);
  e.on('queue', observe);
  e.on('ended', (info) => {
    finish('stopped');
    sched.broadcastEnded();
    // A broadcast that ended on purpose — stopped, or played out — leaves
    // tonight empty: what a saved schedule needs to remember it already
    // has. A crash keeps the lineup, so the night can be resumed.
    if (!info || info.code === 0) sched.clearTonight();
    broadcast('schedule', scheduleView());
  });

  e.on('publisher-restart', () => {
    // The receiver's schedule/metadata/artwork live in memory — a
    // reconnect is the moment to restate all three.
    sgArtPushed.clear();
    sgSchedule(); sgNowPlaying();
    // And once more after a beat: the receiver is still winding down the
    // OLD session when the new one connects, and a restate that lands
    // first was wiped by that — the viewer's ring fell back to a stopwatch
    // until the next clip. Same grace as the recovery path below.
    sgRestate();
    if (tsBytes === 0) return;
    tsBytes = 0;
    for (const ws of previewSockets) {
      try { ws.close(1000, 'stream restarted'); } catch { /* closing */ }
    }
  });

  e.on('data', (chunk) => {
    const at = tsBytes;
    tsBytes += chunk.length;
    if (!previewSockets.size || !previewEnabled()) return;
    for (const ws of previewSockets) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > PREVIEW_BUFFER_MAX) { ws.jsrNeedsSync = true; continue; }
      if (ws.jsrNeedsSync) {
        // Joining (or rejoining after falling behind) mid-stream: start at
        // the next packet boundary and let the demuxer wait for the next
        // PAT and keyframe — a moment of black, never a corrupt picture.
        const skip = (188 - (at % 188)) % 188;
        if (skip >= chunk.length) continue;
        ws.jsrNeedsSync = false;
        ws.send(chunk.subarray(skip));
      } else {
        ws.send(chunk);
      }
    }
  });
}

/**
 * Construct a playout engine with its event wiring attached.
 *
 * The publisher inside this engine holds the RTMP connection for the whole
 * broadcast; seeking, pausing and track changes restart only the source, so
 * none of them need a new engine.
 */
/** The run-ahead budget in bytes, or null when the cache is off. */
function runAheadBudget() {
  const ra = config.runAhead ?? {};
  if (ra.enabled === false) return null;
  const mb = ra.ramMB === 'auto' || ra.ramMB == null
    ? recommendedCacheBytes() / 1024 ** 2
    : Number(ra.ramMB);
  if (!Number.isFinite(mb) || mb < 16) return null;
  return { ramBytes: Math.round(mb * 1024 ** 2) };
}

function buildEngine({ profile, selection }) {
  const e = new PipelinePlayout({
    destinations: publishDestinations(config, config.encoder.codec ?? 'h264'),
    buffer: config.buffer,
    profile,
    selection,
    // Extracted subtitle tracks and embedded fonts live here.
    cacheDir: config.paths.cache,
    overlayDir: overlayDir(),
    resolveSelection: (item) => selectionFor(item, profile),
    runAhead: runAheadBudget(),
  });

  wirePreview(e);

  e.on('status', () => {
    broadcast('stream', streamStatus()); syncOwncastTitle();
    sgSync(); sgQueue({ now: true, schedule: true });
  });
  e.on('nowplaying', () => {
    broadcast('stream', streamStatus()); syncOwncastTitle();
    // Re-push, not just sync: the spawn emits this when the on-air colour
    // range settles, and the receiver only learns it from a fresh push.
    // The beat-collapse in sgQueue keeps this cheap.
    sgSync(); sgQueue({ now: true });
  });
  e.on('queue', () => { broadcast('stream', streamStatus()); sgSync(); sgQueue({ now: true, schedule: true }); });
  e.on('seeked', () => { broadcast('stream', streamStatus()); sgSync(); sgQueue({ now: true }); });
  e.on('selection', () => { broadcast('stream', streamStatus()); sgSync(); sgQueue({ now: true }); });
  e.on('progress', (b) => {
    sgSync();
    sgDriftCheck(e.snapshot());
    // The cache bands ride the half-second progress tick. They used to
    // travel only on rare status events, so the panel's bar froze at
    // whatever the cache looked like seconds after go-live — an engine
    // holding the whole episode while the bar showed a sliver.
    const s = e.snapshot();
    broadcast('progress', {
      // The AIRED position, not the encoder's. The raw progress position
      // is the feed frontier, which on the chunked path advances in
      // 20-second bursts as chunks pour into the bank — a clock built on
      // it ticks in lurches. What has aired advances at exactly realtime,
      // which is what a clock is.
      position: s.position ?? b.position, speed: b.speed, drops: b.drops,
      buffer: b.buffer, bufferMax: b.bufferMax,
      cachedAhead: s.cachedAhead ?? 0, cachedBehind: s.cachedBehind ?? 0,
      rebuilding: s.rebuilding ?? false,
    });
  });
  e.on('warn', (m) => { dpush('warn', m); broadcast('warn', { message: redact(String(m)) }); });
  e.on('log', (m) => {
    dpush('ffmpeg', m);
    /**
     * An EXTRA destination reconnecting is invisible to the engine — the
     * fifo muxer handles it inside ffmpeg — but its own log line is the
     * signal, and a restarted receiver has empty in-memory metadata and
     * artwork. Restate everything, debounced (recoveries can rapid-fire),
     * with a beat of grace for the receiver's HTTP to follow its RTMP up.
     */
    if (String(m).includes('Recovery successful')) sgRestate();
  });
  // Distinct from a generic warning: this one predicts the stream failing.
  e.on('tooslow', (d) => broadcast('error', {
    message: `Cannot encode fast enough (${d.speed}x). The stream will stall — `
      + 'try turning subtitles off or lowering the resolution.',
  }));
  e.on('fatal', (err) => {
    dpush('error', err.message);
    broadcast('error', { message: redact(err.message) });
    if (engine === e) engine = null;
    broadcast('stream', streamStatus());
  });
  e.on('ended', () => {
    if (engine === e) engine = null;
    broadcast('stream', streamStatus());
  });
  // A publisher that dies mid-broadcast (Owncast hung up, network dropped)
  // is just as terminal as 'fatal' — without releasing the engine here,
  // every later start bounces off "Already streaming" until the service
  // restarts.
  e.on('crashed', ({ code, stderr }) => {
    const msg = `The broadcast connection died (exit ${code}). ${stderr ?? ''}`;
    dpush('error', msg);
    broadcast('error', { message: redact(msg) });
    if (engine === e) engine = null;
    broadcast('stream', streamStatus());
  });

  lastEngine = e;
  return e;
}

// ── auth ───────────────────────────────────────────────────────────────

// The old JELLYSTREAMERR_* name keeps working — a compose written before
// the rename must not silently stop trusting its proxy.
const TRUST_PROXY_ENV = process.env.STREAMERR_TRUST_PROXY
  || process.env.JELLYSTREAMERR_TRUST_PROXY;

const passwordHash = () => config.auth?.passwordHash || null;
const authDisabled = () => config.auth?.disabled === true;
const auth = requireAuth(passwordHash, authDisabled);

/** Client address for throttling. Honours X-Forwarded-For only when the
 *  panel is knowingly behind a proxy, so a direct caller cannot spoof its
 *  way out of the rate limit by inventing a header. */
function clientIp(req) {
  if (TRUST_PROXY_ENV) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Whether this request reached us over TLS, so the session cookie can carry
 *  Secure. Behind a TLS-terminating proxy only the forwarded header knows. */
function isSecure(req) {
  if (req.socket.encrypted) return true;
  return TRUST_PROXY_ENV
    ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
    : false;
}

app.get('/api/auth/status', (req, res) => {
  res.json({
    // With auth disabled by hand in the config, the panel is configured and
    // authenticated by definition — the SPA goes straight in, no login, no
    // setup wizard.
    configured: authDisabled() || Boolean(passwordHash()),
    // Never "authenticated" merely because setup has not run. Claiming it
    // was what let the panel skip its own gate and drop a brand-new install
    // straight into the wizard with no password and no way to notice.
    authenticated: authDisabled() || validSession(tokenFromRequest(req)),
    onboarded: Boolean(config.onboarded),
  });
});

app.post('/api/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const wait = throttleCheck(ip);
  if (wait) {
    return res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
    });
  }
  // Count the attempt BEFORE spending a hash on it. Counting afterwards let
  // a burst of parallel requests all pass the check while none had yet
  // recorded a failure — twelve concurrent guesses sailed through — and it
  // also meant the limiter could not protect the libuv threadpool, which is
  // the more damaging half: the hash runs there, alongside the broadcast's
  // file I/O. A successful login clears the budget.
  throttleFail(ip);
  const ok = await verifyPassword(req.body?.password ?? '', passwordHash());
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  throttleReset(ip);
  const token = createSession();
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(req) }));
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(tokenFromRequest(req));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

/** First-run only: refuses once a password exists, so it can't be reset anonymously. */
app.post('/api/auth/setup', async (req, res) => {
  if (passwordHash()) return res.status(409).json({ error: 'Already configured' });
  // Hashing is as expensive here as at login, and this route is reachable
  // before any credential exists.
  const setupIp = clientIp(req);
  if (throttleCheck(setupIp)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  throttleFail(setupIp);
  try {
    const hash = await hashPassword(req.body?.password ?? '');
    saveConfig({ auth: { passwordHash: hash } });
    throttleReset(setupIp);
    const token = createSession();
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(req) }));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Everything below requires a session once a password is set.
app.use('/api', auth);

/** Changing the password needs the current one, even with a valid session. */
app.post('/api/auth/password', async (req, res) => {
  const { current, next } = req.body ?? {};
  if (passwordHash() && !(await verifyPassword(current ?? '', passwordHash()))) {
    return res.status(403).json({ error: 'Current password is wrong' });
  }
  try {
    saveConfig({ auth: { passwordHash: await hashPassword(next ?? '') } });
    // Changing the password is how someone reacts to a suspected compromise,
    // so it has to end every OTHER session — keeping this one, or the user
    // would be logged out of the tab they just used.
    destroyOtherSessions(tokenFromRequest(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── config ─────────────────────────────────────────────────────────────

/** Secrets never leave the server; the UI shows whether one is set, not what. */
function redactedConfig() {
  return {
    ...config,
    auth: { configured: Boolean(passwordHash()) },
    owncast: {
      ...config.owncast,
      streamKey: config.owncast.streamKey ? '__SET__' : '',
      accessToken: config.owncast.accessToken ? '__SET__' : '',
    },
    streamingestarr: {
      ...config.streamingestarr,
      accessToken: config.streamingestarr?.accessToken ? '__SET__' : '',
      receivers: (config.streamingestarr?.receivers ?? []).map((r) => ({
        ...r, accessToken: r?.accessToken ? '__SET__' : '',
      })),
    },
    // Same sentinel treatment per protocol and per extra destination: a
    // stream key, SRT stream id or passphrase is never sent to a browser,
    // and a field the operator did not touch comes back unchanged.
    publish: redactPublish(publishConfig()),
    // Secrets live inside each source now. Spreading config.library would
    // hand them back verbatim, so every source is rebuilt with its own
    // credentials masked.
    library: {
      ...config.library,
      sources: (config.library?.sources ?? []).map(redactSource),
    },
  };
}

/** One source with its credentials replaced by the sentinel. */
function redactSource(src) {
  const out = { ...src };
  if (out.jellyfin) out.jellyfin = { ...out.jellyfin, apiKey: out.jellyfin.apiKey ? '__SET__' : '' };
  if (out.smb) out.smb = { ...out.smb, password: out.smb.password ? '__SET__' : '' };
  if (out.metadata) {
    out.metadata = { ...out.metadata, apiKey: out.metadata.apiKey ? '__SET__' : '' };
  }
  return out;
}

/**
 * Put the real credentials back where the panel echoed the sentinel.
 *
 * The UI never receives a secret, so it cannot send one back; an untouched
 * field returns as '__SET__' and must resolve to whatever is already stored
 * for that same source, matched by id. Without this, saving any unrelated
 * setting would blank every key.
 */
function restoreSourceSecrets(incoming) {
  const stored = new Map((config.library?.sources ?? []).map((s) => [s.id, s]));
  return incoming.map((src) => {
    const prev = stored.get(src.id);
    const out = { ...src };
    if (out.jellyfin?.apiKey === '__SET__') {
      out.jellyfin = { ...out.jellyfin, apiKey: prev?.jellyfin?.apiKey ?? '' };
    }
    if (out.smb?.password === '__SET__') {
      out.smb = { ...out.smb, password: prev?.smb?.password ?? '' };
    }
    // The catalogue's key is a secret like any other: the browser is sent
    // the sentinel and sends it back, and the stored value has to survive.
    if (out.metadata?.apiKey === '__SET__') {
      out.metadata = { ...out.metadata, apiKey: prev?.metadata?.apiKey ?? '' };
    }
    return out;
  });
}

/** Read-only activity log for the web console. No input path exists. */
app.get('/api/debug/log', (req, res) => {
  res.json({ entries: dlist(Number(req.query.after) || 0) });
});

/**
 * Per-process CPU for this service and its ffmpeg children, sampled from
 * /proc over ~700ms. Read-only introspection of our own process tree —
 * exists so a slow broadcast can be diagnosed remotely ("which process is
 * hot?") without a shell on the box.
 */
app.get('/api/debug/cpu', async (req, res) => {
  const { readFileSync: rf, readdirSync } = await import('fs');
  const sample = () => {
    const out = new Map();
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = rf(`/proc/${pid}/stat`, 'utf8');
        // comm may contain spaces/parens; fields count from after the LAST ')'.
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        if (comm !== 'ffmpeg' && Number(pid) !== process.pid) continue;
        const cmdline = rf(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
        const role = Number(pid) === process.pid ? 'node (panel + feed)'
          : cmdline.includes('-f nut pipe:1') ? 'overlay renderer'
            : cmdline.includes('-f mpegts pipe:1') ? 'source (decode+composite+encode)'
              : cmdline.includes('flv') ? 'publisher' : 'ffmpeg (other)';
        // utime + stime are fields 12 and 13 counted from pid, i.e. 11 and
        // 12 in the post-comm split's 0-basing minus the two consumed.
        out.set(pid, { role, jiffies: Number(f[11]) + Number(f[12]) });
      } catch { /* raced an exit */ }
    }
    return out;
  };
  const hz = 100; // USER_HZ is 100 on every platform this ships to
  const a = sample();
  await new Promise((r) => { setTimeout(r, 700); });
  const b = sample();
  const procs = [];
  for (const [pid, cur] of b) {
    const before = a.get(pid);
    if (!before) continue;
    procs.push({
      pid: Number(pid),
      role: cur.role,
      cpu: Math.round(((cur.jiffies - before.jiffies) / hz / 0.7) * 1000) / 10,
    });
  }
  procs.sort((x, y) => y.cpu - x.cpu);
  res.json({ cores: (await import('os')).cpus().length, procs });
});

/**
 * Directory listing for the library folder picker. Directories only, names
 * only — never file contents — and only for an authenticated session (the
 * panel already runs with filesystem-wide read access by design: its whole
 * job is reading the media tree the operator points it at).
 */
app.get('/api/fs/dirs', (req, res) => {
  const path = resolve(String(req.query.path || '/'));
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Cannot read ${path}: ${err.code ?? err.message}` });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parent = dirname(path);
  res.json({ path, parent: parent === path ? null : parent, dirs });
});

/**
 * The SMB bridge: ffmpeg reads share files as localhost HTTP with Range
 * support, so seeking and probing work without any mount. Strictly local —
 * the panel port faces the LAN, but media bytes are only served to this
 * machine's own processes.
 */
app.get('/smbmedia/*', async (req, res) => {
  // Two independent gates. The peer check keeps media bytes off the LAN;
  // the token is what actually authorises, because a reverse proxy on this
  // same host makes every forwarded request look local.
  const remote = req.socket.remoteAddress ?? '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) {
    return res.status(403).end();
  }
  if (!library?.hasBridge) return res.status(404).end();
  // Each SMB source mints its own token, so the token identifies which one
  // is being asked for — two shares cannot read each other's media.
  const given = String(req.query.t ?? '');
  const source = library.sourceForToken(given);
  if (!source) return res.status(403).end();
  const expected = Buffer.from(source.lib.bridgeToken);
  const givenBuf = Buffer.from(given);
  // Byte length, not string length: one multi-byte character makes those two
  // differ, and timingSafeEqual then THROWS — out of this handler, past
  // Express 4, leaving the request hanging and the socket leaked.
  if (givenBuf.length !== expected.length || !timingSafeEqual(givenBuf, expected)) {
    return res.status(403).end();
  }
  let rel;
  try {
    rel = decodeURIComponent(req.path.replace(/^\/smbmedia\//, ''));
  } catch {
    return res.status(400).json({ error: 'Bad path encoding' });
  }
  // '..' never appears in a path the scanner produced, so its presence means
  // someone is probing outside the configured folder.
  if (!SmbStreamLibrary.safeRel(rel)) {
    return res.status(400).json({ error: 'Bad path' });
  }
  try {
    const size = await source.lib.size(rel);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
      if (start > end || start >= size) {
        return res.status(416).set('Content-Range', `bytes */${size}`).end();
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': 'application/octet-stream',
    });
    const s2 = await source.lib.stream(rel, { start, end });
    if (process.env.JSR_SMB_TRACE) {
      const t0 = Date.now();
      const reqs = (globalThis.__bridgeReqs ??= new Map());
      const id = (globalThis.__bridgeSeq = (globalThis.__bridgeSeq ?? 0) + 1);
      const entry = { start, t0, sent: 0 };
      reqs.set(id, entry);
      if (!globalThis.__bridgeMon) {
        globalThis.__bridgeMon = setInterval(() => {
          const now = Date.now();
          const rows = [...reqs.values()].map((r) =>
            `${Math.round((now - r.t0) / 1000)}s@${r.start}+${Math.round(r.sent / 1024)}K`);
          console.log(`[bridge-live] n=${rows.length} ${rows.join(' ')}`);
        }, 5000);
        globalThis.__bridgeMon.unref?.();
      }
      s2.on('data', (d) => { entry.sent += d.length; });
      const fin = (why) => { reqs.delete(id);
        console.log(`[bridge] ${why} r=${start}-${end} sent=${entry.sent} ${Date.now() - t0}ms`); };
      s2.on('error', (e) => fin('err:' + String(e.message).slice(0, 40)));
      res.on('close', () => fin('close'));
      console.log(`[bridge] open#${id} r=${start}-${end} port=${req.socket.remotePort} ua=${String(req.headers['user-agent'] ?? '').slice(0, 24)}`);
    }
    s2.on('error', () => res.destroy());
    res.on('close', () => s2.destroy?.());
    s2.pipe(res);
  } catch (err) {
    if (process.env.JSR_SMB_TRACE) console.log(`[bridge] 502 ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/config', (req, res) => res.json({
  ...redactedConfig(),
  // Computed, not stored: what 'auto' resolves to on THIS machine, so the
  // Settings page can show a concrete recommendation next to the field.
  recommendedCacheMB: Math.round(recommendedCacheBytes() / 1024 ** 2),
}));

app.put('/api/config', (req, res) => {
  const patch = { ...req.body };
  // The auth block is never writable through the generic config route: the
  // password hash only changes via the change-password endpoint (which
  // demands the current password), and auth.disabled only by hand in the
  // file — a compromised session must not be able to overwrite the lock or
  // switch it off.
  delete patch.auth;
  // A field the UI didn't touch comes back as the placeholder; drop it so the
  // stored secret survives instead of being overwritten with a sentinel.
  if (Array.isArray(patch.streamingestarr?.receivers)) {
    const stored = new Map((config.streamingestarr?.receivers ?? []).map((r) => [r.id, r]));
    // the legacy single token can seed the first row a migration creates
    const legacyTok = config.streamingestarr?.accessToken ?? '';
    patch.streamingestarr.receivers = patch.streamingestarr.receivers.map((r) => ({
      ...r,
      accessToken: r?.accessToken === '__SET__'
        ? (stored.get(r.id)?.accessToken ?? legacyTok)
        : (r?.accessToken ?? ''),
    }));
  }
  for (const [section, field] of [['owncast', 'streamKey'], ['owncast', 'accessToken'],
    ['streamingestarr', 'accessToken']]) {
    if (patch[section]?.[field] === '__SET__') delete patch[section][field];
  }
  if (patch.publish) patch.publish = restorePublishSecrets(patch.publish, publishConfig());
  /**
   * The bank is sized from these, so they are clamped here as well as in the
   * engine — a hand-edited config should not be able to ask for a 10-hour
   * cushion, and applySeconds above the depth would silently do nothing.
   */
  if (patch.buffer) {
    /**
     * Only the keys the patch actually carries.
     *
     * Two cards write to this block — Buffer owns the depth, Studio owns the
     * apply point and the warning switch — so filling in the absent ones
     * with defaults let either card silently reset the other's. Saving a new
     * depth reset the apply point to match it, and turned warnings back on
     * for anyone who had turned them off.
     */
    const cur = config.buffer ?? {};
    const n = (v, lo, hi, d) => {
      const x = Number(v);
      return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d;
    };
    const out = { ...patch.buffer };
    if (out.seconds !== undefined) out.seconds = n(out.seconds, 1, 60, cur.seconds ?? 15);
    const secs = out.seconds ?? cur.seconds ?? 15;
    if (out.applySeconds !== undefined) {
      out.applySeconds = n(out.applySeconds, 0, secs, secs);
    } else if (Number(cur.applySeconds) > secs) {
      // Lowering the depth has to carry a deeper apply point down with it,
      // or it would ask for more cushion than exists.
      out.applySeconds = secs;
    }
    if (out.studioWarnings !== undefined) out.studioWarnings = Boolean(out.studioWarnings);
    patch.buffer = out;
  }
  if (Array.isArray(patch.library?.sources)) {
    patch.library.sources = restoreSourceSecrets(patch.library.sources);
  }
  delete patch.auth; // password changes go through their own endpoint

  // ffmpeg reads a bare number as BITS per second, so a stored "12000"
  // means 12 kbps and produces a picture made of coloured blocks. Normalise
  // on the way in so no client can persist a value that means something
  // 1000x different from what was intended.
  if (patch.encoder?.videoBitrate !== undefined) {
    patch.encoder.videoBitrate = normalizeBitrate(patch.encoder.videoBitrate, '6000k');
  }
  if (patch.encoder?.audioBitrate !== undefined) {
    patch.encoder.audioBitrate = normalizeBitrate(patch.encoder.audioBitrate, '160k');
  }
  // Per-codec overrides: empty means "derive from the H.264 anchor"
  // (hevc 2/3, av1 1/2 — see codecBitrate), so empty stays empty.
  for (const k of ['hevcBitrate', 'av1Bitrate']) {
    if (patch.encoder?.[k] !== undefined && patch.encoder[k] !== '') {
      patch.encoder[k] = normalizeBitrate(patch.encoder[k], '');
    }
  }

  // Numbers must BE numbers. These are interpolated straight into ffmpeg
  // filtergraphs ("scale=W:H", "color=s=WxH"), and a filtergraph is a
  // comma-separated language: a height of "1080,drawtext=textfile=/etc/passwd"
  // appends a filter of the attacker's choosing and renders an arbitrary file
  // into the live broadcast. Coercing and clamping here closes that for every
  // client, since nothing downstream re-validates.
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  if (patch.encoder?.width !== undefined) {
    patch.encoder.width = clamp(patch.encoder.width, 16, 7680, config.encoder.width);
  }
  if (patch.encoder?.height !== undefined) {
    patch.encoder.height = clamp(patch.encoder.height, 16, 4320, config.encoder.height);
  }
  if (patch.encoder?.fps !== undefined) {
    patch.encoder.fps = clamp(patch.encoder.fps, 1, 240, config.encoder.fps);
  }
  if (patch.encoder?.overlayPipe !== undefined) {
    // Tri-state: false (off), true (arm on studio content), 'always'
    // (OBS semantics — the compositor rides every eligible clip).
    patch.encoder.overlayPipe = patch.encoder.overlayPipe === 'always'
      ? 'always' : Boolean(patch.encoder.overlayPipe);
  }
  if (patch.encoder?.tonemap !== undefined) {
    // An unknown value must not silently become a filter graph.
    patch.encoder.tonemap = ['auto', 'vaapi', 'cpu', 'none']
      .includes(patch.encoder.tonemap) ? patch.encoder.tonemap : config.encoder.tonemap;
  }
  if (patch.encoder?.tonemapCurve !== undefined) {
    patch.encoder.tonemapCurve = TONEMAP_CURVES
      .includes(patch.encoder.tonemapCurve) ? patch.encoder.tonemapCurve : 'hable';
  }
  if (patch.encoder?.deinterlace !== undefined) {
    patch.encoder.deinterlace = ['auto', 'on', 'off']
      .includes(patch.encoder.deinterlace) ? patch.encoder.deinterlace : 'auto';
  }
  if (patch.encoder?.hdrOutput !== undefined) {
    patch.encoder.hdrOutput = Boolean(patch.encoder.hdrOutput);
  }
  if (patch.encoder?.copyMaxGopSeconds !== undefined) {
    patch.encoder.copyMaxGopSeconds = clamp(patch.encoder.copyMaxGopSeconds, 1, 30, 4);
  }
  if (patch.encoder?.copyLimitKbps !== undefined) {
    patch.encoder.copyLimitKbps = clamp(patch.encoder.copyLimitKbps, 1000, 200000, 30000);
  }
  if (patch.encoder?.av1Preset !== undefined && patch.encoder.av1Preset !== '') {
    patch.encoder.av1Preset = clamp(patch.encoder.av1Preset, 5, 13, '');
  }
  if (patch.encoder?.gopSeconds !== undefined) {
    patch.encoder.gopSeconds = clamp(patch.encoder.gopSeconds, 1, 60, config.encoder.gopSeconds);
  }
  // The render device becomes part of "-init_hw_device vaapi=va:<device>",
  // where a comma would likewise start a second option.
  if (patch.encoder?.device !== undefined) {
    const dev = String(patch.encoder.device);
    if (!/^\/dev\/dri\/[A-Za-z0-9_-]+$/.test(dev)) {
      return res.status(400).json({
        error: 'Render device must be a path like /dev/dri/renderD128',
      });
    }
    patch.encoder.device = dev;
  }

  // The panel expresses intent — which languages you understand, and whether
  // you want the original audio or a dub. The engine consumes ordered
  // language lists. Deriving here means any client gets it right, and the two
  // representations cannot drift apart.
  if (patch.tracks?.languages || patch.tracks?.audioMode) {
    const merged = { ...config.tracks, ...patch.tracks };
    const langs = merged.languages ?? [];
    patch.tracks = {
      ...patch.tracks,
      // Original audio means "don't prefer any language", which falls through
      // to the file's default track — the original, for essentially every
      // release that carries more than one audio track.
      audioLanguages: merged.audioMode === 'dubbed' ? langs : [],
      subtitleLanguages: langs,
    };
  }

  // Coerced on its own, not alongside the items below: a patch that carries
  // items but no `hidden` must leave the hide state as it was. Folding it in
  // there would read a missing key as false and quietly put hidden overlays
  // back on air on the next unrelated save.
  if (patch.overlay?.hidden !== undefined) {
    patch.overlay = { ...patch.overlay, hidden: Boolean(patch.overlay.hidden) };
  }

  // Overlays end up inside an ASS script that libass renders into the live
  // picture. The generator already strips braces and newlines from the text
  // so no event can invent its own override tags, but the numbers arrive
  // straight from a client and are worth pinning here too — the same reason
  // the encoder fields above are clamped rather than trusted.
  if (patch.overlay?.items !== undefined) {
    const num = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    patch.overlay = {
      ...patch.overlay,
      items: (Array.isArray(patch.overlay.items) ? patch.overlay.items : [])
        .slice(0, 32)
        .map((it, i) => ({
          id: String(it?.id ?? `ov${i}`).slice(0, 64),
          type: it?.type === 'image' ? 'image' : it?.type === 'censor' ? 'censor' : 'text',
          text: String(it?.text ?? '').slice(0, 300),
          // Stripped to a bare filename. This names a file that gets
          // composited into a public broadcast, so anything that could climb
          // out of the uploads directory is removed rather than rejected.
          file: String(it?.file ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128),
          x: num(it?.x, 0, 1, 0.5),
          y: num(it?.y, 0, 1, 0.5),
          size: num(it?.size, 0.01, 1, 0.06),
          rotation: num(it?.rotation, -360, 360, 0),
          opacity: num(it?.opacity, 0, 1, 1),
          // Movement is a closed-form expression the encoder evaluates per
          // frame, so an unknown kind must fall back to standing still
          // rather than reaching the filter graph as a literal.
          motion: it?.motion === 'bounce' ? 'bounce' : 'none',
          speed: num(it?.speed, 0.01, 0.4, 0.06),
          colour: /^#[0-9a-f]{6}$/i.test(String(it?.colour)) ? it.colour : '#ffffff',
          font: String(it?.font ?? '').slice(0, 64),
          outline: it?.outline !== false,
          enabled: it?.enabled !== false,
          // A censor box is sized on both axes and carries a blur strength.
          // The encoder clamps these again, but they are pinned here for
          // the same reason as the rest — and without them the box came
          // back from disk as an empty caption.
          ...(it?.type === 'censor' ? {
            w: num(it?.w, 0.01, 1, 0.24),
            h: num(it?.h, 0.01, 1, 0.18),
            strength: num(it?.strength, 1, 10, 5),
          } : {}),
        })),
    };
  }

  try {
    saveConfig(patch);
    refreshLibrary();
    scheduleAutoScan();
    // Studio overlays are part of the encoder profile, which a broadcast
    // freezes when it starts. Without this an Apply only reached the disk:
    // the button went quiet, the config was correct, and nothing changed on
    // air until the next broadcast. The engine decides whether the change is
    // worth restarting the source for.
    if (patch.overlay !== undefined && engine) {
      // Arming state first: setOverlay may respawn, and the spawn must
      // already know whether the pipe stays armed for later toggles.
      engine.setOverlayConfigured(overlayConfigured());
      engine.setOverlay(visibleOverlay());
    }
    // Turning the preview off mid-broadcast takes effect immediately: every
    // open panel learns via the status push, and connected preview windows
    // are cut rather than left streaming a feature that is now disabled.
    if (patch.preview !== undefined) {
      if (!previewEnabled()) {
        for (const ws of previewSockets) {
          try { ws.close(1000, 'preview disabled'); } catch { /* closing */ }
        }
      }
      broadcast('stream', streamStatus());
    }
    res.json(redactedConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── studio overlay pictures ────────────────────────────────────────────

/**
 * Uploads are matched by CONTENT, not by the name the client chose.
 *
 * These files become ffmpeg inputs on a live broadcast, so trusting a
 * `.png` suffix would let any file at all be handed to a demuxer. The
 * signature decides what it is, and the extension is then derived from
 * that — which also means a mislabelled but genuine picture still works.
 */
const IMAGE_KINDS = [
  { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },              // GIF8
  { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageKind(buf) {
  if (!buf || buf.length < 12) return null;
  for (const k of IMAGE_KINDS) {
    if (k.magic.every((b, i) => buf[i] === b)) return k;
  }
  // RIFF....WEBP — the only one whose signature is not a simple prefix.
  if (buf.slice(0, 4).toString('latin1') === 'RIFF'
      && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp' };
  return null;
}

/** Bare filename, restricted charset — these are joined onto a directory. */
const safeName = (n) => String(n ?? '')
  .replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 128);

app.get('/api/overlay/images', (req, res) => {
  const dir = overlayDir();
  if (!existsSync(dir)) return res.json([]);
  const out = readdirSync(dir)
    .filter((n) => /\.(png|gif|jpe?g|webp)$/i.test(n))
    .map((n) => {
      const s = statSync(join(dir, n));
      return { name: n, bytes: s.size, at: s.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
  res.json(out);
});

app.get('/api/overlay/images/:name', (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(404).json({ error: 'No such picture' });
  // sendFile rather than a piped createReadStream. The existsSync-then-open
  // gap is real — deleting a picture while another open panel still has an
  // <img> pointed at it hits it — and an unhandled 'error' on a piped
  // stream reaches the process-level uncaughtException handler, which stops
  // the engine. A late 404 on a thumbnail would have ended the broadcast.
  res.sendFile(name, { root: overlayDir(), dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'No such picture' });
  });
});

app.post('/api/overlay/images',
  express.raw({ type: '*/*', limit: MAX_IMAGE_BYTES }),
  (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: 'No picture was uploaded' });
    }
    const kind = imageKind(body);
    if (!kind) {
      return res.status(400).json({ error: 'That is not a PNG, GIF, JPEG or WebP' });
    }
    // Keep the user's name where it is usable, but force the extension to
    // match what the bytes actually are.
    const asked = safeName(req.query.name).replace(/\.[^.]*$/, '');
    const base = asked || `overlay-${Date.now()}`;
    let name = `${base}.${kind.ext}`;
    const dir = overlayDir();
    mkdirSync(dir, { recursive: true });
    // Never silently replace: a name collision that overwrote an existing
    // logo would change what is on air for an overlay the user did not touch.
    for (let i = 2; existsSync(join(dir, name)); i += 1) name = `${base}-${i}.${kind.ext}`;
    writeFileSync(join(dir, name), body);
    res.json({ name, bytes: body.length });
  });

app.delete('/api/overlay/images/:name', (req, res) => {
  const name = safeName(req.params.name);
  const path = join(overlayDir(), name);
  if (!name || !existsSync(path)) return res.status(404).json({ error: 'No such picture' });
  // Overlays still pointing at it are left alone rather than rewritten: the
  // engine skips a picture whose file is gone, so a delete cannot break a
  // running broadcast, and the editor can show the dangling item plainly.
  unlinkSync(path);
  res.json({ ok: true });
});

// ── setup checks ───────────────────────────────────────────────────────

app.post('/api/check/owncast', async (req, res) => {
  const url = req.body?.rtmpUrl ?? config.owncast.rtmpUrl;
  const key = req.body?.streamKey === '__SET__' || !req.body?.streamKey
    ? config.owncast.streamKey
    : req.body.streamKey;

  if (!url || !key) return res.status(400).json({ error: 'Address and stream key are required' });
  if (engine) return res.status(409).json({ error: 'Stop the current broadcast first' });

  let target;
  try {
    target = `${assertRtmpUrl(url)}/${key}`;
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // Two different questions. "Does it accept us" only needs a few seconds and
  // no pacing. "Can I watch it appear" needs realtime pacing AND enough
  // content for Owncast to build a playable HLS playlist — it buffers several
  // segments before a viewer sees anything.
  const watch = Boolean(req.body?.watch);
  const seconds = watch ? 30 : 3;
  const t0 = Date.now();
  const result = await testRtmpConnection(target, {
    seconds,
    realtime: watch,
    timeoutMs: (seconds + 20) * 1000,
  });
  res.json(result.ok
    ? { ok: true, ms: Date.now() - t0, seconds }
    : { ok: false, error: redact(result.error) });
});

// Proves the title sync end to end: same endpoint, same auth the live sync
// uses, so a green result here means episode titles will reach the watch
// page. Uses the on-air title when live, a labelled test value otherwise.
app.post('/api/check/owncast-title', async (req, res) => {
  const apiUrl = String(req.body?.apiUrl ?? config.owncast.apiUrl ?? '').replace(/\/+$/, '');
  const token = req.body?.accessToken && req.body.accessToken !== '__SET__'
    ? req.body.accessToken
    : config.owncast.accessToken;
  if (!apiUrl) return res.status(400).json({ ok: false, error: 'Owncast address is required' });
  if (!token) return res.status(400).json({ ok: false, error: 'Access token is required' });
  const value = streamStatus().playing?.title ?? 'Streamerr — title sync test';
  try {
    const r = await fetch(`${apiUrl}/api/integrations/streamtitle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      return res.json({
        ok: false,
        error: r.status === 401
          ? 'Owncast rejected the token (HTTP 401) — check it has the "change stream title" permission'
          : `Owncast answered HTTP ${r.status}`,
      });
    }
    res.json({ ok: true, value });
  } catch (err) {
    res.json({ ok: false, error: `Could not reach ${apiUrl}: ${err.cause?.message ?? err.message}` });
  }
});

/**
 * Proves the Streamingestarr link end to end: capabilities discovery with
 * the same auth the live pushes use. Green here = metadata will land.
 */
app.post('/api/check/streamingestarr', async (req, res) => {
  const url = String(req.body?.url ?? config.streamingestarr?.url ?? '').replace(/\/+$/, '');
  // A row can test with its SAVED token (field left blank): resolve by id,
  // falling back to the legacy single token, exactly like the pushes do.
  const stored = req.body?.receiverId
    ? (config.streamingestarr?.receivers ?? []).find((r) => r.id === req.body.receiverId)?.accessToken
      ?? config.streamingestarr?.accessToken
    : config.streamingestarr?.accessToken;
  const token = req.body?.accessToken && req.body.accessToken !== '__SET__'
    ? req.body.accessToken
    : stored;
  if (!url) return res.status(400).json({ ok: false, error: 'Receiver address is required' });
  if (!token) return res.status(400).json({ ok: false, error: 'Access token is required' });
  try {
    const r = await fetch(`${url}/api/integrations/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      return res.json({
        ok: false,
        error: r.status === 401
          ? 'The receiver rejected the token (HTTP 401) — create one with the system-messages scope'
          : `The receiver answered HTTP ${r.status}`,
      });
    }
    const caps = await r.json();
    if (caps?.service !== 'streamingestarr') {
      return res.json({ ok: false, error: 'That address answers, but it is not a Streamingestarr receiver' });
    }
    res.json({ ok: true, caps });
  } catch (err) {
    res.json({ ok: false, error: `Could not reach ${url}: ${err.cause?.message ?? err.message}` });
  }
});

/**
 * The fixed sets the settings form builds its pickers from.
 *
 * Served rather than duplicated in the frontend so a language the panel
 * offers is always one the track matcher resolves, and so the render device
 * list is the machine's actual one instead of a guess.
 */
app.get('/api/options', async (req, res) => {
  // Named, not just listed: renderD128 is enumeration order, so an operator
  // reading a bare path cannot tell a discrete card from the CPU's
  // integrated graphics — nor that a second node exists but was never
  // passed into the container.
  let renderNodeInfo = [];
  try {
    renderNodeInfo = await renderNodes();
  } catch {
    // Naming is a nicety; never let it break the settings page.
  }
  const renderDevices = renderNodeInfo.map((n) => n.path);
  /**
   * Which tone-map engines this machine can actually run.
   *
   * Offering "GPU" on a driver without the filter is offering a guaranteed
   * dead clip — which is exactly what happened: the option was picked, every
   * spawn died at -22, and nothing in the UI had said it could not work.
   * A control that lists impossible choices is worse than no control.
   */
  let tonemapEngines = { vaapi: null, cpu: null };
  let hdr10 = null;
  try {
    tonemapEngines = {
      vaapi: await vaapiTonemapPresent(config.encoder.device),
      cpu: await cpuTonemapAvailable(),
    };
    // Gates the HDR-output switch: without main10 encode there is no HDR
    // to output and the control would be a guaranteed disappointment.
    hdr10 = await vaapiMain10Present(config.encoder.device);
  } catch {
    // Unknown beats wrong: the UI shows no availability hint rather than
    // claiming something is unsupported because a probe crashed.
  }
  res.json({
    renderNodes: renderNodeInfo,
    tonemapEngines,
    tonemapCurves: TONEMAP_CURVES,
    hdr10,
    languages: LANGUAGES.map(({ code, name }) => ({ code, name })),
    renderDevices,
    // Names and labels are static; only whether each one WORKS needs the
    // probe. Sending them up front means the encoder choice is a list from
    // the moment the page loads instead of a free text box until you
    // remember to press Probe.
    encoderBackends: Object.entries(BACKENDS).map(([backend, b]) => ({ backend, label: b.label })),
  });
});

/** Progress of background still generation, for the library indicator. */
app.get('/api/library/stills', (req, res) => res.json(stillSweeper?.status()
  ?? { running: false, done: 0, total: 0, failed: 0, pending: 0 }));

/** Progress of background TMDB matching, for the library indicator. */
app.get('/api/library/meta/status', (req, res) => res.json(tmdbSweeper?.status()
  ?? { running: false, fetched: 0, matched: 0, missed: 0 }));

// Async by hand rather than through wrap(): it is declared further down
// and a const is not hoisted — referencing it here crashed the boot.
const metaRoute = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Candidates for the Fix-artwork picker; the key never leaves the server. */
app.get('/api/library/meta/search', metaRoute(async (req, res) => {
  const meta = currentTmdbMeta();
  if (!meta?.enabled) return res.status(409).json({ error: 'TMDB is not configured' });
  const type = req.query.type === 'movie' ? 'movie' : 'tv';
  const q = String(req.query.q ?? '').slice(0, 200);
  if (!q.trim()) return res.json({ results: [] });
  res.json({ results: await meta.search(type, q) });
}));

/**
 * The operator's correction: pin this TMDB entry to that library title.
 * Replaces the wrong match (or the miss) in the cache; the sweeper is
 * kicked so a corrected series gets its episode names straight away.
 */
app.post('/api/library/meta/assign', metaRoute(async (req, res) => {
  const meta = currentTmdbMeta();
  if (!meta?.enabled) return res.status(409).json({ error: 'TMDB is not configured' });
  const { metaKey, tmdbId } = req.body ?? {};
  if (!metaKey || !Number(tmdbId)) return res.status(400).json({ error: 'metaKey and tmdbId are required' });
  const entry = await meta.assign(String(metaKey), Number(tmdbId));
  tmdbSweeper?.start();
  res.json({ ok: true, title: entry.title, year: entry.year });
}));

/**
 * The operator's rejection: nothing on TMDB is this title. The wrong match
 * is dropped and the absence pinned, so the sweeper cannot put the same
 * wrong answer back; the title falls back to filename and local artwork.
 */
app.post('/api/library/meta/clear', metaRoute(async (req, res) => {
  const meta = currentTmdbMeta();
  if (!meta?.enabled) return res.status(409).json({ error: 'TMDB is not configured' });
  const { metaKey } = req.body ?? {};
  if (!metaKey) return res.status(400).json({ error: 'metaKey is required' });
  meta.clear(String(metaKey));
  res.json({ ok: true });
}));

app.get('/api/check/encoders', async (req, res) => {
  const results = await probeAll(config.encoder.device);
  const caps = await probeConcatCapabilities();
  res.json({
    encoders: results.map(({ backend, ok, label, error }) => ({ backend, ok, label, error })),
    ffmpeg: caps.version,
    recursionDepth: caps.recursionDepth,
  });
});

/**
 * Line a metadata catalogue up against the media we can open.
 *
 * Answers the only question the operator should have to think about — "is
 * this the same library?" — and derives the path translation as a side
 * effect, so nobody types a mapping rule. Read-only: it enumerates both
 * sides and compares strings.
 */
app.post('/api/match/library', async (req, res) => {
  try {
    const { media, jellyfin } = req.body ?? {};
    if (!media?.provider) return res.status(400).json({ error: 'No media source given' });
    if (!jellyfin?.url) return res.status(400).json({ error: 'No Jellyfin address given' });

    /**
     * The media half arrives with the same '__SET__' sentinels as any
     * save — the panel never holds a real secret. Building a library
     * straight from it probed the share with the literal sentinel as the
     * password; the share then listed nothing, and the match reported
     * "the source listed no files" against a perfectly healthy library —
     * so the rules could never be derived and every paired playback died
     * at the bridge with an ffprobe 5XX.
     */
    const [restored] = restoreSourceSecrets([media]);
    const mediaLib = makeLibrary({ library: { sources: [restored] } }).sources[0]?.lib;
    if (typeof mediaLib?.allPaths !== 'function') {
      return res.status(400).json({ error: 'This media source cannot be matched yet' });
    }
    // The panel never holds a real key, so the sentinel resolves to what is
    // stored for the source being edited.
    // The catalogue key lives on the source's metadata block; the legacy
    // jellyfin block is checked too so an unmigrated source still matches.
    const src = (config.library?.sources ?? [])
      .find((x) => x.id === media.id) ?? {};
    const stored = src.metadata?.apiKey || src.jellyfin?.apiKey
      || (config.library?.sources ?? []).find((x) => x.metadata?.apiKey)?.metadata?.apiKey
      || '';
    const apiKey = jellyfin.apiKey === '__SET__' ? stored : (jellyfin.apiKey ?? '');
    const jf = new JellyfinLibrary({ url: jellyfin.url, apiKey });

    const [reported, local] = await Promise.all([jf.allPaths(), mediaLib.allPaths()]);
    /**
     * Say WHICH side is empty.
     *
     * "No files matched" reads as "these are different libraries", and that
     * is only one of the reasons it can happen: a share that lists nothing,
     * or a catalogue that returns nothing, produce the same sentence while
     * meaning something completely different. An operator who knows their
     * media is identical is then told, confidently, that it is not.
     */
    if (!local.length) {
      return res.json({
        matched: 0, total: reported.length, rules: [], examples: [],
        counts: { catalogue: reported.length, media: 0 },
        description: 'No media found to compare. The source listed no files —'
          + ' check the share or folder on the previous step.',
      });
    }
    if (!reported.length) {
      return res.json({
        matched: 0, total: 0, rules: [], examples: [],
        counts: { catalogue: 0, media: local.length },
        description: 'The catalogue returned no files. Check the address and key.',
      });
    }
    const result = deriveMapping(reported, local);
    res.json({
      matched: result.matched,
      total: result.total,
      rules: result.rules,
      ambiguous: result.ambiguous,
      // A handful of examples, never the whole list: this is a summary, and
      // the paths are the operator's business rather than a payload.
      examples: result.unmatched.slice(0, 3),
      // Both sizes, so a lopsided comparison is visible rather than inferred.
      counts: { catalogue: reported.length, media: local.length },
      description: describeMatch(result),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/check/library', async (req, res) => {
  try {
    /**
     * Test against submitted values so the panel can validate before saving.
     * Both shapes are accepted: the settings page sends the whole
     * `sources` list, and older callers send one flat provider block.
     */
    const body = req.body ?? {};
    const submitted = Array.isArray(body.sources) ? body : (body.provider ? { sources: [body] } : null);
    // The panel holds no real secrets, so a submitted source carries the
    // sentinel. Without resolving it here, testing a source with a saved
    // key probed with the literal string and reported a 401.
    if (submitted) submitted.sources = restoreSourceSecrets(submitted.sources);
    const probe = submitted ? makeLibrary({ library: submitted }) : library;
    if (!probe.configured) return res.status(400).json({ error: 'Not configured' });
    res.json(await probe.test());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Pair library roots against local directories to seed path mapping. */
app.post('/api/check/pathmap', async (req, res) => {
  try {
    const probe = req.body?.provider ? makeLibrary({ library: req.body }) : library;
    const libs = await probe.libraries();
    const reported = libs.flatMap((l) => l.locations ?? []);
    const local = (req.body?.localRoots ?? ['/extHdd', '/media', '/mnt', '/data'])
      .filter((p) => existsSync(p));

    // The common case is that no mapping is needed at all — a Jellyfin in an
    // LXC with the same mount reports paths this container can already open.
    // Checking is trivial and saves the user reasoning about it.
    const reachable = reported.filter((p) => existsSync(p));
    const noMappingNeeded = reported.length > 0 && reachable.length === reported.length;

    res.json({
      reported,
      local,
      reachable,
      noMappingNeeded,
      suggested: noMappingNeeded ? [] : suggestRules(reported, local),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── library ────────────────────────────────────────────────────────────

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Pick up media added since the panel was opened.
 *
 * For a folder or a share this only means dropping the client and rebuilding
 * it, since both read the disk on every request anyway. For Jellyfin it means
 * asking JELLYFIN to rescan — nothing on this side caches its listings, so a
 * missing episode is almost always one Jellyfin has not indexed yet, and
 * refetching our end would just re-read the same stale answer.
 */
async function rescanSources() {
  const asked = [];
  for (const src of config.library?.sources ?? []) {
    if (src.provider !== 'jellyfin' || !src.jellyfin?.url || !src.jellyfin?.apiKey) continue;
    try {
      const r = await fetch(`${String(src.jellyfin.url).replace(/\/+$/, '')}/Library/Refresh`, {
        method: 'POST',
        headers: { Authorization: `MediaBrowser Token="${src.jellyfin.apiKey}"` },
        signal: AbortSignal.timeout(10_000),
      });
      asked.push({ name: src.name, ok: r.ok, status: r.status });
    } catch (err) {
      asked.push({ name: src.name, ok: false, error: err.message });
    }
  }
  refreshLibrary();
  return asked;
}

/**
 * Periodic rescan, so media added to Jellyfin turns up without anyone
 * pressing anything. Server-side on purpose: it has to happen whether or not
 * a browser is open. It is safe during a broadcast because rebuilding the
 * providers now carries SMB bridge tokens across, and a Jellyfin scan is
 * Jellyfin's own background work.
 */
let autoScan = null;
function scheduleAutoScan() {
  clearInterval(autoScan);
  const cfg = config.library?.autoRefresh ?? {};
  if (cfg.enabled === false) return;
  // Clamped: an interval of zero would spin, and anything under an hour
  // asks Jellyfin to rescan more often than it can finish on a large library.
  const hours = Math.min(168, Math.max(1, Number(cfg.hours) || 12));
  autoScan = setInterval(async () => {
    try {
      const asked = await rescanSources();
      const named = asked.filter((a) => a.ok).map((a) => a.name);
      console.log(`  scheduled library scan${named.length ? `: asked ${named.join(', ')} to rescan` : ''}`);
    } catch (err) {
      console.warn(`! scheduled library scan failed: ${err.message}`);
    }
  }, hours * 60 * 60 * 1000);
  autoScan.unref?.();
}

app.post('/api/library/refresh', wrap(async (req, res) => {
  const asked = await rescanSources();
  res.json({
    ok: true,
    rescanned: asked,
    // Jellyfin answers immediately and scans in the background, so a fresh
    // listing may still be a moment away. Say so rather than implying the
    // work is finished.
    note: asked.length ? 'Jellyfin scans in the background; new items may take a moment.' : undefined,
  });
}));

app.get('/api/library/libraries', wrap(async (req, res) =>
  res.json(await library.libraries())));

app.get('/api/library/items', wrap(async (req, res) =>
  res.json(await library.items(req.query.libraryId, {
    startIndex: Number(req.query.startIndex) || 0,
    limit: Math.min(Number(req.query.limit) || 60, 200),
    search: req.query.search,
  }))));

app.get('/api/library/seasons', wrap(async (req, res) =>
  res.json(await library.seasons(req.query.seriesId))));

app.get('/api/library/episodes', wrap(async (req, res) =>
  res.json(await library.episodes(req.query.seriesId, { seasonId: req.query.seasonId }))));

/** Local artwork for the filesystem provider; Jellyfin serves its own. */
app.get('/api/library/image/:id', async (req, res) => {
  let p = library.imagePath?.(req.params.id);
  if (!p && library.resolveImage) p = await library.resolveImage(req.params.id).catch(() => null);
  // A provider may hand back a remote url (Jellyfin serves its own artwork);
  // only a local path can be checked for existence here.
  if (!p || (!isRemote(p) && !existsSync(p))) return res.status(404).end();
  // Media with no artwork of its own resolves to the video file: take a
  // frame from it rather than leaving the row blank. Unlike a scaled image
  // there is no falling back to the source here — a video served where an
  // image belongs renders as a broken tile.
  // Serve a still only if one has already been made: generating here would
  // put ffmpeg on the browsing path, which is what made opening a season
  // over SMB crawl. The sweeper fills these in behind the scenes, and until
  // it has, the row keeps its placeholder.
  const fromVideo = isVideoFile(p);
  const scaled = fromVideo
    ? cachedFrame(p, config.paths?.cache)
    : await thumbnail(p, config.paths?.cache).catch(() => null);
  if (fromVideo && !scaled) return res.status(404).end();
  // Remote art has no local fallback: if scaling failed, redirect rather than
  // trying to stream a url through createReadStream.
  if (!scaled && isRemote(p)) return res.redirect(302, p);
  // The url carries the source mtime, so a re-scraped image arrives under a
  // new url and can be cached hard rather than re-fetched on a timer.
  res.setHeader('Cache-Control', req.query.v
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=86400');
  if (scaled) res.setHeader('Content-Type', 'image/jpeg');
  createReadStream(scaled ?? p).pipe(res);
});

/** Tracks for one episode, plus which we'd pick — drives the track picker. */
app.get('/api/library/tracks', wrap(async (req, res) => {
  const item = await library.item(req.query.id);
  const path = library.resolvePath(item);
  const tracks = await probeTracks(path);
  const subtitles = await listSubtitles(path, tracks);
  const chosen = selectTracks(tracks, subtitles, config.tracks ?? {});
  res.json({
    audio: tracks.audio,
    subtitles: subtitles.map((s) => ({ ...s, path: undefined, key: s.external ? s.path : s.typeIndex })),
    chosen: {
      audioIndex: chosen.audio?.typeIndex ?? null,
      subtitleKey: chosen.subtitle ? (chosen.subtitle.external ? chosen.subtitle.path : chosen.subtitle.typeIndex) : null,
      reason: chosen.reason,
    },
  });
}));

// ── playout ────────────────────────────────────────────────────────────

app.get('/api/stream/status', (req, res) => res.json(streamStatus()));

app.post('/api/stream/start', (req, res) => startStream(req, res));
const startStream = wrap(async (req, res) => {
  if (engine) return res.status(409).json({ error: 'Already streaming' });
  // Make sure the previous broadcast has really let go of the connection.
  if (lastEngine) {
    try { lastEngine.hardStop(); } catch { /* already down */ }
    lastEngine = null;
  }

  // Entries are bare ids or { id, startAt, breakOffline, breakBefore, seg }
  // — the schedule store sends the latter so tonight's pins, breaks and
  // the tag that ties an item back to its schedule ride along.
  const entries = (req.body?.itemIds ?? [])
    .map((e) => (typeof e === 'string' ? { id: e } : e))
    .filter((e) => e && typeof e === 'object' && e.id);
  const ids = entries.map((e) => e.id);
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });

  // Scheduled start: broadcast a countdown card until this moment, then
  // roll the queue. Seconds since epoch; anything not sensibly in the
  // future is treated as "start now" rather than rejected.
  let startAt = Number(req.body?.startAt) || null;
  if (startAt != null) {
    const now = Date.now() / 1000;
    if (startAt <= now + 5) startAt = null;
    if (startAt != null && startAt > now + 24 * 3600) {
      return res.status(400).json({ error: 'Scheduled start must be within 24 hours' });
    }
  }

  /**
   * Codec guard rails, BEFORE anything spawns: a foreseeable bad choice
   * deserves a sentence, not a -22 from ffmpeg. AV1 cannot travel over
   * RTMP (enhanced-flv av01 has no deployed receivers here; the contract
   * says SRT/matroska), and a vaapi box without the chosen codec's
   * encode entrypoint fails a 1-frame probe in ~300ms.
   */
  const codec = config.encoder.codec ?? 'h264';
  {
    // Codec-aware selection (docs/codec-protocol-unification.md): the
    // primary auto-moves to its SRT slot for hevc/av1 when configured;
    // extras that cannot carry the codec sit out with a named warn and
    // rejoin when the codec allows. Refuse only the unfixable: a primary
    // with no compatible slot at all.
    const sel = publishDestinations(config, codec);
    const prim = sel[0];
    if (codec !== 'h264' && prim && prim.protocol.startsWith('rtmp')) {
      return res.status(400).json({
        error: `${codec.toUpperCase()} cannot travel over classic RTMP and no SRT server is configured for the primary — fill the SRT slot in Settings, or pick H.264`,
      });
    }
    for (const d of sel.skipped ?? []) {
      dpush('warn', `skipping destination '${d.name || d.protocol}' — ${d.protocol} cannot carry ${codec.toUpperCase()}; it rejoins on H.264`);
    }
  }
  // AV1 rides the NUT internal transport (mpegts cannot carry it — its
  // muxer writes AV1 as private data the demuxer reads back as bin_data).
  // The engine switches transports on profile.codec; no refusal needed.
  let lowPower = false;
  let softwareCodec = false;
  if (codec !== 'h264') {
    const enc = { hevc: 'hevc_vaapi', av1: 'av1_vaapi' }[codec];
    const dev = config.encoder.device ?? '/dev/dri/renderD128';
    // -xerror matters: without it ffmpeg exits 0 even when the encoder
    // thread dies with -22 and zero packets come out (measured with
    // av1_vaapi on RDNA2) — the probe would bless a broken go-live.
    const probeArgs = (lp) => ['-v', 'error', '-xerror',
      '-init_hw_device', `vaapi=va:${dev}`, '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:r=24', '-frames:v', '1',
      '-vf', 'format=nv12,hwupload', '-c:v', enc,
      ...(lp ? ['-low_power', '1'] : []), '-f', 'null', '-'];
    // HEVC tries VDENC first (-low_power: the fixed-function media block,
    // far cheaper than EU encode — the N100's HEVC cost complaint). Probed
    // by doing, never assumed: drivers without it fail the 1-frame probe
    // and the normal path is probed next.
    let probe = -1;
    if (codec === 'hevc') {
      probe = spawnSyncSafe('ffmpeg', probeArgs(true));
      if (probe === 0) lowPower = true;
    }
    if (probe !== 0) probe = spawnSyncSafe('ffmpeg', probeArgs(false));
    if (probe !== 0 && config.encoder.backend !== 'x264') {
      // No hardware encoder for this codec — attempt CPU before saying no.
      // The software encoders are proven paths (BACKENDS.x264 carries
      // libx265/libsvtav1 with live-tuned parameters); whether this box can
      // hold realtime is for the speed readout to answer, not a guess here.
      const sw = { hevc: 'libx265', av1: 'libsvtav1' }[codec];
      const swProbe = spawnSyncSafe('ffmpeg', ['-v', 'error', '-xerror',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24', '-frames:v', '1',
        '-c:v', sw, '-f', 'null', '-']);
      if (swProbe !== 0) {
        return res.status(400).json({
          error: `This box has neither a hardware ${codec.toUpperCase()} encoder nor ${sw} in its ffmpeg build — pick H.264`,
        });
      }
      softwareCodec = true;
      dpush('warn', `no hardware ${codec.toUpperCase()} encoder — encoding in software (${sw}). CPU-heavy: watch the speed readout; if it sinks below 1.0x, H.264 is the way back`);
    }
    if (lowPower) dpush('info', 'HEVC encode: VDENC (low_power) available — using the fixed-function encoder');
  }
  ensureDirs();
  const sel = await selectBackend({
    backend: config.encoder.backend,
    device: config.encoder.device,
  });
  // Studio overlays travel with the encoder profile: buildSourceArgs already
  // receives it, and the overlay is a property of the output, not the clip.
  const profile = {
    // A codec the GPU cannot encode demotes THIS RUN to the software
    // backend — the stored setting is untouched, so H.264 comes back on
    // hardware the moment it is selected again.
    ...config.encoder, backend: softwareCodec ? 'x264' : sel.backend,
    overlay: visibleOverlay(),
    overlayConfigured: overlayConfigured(),
    // The H.264 anchor bitrate never changes; other codecs derive their
    // cheaper rate from it (or an explicit hevcBitrate/av1Bitrate override).
    videoBitrate: codecBitrate(config.encoder),
    lowPower,
  };

  // Resolve every item up front so a bad path fails before we go on air.
  const items = [];
  for (const entry of entries) {
    const id = entry.id;
    const item = await library.item(id);
    items.push({
      ...queueExtras(entry),
      posterPath: await posterFile(item.image ?? null),
      ...(Number(entry.startAt) > 0 ? { startAt: Number(entry.startAt), ...(entry.breakOffline ? { breakOffline: true } : {}) } : {}),
      id: item.id,
      title: item.seriesName
        ? `${item.seriesName} — S${item.season ?? '?'}E${item.episode ?? '?'}`
        : item.title,
      // Carried so the panel can group the schedule by show without
      // having to parse it back out of the display title.
      series: item.seriesName ?? null,
      srcPath: library.resolvePath(item),
      duration: item.duration ?? null,
      image: item.image ?? null,
    });
  }

  const tracks = await probeTracks(items[0].srcPath);
  const subs = await listSubtitles(items[0].srcPath, tracks);
  const selection = selectTracks(tracks, subs, {
    ...(config.tracks ?? {}),
    ...(req.body?.trackOverride ?? {}),
  });
  // Source geometry: subtitles must be rendered at the video's content
  // rectangle, not the padded output frame, or 4:3 content gets its
  // positioned subs smeared toward the 16:9 edges.
  selection.video = tracks.video[0] ?? null;

  // The full-GPU chain is the default whenever VAAPI is the backend —
  // subtitle-free 4K films were software-decoding at 0.6x while the GPU
  // idled, because this used to be gated on subtitles existing. The overlay
  // (subtitled) variant additionally needs the driver to honour alpha.
  // items[0], not `item`: that one is scoped to the resolve loop above, and
  // this is the file the tracks were probed from.
  await tuneProfile(profile, selection, items[0]?.srcPath ?? null);

  /**
   * Pre-flight the destination actually configured, not the legacy field.
   *
   * This still called rtmpTarget(), which reads owncast.rtmpUrl — so an
   * install set up through the publish block refused to start with
   * "owncast.rtmpUrl is not configured" while being perfectly configured.
   *
   * Only RTMP is dialled: the tester speaks the RTMP handshake and nothing
   * else, and a check that cannot understand SRT would fail a working
   * target. Extras are not pre-flighted either — a fan-out survives one
   * destination being down by design, so refusing to start because a
   * secondary is unreachable would be the wrong call.
   */
  let dests;
  try {
    dests = publishDestinations();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const primary = dests[0];
  if (primary.protocol === 'rtmp' || primary.protocol === 'rtmps') {
    const conn = await testRtmpConnection(targetUrl(primary.protocol, primary.creds));
    if (!conn.ok) {
      return res.status(502).json({
        error: 'The server would not accept the stream',
        detail: redact(conn.error),
      });
    }
  }

  // A fresh broadcast starts from the configured preferences, not from
  // whatever was switched to during the last one.
  trackIntent = {};
  sgAnnounced = null;
  sgOnAirKey = null;
  // Same capture moment as the destinations themselves: the rooms this
  // broadcast pushes metadata to are the rooms it streams to, and a
  // settings edit mid-broadcast changes neither until the next start.
  // Resolution asks the receiver which room each stream key feeds; ~3s
  // worst case, in parallel, and only when a receiver is configured.
  try {
    const dests = publishDestinations(config, config.encoder.codec ?? 'h264');
    sgChannels = await sgResolveChannels(dests);
  } catch { sgChannels = ['']; }
  engine = buildEngine({ profile, selection });
  // Not awaited: going live can legitimately take minutes when the first
  // clip's subtitles must be extracted (one full read of the file), and an
  // HTTP request cannot sit open that long. The engine reports 'preparing'
  // then 'running' over the status feed; failures arrive the same way.
  const e = engine;
  e.start(items, { startAt }).catch((err) => {
    dpush('error', `start failed: ${err.message}`);
    broadcast('error', { message: redact(String(err.message ?? err)) });
    try { e.stop(); } catch { /* already down */ }
    if (engine === e) engine = null;
  });
  res.json({ ok: true, tracks: selection.reason, ...streamStatus() });
});


app.post('/api/stream/pause', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  engine.pause();
  res.json({ ok: true, position: engine.position });
}));

app.post('/api/stream/resume', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  engine.resume();
  res.json({ ok: true, position: engine.position });
}));

/** Abandon the clip on air and start the next queued one. */
app.post('/api/stream/next', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  if (!engine.skip()) {
    return res.status(409).json({
      error: engine.queue?.length
        ? 'Cannot skip yet — the broadcast is still starting'
        : 'Nothing queued to skip to',
    });
  }
  broadcast('stream', streamStatus());
  res.json(streamStatus());
}));

/** Skip within the current clip. The connection is not affected. */
app.post('/api/stream/seek', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  const position = engine.seek({
    delta: Number(req.body?.delta ?? 0),
    position: req.body?.position != null ? Number(req.body.position) : null,
  });
  res.json({ ok: true, position });
}));

/** Tracks available on the clip currently on air, and which are in use. */
app.get('/api/stream/tracks', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });

  const playing = engine.snapshot().playing;
  if (!playing?.srcPath) return res.status(409).json({ error: 'Nothing playing yet' });

  const tracks = await probeTracks(playing.srcPath);
  const subtitles = await listSubtitles(playing.srcPath, tracks);
  const chosen = engine.selection;

  res.json({
    title: playing.title,
    audio: tracks.audio,
    subtitles: subtitles.map((s) => ({
      ...s,
      path: undefined,
      key: s.external ? s.path : s.typeIndex,
    })),
    chosen: {
      audioIndex: chosen?.audio?.typeIndex ?? null,
      subtitleKey: chosen?.subtitle
        ? (chosen.subtitle.external ? chosen.subtitle.path : chosen.subtitle.typeIndex)
        : null,
      reason: chosen?.reason ?? null,
    },
  });
}));

/**
 * Change audio or subtitle track without losing your place.
 *
 * Track choice is fixed for the life of an ffmpeg process — `-map` and the
 * subtitles filter are set once — so this restarts the encoder and resumes at
 * the current offset. Viewers see a brief interruption; that is the honest
 * cost, and it beats being stuck with a broken subtitle track for an hour.
 */
app.post('/api/stream/tracks', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });

  const playing = engine.snapshot().playing;
  if (!playing?.srcPath) return res.status(409).json({ error: 'Nothing playing yet' });

  const tracks = await probeTracks(playing.srcPath);
  const subs = await listSubtitles(playing.srcPath, tracks);
  const selection = selectTracks(tracks, subs, {
    ...(config.tracks ?? {}),
    audioIndex: req.body?.audioIndex ?? null,
    subtitleId: req.body?.subtitleKey ?? null,
    subtitleMode: req.body?.subtitleMode ?? config.tracks?.subtitleMode ?? 'auto',
  });
  selection.video = tracks.video[0] ?? null;

  // Carry the CHOICE, not the index, into the rest of the queue.
  rememberIntent(selection,
    req.body?.subtitleMode ?? (req.body?.subtitleKey == null ? 'off' : undefined),
    playing);

  /**
   * Re-tune the profile against the NEW selection before the respawn.
   * tuneProfile early-returns for a subtitle-less selection, so a
   * broadcast that started without subtitles still had gpuSubs=false —
   * and switching subtitles on mid-episode respawned into the CPU chunk
   * path (Loading card, cache ramp) on a box whose GPU path was proven
   * fine. Chunking is the emergency path; a stale probe flag must never
   * be what sends a clip there. The probes are process-cached, so this
   * is cheap on every switch after the first.
   */
  if (engine.profile) {
    await tuneProfile(engine.profile, selection, playing.srcPath);
    engine.retune?.(tunedFields(engine.profile));
  }

  // Only the source restarts; the publisher keeps the connection open, so
  // this is near-instant rather than an interruption.
  engine.setSelection(selection);

  broadcast('stream', streamStatus());
  res.json({ ok: true, tracks: selection.reason, position: engine.position });
}));

app.post('/api/stream/stop', (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  engine.stop();
  res.json({ ok: true });
});

app.post('/api/stream/queue', wrap(async (req, res) => {
  if (!engine) return res.status(409).json({ error: 'Not streaming' });
  // Resolving a long queue means dozens of round trips to the library, and
  // the broadcast can end while they are in flight — pin the engine we
  // started with rather than whatever the module variable holds by the
  // time the loop finishes, which may be null.
  const e = engine;
  const items = [];
  // Entries are either a bare id or { id, startAt } — the schedule page
  // sends the latter so pinned air times survive a reorder or removal.
  for (const entry of req.body?.itemIds ?? []) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!id) continue;
    const pin = typeof entry === 'object' ? Number(entry.startAt) || null : null;
    const offline = typeof entry === 'object' && Boolean(entry.breakOffline);
    if (engine !== e) {
      return res.status(409).json({ error: 'The broadcast ended while the queue was being added' });
    }
    // An item the engine already holds needs no library lookup at all.
    // Every edit sends the WHOLE queue back, so re-resolving each entry
    // meant one round trip per queued item per keystroke — measured at
    // 1.76s for a 113-episode queue, hammering Jellyfin for data that had
    // not changed. Reuse what is known and only fetch genuinely new ids.
    // (It also preserves durations probed in the background, which the
    // library cannot tell us again.)
    const known = e.queue.find((q) => q.id === id);
    const base = known ?? await (async () => {
      const item = await library.item(id);
      return {
        id: item.id,
        title: item.seriesName
          ? `${item.seriesName} — S${item.season ?? '?'}E${item.episode ?? '?'}`
          : item.title,
        // Carried so the panel can group the schedule by show without
        // having to parse it back out of the display title.
        series: item.seriesName ?? null,
        srcPath: library.resolvePath(item),
        duration: item.duration ?? null,
        image: item.image ?? null,
      };
    })();
    const next = { ...base };
    delete next.startAt;
    delete next.breakOffline;
    delete next.at;                       // projection, recomputed per snapshot
    delete next.breakBefore;
    delete next.seg;
    if (pin) next.startAt = pin;
    if (pin && offline) next.breakOffline = true;
    Object.assign(next, queueExtras(entry));
    items.push(next);
  }
  if (engine !== e) {
    return res.status(409).json({ error: 'The broadcast ended while the queue was being added' });
  }
  e.setQueue(items);
  broadcast('stream', streamStatus());
  res.json(streamStatus());
}));

// ── static UI ──────────────────────────────────────────────────────────

/* ------------------------------------------------------------------------
 * Schedules: saved lineups, tonight, history. State lives in the store;
 * the engine's queue is derived from tonight whenever it changes.
 * ---------------------------------------------------------------------- */
const sched = createScheduleStore({ path: join(CONFIG_DIR, 'schedules.json') });

/** Extra fields an entry may carry into the engine queue. */
function queueExtras(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const out = {};
  if (entry.seg && typeof entry.seg === 'object') out.seg = entry.seg;
  if (Number(entry.breakBefore) > 0) out.breakBefore = Math.round(Number(entry.breakBefore));
  return out;
}

/**
 * A small local JPEG of an item's artwork, for the countdown card's strip.
 * The receiver's poster preparation already makes exactly that in memory;
 * this writes it once under the cache. Null when there is no artwork, or
 * it cannot be fetched — the card draws a placeholder then.
 */
async function posterFile(image) {
  if (!image) return null;
  try {
    const art = await sgArtPrepare(image);
    if (!art) return null;
    const dir = join(config.paths.cache, 'posters');
    const file = join(dir, `${art.id}.jpg`);
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, Buffer.from(art.data, 'base64'));
    }
    return file;
  } catch { return null; }
}

/** Library items in the shape schedules and the engine keep. */
async function resolveItems(ids) {
  const out = [];
  for (const id of ids ?? []) {
    const item = await library.item(String(id));
    out.push({
      posterPath: await posterFile(item.image ?? null),
      id: item.id,
      title: item.seriesName
        ? `${item.seriesName} — S${item.season ?? '?'}E${item.episode ?? '?'}`
        : item.title,
      series: item.seriesName ?? null,
      season: item.season ?? null,
      episode: item.episode ?? null,
      duration: item.duration ?? null,
      image: item.image ?? null,
    });
  }
  return out;
}

/** Tonight with the engine's projections folded in: air times and what is on. */
function scheduleView() {
  const at = new Map();
  let onAirKey = null;
  // A stopped engine still answers snapshot() with its last clip; nothing
  // is on air then.
  if (engine && engine.status !== 'stopped') {
    const s = engine.snapshot();
    for (const q of s.queue ?? []) if (q.seg?.item && q.at != null) at.set(q.seg.item, q.at);
    onAirKey = s.playing?.seg?.item ?? null;
  }
  const t = sched.tonight();
  return {
    schedules: sched.list().map((x) => ({ ...x, nextRun: sched.nextRun(x.id) })),
    tonight: {
      segments: t.segments.map((seg) => ({
        ...seg,
        items: seg.items.map((it) => ({ ...it, at: at.get(it.key) ?? null, onAir: it.key === onAirKey })),
      })),
      entries: sched.upcomingEntries(),
    },
    history: sched.history(),
    settings: sched.settings(),
    live: Boolean(engine) && engine.status !== 'stopped',
  };
}
sched.onChange(() => broadcast('schedule', scheduleView()));

/** While live, the engine plays what tonight says comes next. */
async function syncTonight() {
  const e = engine;
  if (!e) return;
  const entries = sched.upcomingEntries();
  const items = [];
  for (const entry of entries) {
    const known = e.queue.find((q) => q.id === entry.id) ?? (e.current?.item?.id === entry.id ? e.current.item : null);
    const base = known ? { ...known } : (await resolveItems([entry.id]))[0];
    if (!known) base.srcPath = library.resolvePath(await library.item(entry.id));
    delete base.startAt; delete base.breakOffline; delete base.breakBefore; delete base.seg; delete base.at;
    if (entry.startAt) base.startAt = entry.startAt;
    if (entry.startAt && entry.breakOffline) base.breakOffline = true;
    Object.assign(base, queueExtras(entry));
    items.push(base);
  }
  if (engine !== e) return;
  e.setQueue(items);
  broadcast('stream', streamStatus());
}

/** Express' res, for calling a route handler from inside the process. */
function innerRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

/** Go live with tonight, or append it to a broadcast already running. */
async function goLive({ startAt = null, trackOverride = null } = {}) {
  const entries = sched.upcomingEntries();
  if (!entries.length) return { code: 400, body: { error: 'Nothing is lined up for tonight' } };
  if (engine) { await syncTonight(); return { code: 200, body: streamStatus() }; }
  const r = innerRes();
  await startStream({ body: { itemIds: entries, startAt, trackOverride } }, r);
  if (r.code < 300) sched.onAir(entries[0].seg.item);
  return r;
}

const sroute = (fn) => wrap(async (req, res) => {
  try {
    const out = await fn(req);
    if (out && typeof out.code === 'number' && 'body' in out) return res.status(out.code).json(out.body);
    await syncTonight();
    res.json(scheduleView());
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

app.get('/api/schedule', (req, res) => res.json(scheduleView()));
app.put('/api/schedule/settings', sroute((req) => sched.setSettings(req.body ?? {})));
app.delete('/api/schedule/history', sroute(() => sched.clearHistory()));

app.post('/api/schedule/schedules', sroute(async (req) => {
  const b = req.body ?? {};
  if (b.fromTonight) return sched.saveTonightAs(b.name);
  const items = Array.isArray(b.itemIds) ? await resolveItems(b.itemIds) : (b.items ?? []);
  return sched.create({ ...b, items });
}));
app.put('/api/schedule/schedules/:id', sroute(async (req) => {
  const b = { ...(req.body ?? {}) };
  if (Array.isArray(b.itemIds)) b.items = await resolveItems(b.itemIds);
  return sched.update(req.params.id, b);
}));
app.delete('/api/schedule/schedules/:id', sroute((req) => sched.remove(req.params.id)));
app.post('/api/schedule/schedules/:id/reset', sroute((req) => sched.resetProgress(req.params.id)));
app.post('/api/schedule/schedules/:id/duplicate', sroute((req) => sched.duplicate(req.params.id)));
app.post('/api/schedule/schedules/:id/load', sroute((req) => sched.load(req.params.id, { startAt: Number(req.body?.startAt) || null })));
app.post('/api/schedule/schedules/:id/append', sroute((req) => sched.append(req.params.id, { startAt: Number(req.body?.startAt) || null })));

app.post('/api/schedule/tonight/items', sroute(async (req) => sched.addItems(await resolveItems(req.body?.itemIds ?? []))));
app.put('/api/schedule/tonight/order', sroute((req) => sched.reorder(req.body?.order ?? [])));
app.post('/api/schedule/tonight/items/:key/move', sroute((req) => sched.moveItem(req.params.key, Number(req.body?.delta) || 1)));
app.put('/api/schedule/tonight/items/:key', sroute((req) => sched.setItem(req.params.key, req.body ?? {})));
app.delete('/api/schedule/tonight/items/:key', sroute((req) => sched.removeItem(req.params.key)));
app.post('/api/schedule/tonight/segments/:key/move', sroute((req) => sched.moveSegment(req.params.key, Number(req.body?.delta) || 1)));
app.put('/api/schedule/tonight/segments/:key', sroute((req) => sched.setSegment(req.params.key, req.body ?? {})));
app.put('/api/schedule/tonight/segments/:key/start', sroute((req) => sched.setSegmentStart(req.params.key, Number(req.body?.index) || 0)));
app.delete('/api/schedule/tonight/segments/:key', sroute((req) => sched.removeSegment(req.params.key)));
app.delete('/api/schedule/tonight', sroute(() => sched.clearTonight()));
app.post('/api/schedule/tonight/live', wrap(async (req, res) => {
  const r = await goLive({ startAt: Number(req.body?.startAt) || null, trackOverride: req.body?.trackOverride ?? null });
  res.status(r.code).json(r.body);
}));

/**
 * Auto-start. Every half minute, schedules inside their countdown lead go
 * live with a countdown card until their time; if a broadcast is already
 * running they are appended instead, pinned to that time.
 */
setInterval(() => {
  for (const { schedule, at } of sched.dueAutoStarts(Date.now())) {
    (async () => {
      if (engine) {
        sched.append(schedule.id, { startAt: at });
        await syncTonight();
        dpush('info', `auto-start: "${schedule.name}" appended for ${new Date(at * 1000).toLocaleTimeString()}`);
        return;
      }
      sched.load(schedule.id);
      const r = await goLive({ startAt: at });
      if (r.code >= 300) dpush('warn', `auto-start of "${schedule.name}" failed: ${r.body?.error ?? r.code}`);
      else dpush('info', `auto-start: "${schedule.name}" goes live at ${new Date(at * 1000).toLocaleTimeString()}`);
    })().catch((err) => dpush('warn', `auto-start of "${schedule.name}" failed: ${err.message}`));
  }
}, 30_000).unref?.();

if (existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR, {
    // The bundle's chunks are content-hashed — safe to cache forever. The
    // HTML that points at them must never be cached: express served it
    // with no policy, the browser heuristically kept it, and every deploy
    // needed a hard refresh to stop the stale HTML loading the old app.
    setHeaders: (res, path) => {
      res.setHeader('Cache-Control', path.includes('/immutable/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    },
  }));
  // SPA fallback: any non-API path serves the app shell so client routing works.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(WEB_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => res.status(503).type('text/plain').send(
    'UI not built yet.\n\nRun: cd web && npm install && npm run build\n'
    + 'The API is available under /api.\n',
  ));
}

/**
 * Terminal error handler. MUST stay last — Express picks the four-argument
 * handler by arity, and only ever the first one registered after the failing
 * route.
 *
 * Without this, Express's built-in handler runs, and outside NODE_ENV
 * =production it puts err.stack in the RESPONSE BODY. Malformed JSON on the
 * public login endpoint was enough to hand an anonymous caller the absolute
 * install path, the account name and the dependency layout. Setting
 * NODE_ENV alone would fix that container-side, but this service is also run
 * straight from source, where nothing sets it — so the guarantee belongs
 * here, not in the environment.
 */
// eslint-disable-next-line no-unused-vars -- arity is what marks this a handler
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  // Body parser failures are the client's fault and safe to name; anything
  // else is ours, and the detail belongs in the log, not the reply.
  const message = err.type === 'entity.parse.failed' ? 'Malformed JSON body'
    : err.type === 'entity.too.large' ? 'Request body too large'
      : status < 500 ? 'Bad request'
        : 'Internal error';
  if (status >= 500) console.error('[unhandled]', redact(err.stack ?? String(err)));
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
});

// ── websocket ──────────────────────────────────────────────────────────

// Two endpoints share the HTTP server: /ws (JSON status feed) and
// /ws/preview (binary MPEG-TS). A WebSocketServer bound with {server, path}
// rejects every other path itself, so with two of them the routing has to
// be explicit.
const wss = new WebSocketServer({ noServer: true });
const previewWss = new WebSocketServer({ noServer: true });

/**
 * A WebSocket handshake is not protected by SameSite the way fetch is — some
 * engines never applied it, and a page served from the SAME host on another
 * port is same-site anyway, which is an ordinary homelab shape. Without this
 * check such a page could open /ws/preview and watch the broadcast. Same
 * origin or no origin (native clients, ffmpeg) only.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                 // not a browser
  // Behind a proxy the Host header may have been rewritten to the upstream
  // (nginx does this by default; Caddy preserves the original), which would
  // make every legitimate handshake look cross-origin and silently kill the
  // live feed. Trust the forwarded name only when the operator has said
  // there IS a proxy — otherwise a direct caller could forge it.
  const expected = (TRUST_PROXY_ENV
    && String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim())
    || req.headers.host;
  try {
    return new URL(origin).host === expected;
  } catch { return false; }
}

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  const target = path === '/ws' ? wss : path === '/ws/preview' ? previewWss : null;
  if (!target) { socket.destroy(); return; }
  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  // No `passwordHash() &&`: an unconfigured panel must be closed, not open.
  if (!authDisabled() && !validSession(tokenFromRequest(req))) {
    ws.close(4401, 'unauthorized');
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'stream', payload: streamStatus(), ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

previewWss.on('connection', (ws, req) => {
  if (!authDisabled() && !validSession(tokenFromRequest(req))) {
    ws.close(4401, 'unauthorized');
    return;
  }
  if (!previewEnabled()) {
    ws.close(1000, 'preview disabled');
    return;
  }
  // Starts unsynced: the fan-out aligns this client's first bytes to a TS
  // packet boundary before sending anything.
  ws.jsrNeedsSync = true;
  previewSockets.add(ws);
  ws.on('close', () => previewSockets.delete(ws));
  ws.on('error', () => previewSockets.delete(ws));
});

// ── start ──────────────────────────────────────────────────────────────

ensureDirs();
{
  const swept = sweepCache(config.paths.cache);
  if (swept) console.log(`swept ${swept} leftover cache entr${swept === 1 ? 'y' : 'ies'} from a previous run`);
}
const fixed = normalizeStoredBitrates(normalizeBitrate);
if (fixed) {
  console.warn(`! repaired bitrate config: ${fixed.before.join(', ')} -> ${fixed.after.join(', ')}`);
  saveConfig({ encoder: { videoBitrate: config.encoder.videoBitrate, audioBitrate: config.encoder.audioBitrate } });
}
// A stored config is not a trusted input: it may predate the validation in
// PUT /api/config, or have been edited by hand.
const encFixed = normalizeStoredEncoder();
if (encFixed) {
  console.warn(`! repaired encoder config: ${encFixed.join(', ')}`);
  saveConfig({ encoder: config.encoder });
}
/**
 * Fills in generated stills off the browsing path. Yields to a broadcast:
 * speculative ffmpeg work beside the encoder is how a marginal clip ends up
 * stalling, which this project has learned the hard way.
 */
stillSweeper = new StillSweeper({
  library: () => library,
  cacheDir: () => config.paths?.cache,
  busy: () => Boolean(engine),
  log: (m) => dpush('ffmpeg', m),
});
stillSweeper.start();

// Matches folder/share titles against TMDB in the background, so entering
// the API key is the whole setup: names, episode titles and posters land
// as the sweep progresses, and cached metadata leaves with its title.
tmdbSweeper = new TmdbSweeper({
  library: () => library,
  log: (m) => dpush('ffmpeg', m),
});
tmdbSweeper.start();

scheduleAutoScan();

/**
 * Derive the path rules a paired source is missing, once, at boot.
 *
 * A catalogue paired with a share cannot resolve a single file without
 * them, and the operator-facing derivation lives behind a Check button a
 * setup can easily skip — the symptom is then an ffprobe 5XX on every
 * play, which reads as a network fault, not a missing step. The server
 * holds the real credentials and both halves of the comparison, so it can
 * answer the question itself: enumerate, match, and persist the rules if
 * the libraries agree. Detached and per-source fault-isolated — a share
 * that is down at boot just logs and stays unhealed until next boot or a
 * manual Check.
 */
(async function healPairedMappings() {
  for (const src of config.library?.sources ?? []) {
    if (src.metadata?.provider !== 'jellyfin' || src.provider === 'jellyfin') continue;
    if (src.metadata.pathMap?.length) continue;
    if (!src.metadata.url) continue;
    try {
      const mediaLib = makeLibrary({ library: { sources: [{ ...src, metadata: null }] } })
        .sources[0]?.lib;
      if (typeof mediaLib?.allPaths !== 'function') continue;
      const jf = new JellyfinLibrary({ url: src.metadata.url, apiKey: src.metadata.apiKey });
      const [reported, local] = await Promise.all([jf.allPaths(), mediaLib.allPaths()]);
      if (!reported.length || !local.length) continue;
      const result = deriveMapping(reported, local);
      // Identity mappings derive as zero rules and need no save; only a
      // real translation, backed by real matches, is worth persisting.
      if (!result.rules?.length || !result.matched) continue;
      // Re-read the live source: a Settings save may have landed while the
      // shares were being walked, and its rules then win.
      const cur = (config.library?.sources ?? []).find((s) => s.id === src.id);
      if (!cur || cur.metadata?.pathMap?.length) continue;
      const sources = config.library.sources.map((s) => (s.id === src.id
        ? { ...s, metadata: { ...s.metadata, pathMap: result.rules } } : s));
      saveConfig({ library: { ...config.library, sources } });
      refreshLibrary();
      dpush('info', `[library] "${src.name}": derived ${result.rules.length} path rule(s) `
        + `automatically — ${result.matched}/${result.total} files matched`);
    } catch (err) {
      dpush('warn', `[library] "${src.name}": could not derive path rules — ${err.message}`);
    }
  }
}()).catch((err) => dpush('warn', `[library] mapping heal failed: ${err?.message ?? err}`));

const { port, host } = config.server;
server.listen(port, host, () => {
  console.log(`streamerr listening on http://${host}:${port}`);
  if (authDisabled()) {
    console.warn('  AUTH IS DISABLED ("auth": {"disabled": true} in config.json).');
    console.warn('  Anyone who can reach this port controls broadcasts and can read');
    console.warn('  the stream key. Meant for test machines on trusted networks only.');
  }
  for (const line of publishTargetsRedacted()) console.log(`  target : ${line}`);
  const srcs = config.library?.sources ?? [];
  console.log(`  library: ${srcs.length ? srcs.map((s) => `${s.name} (${s.provider})`).join(', ') : 'none configured'}`);
  if (!passwordHash()) console.log('  no password set — open the panel to run setup');
});
