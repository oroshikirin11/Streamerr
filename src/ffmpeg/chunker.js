/**
 * Parallel chunked encoding, for content one core cannot encode in realtime.
 *
 * libass is single-threaded. Everything else in the chain — decode, scale,
 * the VAAPI encoder — either threads or runs on the GPU, so burning subtitles
 * pins the whole pipeline to one core while the rest of the CPU idles. On an
 * N100 that measured 1.18x realtime for 1080p anime with typeset subtitles:
 * unstreamable, and not fixable by lowering quality.
 *
 * The fix is to stop asking one process to do it. The clip is cut into
 * chunks, several are encoded at once in separate processes, and the finished
 * chunks are written to the publisher IN ORDER. Measured here: 5.18x serial
 * against 18.03x with four workers, a 3.5x gain.
 *
 * Chunks join exactly because `-output_ts_offset` pins each one to its
 * absolute position on the timeline, so nothing depends on chunk durations
 * lining up. Verified at 24.000s and 720 frames across four chunks.
 *
 * Sizes are quantized to whole AAC frames (see onAudioGrid). An encoder can
 * only end a chunk on a frame boundary, so a chunk of a round number of
 * seconds runs past where the next one is placed and every seam steps
 * backwards in audio.
 *
 * The cost is latency: a chunk must finish encoding before it can be sent, so
 * playback runs one chunk-length behind. Seeking discards the buffer.
 */

import { spawn, execFile } from 'child_process';
import { EventEmitter } from 'events';
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { onAudioGrid } from './encoders.js';

/**
 * Seconds in the opening chunk.
 *
 * Every chunk pays a fixed seek cost (ffmpeg backs the seek target off and
 * decode-discards to the previous keyframe), so small chunks are wasteful
 * — but the first one decides how soon the bank starts filling, and the
 * broadcast waits on that. Short opener, full-size thereafter.
 */
const FIRST_CHUNK_SECONDS = 5;

