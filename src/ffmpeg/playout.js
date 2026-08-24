/**
 * The playout engine: one ffmpeg process that outlives every clip.
 *
 * Owncast accepts a single publisher and drops the stream after 10 seconds of
 * socket silence — a hardcoded deadline that a maintainer declined to make
 * configurable. So restarting ffmpeg per episode is not an option: Owncast
 * would see stream-stop / stream-start at every boundary, ending the
 * broadcast and dropping viewers.
 *
 * The mechanism that avoids it: ffmpeg's concat demuxer opens a NESTED
 * .ffconcat reference lazily, at the moment playback reaches it. A flat list
 * is parsed once and never re-read, but a chain of one-clip scripts each
 * pointing at the next lets a single process run indefinitely while
 * everything past the playhead stays editable.
 *
 *     p000000.ffconcat          <- playing now
 *       ffconcat version 1.0
 *       file 3f2a....ts
 *       file p000001.ffconcat   <- need not exist yet
 *
 * Chain scripts live in the cache directory alongside the .ts files they
 * reference, because nested scripts do NOT inherit -safe 0 and resolve
 * relative paths against their own directory. Bare sibling filenames are the
 * only form guaranteed to work.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';
import { ProgressParser, ProgressWatchdog } from './progress.js';

/**
 * How many links to keep written beyond the one currently playing.
 *
 * Counting links rather than seconds is what makes this correct for both a
 * 3-second bumper and a 45-minute episode: with a seconds-based margin, a
 * long clip leaves the next normalization starting far too late, and a short
 * one leaves no time at all.
 */
const LOOKAHEAD_LINKS = 2;
/** An exit this fast means the encoder/config is broken, not flaky. */
const HARD_FAIL_MS = 5_000;

const linkName = (i) => `p${String(i).padStart(6, '0')}.ffconcat`;

