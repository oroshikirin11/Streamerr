/**
 * Keeps the overlay canvas fed across renderer restarts — as a growing
 * NUT file on /dev/shm that successive renderers APPEND to and the
 * source follows (-follow 1). File writes never block, so a swap's
 * SIGTERM always lands on an unblocked renderer and the stream joins at
 * clean boundaries; a reaper punches consumed head pages so a full-rate
 * canvas cannot fill the ramdisk. This replaced the fifo+forwarding
 * transport, whose lockstep and copies cost ~0.35x at full rate.
 */

import { spawn, spawnSync } from 'child_process';
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
    /**
     * The canvas is an APPEND FILE now (put it on /dev/shm), not a fifo.
     * File writes are page-cache memcpys: no 64KB pipe lockstep, no
     * forwarding hop, and they never block — so a swap's SIGTERM always
     * lands on an unblocked renderer, which exits at a clean NUT
     * boundary. The tear/guard apparatus the fifo needed is gone with
     * the fifo. The reader follows the growing file (-follow 1) and a
     * reaper punches consumed head pages so a full-rate canvas cannot
     * fill the ramdisk.
     */
    this._fd = openSync(this.path, 'a');
    this._punched = 0;
    this._headPts = 0;
    this._stopped = false;
    this._pacePos = null;
    this._samples = [];
    /**
     * CONSUMPTION-AWARE reaping. A fixed keep-window killed a broadcast:
     * at full canvas rate 64MB is ~0.3s, a freshly respawned reader fell
     * behind it instantly, and the punched holes read back as zeros — the
     * demuxer hung, the watchdog respawned into the same trap, dead air.
     * The reaper now samples (fileSize, headPts) each tick and punches
     * only regions whose pts the READER has consumed (pace() reports the
     * encode position) minus a 3s margin. And if the reader stalls
     * entirely, the renderer is SIGSTOPped once it runs 6s past the last
     * known consumption — the file cannot outgrow a bounded window even
     * when nothing is draining it.
     */
    this._samples = [];
    this._pacePos = null;
    this._reaper = setInterval(() => {
      try {
        const size = statSync(this.path).size;
        this._samples.push({ size, pts: this._headPts ?? 0 });
        if (this._samples.length > 300) this._samples.shift();
        const consumed = this._pacePos;
        if (consumed != null) {
          let upTo = 0;
          for (const smp of this._samples) {
            if (smp.pts < consumed - 3) upTo = smp.size; else break;
          }
          if (upTo - this._punched > 16 * 1024 * 1024) {
            spawnSync('fallocate', ['-p', '-o', '0', '-l', String(upTo), this.path],
              { stdio: 'ignore' });
            this._punched = upTo;
          }
        }
        // stalled-reader guard, independent of engine ticks
        const lead = (this._headPts ?? 0) - (this._pacePos ?? this._headPts ?? 0);
        const child = this._renderer?.child;
        if (child && lead > 6 && !this._stopped) {
          child.kill('SIGSTOP'); this._stopped = true;
        }
      } catch { /* file may be mid-reset */ }
    }, 2000);
    this._reaper.unref?.();
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
  /** The written canvas head in clip seconds — where a successor must
   *  continue from, since the append file preserves run-ahead. */
  headPts() { return this._headPts ?? 0; }

  /**
   * Consumption-paced flow control. The append file has no backpressure,
   * so left alone a renderer runs (readrate x wall) ahead and an Apply's
   * continuation point drifts minutes out on long clips. The engine
   * feeds the encode position here; past a 2s lead the renderer is
   * SIGSTOPped (zero CPU, file stops growing), under 1s it resumes.
   * Swaps and teardown always CONT first so TERM can be handled.
   */
  pace(positionSecs) {
    if (Number.isFinite(positionSecs)) this._pacePos = positionSecs;
    const child = this._renderer?.child;
    if (!child || !Number.isFinite(positionSecs)) return;
    const lead = (this._headPts ?? 0) - positionSecs;
    try {
      if (lead > 2 && !this._stopped) { child.kill('SIGSTOP'); this._stopped = true; }
      else if (lead < 1 && this._stopped) { child.kill('SIGCONT'); this._stopped = false; }
    } catch { /* gone */ }
  }

  static SYNC = Buffer.from('4e4be4adeeca4569', 'hex');

  spawnRenderer(args) {
    if (!this.active) throw new Error('overlay feed is not active');
    if (this._renderer) throw new Error('a renderer is already running');
    const child = spawn('ffmpeg', args, { stdio: ['ignore', this._fd, 'pipe'] });
    /**
     * The renderer is latency-tolerant by design — the bank absorbs its
     * hiccups — while the encoder is not. Deprioritising it means its
     * readrate bursts can never preempt an encoder thread on a saturated
     * four-core box, which is exactly where this matters.
     */
    try { setPriority(child.pid, 10); } catch { /* best effort */ }
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d.toString()).slice(-4000);
      // -progress on stderr: the renderer's OUTPUT head in clip time.
      // out_time_ms is microseconds despite the name (ffmpeg quirk).
      const ms = tail.lastIndexOf('out_time_ms=');
      if (ms !== -1) {
        const v = parseInt(tail.slice(ms + 12), 10);
        if (Number.isFinite(v)) this._headPts = v / 1e6;
      }
    });
    const done = new Promise((resolve) => {
      child.on('close', (code) => {
        if (this._renderer?.child === child) this._renderer = null;
        // 255 = exited on our SIGTERM: routine swap, not news. File
        // writes never block, so TERM always completes at a boundary.
        if (code !== 0 && code !== 255 && code !== null && this.active) {
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
       * Drain first, then TERM, KILL as escalation. beginDrain reroutes
       * the renderer's output into a buffer and keeps its pipe drained, so
       * SIGTERM never lands on a process blocked in write(): ffmpeg
       * finishes the packet, writes the trailer, exits 0, and the whole
       * buffered tail is valid. Only if it hangs does KILL fire — and then
       * the close handler cuts the buffered tail at the last syncpoint so
       * a torn packet can never reach the reader.
       */
      if (this._stopped) { try { old.child.kill('SIGCONT'); } catch { /* gone */ } this._stopped = false; }
      try { old.child.kill('SIGTERM'); } catch { /* already gone */ }
      const grace = setTimeout(() => {
        this.log('[overlay-pipe] renderer ignored TERM for 5s — KILLed\n');
        try { old.child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5000);
      await old.done;
      clearTimeout(grace);
    }
    this.spawnRenderer(args);
  }

  _teardown() {
    if (this._renderer) {
      if (this._stopped) { try { this._renderer.child.kill('SIGCONT'); } catch { /* gone */ } this._stopped = false; }
      try { this._renderer.child.kill('SIGKILL'); } catch { /* gone */ }
      this._renderer = null;
    }
    if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
    if (this._fd !== null) {
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
