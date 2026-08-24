/**
 * Parser and watchdog for ffmpeg's `-progress` output.
 *
 * Format is newline-delimited key=value, with each block terminated by
 * `progress=continue` (or `progress=end` on the final one).
 *
 * Two things about this output are counter-intuitive and both matter:
 *
 *  1. `out_time_ms` is actually MICROSECONDS. It is byte-identical to
 *     `out_time_us`. Long-standing mislabel — we parse out_time_us.
 *
 *  2. When the input starves, ffmpeg blocks on read() and emits NOTHING.
 *     It does not keep ticking with a frozen out_time. So a stall can only
 *     be detected by the staleness of the stream itself, never by comparing
 *     field values.
 */

import { EventEmitter } from 'events';

/**
 * Feed raw `-progress` text in; get parsed blocks out.
 *
 * Events:
 *   'block'  ({ frame, fps, speed, outTimeUs, dropFrames, dupFrames, progress })
 */
export class ProgressParser extends EventEmitter {
  constructor() {
    super();
    this._buf = '';
    this._acc = {};
  }

  push(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      this._acc[key] = val;

      // `progress` terminates a block.
      if (key === 'progress') {
        this.emit('block', normalise(this._acc));
        this._acc = {};
      }
    }
  }
}

function num(v) {
  if (v == null || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalise(raw) {
  return {
    frame: num(raw.frame),
    fps: num(raw.fps),
    // "1.05x" -> 1.05
    speed: raw.speed && raw.speed !== 'N/A' ? num(raw.speed.replace(/x$/, '')) : null,
    outTimeUs: num(raw.out_time_us),
    outTime: raw.out_time ?? null,
    dropFrames: num(raw.drop_frames) ?? 0,
    dupFrames: num(raw.dup_frames) ?? 0,
    totalSize: num(raw.total_size),
    progress: raw.progress ?? 'continue',
  };
}

/**
 * Watches a ProgressParser and reports trouble.
 *
 * Events:
 *   'stall'  ({ silentMs })          no progress block for too long
 *   'drift'  ({ speed })             falling behind realtime
 *   'drops'  ({ delta, total })      frames being dropped
 *
 * Owncast drops the stream after 10s of socket silence and that is not
 * configurable, so the stall threshold has to leave room to react.
 */
export class ProgressWatchdog extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.statsPeriodMs   must match ffmpeg's -stats_period
   * @param {number} opts.stallFactor     multiples of statsPeriod before alarm
   * @param {number} opts.driftWindowMs   how long speed must stay low
   * @param {number} opts.driftFloor      speed below this counts as drift
   */
  constructor({
    statsPeriodMs = 500,
    stallFactor = 3,
    driftWindowMs = 10_000,
    driftFloor = 0.95,
  } = {}) {
    super();
    this.statsPeriodMs = statsPeriodMs;
    this.stallMs = statsPeriodMs * stallFactor;
    this.driftWindowMs = driftWindowMs;
    this.driftFloor = driftFloor;

    this.lastBlockAt = null;
    this.lastDrops = 0;
    this._slowSince = null;
    this._timer = null;
    this._stalled = false;
  }

  start() {
    this.lastBlockAt = Date.now();
    this._timer = setInterval(() => this._check(), Math.max(200, this.statsPeriodMs));
    // Don't hold the event loop open just for the watchdog.
    this._timer.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Wire to a ProgressParser's 'block' event. */
  onBlock(block) {
    this.lastBlockAt = Date.now();
    this._stalled = false;

    if (block.dropFrames > this.lastDrops) {
      this.emit('drops', {
        delta: block.dropFrames - this.lastDrops,
        total: block.dropFrames,
      });
      this.lastDrops = block.dropFrames;
    }

    if (block.speed != null && block.speed < this.driftFloor) {
      this._slowSince ??= Date.now();
      if (Date.now() - this._slowSince >= this.driftWindowMs) {
        this.emit('drift', { speed: block.speed });
        this._slowSince = Date.now(); // re-arm rather than spamming
      }
    } else {
      this._slowSince = null;
    }
  }

  _check() {
    if (this.lastBlockAt == null || this._stalled) return;
    const silentMs = Date.now() - this.lastBlockAt;
    if (silentMs >= this.stallMs) {
      this._stalled = true;
      this.emit('stall', { silentMs });
    }
  }
}
