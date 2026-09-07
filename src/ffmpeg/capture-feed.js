/**
 * The bytes of a live browser capture, between the WebSocket and ffmpeg.
 *
 * A screen share arrives as one endless WebM (see webm.js). The engine's
 * source process is not endless: a Studio apply, a watchdog respawn and a
 * resume after a pause each replace it. So the stream cannot simply be
 * piped into stdin — something has to hold the header, know where the
 * keyframes are, and hand the successor a stream it can start on.
 *
 * This is that something. It parses as bytes arrive, keeps whole clusters in
 * a bounded ring, and writes them into whichever sink is attached:
 *
 *   attach(w, { fresh })   start writing to `w`: the init segment first, then
 *                          clusters from a video keyframe — the OLDEST
 *                          unsent one (continue: nothing is lost, the bank
 *                          absorbs the backlog) or, with `fresh`, the NEWEST
 *                          (resume after a pause: what happened behind the
 *                          card is nobody's business). A backlog longer than
 *                          `maxBacklogSeconds` is jumped over either way, so
 *                          a stream armed for minutes does not air minutes
 *                          late.
 *   detach()               stop writing; bytes keep accumulating in the ring
 *   push(chunk)            bytes from the sender
 *   end()                  no more bytes; the sink gets EOF once drained
 *
 * Every emitted cluster is re-headed with a rebased timecode so a sink
 * always sees a stream that starts at zero and stays continuous across
 * anything this dropped — a reader sees a cut, never a gap.
 *
 * Backpressure never reaches the sender: when the ring is over budget, the
 * OLDEST unsent clusters go and the next write starts on a keyframe again.
 */

import { EventEmitter } from 'events';
import { WebmScanner, clusterHeader, codecName } from './webm.js';

/** Default ring budget: about a minute of a 10 Mb/s capture. */
export const RING_MAX_BYTES = 80 * 1024 * 1024;

export class CaptureFeed extends EventEmitter {
  constructor({ maxBytes = RING_MAX_BYTES, frameMs = 33 } = {}) {
    super();
    this.maxBytes = maxBytes;
    /** Assumed spacing of two video frames, for closing the seam over a drop. */
    this.frameMs = frameMs;
    this.init = null;
    this.meta = { timecodeScale: 1_000_000, tracks: [] };
    this.video = null;    // { codec, width, height, track }
    this.audio = null;    // { codec, sampleRate, channels, track }
    /** Unsent clusters: { tc, blocks: [{buf, key, video, rel, bytes}], bytes } */
    this.ring = [];
    this.ringBytes = 0;
    this._cur = null;
    this.sink = null;
    this.ended = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.dropped = 0;        // bytes dropped for budget
    this.keyframes = 0;
    this.lastKeyTc = null;
    this.maxKeyGapTc = null; // widest keyframe spacing seen, in ticks
    this.lastTc = null;      // newest cluster timecode seen
    this.startedAt = null;
    this._scanner = new WebmScanner({
      onInit: (buf, meta) => this._onInit(buf, meta),
      onCluster: (tc) => this._onCluster(tc),
      onBlock: (b) => this._onBlock(b),
      onWarn: (m) => this.emit('warn', m),
    });
  }

  // ── input ────────────────────────────────────────────────────────────

  push(chunk) {
    if (this.ended) return;
    this.bytesIn += chunk.length;
    this.startedAt ??= Date.now();
    this._scanner.push(chunk);
    this._pump();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this._pump();
    this.emit('end');
  }

  /** Seconds of one timecode tick. */
  get tickSeconds() { return (this.meta.timecodeScale ?? 1_000_000) / 1e9; }

  /** Ticks per millisecond. */
  get _ticksPerMs() { return 1e6 / (this.meta.timecodeScale ?? 1_000_000); }

  _onInit(buf, meta) {
    this.init = buf;
    this.meta = meta;
    const v = meta.tracks.find((t) => t.type === 1);
    const a = meta.tracks.find((t) => t.type === 2);
    this.video = v ? { codec: codecName(v.codec), width: v.width, height: v.height, track: v.number } : null;
    this.audio = a ? { codec: codecName(a.codec), sampleRate: a.sampleRate, channels: a.channels, track: a.number } : null;
    this.emit('init', { video: this.video, audio: this.audio });
  }

