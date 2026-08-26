/**
 * The panel: REST API, WebSocket status feed, and the built UI.
 *
 * Everything configurable lives behind this — the goal is that nothing ever
 * requires hand-editing config.json.
 */

import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { existsSync, createReadStream, readdirSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  config, saveConfig, ensureDirs, rtmpTarget, rtmpTargetRedacted, redact, assertRtmpUrl,
  normalizeStoredBitrates, normalizeStoredEncoder, ROOT,
} from './config.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  validSession, tokenFromRequest, requireAuth, sessionCookie, SESSION_COOKIE,
  throttleCheck, throttleFail, throttleReset, destroyOtherSessions,
} from './auth.js';
import {
  probeAll, selectBackend, probeConcatCapabilities, vaapiAlphaHonored,
  pickPillarboxGraph,
} from './ffmpeg/probe.js';
import { normalizeBitrate } from './ffmpeg/encoders.js';
import { testRtmpConnection, probeDuration } from './ffmpeg/playout.js';
import { PipelinePlayout, contentRect, effectiveFps, recommendedCacheBytes } from './ffmpeg/pipeline.js';
import { probeTracks, listSubtitles, selectTracks } from './ffmpeg/tracks.js';
import { sweepCache } from './ffmpeg/subcache.js';
import { makeLibrary } from './library/index.js';
import { SmbStreamLibrary } from './library/smbstream.js';
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
async function tuneProfile(profile, selection) {
  if (profile.backend !== 'vaapi' || config.encoder.gpuSubs === false) return;
  profile.gpuFull = true;
  profile.gpuSubs = false;
  profile.barsGraph = undefined;
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

/** Track preferences for one clip, honouring any live switch. */
function trackPrefs() {
  const prefs = { ...(config.tracks ?? {}) };
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
  const selection = selectTracks(tracks, subs, trackPrefs());
  selection.video = tracks.video[0] ?? null;
  if (profile) await tuneProfile(profile, selection);
  return selection;
}

/** Remember a live switch as language + mode, for the clips that follow. */
function rememberIntent(selection, subtitleMode) {
  const sub = selection.subtitle ?? null;
  trackIntent = {
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
function refreshLibrary() {
  library = makeLibrary(config);
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

/** Whether panels should offer the floating preview window at all. */
const previewEnabled = () => config.preview?.enabled !== false;

function streamStatus() {
  if (!engine) {
    return { status: 'stopped', playing: null, queue: [], preview: previewEnabled() };
  }
  const s = engine.snapshot();
  return {
    status: s.status,
    playing: s.playing
      ? {
        title: s.playing.title,
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
    target: rtmpTarget(),
    profile,
    selection,
    // Extracted subtitle tracks and embedded fonts live here.
    cacheDir: config.paths.cache,
    resolveSelection: (item) => selectionFor(item, profile),
    runAhead: runAheadBudget(),
  });

  wirePreview(e);

  e.on('status', () => { broadcast('stream', streamStatus()); syncOwncastTitle(); });
  e.on('nowplaying', () => { broadcast('stream', streamStatus()); syncOwncastTitle(); });
  e.on('queue', () => broadcast('stream', streamStatus()));
  e.on('seeked', () => broadcast('stream', streamStatus()));
  e.on('selection', () => broadcast('stream', streamStatus()));
  e.on('progress', (b) => {
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
  e.on('log', (m) => dpush('ffmpeg', m));
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

const passwordHash = () => config.auth?.passwordHash || null;
const auth = requireAuth(passwordHash);

/** Client address for throttling. Honours X-Forwarded-For only when the
 *  panel is knowingly behind a proxy, so a direct caller cannot spoof its
 *  way out of the rate limit by inventing a header. */
function clientIp(req) {
  if (process.env.JELLYSTREAMERR_TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Whether this request reached us over TLS, so the session cookie can carry
 *  Secure. Behind a TLS-terminating proxy only the forwarded header knows. */
function isSecure(req) {
  if (req.socket.encrypted) return true;
  return process.env.JELLYSTREAMERR_TRUST_PROXY
    ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
    : false;
}

app.get('/api/auth/status', (req, res) => {
  res.json({
    configured: Boolean(passwordHash()),
    // Never "authenticated" merely because setup has not run. Claiming it
    // was what let the panel skip its own gate and drop a brand-new install
    // straight into the wizard with no password and no way to notice.
    authenticated: validSession(tokenFromRequest(req)),
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
  // Count the attempt BEFORE spending scrypt on it. Counting afterwards let
  // a burst of parallel requests all pass the check while none had yet
  // recorded a failure — twelve concurrent guesses sailed through — and it
  // also meant the limiter could not protect the libuv threadpool, which is
  // the more damaging half: scrypt runs there, alongside the broadcast's
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
    library: {
      ...config.library,
      jellyfin: {
        ...config.library.jellyfin,
        apiKey: config.library.jellyfin?.apiKey ? '__SET__' : '',
      },
      smb: {
        ...config.library.smb,
        password: config.library.smb?.password ? '__SET__' : '',
      },
    },
  };
}

/** Read-only activity log for the web console. No input path exists. */
app.get('/api/debug/log', (req, res) => {
  res.json({ entries: dlist(Number(req.query.after) || 0) });
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
  if (typeof library?.stream !== 'function') return res.status(404).end();
  const expected = Buffer.from(library.bridgeToken ?? '');
  const given = Buffer.from(String(req.query.t ?? ''));
  // Byte length, not string length: one multi-byte character makes those two
  // differ, and timingSafeEqual then THROWS — out of this handler, past
  // Express 4, leaving the request hanging and the socket leaked.
  if (!expected.length || given.length !== expected.length
      || !timingSafeEqual(given, expected)) {
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
    const size = await library.size(rel);
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
    const s2 = await library.stream(rel, { start, end });
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
  // A field the UI didn't touch comes back as the placeholder; drop it so the
  // stored secret survives instead of being overwritten with a sentinel.
  for (const [section, field] of [['owncast', 'streamKey'], ['owncast', 'accessToken']]) {
    if (patch[section]?.[field] === '__SET__') delete patch[section][field];
  }
  if (patch.library?.jellyfin?.apiKey === '__SET__') delete patch.library.jellyfin.apiKey;
  if (patch.library?.smb?.password === '__SET__') delete patch.library.smb.password;
  delete patch.auth; // password changes go through their own endpoint

  // ffmpeg reads a bare number as BITS per second, so a stored "12000"
  // means 12 kbps and produces a picture made of coloured blocks. Normalise
  // on the way in so no client can persist a value that means something
  // 1000x different from what was intended.
  if (patch.encoder?.videoBitrate !== undefined) {
    patch.encoder.videoBitrate = normalizeBitrate(patch.encoder.videoBitrate, '4500k');
  }
  if (patch.encoder?.audioBitrate !== undefined) {
    patch.encoder.audioBitrate = normalizeBitrate(patch.encoder.audioBitrate, '160k');
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

  try {
    saveConfig(patch);
    refreshLibrary();
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
  const value = streamStatus().playing?.title ?? 'Jellystreamerr — title sync test';
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

app.get('/api/check/encoders', async (req, res) => {
  const results = await probeAll(config.encoder.device);
  const caps = await probeConcatCapabilities();
  res.json({
    encoders: results.map(({ backend, ok, label, error }) => ({ backend, ok, label, error })),
    ffmpeg: caps.version,
    recursionDepth: caps.recursionDepth,
  });
});

app.post('/api/check/library', async (req, res) => {
  try {
    // Test against submitted values so the wizard can validate before saving.
    const probe = req.body?.provider ? makeLibrary({ library: req.body }) : library;
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
app.get('/api/library/image/:id', (req, res) => {
  const p = library.imagePath?.(req.params.id);
  if (!p || !existsSync(p)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  createReadStream(p).pipe(res);
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

app.post('/api/stream/start', wrap(async (req, res) => {
  if (engine) return res.status(409).json({ error: 'Already streaming' });
  // Make sure the previous broadcast has really let go of the connection.
  if (lastEngine) {
    try { lastEngine.hardStop(); } catch { /* already down */ }
    lastEngine = null;
  }

  const ids = req.body?.itemIds ?? [];
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

  ensureDirs();
  const sel = await selectBackend({
    backend: config.encoder.backend,
    device: config.encoder.device,
  });
  const profile = { ...config.encoder, backend: sel.backend };

  // Resolve every item up front so a bad path fails before we go on air.
  const items = [];
  for (const id of ids) {
    const item = await library.item(id);
    items.push({
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
  await tuneProfile(profile, selection);

  const conn = await testRtmpConnection(rtmpTarget());
  if (!conn.ok) {
    return res.status(502).json({
      error: 'Owncast would not accept the stream',
      detail: redact(conn.error),
    });
  }

  // A fresh broadcast starts from the configured preferences, not from
  // whatever was switched to during the last one.
  trackIntent = {};
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
}));


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
    req.body?.subtitleMode ?? (req.body?.subtitleKey == null ? 'off' : undefined));

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
    if (pin) next.startAt = pin;
    if (pin && offline) next.breakOffline = true;
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
  const expected = (process.env.JELLYSTREAMERR_TRUST_PROXY
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
  if (!validSession(tokenFromRequest(req))) {
    ws.close(4401, 'unauthorized');
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'stream', payload: streamStatus(), ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

previewWss.on('connection', (ws, req) => {
  if (!validSession(tokenFromRequest(req))) {
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
const { port, host } = config.server;
server.listen(port, host, () => {
  console.log(`jellystreamerr listening on http://${host}:${port}`);
  console.log(`  target : ${rtmpTargetRedacted()}`);
  console.log(`  library: ${config.library.provider}`);
  if (!passwordHash()) console.log('  no password set — open the panel to run setup');
});
