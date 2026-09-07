/**
 * A screen share, server side.
 *
 * The browser does the capturing (getDisplayMedia + MediaRecorder) and
 * sends the WebM over /ws/capture. One session exists at a time: armed
 * while the operator has picked a screen and not yet gone live, live while
 * it is the broadcast, ended when the socket closes or the operator stops.
 *
 * A screen share is its own broadcast. It is never queued behind media,
 * never mixed with it, and it never appears on the schedule: going live
 * with a screen starts a broadcast whose only item is the screen, and the
 * broadcast ends when the share does. The engine plays it as a queue item
 * of kind `live` — one entry, no duration — through the same publisher,
 * bank, Studio overlays and hold card every clip uses.
 *
 * Wire protocol on the socket, sender → server:
 *   text  {"type":"hello", mime, width, height, fps, audio, title, surface, kbps, sender}
 *   binary  WebM bytes, any chunking
 *   text  {"type":"health", bufferedAmount, bytes, fps, muted}
 *   text  {"type":"end"}
 * server → sender:
 *   text  {"type":"state", ...status}     on every change
 *   text  {"type":"error", message}       then close
 */

import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { CaptureFeed } from './ffmpeg/capture-feed.js';

export const CAPTURE_DEFAULTS = {
  // Seconds the broadcast is held before it goes out when a screen share
  // STARTS a broadcast. 0 = no delay: the publisher connects as soon as the
  // first bytes arrive. Any stall then reaches viewers unbuffered; a few
  // seconds absorb the ordinary hiccups. Never more than buffer.seconds.
  delaySeconds: 0,
  // Ship the browser's H.264 untouched when nothing is drawn on it. Off
  // forces a transcode to the configured picture for every share.
  passthrough: true,
  // Sender-side recorder settings, handed to the panel as defaults.
  quality: 'balanced',   // sharp | balanced | light
  fps: 30,               // 30 | 60
  audio: 'auto',         // auto | monitor | mic | both | none
  // What the engine does when the share ends: 'end' the broadcast, or
  // 'hold' the stream on a card for up to holdMinutes and end then.
  onEnd: 'end',
  holdMinutes: 5,
};

const clampSeconds = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

export class CaptureSession extends EventEmitter {
  constructor({ ws, hello, sender, settings = {} }) {
    super();
    this.id = randomBytes(6).toString('hex');
    this.ws = ws;
    this.hello = hello;
    this.sender = sender;             // { ip, ua }
    this.settings = settings;
    this.createdAt = Date.now();
    this.state = 'armed';             // armed | live | ended
    this.title = String(hello.title ?? '').trim().slice(0, 80) || 'Screen';
    this.health = null;
    this.feed = new CaptureFeed({ frameMs: 1000 / (Number(hello.fps) > 0 ? Number(hello.fps) : 30) });
    this.item = null;
    this.endedBy = null;
    this.liveAt = null;
  }

  /** The queue item the engine plays. Built once; the feed rides along unseen. */
  liveItem({ delaySeconds, bufferSeconds }) {
    if (this.item) return this.item;
    const item = {
      id: `capture:${this.id}`,
      title: this.title,
      series: null,
      live: true,
      duration: null,
      image: null,
      kbps: Number(this.hello.kbps) > 0 ? Number(this.hello.kbps) : null,
      delaySeconds: clampSeconds(delaySeconds, bufferSeconds ?? 60),
      // What the engine does when the share ends (see CAPTURE_DEFAULTS).
      onEnd: this.settings.onEnd === 'hold' ? 'hold' : 'end',
      holdMinutes: Number(this.settings.holdMinutes) > 0 ? Number(this.settings.holdMinutes) : 5,
    };
    // Non-enumerable: the item is spread into snapshots and JSON'd to the
    // panel, and a feed holding megabytes of ring must never ride along.
    Object.defineProperty(item, 'feed', { value: this.feed, enumerable: false });
    Object.defineProperty(item, 'session', { value: this, enumerable: false });
    this.item = item;
    return item;
  }