export class PlayoutEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir      holds both .ts clips and chain scripts
   * @param {import('./normalizer.js').Normalizer} opts.normalizer
   * @param {string} opts.target        full rtmp:// URL including stream key
   * @param {string} [opts.progressPath]
   * @param {number} [opts.statsPeriodMs]
   */
  constructor({
    cacheDir, normalizer, target, statsPeriodMs = 500,
    fileOutput = false, endBehavior = 'end', initialBurst = 10, caps = null,
  }) {
    super();
    this.cacheDir = cacheDir;
    this.normalizer = normalizer;
    this.target = target;
    this.statsPeriodMs = statsPeriodMs;
    /** Write to a plain file instead of RTMP — used by the selftest. */
    this.fileOutput = fileOutput;
    this.initialBurst = initialBurst;
    /** Feature-detected concat demuxer options; see probeConcatCapabilities. */
    this.caps = caps ?? { recursionDepth: true, segmentTimeMetadata: true };
    /**
     * What to do when the queue runs dry:
     *   'end'    — terminate the chain so playback stops cleanly
     *   'filler' — keep the channel alive with black+silence
     */
    this.endBehavior = endBehavior;
    this.terminated = false;

    this.status = 'stopped'; // stopped | starting | running | stopping
    this.proc = null;
    this.watchdog = null;

    /** Upcoming items: { id, title, srcPath }. Mutable while live. */
    this.queue = [];
    /** Items already written into the chain, oldest first. */
    this.committed = [];

    this.linkIndex = 0;
    this.committedDuration = 0; // seconds of chain written so far
    this.outTimeSec = 0;        // playhead, from -progress
    this.currentIndex = -1;     // index into `committed` believed to be playing

    this._restarts = [];
    this._fillerKey = null;
    this._advancing = false;
  }

  // ── queue ────────────────────────────────────────────────────────────

  enqueue(item) {
    this.queue.push(item);
    this.emit('queue', this.snapshot());
    // Warm the cache for whatever we just added, best-effort.
    this._prefetch();
    return this;
  }

  /** Replace the pending queue. Committed items keep playing. */
  setQueue(items) {
    this.queue = [...items];
    this.emit('queue', this.snapshot());
    this._prefetch();
  }

  snapshot() {
    return {
      status: this.status,
      playing: this.committed[this.currentIndex] ?? null,
      queue: [...this.queue],
      outTimeSec: this.outTimeSec,
      committedDuration: this.committedDuration,
    };
  }

  async _prefetch() {
    const lookahead = this.normalizer.profile.lookahead ?? 2;
    for (const item of this.queue.slice(0, lookahead)) {
      this.normalizer.ensure(item.srcPath, item.trackOverride ?? null).catch((err) => {
        this.emit('warn', `prefetch failed for ${item.srcPath}: ${err.message}`);
      });
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start() {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!this.queue.length) throw new Error('Queue is empty');

    this.status = 'starting';
    this.emit('status', this.status);

    // Fill the chain before ffmpeg opens it. The head link must exist, and
    // having the lookahead already written means a slow first normalization
    // can't strand us the moment playback starts.
    await this._topUp();

    this._spawn(join(this.cacheDir, linkName(0)));
  }

  stop() {
    if (!this.proc) {
      this.status = 'stopped';
      this.emit('status', this.status);
      return;
    }
    this.status = 'stopping';
    this.emit('status', this.status);

    const proc = this.proc;
    // Never SIGKILL first — ffmpeg needs to close the RTMP session cleanly.
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5_000).unref?.();
  }

  _spawn(headPath) {
    const args = buildPlayoutArgs({
      head: headPath,
      target: this.target,
      statsPeriodMs: this.statsPeriodMs,
      fileOutput: this.fileOutput,
      initialBurst: this.initialBurst,
      caps: this.caps,
    });

    const startedAt = Date.now();
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = child;

    const parser = new ProgressParser();
    this.watchdog = new ProgressWatchdog({ statsPeriodMs: this.statsPeriodMs }).start();

    parser.on('block', (b) => {
      this.watchdog.onBlock(b);
      if (b.outTimeUs != null) {
        this.outTimeSec = b.outTimeUs / 1e6;
        this._maybeAdvance();
      }
      this.emit('progress', b);
    });

    this.watchdog.on('stall', ({ silentMs }) => {
      this.emit('warn', `ffmpeg stalled — no progress for ${silentMs}ms`);
      this.emit('stall', { silentMs });
      this.stop();
    });
    this.watchdog.on('drift', ({ speed }) => {
      this.emit('warn', `falling behind realtime (speed ${speed}x)`);
    });
    this.watchdog.on('drops', (d) => this.emit('warn', `dropped ${d.delta} frames`));

    child.stdout.on('data', (d) => parser.push(d));

    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      this.emit('log', s);
    });

    child.on('error', (err) => {
      this.emit('error', err);
      this._teardown();
    });

    child.on('close', (code) => {
      const ranMs = Date.now() - startedAt;
      this.watchdog?.stop();

      const wasStopping = this.status === 'stopping';
      this._teardown();

      if (wasStopping || code === 0) {
        this.emit('ended', { code });
        return;
      }
      // An exit this fast is a configuration or encoder problem; restarting
      // identical args would just loop. Surface it instead.
      if (ranMs < HARD_FAIL_MS) {
        this.emit('fatal', new Error(
          `ffmpeg exited after ${ranMs}ms (code ${code}) — likely a config or `
          + `encoder problem, not a transient failure.\n${lastLines(stderr, 8)}`,
        ));
        return;
      }
      this.emit('crashed', { code, ranMs, stderr: lastLines(stderr, 8) });
    });

    this.status = 'running';
    this.emit('status', this.status);
  }

  _teardown() {
    this.proc = null;
    this.watchdog?.stop();
    this.watchdog = null;
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.emit('status', this.status);
    }
  }

  // ── chain writing ────────────────────────────────────────────────────

  /** How far the playhead is from the end of everything written so far. */
  get remainingSeconds() {
    return this.committedDuration - this.outTimeSec;
  }

  /**
   * Which committed link the playhead is inside, derived from cumulative
   * durations. `-segment_time_metadata` exposes this per packet too, but
   * summing what we wrote is simpler and does not depend on parsing metadata
   * out of the packet stream.
   */
  _playingIndex() {
    let acc = 0;
    for (let i = 0; i < this.committed.length; i++) {
      acc += this.committed[i].duration;
      if (this.outTimeSec < acc) return i;
    }
    return Math.max(0, this.committed.length - 1);
  }

  _maybeAdvance() {
    const idx = this._playingIndex();
    if (idx !== this.currentIndex) {
      this.currentIndex = idx;
      this.emit('nowplaying', this.committed[idx] ?? null);
    }
    if (this._advancing || this.terminated) return;
    if (this.committed.length - idx > LOOKAHEAD_LINKS) return;

    this._advancing = true;
    this._topUp()
      .catch((err) => this.emit('warn', `chain extension failed: ${err.message}`))
      .finally(() => { this._advancing = false; });
  }

  /** Extend the chain until it is LOOKAHEAD_LINKS ahead of the playhead. */
  async _topUp() {
    while (!this.terminated) {
      const ahead = this.committed.length - Math.max(0, this.currentIndex);
      if (this.committed.length && ahead > LOOKAHEAD_LINKS) break;

      // With 'end', a queue that is merely *waiting* on normalization must
      // not be mistaken for a finished one.
      if (!this.queue.length) {
        if (this.endBehavior === 'end') {
          this.terminated = true;
          break;
        }
        await this._commitFiller();
        continue;
      }

      try {
        await this._commitNext();
      } catch (err) {
        // A single bad file must not take the channel down; skip it and
        // keep the chain moving.
        this.emit('warn', `skipping unplayable item: ${err.message}`);
        if (!this.queue.length && this.endBehavior !== 'end') {
          await this._commitFiller();
        }
      }
    }
  }

  /**
   * Append the head of the queue as the next chain link — but only if it is
   * ALREADY normalized.
   *
   * This is the rule that keeps the channel alive. Awaiting an encode here
   * would mean racing the playhead: if normalization takes longer than the
   * remaining committed runtime, ffmpeg reaches a nested script that does not
   * exist yet and exits. Committing filler instead costs a few seconds of
   * black and keeps the RTMP socket fed, which is always the better trade.
   */
  async _commitNext() {
    const item = this.queue[0];
    if (!item) return;

    let key;
    try {
      key = await this.normalizer.keyFor(item.srcPath, item.trackOverride ?? null);
    } catch (err) {
      this.queue.shift(); // unreadable source — drop it
      throw new Error(`${item.srcPath}: ${err.message}`);
    }

    if (!this.normalizer.has(key)) {
      // Not ready. Keep it queued, make sure it's encoding, and buy time.
      this.normalizer.ensure(item.srcPath, item.trackOverride ?? null).catch((err) => {
        this.emit('warn', `normalize failed for ${item.title ?? item.srcPath}: ${err.message}`);
        // Drop it so the queue can't wedge on one bad file.
        const i = this.queue.indexOf(item);
        if (i !== -1) this.queue.splice(i, 1);
      });
      this.emit('waiting', { item });
      await this._commitFiller();
      return;
    }

    this.queue.shift();
    const path = this.normalizer.pathFor(key);
    const duration = await probeDuration(path);

    this.normalizer.pin(key);
    // If this was the last item and we're not keeping the channel alive with
    // filler, write it as a terminal link — no successor reference. A link
    // pointing at a script that never gets written is a hard error; a link
    // with no pointer at all ends playback cleanly with exit 0.
    const isLast = !this.queue.length && this.endBehavior === 'end';
    this._writeLink(key, { terminal: isLast });

    this.committed.push({ ...item, key, duration });
    this.committedDuration += duration;
    if (this.currentIndex < 0) this.currentIndex = 0;

    this.emit('committed', { item, key, duration });
    this.emit('queue', this.snapshot());
    this._prefetch();
  }

  /**
   * Black + silence, generated once and reused. Buys time when the next clip
   * isn't normalized yet — far better than letting the socket go quiet.
   */
  async _commitFiller() {
    this._fillerKey ??= await makeFiller(this.cacheDir, this.normalizer.profile);
    const duration = await probeDuration(join(this.cacheDir, `${this._fillerKey}.ts`));

    this.normalizer.pin(this._fillerKey);
    this._writeLink(this._fillerKey);

    this.committed.push({ id: null, title: 'filler', key: this._fillerKey, duration });
    this.committedDuration += duration;
    this.emit('filler', { seconds: duration });
  }

  /**
   * Write chain link N: one clip, then a reference to link N+1.
   *
   * Written to a temp name and renamed, because ffmpeg may open this file at
   * any moment and a partially-written script is a parse error that kills the
   * process. Rename is atomic within a directory.
   */
  _writeLink(clipKey, { terminal = false } = {}) {
    const i = this.linkIndex++;
    const body = [
      'ffconcat version 1.0',
      `file ${clipKey}.ts`,
      ...(terminal ? [] : [`file ${linkName(i + 1)}`]),
      '',
    ].join('\n');

    this._atomicWrite(linkName(i), body);
    if (terminal) this.emit('terminated', { atLink: i });
  }

  /**
   * ffmpeg may open any of these files at any moment, and a half-written
   * script is a parse error that kills the process. Rename is atomic within
   * a directory, so the file only ever appears complete.
   */
  _atomicWrite(name, body) {
    const finalPath = join(this.cacheDir, name);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, body);
    renameSync(tmpPath, finalPath);
  }
}

