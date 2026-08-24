/**
 * The playout engine: one ffmpeg process that outlives every clip.
 *
 * Source files are streamed DIRECTLY and encoded live, the way OBS does it —
 * playback starts in about a second rather than after a full pre-encode.
 *
 * An earlier design normalized every clip to disk first, on the belief that
 * the concat demuxer silently corrupts mixed-format input. Measured, that
 * turned out to be false when re-encoding: joining 480p25/44.1kHz,
 * 720p30/48kHz and 1080p24/48kHz sources through concat with normalizing
 * filters produced 15.088s against 15.00 expected. The filters conform
 * everything on the way through, so the pre-pass bought nothing but latency.
 *
 * Gaplessness comes from ffmpeg's concat demuxer opening a NESTED .ffconcat
 * reference lazily, at the moment playback reaches it. A flat list is parsed
 * once and never re-read, but a chain of one-clip scripts each pointing at
 * the next lets a single process run indefinitely while everything past the
 * playhead stays editable.
 *
 *     p000000.ffconcat          <- playing now
 *       ffconcat version 1.0
 *       file 3f2a....mkv        <- symlink to the real file
 *       file p000001.ffconcat   <- need not exist yet
 *
 * This matters because Owncast accepts a single publisher and drops the
 * stream after 10 seconds of socket silence — a hardcoded deadline. One
 * ffmpeg per episode would mean a reconnect at every boundary, which Owncast
 * sees as stream-stop / stream-start.
 *
 * Why symlinks: nested scripts do NOT inherit -safe 0 and resolve relative
 * paths against their own directory, so entries must be bare sibling names.
 * The media lives elsewhere (and read-only), so each queued clip gets a
 * symlink in the work directory and the chain references that.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import {
  writeFileSync, renameSync, existsSync, symlinkSync, unlinkSync, statSync,
} from 'fs';
import { extname, join } from 'path';
import { ProgressParser, ProgressWatchdog } from './progress.js';
import { BACKENDS, audioArgs, scaleFilter } from './encoders.js';
import { buildSubtitleFilter } from './tracks.js';

/**
 * How many links to keep written beyond the one currently playing.
 *
 * Counting links rather than seconds is what makes this correct for both a
 * 3-second bumper and a 45-minute episode.
 */
const LOOKAHEAD_LINKS = 2;
/** An exit this fast means the encoder/config is broken, not flaky. */
const HARD_FAIL_MS = 5_000;

const linkName = (i) => `p${String(i).padStart(6, '0')}.ffconcat`;

