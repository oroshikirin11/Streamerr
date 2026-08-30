/**
 * Keeps the overlay pipe fed across renderer restarts.
 *
 * The main encoder reads RGBA frames from a fifo for the whole life of a
 * source process. Renderers come and go — every Apply kills one and starts
 * another — and this class is what makes that survivable:
 *
 *  - it holds the fifo's write end open for the life of the source, so the
 *    reader never sees EOF between renderers (a fifo EOFs the moment its
 *    LAST writer closes, and eof_action=repeat then freezes the overlay
 *    forever);
 *  - it counts the bytes forwarded, because rawvideo has no timestamps: the
 *    frame COUNT is the only clock both sides share, and the next renderer
 *    must continue from exactly the frame the last one stopped at or every
 *    subtitle drifts by the difference;
 *  - it pads a killed renderer's final partial frame to the frame boundary.
 *    Without that, every later frame is offset by the shortfall and the
 *    reader interprets the stream sheared — no error anywhere, just a
 *    picture made of two misaligned halves.
 *
 * The write side is the holder fd wrapped in a net.Socket, which libuv
 * treats as a pipe: writes are non-blocking with real backpressure. This
 * matters more than it looks. A plain fs.write to a full fifo parks a
 * threadpool thread until a reader drains it — and when the reader is gone
 * (source respawn), that thread is parked forever. Node has four by
 * default, so four clip boundaries would silently starve every fs
 * operation in the process. The socket buffers instead, pausing the
 * renderer's stdout via pipe backpressure, and destroy() discards cleanly.
 *
 * The fd is opened read-write, not write-only: a fifo opened O_WRONLY
 * blocks until a reader appears (deadlock when the feed starts before the
 * encoder), and a fifo whose reader is also itself can never take EPIPE.
 */

import { spawn, spawnSync } from 'child_process';
import { Socket } from 'net';
import { closeSync, openSync, rmSync, statSync } from 'fs';
import { setPriority } from 'os';

export class OverlayFeed {
  constructor({ path, log = () => {} }) {
    this.path = path;
    this.log = log;
    this._fd = null;
    this._sock = null;
    this._renderer = null;
    this.active = false;
  }

  /**
   * Fresh pipe for a fresh source process.
   *
   * Deliberately synchronous: _play is synchronous, and the fifo must exist
   * before the source ffmpeg opens it or the open fails outright. The whole
   * reset is a few milliseconds. Recreating the fifo (rather than draining
   * it) guarantees the new reader starts at byte zero — leftovers from the
   * previous source would land at the head of the new one's first frame and
   * shear everything after.
   */
  resetSync() {
    this._teardown();
    try { rmSync(this.path, { force: true }); } catch { /* fine */ }
    const made = spawnSync('mkfifo', [this.path], { stdio: 'ignore' });
    if (made.status !== 0 || !statSync(this.path).isFIFO()) {
      throw new Error(`could not create the overlay pipe at ${this.path}`);
    }
    // r+ so the fifo never EOFs between renderers, and never blocks on
    // open. Wrapped in a Socket for non-blocking writes with real
    // backpressure — a plain fs.write to a full fifo parks a threadpool
    // thread, and when the reader is gone it parks it forever.
    this._fd = openSync(this.path, 'r+');
    this._sock = new Socket({ fd: this._fd, readable: false, writable: true });
    this._sock.on('error', (err) => this.log(`[overlay-pipe] ${err.message}\n`));
    this.active = true;
  }

  /**
   * Start a renderer writing into the pipe. At most one at a time — two
   * writers interleave and the frames come out sheared.
   */
  /**
   * NUT syncpoint startcode. Every frame group begins with one, and the
   * guard below only ever forwards COMPLETE syncpoint-delimited chunks.
   *
   * This exists because of a measured failure mode, not caution: when the
   * encoder falls behind, the renderer blocks mid-write in a full fifo, so
   * a swap's SIGTERM cannot land between packets and the kill tears one.
   * The reader then chews misaligned RGBA until it resyncs — on screen as
   * dotted, colour-separated ghost text (channel phase drift), held for
   * seconds by the VFR canvas. Every probe of every stage was clean; the
   * tear only exists live, under load, at a swap. With the guard, a dead
   * renderer's incomplete tail is discarded at a frame boundary and the
   * reader is physically unable to see a torn packet.
   */
  static SYNC = Buffer.from('4e4be4adeeca4569', 'hex');