  _onCluster(tc) {
    this._cur = { tc, blocks: [], bytes: 0 };
    this.ring.push(this._cur);
    this.lastTc = tc;
  }

  _onBlock(b) {
    if (!this._cur) {
      // A block before any Timecode: not legal, but do not lose the data —
      // give it a cluster at the last known time.
      this._onCluster(this.lastTc ?? 0);
    }
    const video = this.video ? b.track === this.video.track : b.keyframe;
    const key = video && b.keyframe;
    if (key) {
      const tc = this._cur.tc + b.relTimecode;
      if (this.lastKeyTc != null) {
        const gap = tc - this.lastKeyTc;
        if (gap > 0 && (this.maxKeyGapTc == null || gap > this.maxKeyGapTc)) this.maxKeyGapTc = gap;
      }
      this.lastKeyTc = tc;
      this.keyframes += 1;
    }
    const blk = { buf: b.buf, key, video, rel: b.relTimecode, relAt: b.relAt ?? null, bytes: b.bytes };
    this._cur.blocks.push(blk);
    this._cur.bytes += b.bytes;
    this.ringBytes += b.bytes;
    if (key) this.emit('keyframe');
    this._trim();
  }

  /** Widest keyframe spacing seen so far, in seconds; null before two keyframes. */
  keyGapSeconds() {
    return this.maxKeyGapTc == null ? null : this.maxKeyGapTc * this.tickSeconds;
  }

  /** Seconds of content held in the ring (newest minus oldest cluster). */
  backlogSeconds() {
    if (this.ring.length < 2) return 0;
    return (this.ring[this.ring.length - 1].tc - this.ring[0].tc) * this.tickSeconds;
  }

  /** Drop the oldest unsent clusters until the ring fits its budget. */
  _trim() {
    while (this.ringBytes > this.maxBytes && this.ring.length > 1) {
      const c = this.ring[0];
      if (c === this._cur) break;   // never drop the cluster still being filled
      this.ring.shift();
      this.ringBytes -= c.bytes;
      this.dropped += c.bytes;
      // Whatever follows must start on a keyframe again, and the seam closes.
      if (this.sink) { this.sink.needKey = true; this.sink.cut = true; }
    }
  }

  // ── output ───────────────────────────────────────────────────────────

  /**
   * Start writing into `w` (a Writable — ffmpeg's stdin).
   *
   * @param {object} [o]
   * @param {boolean} [o.fresh]  start from the newest keyframe, dropping the
   *                             backlog (resume after a pause)
   * @param {number} [o.maxBacklogSeconds]  jump to the newest keyframe when
   *                             the backlog is longer than this
   */
  attach(w, { fresh = false, maxBacklogSeconds = 2 } = {}) {
    this.detach();
    const sink = {
      w, headerDone: false, needKey: true, cut: false,
      shift: null, lastOutAbs: null, waiting: false,
      onDrain: () => { sink.waiting = false; this._pump(); },
      onGone: () => { if (this.sink === sink) this.detach(); },
    };
    w.on('drain', sink.onDrain);
    w.on('error', sink.onGone);
    w.on('close', sink.onGone);
    this.sink = sink;
    // A cluster the previous reader had begun belongs to its timeline;
    // this reader re-heads it on its own origin.
    for (const c of this.ring) { c.headerOut = false; c.outTc = null; }

    const backlog = this.backlogSeconds();
    if (fresh || backlog > maxBacklogSeconds) {
      // Keep from the last cluster that holds a video keyframe; everything
      // older is stale.
      let i = this.ring.length - 1;
      while (i > 0 && !this.ring[i].blocks.some((b) => b.key)) i -= 1;
      if (i > 0) {
        for (let k = 0; k < i; k++) { this.ringBytes -= this.ring[k].bytes; this.dropped += this.ring[k].bytes; }
        this.ring.splice(0, i);
      }
    }
    this.emit('attach', { fresh, backlog });
    this._pump();
  }