/**
 * Playout is `-c copy` — every clip was already encoded to the house profile
 * during normalization, so there is nothing to encode while live.
 */
export function buildPlayoutArgs({
  head, target, statsPeriodMs = 500, fileOutput = false, initialBurst = 10,
  caps = { recursionDepth: true, segmentTimeMetadata: true },
}) {
  // Writing to a file exercises the identical concat/copy path minus the RTMP
  // muxer, which is what the selftest needs in order to verify chaining
  // without a server.
  const sink = fileOutput
    ? ['-f', 'mpegts']
    : [
      // Reconnects a dropped RTMP push without killing the process. This is
      // the only in-ffmpeg mechanism that survives a blip, and Owncast's 10s
      // deadline leaves no room to restart the whole pipeline.
      '-f', 'fifo', '-fifo_format', 'flv',
      '-attempt_recovery', '1', '-recover_any_error', '1',
      '-restart_with_keyframe', '1', '-recovery_wait_time', '1',
      '-drop_pkts_on_overflow', '1', '-queue_size', '240',
      // no_sequence_end: otherwise ffmpeg sends an explicit end-of-sequence
      // tag on exit and Owncast ends the broadcast.
      '-flvflags', 'no_duration_filesize+no_sequence_end',
    ];

  return [
    '-hide_banner', '-nostdin',
    // Pace by timestamps. The initial burst fills Owncast's buffer quickly so
    // the first HLS segment appears without a long wait — but note it makes
    // out_time race ahead of wallclock at startup, consuming that many
    // seconds of chain immediately. It must stay well under one clip.
    '-re', '-readrate_initial_burst', String(initialBurst),
    '-f', 'concat', '-safe', '0',
    // Default is 10. Without this the channel dies on the 11th clip with
    // "Too deep recursion". Depth costs no memory; a 400-link chain peaked
    // under 2 MB RSS.
    //
    // Not present on every ffmpeg build, and an unrecognised option is fatal
    // rather than ignored — so it is feature-detected, never assumed.
    ...(caps.recursionDepth ? ['-recursion_depth', '2147483647'] : []),
    // Attaches lavf.concat.start_time to each packet — the only way to know
    // playlist position from inside a single long-running process.
    ...(caps.segmentTimeMetadata ? ['-segment_time_metadata', '1'] : []),
    '-i', head,
    '-c', 'copy',
    '-muxdelay', '0', '-muxpreload', '0',
    // Without this the muxer will stall video up to 10s waiting on lagging
    // audio, which reads as a freeze.
    '-max_interleave_delta', '0',
    ...sink,
    '-progress', 'pipe:1', '-stats_period', String(statsPeriodMs / 1000),
    target,
  ];
}

