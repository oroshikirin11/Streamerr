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
 *  - at a swap it guarantees the reader only ever sees whole NUT frame
 *    groups: the dying renderer drains into a buffer and anything after
 *    the last syncpoint — the packet a kill may have torn — is dropped at
 *    the boundary. Steady-state bytes flow untouched; the guard costs
 *    nothing while a renderer is simply running.
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
   * swap-time guard below uses it to cut a dying renderer's stream at a
   * frame boundary.
   *
   * This exists because of a measured failure mode, not caution: a swap's
   * kill can land mid-write and tear a NUT packet. The reader then chews
   * misaligned RGBA until it resyncs — on screen as dotted,
   * colour-separated ghost text (channel phase drift) or, when the tear
   * lands in a header, a fatal demux error that silently restarts the
   * source. Every probe of every stage was clean; the tear only exists
   * live, at a swap.
   *
   * The guard runs ONLY at swap time. An always-on hold (forward nothing
   * until the NEXT syncpoint proves the frame complete) was measured to
   * cost 1.02x -> 0.63x on the N100: the idle band's heartbeat arrives
   * every ~0.5s, so each canvas frame was delivered one beat late and
   * framesync stalled the encoder for that beat, every beat. In steady
   * state bytes now flow untouched; at a swap, forwarding pauses first,
   * the old renderer drains into a buffer, and only provably whole frame
   * groups from that buffer reach the fifo.
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
     * Steady state: forward immediately, with backpressure. Draining: a
     * swap is in progress — buffer instead, so the kill's torn tail never
     * reaches the fifo, and so the renderer is never blocked in write()
     * when SIGTERM arrives (node keeps its pipe drained), which is what
     * lets it exit at a packet boundary.
     */
    let draining = false;
    const tailChunks = [];
    const onData = (d) => {
      if (this._sock !== sock) return;
      if (draining) { tailChunks.push(d); return; }
      if (!sock.write(d)) {
        child.stdout.pause();
        sock.once('drain', () => child.stdout.resume());
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
        if (this._sock === sock && tailChunks.length) {
          const buf = Buffer.concat(tailChunks);
          tailChunks.length = 0;
          if (code === 0) {
            // Clean exit: whole frames plus the trailer — forward as is.
            sock.write(buf);
          } else {
            // Terminated. Bytes before the FIRST syncpoint complete the
            // frame group already partly in the fifo; between first and
            // last are provably whole groups. From the last syncpoint on
            // is the group the kill may have torn — drop it. A canvas
            // frame lost at a swap is invisible; a torn one is not.
            let last = -1;
            let from = 0;
            for (;;) {
              const i = buf.indexOf(OverlayFeed.SYNC, from);
              if (i === -1) break;
              last = i;
              from = i + OverlayFeed.SYNC.length;
            }
            if (last > 0) sock.write(buf.subarray(0, last));
            else if (last === -1 && this.active) {
              this.log('[overlay-pipe] renderer died mid-frame with no boundary in its tail — the reader may resync through garbage\n');
            }
          }
        }
        if (code !== 0 && code !== null && this.active) {
          this.log(`[overlay-pipe] renderer exited ${code}: ${tail.split('\n').filter(Boolean).slice(-2).join(' | ')}\n`);
        }
        resolve(code);
      });
      child.on('error', () => resolve(-1));
    });
    this._renderer = {
      child,
      done,
      beginDrain: () => {
        draining = true;
        // If backpressure paused the pipe, wake it: draining must never
        // leave the renderer blocked in write() when SIGTERM lands.
        try { child.stdout.resume(); } catch { /* gone */ }
      },
    };
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
       * Drain first, then TERM, KILL as escalation. beginDrain reroutes
       * the renderer's output into a buffer and keeps its pipe drained, so
       * SIGTERM never lands on a process blocked in write(): ffmpeg
       * finishes the packet, writes the trailer, exits 0, and the whole
       * buffered tail is valid. Only if it hangs does KILL fire — and then
       * the close handler cuts the buffered tail at the last syncpoint so
       * a torn packet can never reach the reader.
       */
      old.beginDrain();
      try { old.child.kill('SIGTERM'); } catch { /* already gone */ }
      const grace = setTimeout(() => {
        try { old.child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 1500);
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
