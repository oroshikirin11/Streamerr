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

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createReadStream, existsSync, mkdirSync, unlinkSync } from 'fs';
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
    holdUntilReady = false,
  }) {
    super();
    // Deliver nothing until two chunks are in hand ('ready'). Mid-broadcast
    // a cover card feeds the publisher while chunks encode, and it dies at
    // the first delivery — so delivering chunk 0 alone (the short opener)
    // kills the card, airs ~5s, and then starves the publisher for the
    // whole of chunk 1's encode. One to send and one in hand is the same
    // rule going on air uses, for the same reason.
    this.holdUntilReady = holdUntilReady;
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

  /** The short opening chunk, on the same audio-frame grid as the rest. */
  _firstSize() {
    return Math.min(this.chunkSeconds, onAudioGrid(FIRST_CHUNK_SECONDS));
  }

  /** Absolute position in the clip where chunk `i` starts. */
  _startOf(i) {
    // Offsets follow the sizes above: chunk 0 is short, the rest full.
    if (i === 0) return this.startOffset;
    return this.startOffset + this._firstSize() + (i - 1) * this.chunkSeconds;
  }

  /** How long chunk `i` should be, clipped to the end of the file. */
  /**
   * The first chunk is deliberately short.
   *
   * Nothing reaches the publisher until a whole chunk has finished
   * encoding, so a 20s chunk means 20s+ of silence on a connection
   * Owncast drops after 10. Getting the first few seconds out quickly
   * puts the stream on air, and the bank covers the gap while the
   * full-size chunks behind it catch up.
   */
  _durOf(i) {
    const size = i === 0 ? this._firstSize() : this.chunkSeconds;
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

  /** Keep `workers` encodes in flight, and never run far ahead of the writer. */
  _fill() {
    if (!this.running) return;

    while (
      this._procs.size < this.workers
      && this.nextToSchedule - this.nextToWrite < this.workers * 2
    ) {
      const i = this.nextToSchedule;
      if (this.duration != null && this._startOf(i) >= this.duration - 0.05) {
        this.finished = true;
        break;
      }
      this.nextToSchedule += 1;
      this._encode(i);
    }
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

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
        // Going on air is gated on this, not on a timer: the publisher
        // consumes at exactly realtime once connected, so it must never be
        // handed a chunk without the next one already encoded. Two
        // finished chunks means one to send and one in hand.
        this._encoded = (this._encoded ?? 0) + 1;
        this._done.push({ at: Date.now(), content: this._durOf(index) });
        if (this._done.length > 64) this._done.shift();
        if (!this._announcedReady && (this._encoded >= 2 || this.finished)) {
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
    if (this.holdUntilReady && !this._announcedReady) return;

    const next = this.chunks.get(this.nextToWrite);
    if (!next || !next.done) {
      // Nothing ready. If every worker is idle and nothing is pending, we're
      // at the end of the clip.
      if (this.finished && this._procs.size === 0 && !this.chunks.has(this.nextToWrite)) {
        this.emit('complete');
      }
      return;
    }

    this.chunks.delete(this.nextToWrite);
    this.nextToWrite += 1;

    if (next.failed) {
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
    const rs = createReadStream(next.out);
    rs.on('error', () => { this._writing = false; safeUnlink(next.out); this._drain(); });
    rs.on('end', () => {
      this._writing = false;
      safeUnlink(next.out);
      this.emit('chunk', { index: next.index, start: this._startOf(next.index) });
      this._fill();
      this._drain();
    });
    // end:false — the publisher must outlive every chunk.
    rs.pipe(this._sink, { end: false });
  }
}

function safeUnlink(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
