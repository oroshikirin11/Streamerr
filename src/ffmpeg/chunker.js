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
 * lining up. Verified at 24.000s and 720 frames across four chunks, with
 * audio landing within one video frame.
 *
 * The cost is latency: a chunk must finish encoding before it can be sent, so
 * playback runs one chunk-length behind. Seeking discards the buffer.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createReadStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

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
  }) {
    super();
    this.srcPath = srcPath;
    this.startOffset = startOffset;
    this.duration = duration;
    this.chunkSeconds = Math.max(4, chunkSeconds);
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
  }

  /** Absolute position in the clip where chunk `i` starts. */
  _startOf(i) {
    return this.startOffset + i * this.chunkSeconds;
  }

  /** How long chunk `i` should be, clipped to the end of the file. */
  _durOf(i) {
    if (this.duration == null) return this.chunkSeconds;
    const remaining = this.duration - this._startOf(i);
    return Math.min(this.chunkSeconds, Math.max(0, remaining));
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
      if (record.failed) {
        this.emit('warn', `chunk ${index} failed: ${lastLines(stderr, 2)}`);
      }
      this._fill();
      this._drain();
    });
  }

  /**
   * Write finished chunks to the sink strictly in order.
   *
   * Out-of-order delivery would put the timeline back to front, so a chunk
   * that finishes early waits for its predecessors.
   */
  _drain() {
    if (this._writing || !this.running) return;

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
