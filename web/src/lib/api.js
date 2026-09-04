/**
 * Thin API client. Every call goes through here so auth failures and error
 * shapes are handled once rather than at each call site.
 */

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    // The browser's own wording for this is "NetworkError when attempting
    // to fetch resource", which reads like a bug in the page rather than
    // what it is: the server is not answering.
    const err = new Error('Lost connection to Streamerr — the server is not responding.');
    err.offline = true;
    throw err;
  }

  if (res.status === 401 && path !== '/api/auth/login') {
    const err = new Error('Not authenticated');
    err.unauthenticated = true;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Some endpoints legitimately return no body.
  }

  if (!res.ok) {
    const err = new Error(data?.error ?? `${res.status} ${res.statusText}`);
    err.detail = data?.detail;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),

  /**
   * Overlay pictures go up as raw bytes, not multipart: the server needs the
   * file and nothing else, and this keeps a form-parser dependency out of a
   * service whose only upload is this one.
   */
  uploadOverlayImage: async (file) => {
    const res = await fetch(`/api/overlay/images?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
    return data;
  },

  authStatus: () => request('GET', '/api/auth/status'),
  login: (password) => request('POST', '/api/auth/login', { password }),
  logout: () => request('POST', '/api/auth/logout'),
  setupPassword: (password) => request('POST', '/api/auth/setup', { password }),
  changePassword: (current, next) => request('POST', '/api/auth/password', { current, next }),

  config: () => request('GET', '/api/config'),
  saveConfig: (patch) => request('PUT', '/api/config', patch),

  checkOwncast: (body) => request('POST', '/api/check/owncast', body),
  checkEncoders: () => request('GET', '/api/check/encoders'),
  checkLibrary: (body) => request('POST', '/api/check/library', body),
  matchLibrary: (body) => request('POST', '/api/match/library', body),
  checkPathmap: (body) => request('POST', '/api/check/pathmap', body),

  libraries: () => request('GET', '/api/library/libraries'),
  items: (libraryId, opts = {}) => {
    const q = new URLSearchParams({ libraryId, ...opts });
    return request('GET', `/api/library/items?${q}`);
  },
  refreshLibrary: () => request('POST', '/api/library/refresh'),
  seasons: (seriesId) => request('GET', `/api/library/seasons?seriesId=${seriesId}`),
  episodes: (seriesId, seasonId) => {
    const q = new URLSearchParams({ seriesId });
    if (seasonId) q.set('seasonId', seasonId);
    return request('GET', `/api/library/episodes?${q}`);
  },
  tracks: (id) => request('GET', `/api/library/tracks?id=${id}`),
  inspect: (id) => request('GET', `/api/library/inspect?id=${encodeURIComponent(id)}`),

  streamStatus: () => request('GET', '/api/stream/status'),
  start: (itemIds, trackOverride, startAt = null) =>
    request('POST', '/api/stream/start', { itemIds, trackOverride, startAt }),
  stop: () => request('POST', '/api/stream/stop'),
  setQueue: (itemIds) => request('POST', '/api/stream/queue', { itemIds }),
  liveTracks: () => request('GET', '/api/stream/tracks'),
  pause: () => request('POST', '/api/stream/pause'),
  resume: () => request('POST', '/api/stream/resume'),
  seek: (body) => request('POST', '/api/stream/seek', body),
  next: () => request('POST', '/api/stream/next'),
  setTracks: (body) => request('POST', '/api/stream/tracks', body),

  // Schedules: saved lineups, tonight, history. Every mutation answers with
  // the whole schedule view, so callers just adopt what comes back.
  schedule: () => request('GET', '/api/schedule'),
  scheduleSettings: (patch) => request('PUT', '/api/schedule/settings', patch),
  clearHistory: () => request('DELETE', '/api/schedule/history'),
  createSchedule: (body) => request('POST', '/api/schedule/schedules', body),
  updateSchedule: (id, patch) => request('PUT', `/api/schedule/schedules/${encodeURIComponent(id)}`, patch),
  deleteSchedule: (id) => request('DELETE', `/api/schedule/schedules/${encodeURIComponent(id)}`),
  resetSchedule: (id) => request('POST', `/api/schedule/schedules/${encodeURIComponent(id)}/reset`),
  duplicateSchedule: (id) => request('POST', `/api/schedule/schedules/${encodeURIComponent(id)}/duplicate`),
  loadSchedule: (id, startAt = null, restart = false) => request('POST', `/api/schedule/schedules/${encodeURIComponent(id)}/load`, { startAt, restart }),
  appendSchedule: (id, startAt = null, restart = false) => request('POST', `/api/schedule/schedules/${encodeURIComponent(id)}/append`, { startAt, restart }),
  tonightAdd: (itemIds) => request('POST', '/api/schedule/tonight/items', { itemIds }),
  tonightOrder: (order) => request('PUT', '/api/schedule/tonight/order', { order }),
  tonightMove: (key, delta) => request('POST', `/api/schedule/tonight/items/${encodeURIComponent(key)}/move`, { delta }),
  tonightSetItem: (key, patch) => request('PUT', `/api/schedule/tonight/items/${encodeURIComponent(key)}`, patch),
  tonightRemove: (key) => request('DELETE', `/api/schedule/tonight/items/${encodeURIComponent(key)}`),
  tonightSegMove: (key, delta) => request('POST', `/api/schedule/tonight/segments/${encodeURIComponent(key)}/move`, { delta }),
  tonightSetSeg: (key, patch) => request('PUT', `/api/schedule/tonight/segments/${encodeURIComponent(key)}`, patch),
  tonightSegStart: (key, index) => request('PUT', `/api/schedule/tonight/segments/${encodeURIComponent(key)}/start`, { index }),
  tonightRemoveSeg: (key) => request('DELETE', `/api/schedule/tonight/segments/${encodeURIComponent(key)}`),
  tonightClear: () => request('DELETE', '/api/schedule/tonight'),
  goLive: (startAt = null, trackOverride = null) => request('POST', '/api/schedule/tonight/live', { startAt, trackOverride }),
};

/** Live status feed. Reconnects on drop — the panel is left open for hours. */
export function connectStatus(onMessage, onLiveness = null) {
  let ws = null;
  let closed = false;
  let retry = 1000;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch { /* ignore malformed frames */ }
    };
    ws.onopen = () => { retry = 1000; onLiveness?.(true); };
    ws.onclose = (ev) => {
      if (closed) return;
      // Report the close code: 4401 means the session is gone (sign in
      // again), anything else is a transport problem. Silence here is what
      // made a dead feed indistinguishable from an idle server.
      onLiveness?.(false, ev?.code);
      setTimeout(open, retry);
      // Cap low. This is a live control panel: a socket that backs off to
      // fifteen seconds means the transport bar can keep showing a broadcast
      // that already stopped, which is exactly how a flapping connection
      // presented — instant in one browser, fifteen seconds late in another.
      retry = Math.min(retry * 2, 4000);
    };
    ws.onerror = () => ws?.close();
  };

  open();
  return () => { closed = true; ws?.close(); };
}

/**
 * Wall-clock time, always 24-hour.
 *
 * Left to itself the browser picks by locale, and a US locale renders
 * "8:15 PM". Times in a broadcast schedule are read against each other and
 * against a clock on the wall, so they are pinned to 24-hour everywhere
 * rather than inherited.
 */
export function clockTime(epoch) {
  if (epoch == null) return null;
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** As clockTime, but carrying the weekday when it is not today. */
export function clockDay(epoch) {
  if (epoch == null) return null;
  const d = new Date(epoch * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? clockTime(epoch)
    : `${d.toLocaleDateString([], { weekday: 'short' })} ${clockTime(epoch)}`;
}

/**
 * Coerce typing into "HH:MM" as it goes.
 *
 * <input type="time"> would be the obvious control, but Chromium renders it
 * from the BROWSER's locale and ignores both the element's lang and the
 * document's — on a US locale it shows "06:12 PM" no matter what the page
 * declares. A plain text field is the only way to guarantee 24-hour, so
 * this does the masking the native control would have done.
 */
export function maskClock(raw) {
  const d = String(raw ?? '').replace(/\D/g, '').slice(0, 4);
  if (d.length <= 2) return d;
  return `${d.slice(0, 2)}:${d.slice(2)}`;
}

/** "HH:MM" -> {h, m}, or null when it is not a real 24-hour time. */
export function parseClock(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Human names for the language codes that actually turn up in media files.
 * ffprobe reports ISO-639-2/B ("ger", "jpn"); showing that raw in the panel
 * reads like a debug dump.
 */
const LANGUAGE_NAMES = {
  eng: 'English', jpn: 'Japanese', ger: 'German', deu: 'German',
  fre: 'French', fra: 'French', spa: 'Spanish', ita: 'Italian',
  por: 'Portuguese', rus: 'Russian', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', dut: 'Dutch', nld: 'Dutch', pol: 'Polish',
  swe: 'Swedish', nor: 'Norwegian', dan: 'Danish', fin: 'Finnish',
  ara: 'Arabic', hin: 'Hindi', tur: 'Turkish', cze: 'Czech',
  ces: 'Czech', hun: 'Hungarian', gre: 'Greek', ell: 'Greek',
  heb: 'Hebrew', tha: 'Thai', vie: 'Vietnamese', ukr: 'Ukrainian',
  ron: 'Romanian', rum: 'Romanian', bul: 'Bulgarian', ind: 'Indonesian',
};

export function languageName(code) {
  if (!code) return 'Unknown';
  return LANGUAGE_NAMES[String(code).toLowerCase()] ?? String(code).toUpperCase();
}

/** Channel counts as people describe them, not as integers. */
function channelName(n) {
  if (!n) return null;
  if (n === 1) return 'mono';
  if (n === 2) return 'stereo';
  return `${n - 1}.1`;
}

/** One-line description of the audio track being broadcast. */
export function audioLabel(a) {
  if (!a) return 'None';
  const bits = [languageName(a.language)];
  if (a.title) bits.push(a.title);
  const ch = channelName(a.channels);
  if (ch) bits.push(ch);
  return bits.join(' · ');
}

/** One-line description of the subtitle track being burned in. */
export function subtitleLabel(s) {
  if (!s) return 'Off';
  const bits = [languageName(s.language)];
  if (s.title) bits.push(s.title);
  // "signs only" rather than "forced" for the DISPOSITION. Releases label
  // tracks freely, and one whose title is literally "Forced" while its
  // disposition is not rendered as "English · Forced" against a genuinely
  // forced "English · forced" — the same words, differing in case, for two
  // tracks that behave completely differently.
  if (s.forced) bits.push('signs only');
  if (s.external) bits.push('sidecar');
  return bits.join(' · ');
}

/** The same track as a one-line choice in a switcher list. */
export function subtitleChoice(s) {
  const bits = [languageName(s.language)];
  if (s.title) bits.push(s.title);
  bits.push(s.codec);
  if (s.forced) bits.push('signs only');
  if (s.external) bits.push('sidecar');
  return bits.join(' · ');
}