export class ChunkScheduler extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.srcPath
   * @param {number} o.startOffset   where in the clip to begin
   * @param {number} o.duration      clip length, or null if unknown
   * @param {number} o.chunkSeconds
   * @param {number} o.workers       how many encodes to run at once
   * @param {string} o.workDir
   * @param {(chunk: {index,start,dur,out}) => string[]} o.buildArgs
   */
  constructor({
    srcPath, startOffset = 0, duration = null,
    chunkSeconds = 20, workers = 3, workDir, buildArgs,
    holdUntilReady = false, tsOffsetOf = null,
    aheadSeconds = null, aheadBytes = null, keepBytes = null,
  }) {
    super();
    // Deliver nothing until two chunks are in hand ('ready'). Mid-broadcast
    // a cover card feeds the publisher while chunks encode, and it dies at
    // the first delivery — so delivering chunk 0 alone (the short opener)
    // kills the card, airs ~5s, and then starves the publisher for the
    // whole of chunk 1's encode. One to send and one in hand is the same
    // rule going on air uses, for the same reason.
    this.holdUntilReady = holdUntilReady;
    /**
     * Placement correction applied at delivery, in seconds — see setShift.
     * Zero means chunks are streamed exactly as encoded.
     */
    this.shift = 0;
    /** Baked absolute placement of a chunk, from the pipeline. */
    this.tsOffsetOf = tsOffsetOf;
    /**
     * Run-ahead budget. Null keeps the legacy near-sighted bound (twice the
     * worker count): enough to keep every worker busy, nothing more. Set,
     * they let the encoders run minutes ahead of the playhead — seconds is
     * the target, bytes the hard ceiling against the RAM the chunk files
     * actually occupy (the workDir is tmpfs when the cache is on, so bytes
     * here ARE memory).
     */
    this.aheadSeconds = aheadSeconds;
    this.aheadBytes = aheadBytes;
    /**
     * Retention budget for DELIVERED chunks. A backward seek is usually
     * the cheapest intent there is — "I missed a line" — and was the most
     * expensive operation in the system: everything behind the playhead
     * was deleted, so it rebuilt from scratch AND destroyed the forward
     * cushion doing it. Retained chunks make it a jump like any other.
     */
    this.keepBytes = keepBytes;
    this._cacheBytes = 0;
    this._keptBytes = 0;
    this.srcPath = srcPath;
    this.startOffset = startOffset;
    this.duration = duration;
    this.chunkSeconds = onAudioGrid(Math.max(4, chunkSeconds));
    this.workers = Math.max(1, workers);
    this.workDir = workDir;
    this.buildArgs = buildArgs;

    /** index -> { proc, out, done, failed } */
    this.chunks = new Map();
    this.nextToSchedule = 0;
    this.nextToWrite = 0;
    this.running = false;
    this.finished = false;

    this._sink = null;
    this._writing = false;
    this._procs = new Set();
    /** Completion samples: { at, content } — see speed(). */
    this._done = [];
  }

  /** The short ramp chunk, on the same audio-frame grid as the rest. */
  _firstSize() {
    return Math.min(this.chunkSeconds, onAudioGrid(FIRST_CHUNK_SECONDS));
  }

  /**
   * How many opening chunks are short.
   *
   * Going live — and coming back after a seek or resume — is gated on one
   * full chunkSeconds of encoded content. A single 20s chunk cannot finish
   * faster than one worker can encode 20 seconds, no matter how many other
   * cores sit idle; on an N100 that put minutes of card on screen after
   * every seek. The same cushion cut as SHORT chunks spreads across the
   * whole worker pool and finishes in a fraction of the wall time. After
   * the ramp, chunks return to full size for fewer seams.
   */
  _rampCount() {
    const first = this._firstSize();
    return first >= this.chunkSeconds ? 1 : Math.ceil(this.chunkSeconds / first);
  }

  /** Absolute position in the clip where chunk `i` starts. */
  _startOf(i) {
    const first = this._firstSize();
    const ramp = Math.min(i, this._rampCount());
    return this.startOffset + ramp * first
      + Math.max(0, i - this._rampCount()) * this.chunkSeconds;
  }

  /** How long chunk `i` should be, clipped to the end of the file. */
  _durOf(i) {
    const size = i < this._rampCount() ? this._firstSize() : this.chunkSeconds;
    if (this.duration == null) return size;
    const remaining = this.duration - this._startOf(i);
    return Math.min(size, Math.max(0, remaining));
  }

  _isLast(i) {
    return this.duration != null && this._startOf(i) + this._durOf(i) >= this.duration - 0.05;
  }

  start(sink) {
    if (this.running) return;
    this.running = true;
    this._sink = sink;
    mkdirSync(this.workDir, { recursive: true });
    this._fill();
  }

  stop() {
    this.running = false;
    for (const p of this._procs) {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this._procs.clear();
    for (const c of this.chunks.values()) safeUnlink(c.out);
    this.chunks.clear();
  }

  /** Keep `workers` encodes in flight, within the run-ahead budget. */
  _fill() {
    if (!this.running) return;

    while (this._procs.size < this.workers && this._withinBudget()) {
      const i = this.nextToSchedule;
      if (this.duration != null && this._startOf(i) >= this.duration - 0.05) {
        this.finished = true;
        break;
      }
      this.nextToSchedule += 1;
      this._encode(i);
    }
  }

  /**
   * May the next chunk be scheduled? Without a budget, stay near-sighted;
   * with one, run ahead until the content span or the byte ceiling is hit.
   */
  _withinBudget() {
    if (this.aheadSeconds == null) {
      return this.nextToSchedule - this.nextToWrite < this.workers * 2;
    }
    const span = this._startOf(this.nextToSchedule) - this._startOf(this.nextToWrite);
    if (span >= this.aheadSeconds) return false;
    if (this.aheadBytes != null && this._cacheBytes >= this.aheadBytes) return false;
    return true;
  }

  /**
   * Suspend delivery while a card airs, keeping every chunk and every
   * worker. Pause used to kill the whole scheduler — so resume rebuilt
   * from zero and put a minute of card on screen for a position that was
   * sitting in the retained window the entire time.
   */
  pauseDelivery() {
    this._holdDelivery = true;
    if (this._rs) {
      try { this._rs.unpipe(this._sink); } catch { /* gone */ }
      try { this._rs.destroy(); } catch { /* gone */ }
    }
    this._writing = false;
  }

  /** Where the retained window begins, in clip seconds. */
  keptStart() {
    let lo = null;
    for (const [i, c] of this.chunks) {
      if (c.delivered && (lo == null || i < lo)) lo = i;
    }
    return lo == null ? null : this._startOf(lo);
  }

  /** Drop the oldest retained chunks once the keep budget is exceeded. */
  _evictKept() {
    if (!this.keepBytes || this._keptBytes <= this.keepBytes) return;
    const kept = [...this.chunks.entries()]
      .filter(([, c]) => c.delivered)
      .sort(([a], [b]) => a - b);
    for (const [i, c] of kept) {
      if (this._keptBytes <= this.keepBytes) break;
      if (i >= this.nextToWrite) break;   // never evict undelivered ground
      safeUnlink(c.out);
      this._keptBytes -= c.bytes ?? 0;
      this.chunks.delete(i);
    }
  }

  /** Encoded-but-unaired content, in seconds — the cushion the UI shows. */
  cachedSeconds() {
    let sum = 0;
    for (const [i, c] of this.chunks) {
      if (c.done && !c.failed && !c.delivered) sum += this._durOf(i);
    }
    return sum;
  }

  /** Retained already-aired content, in seconds — the band BEHIND the playhead. */
  keptSeconds() {
    let sum = 0;
    for (const [i, c] of this.chunks) if (c.delivered) sum += this._durOf(i);
    return sum;
  }

  _encode(index) {
    const out = join(this.workDir, `chunk-${String(index).padStart(5, '0')}.ts`);
    safeUnlink(out);

    const args = this.buildArgs({
      index,
      start: this._startOf(index),
      dur: this._durOf(index),
      out,
      last: this._isLast(index),
    });

    // Niced below the publisher: the encoders may use every core, but
    // never at the expense of the process that holds the live connection.
    const proc = process.platform === 'linux'
      ? spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this._procs.add(proc);

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });

    const record = { proc, out, done: false, failed: false, index };
    this.chunks.set(index, record);

    proc.on('close', (code) => {
      this._procs.delete(proc);
      if (!this.running) return;

      record.done = true;
      record.failed = code !== 0 || !existsSync(out);
      if (!record.failed) {
        try { record.bytes = statSync(out).size; } catch { record.bytes = 0; }
        if (record.skipped) {
          // Finished after a forward seek already jumped past it: retire
          // straight into the retained window, never into the queue.
          record.skipped = false;
          if (this.keepBytes) {
            record.delivered = true;
            this._keptBytes += record.bytes;
            this._evictKept();
          } else {
            this.chunks.delete(index);
            safeUnlink(out);
          }
        } else {
          this._cacheBytes += record.bytes;
        }
      } else if (record.skipped) {
        this.chunks.delete(index);
        safeUnlink(out);
      }
      if (!record.failed) {
        // Going on air is gated on this, not on a timer: the publisher
        // consumes at exactly realtime once connected, so it must never be
        // handed a chunk without the next one already encoded. Two
        // finished chunks means one to send and one in hand.
        this._encoded = (this._encoded ?? 0) + 1;
        this._encodedSeconds = (this._encodedSeconds ?? 0) + this._durOf(index);
        this._done.push({ at: Date.now(), content: this._durOf(index) });
        if (this._done.length > 64) this._done.shift();
        if (this._durOf(index) >= this.chunkSeconds - 0.001) this._fullDone = true;
        // Ready needs a full chunkSeconds of content AND one full-size
        // chunk in hand. The cushion alone is not enough: with few
        // workers the short opening ramp monopolizes the pool, the first
        // full chunk starts late and lands long after the ramp has been
        // paid out — measured on the N100 as the publisher airing exactly
        // the ramp (24.93s) and then starving to death. A finished full
        // chunk is the proof the post-ramp cadence can hold.
        if (!this._announcedReady
            && ((this._encodedSeconds >= this.chunkSeconds && this._fullDone)
              || this.finished)) {
          this._announcedReady = true;
          this.emit('ready');
        }
      }
      if (record.failed) {
        this.emit('warn', `chunk ${index} failed: ${lastLines(stderr, 2)}`);
      }
      this._fill();
      this._drain();
    });
  }

  /**
   * Chunks are placed on the output timeline AT ENCODE TIME, but while a
   * cover card is on air the timeline moves on without them. Splicing them
   * in at their baked positions then steps BACKWARDS by the card's whole
   * duration — and the publisher's -re pacer, reading timestamps from the
   * past, concludes it is ahead of schedule and sleeps for exactly that
   * long. Measured directly: a 7.5s card produced a 7.1s hole in the
   * bytes reaching the server; on slow hardware the card runs minutes,
   * and so did the stall.
   *
   * The shift moves every remaining chunk forward to land just past the
   * card instead: a copy-only remux per chunk, no re-encode, ~50ms. The
   * seam becomes a small FORWARD gap, which the pacer treats as lag and
   * reads through at once.
   */
  setShift(seconds) {
    // Negative is legal: a seek into the run-ahead cache pulls a chunk
    // baked FURTHER along the clip back to the current stream head. The
    // invariant is only that delivered timestamps land forward of what
    // has aired — the caller owes that, this is just the offset.
    this.shift = Number(seconds) || 0;
  }

  /**
   * Jump delivery to the chunk containing clip position `seconds`.
   *
   * The point of the run-ahead cache: a seek whose target is already
   * encoded needs no new scheduler, no cover card and no re-encode — just
   * start delivering from a different chunk. Returns the chunk's exact
   * start position, or null when the target is not in hand (caller falls
   * back to a full rebuild).
   */
  jumpTo(seconds, head) {
    // Backward targets scan the retained window; forward ones the queue.
    // Retention makes the two symmetric: a kept chunk re-delivers exactly
    // like a pending one, re-stamped fresh at the current head.
    const lowest = Math.min(this.nextToWrite,
      ...[...this.chunks.keys()].filter((k) => this.chunks.get(k)?.delivered));
    let i = null;
    for (let k = lowest; ; k++) {
      const st = this._startOf(k);
      if (this.duration != null && st >= this.duration - 0.05) break;
      if (seconds >= st && seconds < st + this._durOf(k)) { i = k; break; }
      if (st > seconds) break;
    }
    if (i == null) return null;
    // A target within the last second of a chunk means trimming nearly all
    // of it — the remux of a near-empty tail fails, and the viewer would
    // not notice a sub-second difference anyway. Serve the next chunk from
    // its start instead.
    let trim = Math.max(0, seconds - this._startOf(i));
    if (this._durOf(i) - trim < 1) { i += 1; trim = 0; }
    const c = this.chunks.get(i);
    // The cushion total says nothing about THIS chunk: workers finish out
    // of order, so a 2-minute cushion can coexist with the one chunk the
    // seek needs still encoding. Decline and let the caller rebuild.
    if (!c || !c.done || c.failed) return null;

    // Abort an in-flight delivery. UNPIPE before destroying: destroy alone
    // lets slices already queued in the pipe land in the sink afterwards —
    // a partial tail of the old chunk arriving BEHIND the seek's aligned
    // flush. That knocked the preview mirror off its 188-byte phase
    // permanently: every client joining after a cache seek computed the
    // wrong packet boundary and its demuxer never locked (the frozen
    // preview after seeking). The sink's supersession guard cannot catch
    // this case — a jump keeps the scheduler.
    if (this._rs) {
      try { this._rs.unpipe(this._sink); } catch { /* gone */ }
      try { this._rs.destroy(); } catch { /* gone */ }
    }
    this._writing = false;
    if (i >= this.nextToWrite) {
      // Forward: what lies between playhead and target moves to the
      // retained window (it aired conceptually — the viewer skipped it),
      // or is dropped when retention is off.
      for (let k = this.nextToWrite; k < i; k++) {
        const drop = this.chunks.get(k);
        if (!drop) continue;
        if (drop.bytes) this._cacheBytes -= drop.bytes;
        if (this.keepBytes && drop.done && !drop.failed) {
          drop.delivered = true;
          this._keptBytes += drop.bytes ?? 0;
        } else if (!drop.done) {
          // Still encoding. Deleting it here left a HOLE in the retention
          // window — the encode completed into a record nothing knew, and
          // every backward jump across the gap declined forever after.
          // Its close handler retires it into the retained window instead.
          drop.skipped = true;
        } else {
          safeUnlink(drop.out);
          this.chunks.delete(k);
        }
      }
      this._evictKept();
    } else {
      // Backward: wake the retained chunks from target to the old
      // playhead — they re-deliver, and everything already queued AHEAD
      // survives untouched. The round trip costs zero re-encoding.
      for (let k = i; k < this.nextToWrite; k++) {
        const c = this.chunks.get(k);
        if (!c || !c.delivered) {
          if (process.env.JSR_TRACE) {
            this.emit('warn', `[trace] back-jump declined at k=${k}: `
              + `${!c ? 'missing' : `delivered=${c.delivered} done=${c.done} failed=${c.failed}`}`
              + ` (i=${i} nextToWrite=${this.nextToWrite})`);
          }
          return null;   // hole in the window — rebuild
        }
      }
      for (let k = i; k < this.nextToWrite; k++) {
        const c = this.chunks.get(k);
        c.delivered = false;
        c.trimmed = 0;
        this._keptBytes -= c.bytes ?? 0;
        this._cacheBytes += c.bytes ?? 0;
      }
    }
    this.nextToWrite = i;
    // Consumed by _deliverable: trim the chunk's head to the target and
    // place it at `head`. The shift for everything AFTER it is computed
    // from the trimmed chunk's MEASURED duration, because the input seek
    // snaps to a keyframe at or before the target and the exact cut is
    // only known after the remux.
    this._jump = { index: i, head, trim };
    this.shift = 0;
    this._holdDelivery = false;
    this._fill();
    this._drain();
    return this._startOf(i);
  }

  /** Deliverable path for a chunk: re-stamped when a shift or jump is set. */
  _deliverable(record, cb) {
    const jump = this._jump?.index === record.index ? this._jump : null;
    if (!jump && (!this.shift || typeof this.tsOffsetOf !== 'function')) {
      return cb(record.out);
    }
    const shifted = record.out.replace(/\.ts$/, '.shift.ts');
    const run = (trimRel, offset) => execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...(trimRel > 0.02 ? ['-ss', trimRel.toFixed(3)] : []),
      '-i', record.out,
      '-c', 'copy', '-muxdelay', '0', '-muxpreload', '0',
      '-output_ts_offset', offset.toFixed(3),
      '-mpegts_flags', '+resend_headers+initial_discontinuity',
      '-f', 'mpegts', shifted,
    ], (err) => after(err));
    let after;

    if (jump) {
      // Two passes, because single-pass placement means juggling three
      // timestamp bases (the file's baked absolutes, seek-relative, and
      // output) and ffmpeg's rebase rules differ between them — measured
      // wrong twice. Pass 1 only trims: input seek, keyframe snap, base
      // irrelevant. Pass 2 re-bases the trimmed file to zero and places
      // it at the head — the exact code path every other re-stamp in
      // this engine already trusts.
      // The chunk's effective start moved to the trim point — the pos
      // stamps on its bytes must say so, or the playbar rewinds to the
      // chunk boundary the moment the jump chunk finishes delivering.
      record.trimmed = jump.trim;
      const cutFile = record.out.replace(/\.ts$/, '.cut.ts');
      execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        ...(jump.trim > 0.02 ? ['-ss', jump.trim.toFixed(3)] : []),
        '-i', record.out, '-c', 'copy',
        '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', cutFile,
      ], (terr) => {
        if (terr) { after(terr); return; }
        execFile('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-i', cutFile, '-c', 'copy',
          '-muxdelay', '0', '-muxpreload', '0',
          '-output_ts_offset', jump.head.toFixed(3),
          '-mpegts_flags', '+resend_headers+initial_discontinuity',
          '-f', 'mpegts', shifted,
        ], (err) => { safeUnlink(cutFile); after(err); });
      });
    } else {
      run(0, this.tsOffsetOf(this._startOf(record.index)) + this.shift);
    }

    after = (err) => {
      if (err) {
        // Deliver unshifted rather than not at all: a backwards seam
        // stalls the pacer for the card period, but silence kills the
        // broadcast outright.
        this._jump = null;
        this.emit('warn', `restamp of chunk ${record.index} failed — delivering as baked`);
        return cb(record.out);
      }
      if (!jump) return cb(shifted);
      // Everything after the trimmed chunk continues from where it
      // actually ends — measured, not assumed, because the keyframe snap
      // decides the true cut.
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', shifted], (perr, out) => {
        const dur = Number(String(out ?? '').trim());
        this._jump = null;
        if (perr || !Number.isFinite(dur) || dur <= 0) {
          this.emit('warn', `probe of trimmed chunk ${record.index} failed — seams may stall once`);
        } else if (typeof this.tsOffsetOf === 'function') {
          const nextBase = this.tsOffsetOf(this._startOf(record.index + 1));
          this.shift = jump.head + dur - nextBase;
        }
        cb(shifted);
      });
    };
  }

  /**
   * Encoding throughput as a multiple of realtime — the same quantity a
   * single ffmpeg reports as `speed=`, which the chunked path otherwise
   * cannot show because there is no one process to ask.
   *
   * Measured as content finished per unit of WALL time, not per chunk.
   * Chunks encode in parallel, so summing their individual rates would
   * report several times the throughput actually being achieved; what has
   * to stay above 1.0 is how fast finished content accumulates against the
   * clock, because that is what the publisher is paying out.
   *
   * Reads ~1.0 in steady state by design rather than luck: once the bank
   * fills, backpressure stops the workers. Sustained below 1.0 is the
   * problem case.
   */
  speed(windowMs = 30_000) {
    const now = Date.now();
    const win = this._done.filter((d) => d.at >= now - windowMs);
    // Falling back to the full history when the window runs dry is what
    // keeps this readable in steady state. Once the bank is full,
    // backpressure stops the workers and chunks stop completing, so a
    // short window empties and would report nothing precisely when the
    // stream is healthiest. Measuring across the paused time instead lets
    // the figure settle toward 1.0, which is both true and the same thing
    // the single-process path shows.
    const recent = win.length >= 2 ? win : this._done;
    // The oldest sample marks where measuring starts, so its own content
    // finished before that point and must not be counted inside the span.
    if (recent.length < 2) return null;
    const span = (now - recent[0].at) / 1000;
    if (span < 0.5) return null;
    const content = recent.slice(1).reduce((a, d) => a + d.content, 0);
    return Math.round((content / span) * 100) / 100;
  }

  /**
   * Write finished chunks to the sink strictly in order.
   *
   * Out-of-order delivery would put the timeline back to front, so a chunk
   * that finishes early waits for its predecessors.
   */
  _drain() {
    if (this._writing || !this.running) return;
    if (this._holdDelivery) return;
    if (this.holdUntilReady && !this._announcedReady) return;
    if (process.env.JSR_TRACE) this.emit('warn', `[trace] drain: next=${this.nextToWrite} done=${this.chunks.get(this.nextToWrite)?.done ?? 'none'}`);

    const next = this.chunks.get(this.nextToWrite);
    if (!next || !next.done) {
      // Nothing ready. If every worker is idle and nothing is pending, we're
      // at the end of the clip.
      if (this.finished && this._procs.size === 0 && !this.chunks.has(this.nextToWrite)) {
        this.emit('complete');
      }
      return;
    }

    this.nextToWrite += 1;
    if (next.bytes) {
      this._cacheBytes -= next.bytes;
      if (this.keepBytes && !next.failed) {
        // Retained for backward seeks rather than deleted.
        next.delivered = true;
        this._keptBytes += next.bytes;
        this._evictKept();
      } else {
        this.chunks.delete(next.index);
        next.bytes = 0;
      }
    } else {
      this.chunks.delete(next.index);
    }
    this._fill();   // budget freed — the encoders may move again

    if (next.failed) {
      this.chunks.delete(next.index);
      safeUnlink(next.out);
      // Dropping a bad chunk quietly and carrying on means a broken
      // filtergraph plays an entire queue as silence. The streaming path
      // stops after two dead clips in a row; match it.
      this._failStreak = (this._failStreak ?? 0) + 1;
      if (this._failStreak >= 2) {
        this.running = false;
        this.emit('fatal', new Error(
          `Two chunks in a row failed to encode (${this._failStreak}); `
          + 'stopping rather than broadcasting nothing.'));
        return;
      }
      this._drain();
      return;
    }
    this._failStreak = 0;

    this._writing = true;
    this._deliverable(next, (path) => {
      if (!this.running) { this._writing = false; return; }
      // Announce what is about to stream, with its exact byte size, so
      // the pipeline can interpolate the playhead WITHIN the chunk. The
      // stamps otherwise only move once per chunk — a time display that
      // ticks in 20-second jumps.
      try {
        this.emit('chunkstart', {
          index: next.index,
          start: this._startOf(next.index) + (next.trimmed ?? 0),
          dur: this._durOf(next.index) - (next.trimmed ?? 0),
          bytes: statSync(path).size,
        });
      } catch { /* stat raced a cleanup — interpolation just skips */ }
      const rs = createReadStream(path);
      this._rs = rs;
      const cleanup = () => {
        if (path !== next.out) safeUnlink(path);          // derived remux copy
        if (!next.delivered) safeUnlink(next.out);        // retained ones stay
      };
      rs.on('error', () => { this._writing = false; cleanup(); this._drain(); });
      rs.on('end', () => {
        this._writing = false;
        cleanup();
        // A stopped scheduler's in-flight stream still ends — but its
        // 'chunk' must not fire: the pipeline computes the live timeline
        // from these, and a stale one lands with the NEXT scheduler's
        // base, inflating the timeline by roughly the seek distance.
        if (!this.running) return;
        this.emit('chunk', {
          index: next.index,
          start: this._startOf(next.index) + (next.trimmed ?? 0),
        });
        this._fill();
        this._drain();
      });
      // end:false — the publisher must outlive every chunk.
      rs.pipe(this._sink, { end: false });
    });
  }
}

function safeUnlink(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
