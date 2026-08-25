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
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  config, saveConfig, ensureDirs, rtmpTarget, rtmpTargetRedacted, redact,
  normalizeStoredBitrates, ROOT,
} from './config.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  validSession, tokenFromRequest, requireAuth, sessionCookie, SESSION_COOKIE,
} from './auth.js';
import {
  probeAll, selectBackend, probeConcatCapabilities, vaapiAlphaHonored,
  pickPillarboxGraph,
} from './ffmpeg/probe.js';
import { normalizeBitrate } from './ffmpeg/encoders.js';
import { testRtmpConnection, probeDuration } from './ffmpeg/playout.js';
import { PipelinePlayout, contentRect } from './ffmpeg/pipeline.js';
import { probeTracks, listSubtitles, selectTracks } from './ffmpeg/tracks.js';
import { sweepCache } from './ffmpeg/subcache.js';
import { makeLibrary } from './library/index.js';
import { suggestRules } from './library/pathmap.js';
import { dpush, dlist, teeConsole } from './debuglog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '../web/build');

teeConsole();

const app = express();
const server = http.createServer(app);
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
  return prefs;
}

/** Re-pick tracks against a specific file's own streams. */
async function selectionFor(item) {
  const tracks = await probeTracks(item.srcPath);
  const subs = await listSubtitles(item.srcPath, tracks);
  const selection = selectTracks(tracks, subs, trackPrefs());
  selection.video = tracks.video[0] ?? null;
  return selection;
}

/** Remember a live switch as language + mode, for the clips that follow. */
function rememberIntent(selection, subtitleMode) {
  trackIntent = {
    audioLanguage: selection.audio?.language ?? null,
    subtitleLanguage: selection.subtitle?.language ?? null,
    subtitleMode: subtitleMode ?? trackIntent.subtitleMode,
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

function streamStatus() {
  if (!engine) return { status: 'stopped', playing: null, queue: [] };
  const s = engine.snapshot();
  return {
    status: s.status,
    playing: s.playing
      ? { title: s.playing.title, duration: s.playing.duration, image: s.playing.image ?? null }
      : null,
    queue: s.queue.map((q) => ({ id: q.id, title: q.title })),
    position: s.position,
  };
}

/**
 * Construct a playout engine with its event wiring attached.
 *
 * The publisher inside this engine holds the RTMP connection for the whole
 * broadcast; seeking, pausing and track changes restart only the source, so
 * none of them need a new engine.
 */
function buildEngine({ profile, selection }) {
  const e = new PipelinePlayout({
    target: rtmpTarget(),
    profile,
    selection,
    // Extracted subtitle tracks and embedded fonts live here.
    cacheDir: config.paths.cache,
    resolveSelection: selectionFor,
  });

  e.on('status', () => broadcast('stream', streamStatus()));
  e.on('nowplaying', () => broadcast('stream', streamStatus()));
  e.on('queue', () => broadcast('stream', streamStatus()));
  e.on('seeked', () => broadcast('stream', streamStatus()));
  e.on('progress', (b) => broadcast('progress', {
    position: b.position, speed: b.speed, drops: b.drops,
  }));
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

app.get('/api/auth/status', (req, res) => {
  res.json({
    configured: Boolean(passwordHash()),
    authenticated: !passwordHash() || validSession(tokenFromRequest(req)),
    onboarded: Boolean(config.onboarded),
  });
});

app.post('/api/auth/login', async (req, res) => {
  const ok = await verifyPassword(req.body?.password ?? '', passwordHash());
  if (!ok) return res.status(401).json({ error: 'Wrong password' });

  const token = createSession();
  res.setHeader('Set-Cookie', sessionCookie(token));
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
  try {
    const hash = await hashPassword(req.body?.password ?? '');
    saveConfig({ auth: { passwordHash: hash } });
    const token = createSession();
    res.setHeader('Set-Cookie', sessionCookie(token));
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

app.get('/api/config', (req, res) => res.json(redactedConfig()));

app.put('/api/config', (req, res) => {
  const patch = { ...req.body };
  // A field the UI didn't touch comes back as the placeholder; drop it so the
  // stored secret survives instead of being overwritten with a sentinel.
  for (const [section, field] of [['owncast', 'streamKey'], ['owncast', 'accessToken']]) {
    if (patch[section]?.[field] === '__SET__') delete patch[section][field];
  }
  if (patch.library?.jellyfin?.apiKey === '__SET__') delete patch.library.jellyfin.apiKey;
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

  const target = `${String(url).replace(/\/+$/, '')}/${key}`;
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
  if (profile.backend === 'vaapi' && config.encoder.gpuSubs !== false) {
    profile.gpuFull = true;
    if (selection.subtitle) {
      if (globalThis.__alphaOk === undefined) {
        globalThis.__alphaOk = await vaapiAlphaHonored(profile.device,
          { width: profile.width, height: profile.height });
      }
      profile.gpuSubs = globalThis.__alphaOk;

      // Pillarboxed content needs a graph shape this driver actually
      // supports; which one that is has to be measured, not assumed.
      const rect = contentRect(selection.video, profile);
      if (profile.gpuSubs && rect.bars) {
        const key = `${rect.w}x${rect.h}@${rect.x},${rect.y}`;
        globalThis.__barsGraph ??= {};
        if (globalThis.__barsGraph[key] === undefined) {
          globalThis.__barsGraph[key] = await pickPillarboxGraph({
            device: profile.device,
            width: profile.width, height: profile.height, rect,
            profile,
          });
          console.log(`pillarbox+subtitle graph for ${key}: `
            + `${globalThis.__barsGraph[key] ?? 'none — burning on the CPU'}`);
        }
        profile.barsGraph = globalThis.__barsGraph[key];
        // No working GPU composite for this shape: the CPU path burns
        // subtitles between scale and pad, which every driver can do.
        if (!profile.barsGraph) profile.gpuSubs = false;
      }
    }
  }

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
  e.start(items).catch((err) => {
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
  const items = [];
  for (const id of req.body?.itemIds ?? []) {
    const item = await library.item(id);
    items.push({
      id: item.id,
      title: item.seriesName
        ? `${item.seriesName} — S${item.season ?? '?'}E${item.episode ?? '?'}`
        : item.title,
      srcPath: library.resolvePath(item),
      duration: item.duration ?? null,
      image: item.image ?? null,
    });
  }
  engine.setQueue(items);
  broadcast('stream', streamStatus());
  res.json(streamStatus());
}));

// ── static UI ──────────────────────────────────────────────────────────

if (existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR));
  // SPA fallback: any non-API path serves the app shell so client routing works.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(WEB_DIR, 'index.html')));
} else {
  app.get('/', (req, res) => res.status(503).type('text/plain').send(
    'UI not built yet.\n\nRun: cd web && npm install && npm run build\n'
    + 'The API is available under /api.\n',
  ));
}

// ── websocket ──────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  if (passwordHash() && !validSession(tokenFromRequest(req))) {
    ws.close(4401, 'unauthorized');
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'stream', payload: streamStatus(), ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
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
const { port, host } = config.server;
server.listen(port, host, () => {
  console.log(`jellystreamerr listening on http://${host}:${port}`);
  console.log(`  target : ${rtmpTargetRedacted()}`);
  console.log(`  library: ${config.library.provider}`);
  if (!passwordHash()) console.log('  no password set — open the panel to run setup');
});