  spawnRenderer(args) {
    if (!this.active) throw new Error('overlay feed is not active');
    if (this._renderer) throw new Error('a renderer is already running');
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    /**
     * The renderer is latency-tolerant by design — the bank absorbs its
     * hiccups — while the encoder is not. Deprioritising it means its
     * readrate bursts can never preempt an encoder thread on a saturated
     * four-core box, which is exactly where this matters.
     */
    try { setPriority(child.pid, 10); } catch { /* best effort */ }
    const sock = this._sock;
    /**
     * Hold everything from the LATEST syncpoint onward; forward the rest.
     * Each new syncpoint flushes the chunk before it, so what reaches the
     * fifo is always whole frames — one canvas frame of extra latency,
     * absorbed by the bank like every other pipeline delay here.
     */
    let held = Buffer.alloc(0);
    const onData = (d) => {
      if (this._sock !== sock) return;
      held = held.length ? Buffer.concat([held, d]) : d;
      // Search from just before the old tail so a startcode split across
      // chunk boundaries is still found.
      let last = -1;
      let from = Math.max(0, held.length - d.length - OverlayFeed.SYNC.length);
      for (;;) {
        const i = held.indexOf(OverlayFeed.SYNC, from);
        if (i === -1) break;
        last = i;
        from = i + OverlayFeed.SYNC.length;
      }
      if (last > 0) {
        const out = held.subarray(0, last);
        held = held.subarray(last);
        if (!sock.write(out)) {
          child.stdout.pause();
          sock.once('drain', () => child.stdout.resume());
        }
      }
    };
    child.stdout.on('data', onData);
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    const done = new Promise((resolve) => {
      child.on('close', (code) => {
        if (this._renderer?.child === child) this._renderer = null;
        // A clean exit's tail is the last frame plus the trailer — valid,
        // forward it. A killed renderer's tail is the torn packet this
        // guard exists to stop; drop it at the boundary.
        if (this._sock === sock && held.length) {
          if (code === 0) sock.write(held);
          held = Buffer.alloc(0);
        }
        if (code !== 0 && code !== null && this.active) {
          this.log(`[overlay-pipe] renderer exited ${code}: ${tail.split('\n').filter(Boolean).slice(-2).join(' | ')}\n`);
        }
        resolve(code);
      });
      child.on('error', () => resolve(-1));
    });
    this._renderer = { child, done };
    // The exit promise is internal sequencing (swap awaits it to pad before
    // appending). Callers get nothing to await: a renderer runs until it is
    // replaced, and "done" here would mean "the overlay stopped".
  }

  /**
   * Replace the running renderer — the whole point of the design. The old
   * one is killed, its final partial frame padded, and the new one appended
   * so the reader sees one continuous stream.
   */
  async swap(args) {
    if (!this.active) throw new Error('overlay feed is not active');
    const old = this._renderer;
    if (old) {
      /**
       * TERM first, KILL as escalation. A SIGKILLed renderer tears its
       * current NUT packet mid-write and the demuxer has to resync through
       * garbage — recoverable, but on iHD a mis-latched parse painted the
       * canvas as giant green ghosts until the next clean frame. SIGTERM
       * lets ffmpeg finish the packet and exit at a frame boundary, so the
       * next renderer's stream begins exactly where the last byte ended.
       */
      try { old.child.kill('SIGTERM'); } catch { /* already gone */ }
      const grace = setTimeout(() => {
        try { old.child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 400);
      await old.done;
      clearTimeout(grace);
    }
    this.spawnRenderer(args);
  }

  _teardown() {
    if (this._renderer) {
      try { this._renderer.child.kill('SIGKILL'); } catch { /* gone */ }
      this._renderer = null;
    }
    if (this._sock) {
      try { this._sock.destroy(); } catch { /* gone */ }
      this._sock = null;
      this._fd = null;
    } else if (this._fd !== null) {
      try { closeSync(this._fd); } catch { /* gone */ }
      this._fd = null;
    }
    this.active = false;
  }

  stopSync() {
    this._teardown();
    try { rmSync(this.path, { force: true }); } catch { /* fine */ }
  }
}