export class PlayoutEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.workDir     holds chain scripts and clip symlinks
   * @param {string} opts.target      full rtmp:// URL, or a local file
   * @param {object} opts.profile     encoder profile incl. resolved `backend`
   * @param {object} [opts.selection] track selection from selectTracks()
   */
  constructor({
    workDir, target, profile, selection = null,
    statsPeriodMs = 500, endBehavior = 'end', initialBurst = 10,
    caps = null, startOffset = 0,
  }) {
    super();
    this.workDir = workDir;
    this.target = target;
    this.profile = profile;
    this.selection = selection;
    this.statsPeriodMs = statsPeriodMs;
    this.endBehavior = endBehavior;
    this.initialBurst = initialBurst;
    this.caps = caps ?? { recursionDepth: true, segmentTimeMetadata: true };
    /** Seconds into the first clip to begin at, for resuming a broadcast. */
    this.startOffset = startOffset;

    this.status = 'stopped'; // stopped | starting | running | stopping
    this.proc = null;
    this.watchdog = null;
    this.terminated = false;

    /** Upcoming items: { id, title, srcPath }. Mutable while live. */
    this.queue = [];
    /** Items already written into the chain, oldest first. */
    this.committed = [];

    this.linkIndex = 0;
    this.committedDuration = 0;
    this.outTimeSec = 0;
    this.currentIndex = -1;

    this._advancing = false;
  }

  // ── queue ────────────────────────────────────────────────────────────

  enqueue(item) {
    this.queue.push(item);
    this.emit('queue', this.snapshot());
    return this;
  }

  /** Replace the pending queue. Committed items keep playing. */
  setQueue(items) {
    this.queue = [...items];
    this.emit('queue', this.snapshot());
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

  // ── lifecycle ────────────────────────────────────────────────────────

  async start() {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!this.queue.length) throw new Error('Queue is empty');

    this.status = 'starting';
    this.emit('status', this.status);

    // Nothing to pre-encode — just link the first clips and go.
    await this._topUp();

    this._spawn(join(this.workDir, linkName(0)));
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
      profile: this.profile,
      selection: this.selection,
      statsPeriodMs: this.statsPeriodMs,
      initialBurst: this.initialBurst,
      caps: this.caps,
      startOffset: this.startOffset,
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
      const s = this._redact(d.toString());
      stderr += s;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      this.emit('log', s);
    });

    child.on('error', (err) => {
      this.emit('error', new Error(this._redact(err.message)));
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

  /**
   * Strip the stream key from anything that might be logged. ffmpeg prints
   * the full output URL in its own diagnostics, so an ordinary error would
   * otherwise leak the key into terminals, logs and bug reports.
   */
  _redact(text) {
    if (!text) return text;
    if (!/^rtmps?:\/\//i.test(String(this.target))) return text;
    const key = String(this.target).split('/').pop();
    if (!key || key.length < 4) return text;
    return text.split(key).join('*'.repeat(8));
  }

  // ── chain writing ────────────────────────────────────────────────────

  get remainingSeconds() {
    return this.committedDuration - this.outTimeSec;
  }

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

      if (!this.queue.length) {
        if (this.endBehavior === 'end') {
          this.terminated = true;
          break;
        }
        // 'filler' would go here; with live encoding there is nothing to
        // wait for, so an empty queue simply means the run is over.
        this.terminated = true;
        break;
      }

      try {
        await this._commitNext();
      } catch (err) {
        // A single bad file must not take the channel down.
        this.emit('warn', `skipping unplayable item: ${err.message}`);
      }
    }
  }

  /**
   * Link the head of the queue into the work directory and append it as the
   * next chain link. No encoding happens here — that is the streaming
   * process's job, which is why playback can start immediately.
   */
  async _commitNext() {
    const item = this.queue.shift();
    if (!item) return;

    if (!existsSync(item.srcPath)) {
      throw new Error(`file not found: ${item.srcPath}`);
    }

    const name = this._link(item.srcPath);
    const duration = await probeDuration(item.srcPath);

    const isLast = !this.queue.length && this.endBehavior === 'end';
    this._writeLink(name, { terminal: isLast });

    this.committed.push({ ...item, linkName: name, duration });
    this.committedDuration += duration;
    if (this.currentIndex < 0) this.currentIndex = 0;

    this.emit('committed', { item, duration });
    this.emit('queue', this.snapshot());
  }

  /**
   * Create a stable-named symlink to a source file inside the work directory.
   *
   * Nested .ffconcat scripts resolve paths against their own directory and do
   * not inherit -safe 0, so entries have to be bare sibling filenames. The
   * media itself lives on a read-only mount elsewhere.
   */
  _link(srcPath) {
    const hash = createHash('sha1').update(srcPath).digest('hex').slice(0, 16);
    const name = `${hash}${extname(srcPath) || '.mkv'}`;
    const dest = join(this.workDir, name);

    try {
      const st = statSync(dest, { throwIfNoEntry: false });
      if (st) return name; // already linked
      symlinkSync(srcPath, dest);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    return name;
  }

  _writeLink(clipName, { terminal = false } = {}) {
    const i = this.linkIndex++;
    const body = [
      'ffconcat version 1.0',
      `file ${clipName}`,
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
    const finalPath = join(this.workDir, name);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, body);
    renameSync(tmpPath, finalPath);
  }

  /**
   * What a replacement engine needs to carry on from here: the clips still to
   * play, and how far into the first one we are.
   *
   * Track selection is fixed for the life of an ffmpeg process — -map and the
   * subtitles filter are set once — so changing subtitles mid-broadcast means
   * a new process. Resuming at the right offset is what keeps that from
   * restarting the episode from the beginning.
   */
  resumeState() {
    const idx = Math.max(0, this.currentIndex);
    let before = 0;
    for (let i = 0; i < idx; i++) before += this.committed[i]?.duration ?? 0;
    return {
      items: [...this.committed.slice(idx), ...this.queue]
        .map(({ id, title, srcPath }) => ({ id, title, srcPath })),
      offset: Math.max(0, this.outTimeSec - before),
    };
  }

  /** Remove symlinks and chain scripts left behind by a finished run. */
  cleanup() {
    for (const c of this.committed) {
      try { unlinkSync(join(this.workDir, c.linkName)); } catch { /* gone */ }
    }
    for (let i = 0; i < this.linkIndex; i++) {
      try { unlinkSync(join(this.workDir, linkName(i))); } catch { /* gone */ }
    }
  }
}

/**
 * Live encode: decode → software scale/pad/subtitles → hardware encode → RTMP.
 *
 * Everything before hwupload must be software. Software filters cannot
 * operate on hardware frames, and there is no hardware equivalent of subtitle
 * rendering.
 */
export function buildPlayoutArgs({
  head, target, profile, selection = null,
  statsPeriodMs = 500, initialBurst = 10, startOffset = 0,
  caps = { recursionDepth: true, segmentTimeMetadata: true },
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  // The subtitles filter accepts the concat script itself as its source and
  // follows the chain, so each clip renders its OWN embedded subtitles —
  // verified with two files carrying different tracks.
  const sub = buildSubtitleFilter(selection?.subtitle ?? null, head);
  const audioIdx = selection?.audio?.typeIndex ?? 0;

  const base = scaleFilter(profile);
  const upload = be.uploadFilter(profile);

  const filterArgs = sub.needsComplex
    ? [
      '-filter_complex',
      `[0:v:0]${base}[base];[base][${sub.overlayInput}]overlay[ov];[ov]${upload}[vout]`,
      '-map', '[vout]',
    ]
    : [
      '-vf', [base, sub.filter, upload].filter(Boolean).join(','),
      '-map', '0:v:0',
    ];

  return [
    '-hide_banner', '-nostdin',
    ...be.deviceArgs(profile),
    // Pace by timestamps. The initial burst fills Owncast's buffer so the
    // first HLS segment appears quickly — but it makes out_time race ahead of
    // wallclock at startup, consuming that much chain immediately, so it must
    // stay well under one clip.
    '-re', '-readrate_initial_burst', String(initialBurst),
    '-f', 'concat', '-safe', '0',
    // Default is 10, and depth accumulates down a chain — without this the
    // channel dies on the 11th clip with "Too deep recursion". Not present on
    // every build, and an unrecognised option is fatal, so it is
    // feature-detected rather than assumed.
    ...(caps.recursionDepth ? ['-recursion_depth', '2147483647'] : []),
    ...(caps.segmentTimeMetadata ? ['-segment_time_metadata', '1'] : []),
    // Input-side seek, so resuming a broadcast after a settings change
    // picks up where it left off instead of restarting the episode.
    ...(startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : []),
    '-i', head,
    ...filterArgs,
    // The `?` makes the audio map optional, so a clip without an audio track
    // at that index doesn't abort the whole channel.
    '-map', `0:a:${audioIdx}?`,
    ...be.encoderArgs(profile),
    ...audioArgs(profile),
    '-muxdelay', '0', '-muxpreload', '0',
    // Without this the muxer stalls video up to 10s waiting on lagging audio,
    // which reads as a freeze.
    '-max_interleave_delta', '0',
    // Reconnects a dropped RTMP push without killing the process — the only
    // in-ffmpeg mechanism that survives a blip, and Owncast's 10s deadline
    // leaves no room to restart the whole pipeline.
    '-f', 'fifo', '-fifo_format', 'flv',
    '-attempt_recovery', '1', '-recover_any_error', '1',
    '-restart_with_keyframe', '1', '-recovery_wait_time', '1',
    '-drop_pkts_on_overflow', '1', '-queue_size', '240',
    // no_sequence_end: otherwise ffmpeg sends an explicit end-of-sequence tag
    // on exit and Owncast ends the broadcast.
    '-flvflags', 'no_duration_filesize+no_sequence_end',
    '-progress', 'pipe:1', '-stats_period', String(statsPeriodMs / 1000),
    target,
  ];
}

/**
 * Push a couple of seconds of colour bars and report whether the server
 * accepted them.
 *
 * This exists because the fifo muxer's recovery options make a rejected
 * connection invisible: with -attempt_recovery it retries forever while the
 * encoder keeps running happily, so a wrong stream key looks identical to a
 * working stream that just never appears. Here the push is direct, with no
 * fifo wrapper, so the server's actual refusal surfaces.
 *
 * Uses libx264 deliberately — always present, and this is testing the network
 * path, not the encoder.
 */
export function testRtmpConnection(target, {
  seconds = 3, timeoutMs = 45_000, realtime = false,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      // Without -re this encodes the whole clip as fast as it can and dumps
      // it in about a second, so the server logs a stream that started and
      // ended immediately and never has enough content to serve. A test meant
      // to be watched has to be paced like a real stream.
      ...(realtime ? ['-re'] : []),
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-f', 'flv', target,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    let timer = setTimeout(() => { timer = null; child.kill('SIGKILL'); }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      else return resolve({ ok: false, error: 'timed out connecting' });
      resolve(code === 0
        ? { ok: true }
        : { ok: false, error: lastLines(stderr, 3) || `ffmpeg exited ${code}` });
    });
  });
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

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