/** Duration in seconds, via ffprobe. */
export function probeDuration(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const n = parseFloat(out.trim());
      if (code !== 0 || !Number.isFinite(n)) {
        return reject(new Error(`ffprobe failed for ${path}: ${err.trim() || `exit ${code}`}`));
      }
      resolve(n);
    });
  });
}

/** Generate a black+silence clip matching the house profile exactly. */
export function makeFiller(cacheDir, profile, seconds = 30) {
  const key = `filler-${profile.width}x${profile.height}-${profile.fps}-${seconds}s`;
  const out = join(cacheDir, `${key}.ts`);
  if (existsSync(out)) return Promise.resolve(key);

  const tmp = `${out}.partial`;
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${profile.width}x${profile.height}:r=${profile.fps}`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(seconds),
      // Software x264 deliberately: filler must exist even when the hardware
      // encoder is the thing that's broken.
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', profile.videoBitrate, '-maxrate', profile.videoBitrate,
      '-g', String(profile.gopSeconds * profile.fps),
      '-keyint_min', String(profile.gopSeconds * profile.fps),
      '-sc_threshold', '0', '-bf', '0',
      '-c:a', 'aac', '-b:a', profile.audioBitrate ?? '160k', '-ar', '48000', '-ac', '2',
      '-fps_mode', 'cfr', '-video_track_timescale', '90000',
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
      '-f', 'mpegts', tmp,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`filler generation failed: ${lastLines(err, 4)}`));
      renameSync(tmp, out);
      resolve(key);
    });
  });
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