  /**
   * The engine's track selection for this feed: geometry from the WebM's
   * own Tracks element (the browser may downscale what it was asked for),
   * frame rate from the sender, always 8-bit 4:2:0 progressive SDR.
   */
  selection() {
    const v = this.feed.video;
    const a = this.feed.audio;
    const fps = Number(this.hello.fps) > 0 ? Math.round(Number(this.hello.fps)) : 30;
    return {
      video: {
        index: 0, typeIndex: 0,
        codec: v?.codec ?? null,
        width: v?.width ?? (Number(this.hello.width) || null),
        height: v?.height ?? (Number(this.hello.height) || null),
        frameRate: `${fps}/1`,
        pixFmt: 'yuv420p',
        sar: '1:1',
        dar: null,
        hdr: false,
        interlaced: false,
      },
      audio: a ? {
        index: 1, typeIndex: 0, codec: a.codec, channels: a.channels ?? 2,
        language: null, title: 'Screen audio',
      } : null,
      subtitle: null,
      reason: 'screen share',
    };
  }

  /** Bytes from the sender. */
  push(chunk) { this.feed.push(chunk); }

  /** The sender is done, or we are: EOF to the engine, socket closed. */
  end(by = 'sender') {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.endedBy = by;
    this.feed.end();
    try { this.ws?.close(1000, by === 'operator' ? 'stopped from the panel' : 'ended'); } catch { /* closing */ }
    this.emit('ended', by);
  }

  /** What every panel sees. */
  status() {
    const f = this.feed.stats();
    return {
      id: this.id,
      state: this.state,
      title: this.title,
      sender: this.sender,
      surface: this.hello.surface ?? null,
      width: f.video?.width ?? this.hello.width ?? null,
      height: f.video?.height ?? this.hello.height ?? null,
      fps: this.hello.fps ?? null,
      codec: f.video?.codec ?? null,
      audio: Boolean(f.audio),
      createdAt: this.createdAt,
      liveAt: this.liveAt,
      health: this.health,
      feed: {
        bytesIn: f.bytesIn, backlogSeconds: f.backlogSeconds, dropped: f.dropped,
        keyGapSeconds: f.keyGapSeconds, attached: f.attached,
      },
    };
  }

  send(msg) {
    try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); } catch { /* gone */ }
  }
}

/** Parse the first frame of a capture socket. */
export function parseHello(raw) {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return null; }
  if (!m || m.type !== 'hello') return null;
  const n = (v, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null;
  };
  return {
    mime: String(m.mime ?? '').slice(0, 120),
    width: n(m.width, 16, 7680),
    height: n(m.height, 16, 4320),
    fps: n(m.fps, 1, 120),
    audio: Boolean(m.audio),
    title: String(m.title ?? '').slice(0, 80),
    surface: String(m.surface ?? '').slice(0, 20) || null,
    kbps: n(m.kbps, 100, 200_000),
    sender: String(m.sender ?? '').slice(0, 120) || null,
  };
}

/** Sanitise a capture settings block from the API. */
export function sanitizeCapture(raw = {}, base = CAPTURE_DEFAULTS, { bufferSeconds = 60 } = {}) {
  const out = { ...base };
  if (raw.delaySeconds !== undefined) out.delaySeconds = clampSeconds(raw.delaySeconds, Math.max(0, bufferSeconds));
  if (raw.passthrough !== undefined) out.passthrough = raw.passthrough !== false;
  if (['sharp', 'balanced', 'light'].includes(raw.quality)) out.quality = raw.quality;
  if ([30, 60].includes(Number(raw.fps))) out.fps = Number(raw.fps);
  if (['auto', 'monitor', 'mic', 'both', 'none'].includes(raw.audio)) out.audio = raw.audio;
  if (['end', 'hold'].includes(raw.onEnd)) out.onEnd = raw.onEnd;
  if (raw.holdMinutes !== undefined) out.holdMinutes = Math.max(1, Math.min(60, Math.round(Number(raw.holdMinutes) || 5)));
  return out;
}