  detach() {
    const s = this.sink;
    if (!s) return;
    this.sink = null;
    try {
      s.w.off('drain', s.onDrain);
      s.w.off('error', s.onGone);
      s.w.off('close', s.onGone);
    } catch { /* gone */ }
    // Whatever was sent stays sent; the next sink starts at a keyframe from
    // the oldest unsent block, which is what the ring now holds.
    this.emit('detach');
  }

  _write(buf) {
    const s = this.sink;
    let ok = true;
    try { ok = s.w.write(buf); } catch { s.onGone(); return false; }
    this.bytesOut += buf.length;
    if (!ok) s.waiting = true;
    return ok;
  }

  _pump() {
    const s = this.sink;
    if (!s || s.waiting) return;
    if (!this.init) return;                 // nothing a reader could start on
    if (!s.w.writable) { s.onGone(); return; }
    if (!s.headerDone) {
      s.headerDone = true;
      if (!this._write(this.init)) return;
    }
    while (this.ring.length) {
      const c = this.ring[0];
      // Do not send a cluster still being filled unless it already holds
      // blocks — its header is emitted with its first written block.
      if (!c.blocks.length) {
        if (c === this._cur) break;
        this.ring.shift();
        continue;
      }
      if (!c.headerOut) {
        // Waiting for a keyframe: drop what precedes it. If the cluster has
        // none yet and is still open, more blocks may come; if it is
        // closed, the whole cluster goes.
        if (s.needKey) {
          const k = c.blocks.findIndex((b) => b.key);
          if (k === -1) {
            if (c === this._cur) break;
            this.ring.shift();
            this.ringBytes -= c.bytes;
            this.dropped += c.bytes;
            continue;
          }
          for (let i = 0; i < k; i++) {
            const b = c.blocks[i];
            c.bytes -= b.bytes; this.ringBytes -= b.bytes; this.dropped += b.bytes;
          }
          c.blocks.splice(0, k);
        }
        const first = c.blocks[0];
        // The absolute time of the first block to go out decides the
        // reader's origin: a fresh reader starts exactly at zero, and a
        // reader continuing over a cut carries on one frame after the last
        // content it got. Everything after is measured from that shift.
        const firstAbs = c.tc + first.rel;
        if (s.shift == null) {
          s.shift = firstAbs;
        } else if (s.cut) {
          const cont = (s.lastOutAbs ?? -this.frameMs * this._ticksPerMs) + this.frameMs * this._ticksPerMs;
          s.shift = firstAbs - cont;
          s.cut = false;
        }
        c.headerOut = true;
        c.outTc = Math.max(0, firstAbs - s.shift);
        s.needKey = false;
        this.emit('cluster', c.outTc);
        if (!this._write(clusterHeader(c.outTc))) return;
      }
      while (c.blocks.length) {
        const b = c.blocks[0];
        c.blocks.shift();
        c.bytes -= b.bytes;
        this.ringBytes -= b.bytes;
        // Rebase: this block's absolute time under the shift, relative to
        // the header that went out. Patched in place when it differs —
        // the block is ours (copied by the scanner) and goes out once.
        const outAbs = c.tc + b.rel - s.shift;
        const outRel = Math.round(outAbs - c.outTc);
        if (outRel !== b.rel && b.relAt != null && outRel >= -32768 && outRel <= 32767) {
          b.buf.writeInt16BE(outRel, b.relAt);
        }
        if (s.lastOutAbs == null || outAbs > s.lastOutAbs) s.lastOutAbs = outAbs;
        if (!this._write(b.buf)) return;
      }
      if (c === this._cur) break;              // wait for more of the open cluster
      this.ring.shift();
    }
    if (this.ended && (!this.ring.length || (this.ring.length === 1 && !this.ring[0].blocks.length))) {
      const w = s.w;
      this.detach();
      try { w.end(); } catch { /* gone */ }
      this.emit('eof');
    }
  }

  /** What the panel shows. */
  stats() {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      dropped: this.dropped,
      backlogSeconds: Math.round(this.backlogSeconds() * 10) / 10,
      keyGapSeconds: this.keyGapSeconds(),
      video: this.video,
      audio: this.audio,
      attached: Boolean(this.sink),
      ended: this.ended,
      damaged: this._scanner.damaged,
    };
  }
}
