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
 * The write side is the fifo fd handed to the renderer as its stdout —
 * node is not in the data path. This is the bisection suspect returned
 * alone; if the ghosts come back with it, the boundary-guard variant on
 * hunt-head replaces it.
 *
 * The fd is opened read-write, not write-only: a fifo opened O_WRONLY
 * blocks until a reader appears (deadlock when the feed starts before the
 * encoder), and a fifo whose reader is also itself can never take EPIPE.
 */

import { spawn, spawnSync } from 'child_process';
import { setPriority } from 'os';
import { closeSync, openSync, rmSync, statSync } from 'fs';

export class OverlayFeed {
  constructor({ path, log = () => {} }) {
    this.path = path;
    this.log = log;
    this._fd = null;
    this._renderer = null;
    this._frameBytes = 0;
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
    /**
     * THE BISECTION SUSPECT, reintroduced alone on the acquitted base.
     *
     * r+ so the fifo never EOFs between renderers; the renderer's stdout
     * IS this fd, so node leaves the data path entirely — measured worth
     * ~12% of an N100 E-core. If the green ghosts return with THIS commit
     * and only this commit, the direct-fd write path is convicted and the
     * fix is the NUT boundary guard (already written, on hunt-head).
     */
    this._fd = openSync(this.path, 'r+');
    this.active = true;
  }

  /**
   * Start a renderer writing into the pipe. At most one at a time — two
   * writers interleave and the frames come out sheared.
   */
  spawnRenderer(args) {
    if (!this.active) throw new Error('overlay feed is not active');
    if (this._renderer) throw new Error('a renderer is already running');
    // stdout IS the fifo fd — no intermediary.
    const child = spawn('ffmpeg', args, { stdio: ['ignore', this._fd, 'pipe'] });
    // Latency-tolerant by design — the bank absorbs its hiccups — so its
    // readrate bursts must never preempt an encoder thread on a saturated
    // four-core box. Scheduling cannot corrupt pixels.
    try { setPriority(child.pid, 10); } catch { /* best effort */ }
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d.toString()).slice(-2000);
    });
    const done = new Promise((resolve) => {
      child.on('close', (code) => {
        if (this._renderer?.child === child) this._renderer = null;
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
      // TERM first so ffmpeg can finish its packet and exit at a frame
      // boundary; KILL only if it is wedged (blocked mid-write in a full
      // fifo). A clean cut costs nothing and a torn one costs the reader a
      // resync through garbage.
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
    if (this._fd !== null) {
      try { closeSync(this._fd); } catch { /* gone */ }
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
