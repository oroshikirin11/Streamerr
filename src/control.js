/**
 * The viewer control channel — Streamingestarr's pause vote.
 *
 * Viewers in a room vote to pause or resume; the receiver counts, and at
 * half the room it sends the sender one command. This module is the
 * sender's half: one websocket per receiver and room while a broadcast is
 * live, the frame handler that turns a command into the same engine
 * pause/resume the host's buttons use, and the state the receiver shows.
 *
 * Wire contract (fixed with the receiver):
 *   receiver → sender  {type:'pause'|'resume', votes, viewers, by:[..], id}
 *   sender → receiver  {type:'ack', id, ok, reason, paused}
 *   sender → receiver  {type:'state', paused, pausedBy, pending, pauseVote}
 *   both               {type:'ping'} / {type:'pong'} every 20 s
 *
 * The frame handler is pure over an injected context so it can be tested
 * with a fake engine; the client wraps it with sockets and timers.
 */
import WebSocket from 'ws';

/** Seconds before a pinned start inside which a vote is refused. */
const PIN_GUARD_S = 120;
export const PING_EVERY_MS = 20_000;
export const DEAD_AFTER_MS = 60_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/** The query token never belongs in a log line, whatever quotes the URL. */
export const redactToken = (text) => String(text).replace(/([?&]accessToken=)[^&\s'"]+/gi, '$1********');

/** The pending kinds that belong to this channel (a skip stays the host's). */
export const pendingOf = (snap) => {
  const k = snap?.pending?.kind;
  return k === 'pause' || k === 'resume' ? k : '';
};

/**
 * Why a viewer command cannot be taken right now — the text the receiver
 * shows the room — or null when it can.
 *
 * @param {'pause'|'resume'} type
 * @param {{engine: object|null, pauseVote: {enabled: boolean, locked: boolean}, now?: number}} ctx
 */
export function refusalFor(type, { engine, pauseVote, now = Date.now() / 1000 }) {
  if (!pauseVote?.enabled) return 'The host has turned viewer controls off';
  if (pauseVote.locked) return 'The host has locked viewer controls for this broadcast';
  if (!engine || typeof engine.snapshot !== 'function') return 'The broadcast is not running';
  const snap = engine.snapshot();
  if (snap.status === 'break' || snap.breakUntil) return 'The broadcast is on a break';
  if (snap.status !== 'running' && snap.status !== 'paused') return 'The broadcast is not running';
  if (snap.playing?.countdown) return 'A countdown card is on air';
  for (const q of snap.queue ?? []) {
    const d = Number(q?.startAt) - now;
    if (q?.startAt && Number.isFinite(d) && d <= PIN_GUARD_S && d >= -PIN_GUARD_S) {
      return 'A scheduled start is less than two minutes away';
    }
  }
  const k = snap.pending?.kind;
  if (k === 'pause' || k === 'resume' || k === 'skip') return 'A change is already on its way';
  if (type === 'pause' && snap.status === 'paused') return 'The broadcast is already paused';
  if (type === 'resume' && snap.status !== 'paused') return 'The broadcast is not paused';
  if (type === 'resume' && snap.pausedBy !== 'viewers') return 'The host paused the broadcast';
  return null;
}

/** The state frame the receiver gets on connect and on every change. */
export function stateFrame({ engine, pauseVote }) {
  const snap = engine?.snapshot?.() ?? null;
  const paused = snap?.status === 'paused';
  return {
    type: 'state',
    paused,
    pausedBy: paused ? (snap.pausedBy === 'viewers' ? 'viewers' : 'host') : '',
    pending: pendingOf(snap),
    pauseVote: Boolean(pauseVote?.enabled && !pauseVote?.locked),
  };
}

/**
 * Handle one frame from the receiver. Returns the reply frame to send, or
 * null when nothing is owed (a pong, an unknown type, garbage).
 *
 * @param {string|object} raw
 * @param {{engine, pauseVote, log?: (line: string) => void,
 *          onCommand?: (cmd: {type, votes, viewers, by, ok, reason}) => void,
 *          label?: string, now?: number}} ctx
 */
export function handleControlFrame(raw, ctx) {
  let f = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    try { f = JSON.parse(String(raw)); } catch { return null; }
  }
  if (!f || typeof f !== 'object') return null;
  const log = ctx.log ?? (() => {});
  const where = ctx.label ? ` [${ctx.label}]` : '';
  if (f.type === 'ping') return { type: 'pong' };
  if (f.type === 'pong') return null;
  if (f.type !== 'pause' && f.type !== 'resume') return null;

  const id = typeof f.id === 'string' ? f.id : String(f.id ?? '');
  const votes = Number.isFinite(Number(f.votes)) ? Number(f.votes) : 0;
  const viewers = Number.isFinite(Number(f.viewers)) ? Number(f.viewers) : 0;
  const by = Array.isArray(f.by) ? f.by.map((n) => String(n)).slice(0, 50) : [];
  const tally = `${votes}/${viewers}${by.length ? ': ' + by.join(', ') : ''}`;
  const engine = ctx.engine ?? null;

  const reason = refusalFor(f.type, { engine, pauseVote: ctx.pauseVote, now: ctx.now });
  if (reason) {
    log(`[control]${where} refused viewers' ${f.type} (${tally}) — ${reason}`);
    ctx.onCommand?.({ type: f.type, votes, viewers, by, ok: false, reason });
    return { type: 'ack', id, ok: false, reason, paused: engine?.status === 'paused' };
  }
  try {
    if (f.type === 'pause') engine.pause({ by: 'viewers' });
    else engine.resume();
  } catch (err) {
    const why = `The engine refused: ${err?.message ?? err}`;
    log(`[control]${where} viewers' ${f.type} failed (${tally}) — ${why}`);
    ctx.onCommand?.({ type: f.type, votes, viewers, by, ok: false, reason: why });
    return { type: 'ack', id, ok: false, reason: why, paused: engine?.status === 'paused' };
  }
  log(`[control]${where} viewers ${f.type === 'pause' ? 'paused' : 'resumed'} the broadcast (${tally})`);
  ctx.onCommand?.({ type: f.type, votes, viewers, by, ok: true, reason: '' });
  return { type: 'ack', id, ok: true, reason: '', paused: engine.status === 'paused' };
}

/** wss://host/api/integrations/control?accessToken=…&channel=… for a receiver. */
export function controlUrl(rc, channel) {
  const u = new URL(String(rc.url));
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/integrations/control`;
  u.search = '';
  u.hash = '';
  u.searchParams.set('accessToken', String(rc.accessToken ?? ''));
  u.searchParams.set('channel', channel || 'main');
  return u.toString();
}

/**
 * The sender's connections: one per configured receiver and per room the
 * broadcast feeds, alive only between start() and stop(). Reconnects with
 * backoff while live; a silent socket is torn down after DEAD_AFTER_MS.
 */
export class ControlClient {
  /**
   * @param {{receivers: () => object[], channels: () => string[],
   *          ctx: () => {engine, pauseVote}, log?: (line) => void,
   *          onCommand?: (cmd) => void, WebSocketImpl?: typeof WebSocket}} opts
   */
  constructor({ receivers, channels, ctx, log, onCommand, WebSocketImpl = WebSocket }) {
    this._receivers = receivers;
    this._channels = channels;
    this._ctx = ctx;
    this._log = (line) => (log ?? (() => {}))(redactToken(line));
    this._onCommand = onCommand;
    this._WS = WebSocketImpl;
    /** key → { rc, channel, label, ws, backoff, timer, ping, lastSeen } */
    this._conns = new Map();
    this.live = false;
  }

  /** A broadcast started: open what the setting allows. */
  start() {
    this.live = true;
    this.refresh();
  }

  /** The broadcast ended: close everything and stop reconnecting. */
  stop() {
    this.live = false;
    for (const key of [...this._conns.keys()]) this._drop(key, 'broadcast ended');
  }

  /** Re-read the setting, receivers and rooms; open or close to match. */
  refresh() {
    const want = new Map();
    if (this.live && this._ctx()?.pauseVote?.enabled) {
      for (const rc of this._receivers() ?? []) {
        for (const ch of this._channels() ?? ['']) {
          let label;
          try { label = `${rc.name || new URL(String(rc.url)).host}/${ch || 'main'}`; } catch { continue; }
          want.set(`${rc.id ?? rc.url}|${ch}`, { rc, channel: ch, label });
        }
      }
    }
    for (const key of [...this._conns.keys()]) {
      if (!want.has(key)) this._drop(key, 'no longer wanted');
    }
    for (const [key, spec] of want) {
      if (!this._conns.has(key)) this._open(key, spec);
    }
    this.pushState();
  }

  /** Send the current state frame to every open socket. */
  pushState() {
    const frame = JSON.stringify(stateFrame(this._ctx()));
    for (const c of this._conns.values()) {
      if (c.ws && c.ws.readyState === 1) {
        try { c.ws.send(frame); } catch { /* the close handler retries */ }
      }
    }
  }

  _open(key, { rc, channel, label }) {
    const c = { rc, channel, label, ws: null, backoff: BACKOFF_MIN_MS, timer: null, ping: null, lastSeen: 0 };
    this._conns.set(key, c);
    this._dial(key);
  }

  _dial(key) {
    const c = this._conns.get(key);
    if (!c || !this.live) return;
    let ws;
    try {
      ws = new this._WS(controlUrl(c.rc, c.channel));
    } catch (err) {
      this._log(`[control] [${c.label}] cannot dial: ${err.message}`);
      this._retry(key);
      return;
    }
    c.ws = ws;
    c.lastSeen = Date.now();
    ws.on?.('open', () => {
      if (this._conns.get(key) !== c || c.ws !== ws) return;
      c.backoff = BACKOFF_MIN_MS;
      c.lastSeen = Date.now();
      this._log(`[control] [${c.label}] connected`);
      try { ws.send(JSON.stringify(stateFrame(this._ctx()))); } catch { /* close follows */ }
      c.ping = setInterval(() => {
        if (Date.now() - c.lastSeen > DEAD_AFTER_MS) {
          this._log(`[control] [${c.label}] silent for ${Math.round(DEAD_AFTER_MS / 1000)}s — reconnecting`);
          try { ws.terminate?.(); ws.close?.(); } catch { /* gone */ }
          return;
        }
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* close follows */ }
      }, PING_EVERY_MS);
      c.ping.unref?.();
    });
    ws.on?.('message', (data) => {
      if (this._conns.get(key) !== c || c.ws !== ws) return;
      c.lastSeen = Date.now();
      const reply = handleControlFrame(data, {
        ...this._ctx(), log: this._log, onCommand: this._onCommand, label: c.label,
      });
      if (reply) {
        try { ws.send(JSON.stringify(reply)); } catch { /* close follows */ }
      }
    });
    ws.on?.('error', (err) => {
      if (this._conns.get(key) !== c || c.ws !== ws) return;
      this._log(`[control] [${c.label}] ${err?.message ?? err}`);
    });
    ws.on?.('close', (code) => {
      if (this._conns.get(key) !== c || c.ws !== ws) return;
      clearInterval(c.ping); c.ping = null;
      c.ws = null;
      if (!this.live || !this._conns.has(key)) return;
      this._log(`[control] [${c.label}] closed (${code ?? '?'}) — retrying in ${Math.round(c.backoff / 1000)}s`);
      this._retry(key);
    });
  }

  _retry(key) {
    const c = this._conns.get(key);
    if (!c || !this.live) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => { c.timer = null; this._dial(key); }, c.backoff);
    c.timer.unref?.();
    c.backoff = Math.min(BACKOFF_MAX_MS, c.backoff * 2);
  }

  _drop(key, why) {
    const c = this._conns.get(key);
    if (!c) return;
    this._conns.delete(key);
    clearTimeout(c.timer);
    clearInterval(c.ping);
    if (c.ws) {
      const ws = c.ws;
      c.ws = null;
      try { ws.close(1000, why); } catch { /* already down */ }
      this._log(`[control] [${c.label}] disconnected — ${why}`);
    }
  }
}
