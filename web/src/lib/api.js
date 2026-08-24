/**
 * Thin API client. Every call goes through here so auth failures and error
 * shapes are handled once rather than at each call site.
 */

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 401) {
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
  checkPathmap: (body) => request('POST', '/api/check/pathmap', body),

  libraries: () => request('GET', '/api/library/libraries'),
  items: (libraryId, opts = {}) => {
    const q = new URLSearchParams({ libraryId, ...opts });
    return request('GET', `/api/library/items?${q}`);
  },
  seasons: (seriesId) => request('GET', `/api/library/seasons?seriesId=${seriesId}`),
  episodes: (seriesId, seasonId) => {
    const q = new URLSearchParams({ seriesId });
    if (seasonId) q.set('seasonId', seasonId);
    return request('GET', `/api/library/episodes?${q}`);
  },
  tracks: (id) => request('GET', `/api/library/tracks?id=${id}`),

  streamStatus: () => request('GET', '/api/stream/status'),
  start: (itemIds, trackOverride) =>
    request('POST', '/api/stream/start', { itemIds, trackOverride }),
  stop: () => request('POST', '/api/stream/stop'),
  setQueue: (itemIds) => request('POST', '/api/stream/queue', { itemIds }),
  liveTracks: () => request('GET', '/api/stream/tracks'),
  setTracks: (body) => request('POST', '/api/stream/tracks', body),
};

/** Live status feed. Reconnects on drop — the panel is left open for hours. */
export function connectStatus(onMessage) {
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
    ws.onopen = () => { retry = 1000; };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
    ws.onerror = () => ws?.close();
  };

  open();
  return () => { closed = true; ws?.close(); };
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
