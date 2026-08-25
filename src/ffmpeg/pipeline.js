/**
 * Split playout: a publisher that never restarts, fed by a source that can.
 *
 * This is how OBS manages to seek instantly while streaming. Its encoder and
 * RTMP connection run continuously; a media source is just something the
 * compositor reads from, so repositioning a decoder never touches the output.
 *
 * The previous design did input → filter → encode → RTMP in one ffmpeg, which
 * meant every seek, pause or subtitle change restarted the RTMP connection and
 * interrupted viewers.
 *
 *   ┌─ source (restartable) ────────┐        ┌─ publisher (immortal) ─┐
 *   │ decode → filter → encode → TS │──pipe──│ copy → FLV → RTMP      │
 *   │ seek / tracks / pause here    │        │ holds the connection   │
 *   └───────────────────────────────┘        └────────────────────────┘
 *
 * Restarting the source starves the pipe for a few hundred milliseconds. The
 * publisher simply blocks on read — it does not exit, and the RTMP session
 * stays open. Owncast only ends a broadcast after ten seconds of silence, so
 * that gap is comfortably invisible.
 *
 * Two details make the seam work:
 *
 *  - `-output_ts_offset` continues each source's timestamps from where the
 *    last one stopped. Without it every restart would reset to zero and hand
 *    the FLV muxer a timeline that jumps backwards.
 *  - The publisher's stdin is never closed when a source exits, or it would
 *    see EOF and shut down the connection we are trying to protect.
 */

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { ProgressParser } from './progress.js';
import { probeDuration } from './playout.js';
import { BACKENDS, audioArgs, scaleFilter } from './encoders.js';
import { buildSubtitleFilter } from './tracks.js';

/**
 * Where the video content lands inside the output frame after aspect-
 * preserving scaling — the rectangle subtitles must be rendered into.
 * A 4:3 source in a 16:9 output occupies a centered 1440x1080 of 1920x1080;
 * rendering subs on the full frame instead smears their positions toward
 * the pillarbox bars.
 */
/**
 * Output framerate for a clip: the source's own rate when it is at or below
 * the profile cap. Forcing 23.976fps anime to 30fps duplicates every fourth
 * frame — 25% more GPU work on scale, composite and encode for zero quality
 * gain, plus judder. Returns { rate: string for -r/lavfi, fps: number }.
 */
export function effectiveFps(video, profile) {
  const cap = profile.fps ?? 30;
  if (profile.fpsMode === 'fixed') return { rate: String(cap), fps: cap };
  const m = /^(\d+)\/(\d+)$/.exec(video?.frameRate ?? '');
  if (m && +m[2] > 0) {
    const f = +m[1] / +m[2];
    if (f > 5 && f <= cap + 0.01) return { rate: video.frameRate, fps: f };
  }
  return { rate: String(cap), fps: cap };
}

export function contentRect(video, profile) {
  const W = profile.width;
  const H = profile.height;
  let vw = video?.width;
  const vh = video?.height;
  if (!vw || !vh) return { w: W, h: H, x: 0, y: 0, bars: false };
  // Use the display width: anamorphic sources (SAR != 1) are stored narrow
  // or wide and stretched at playback, and placement must follow what the
  // viewer sees, not what the file stores.
  const m = /^(\d+):(\d+)$/.exec(video?.sar ?? '');
  if (m && +m[1] > 0 && +m[2] > 0) vw = vw * (+m[1] / +m[2]);
  const r = Math.min(W / vw, H / vh);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const w = even(vw * r);
  const h = even(vh * r);
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  return { w, h, x, y, bars: x > 1 || y > 1 };
}
import { extractSubtitle, extractFonts, isExtractable } from './subcache.js';
import { ChunkScheduler } from './chunker.js';

/** Treat a source that dies this fast as broken rather than finished. */
const SOURCE_FAIL_MS = 2_000;
/** Publisher exiting this fast means the RTMP target rejected us. */
const PUBLISH_FAIL_MS = 5_000;
/**
 * Elastic buffer between source and publisher, in bytes (~16s at 12 Mbps).
 *
 * Encode speed is not constant: libass renders heavy typesetting on one
 * core, so a clip can swing 1.3x → 0.7x scene by scene. Direct piping gave
 * the pipeline only the OS pipe (well under a second) of slack, so every
 * dip below 1.0x — and every source restart at a seek or episode boundary —
 * starved the publisher immediately; ten starved seconds and Owncast ends
 * the broadcast. With a bank, fast sections build reserve that slow
 * sections and restarts spend.
 *
 * Deliberately bounded: everything banked is encoded-but-unaired, so a
 * user-initiated jump (seek, track change, skip) discards it to stay
 * responsive, and viewers skip forward by however much was banked. A few
 * tens of seconds of resilience is worth that; minutes would not be. The
 * byte cap is derived from the configured bitrate to land at ~BANK_SECONDS
 * regardless of quality settings.
 */
/** Window for the speed figure shown in the UI, and for the slow warning. */
const SPEED_WINDOW_MS = 30_000;
const SLOW_WINDOW_MS = 6_000;

const BANK_SECONDS = 15;
const BANK_MIN_BYTES = 2 * 1024 * 1024;
const BANK_MAX_BYTES = 48 * 1024 * 1024;

export class PipelinePlayout extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.target    rtmp:// URL, or a local file for testing
   * @param {object} o.profile   encoder profile incl. resolved `backend`
   * @param {object} [o.selection] track selection from selectTracks()
   */
  constructor({ target, profile, selection = null, statsPeriodMs = 500, cacheDir = null }) {
    super();
    this.target = target;
    this.profile = profile;
    this.selection = selection;
    this.statsPeriodMs = statsPeriodMs;
    /** Where extracted subtitle tracks and fonts are kept. */
    this.cacheDir = cacheDir;
    this._subCache = new Map();   // `${srcPath}:${typeIndex}` -> {path, fontsDir}
    /** Set when a clip is encoded in parallel chunks instead of streamed. */
    this.scheduler = null;
    this._clipBase = 0;

    this.status = 'stopped';   // stopped | running | paused
    this.publisher = null;
    this.source = null;
    this.holding = false;

    /** Upcoming items: { id, title, srcPath, duration }. */
    this.queue = [];
    /** What is on air: { item, offset, duration }. */
    this.current = null;

    /** Seconds published so far — keeps the output timeline monotonic. */
    this.timeline = 0;
    /** Position within the current clip. */
    this.position = 0;

    this._stopping = false;
    /**
     * Stall recovery. The old engine had a watchdog; the rework lost it, and
     * a wedged source or publisher then hangs the broadcast silently — the
     * UI keeps its last state while Owncast times out. A source that stops
     * producing progress gets respawned at the current position; repeated
     * respawns escalate to fatal instead of looping forever.
     */
    this._lastBlockAt = null;
    this._respawns = [];
    this._watch = null;

    const kbps = parseInt(String(profile?.videoBitrate ?? '6000'), 10) || 6000;
    /** ~BANK_SECONDS of stream at the configured bitrate, clamped. */
    this._bankMax = Math.min(BANK_MAX_BYTES,
      Math.max(BANK_MIN_BYTES, kbps * 125 * BANK_SECONDS));
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(items = []) {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!items.length) throw new Error('Nothing to play');

    this.queue = [...items];
    this._stopping = false;

    const first = this.queue.shift();
    // If the chosen subtitle lives inside the container and no extracted copy
    // exists, extract it BEFORE connecting. The subtitles filter reads the
    // ENTIRE file during its init before producing one frame — minutes on a
    // big remux — which overruns both Owncast's 10s silence deadline and the
    // watchdog's grace, guaranteeing an endless respawn loop. Extraction
    // costs the same single read but happens off-air, once ever: the result
    // is cached on disk keyed by size+mtime.
    if (this._needsExtraction(first)) {
      this.status = 'preparing';
      this.current = { item: first, offset: 0, duration: first.duration ?? null };
      this.emit('status', this.status);
      const t0 = Date.now();
      this.emit('log', '[subs] extracting subtitles before going live — '
        + 'first playback of a file reads it once in full\n');
      await this._extract(first);
      this.emit('log', `[subs] prepared in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
      // The user may have hit Stop while the extraction ran.
      if (this._stopping) {
        this.status = 'stopped';
        this.emit('status', this.status);
        this.emit('ended');
        return;
      }
    } else {
      await this.prepare(first);
    }
    // Warm before connecting: Owncast drops a session that is silent for its
    // first 10s, and a cold Bluray over SMB can take longer than that to
    // open. Reading the head first means the source starts hot.
    await this._warm(first);
    this._spawnPublisher();
    this._play(first, 0);
    // 'running' is claimed only when the encoder actually produces output
    // (first progress block) — a green "On air" during a startup that later
    // fails is a lie the user rightly called out.
    this.status = 'starting';
    this.emit('status', this.status);

    this._lastBlockAt = Date.now();
    this._watch = setInterval(() => this._checkHealth(), 2000);
    this._watch.unref?.();
  }

  _checkHealth() {
    if (this.status !== 'running' || !this.source) return;
    // A source paused for backpressure is not stalled — it is doing exactly
    // what it was told. ffmpeg reports no progress while its stdout is
    // paused, so without this the watchdog kills every source that encodes
    // faster than realtime (which is most of them) the moment the bank
    // fills, and the broadcast churns through respawns forever.
    if (this._srcPaused) {
      this._lastBlockAt = Date.now();
      return;
    }
    const silent = Date.now() - (this._lastBlockAt ?? Date.now());
    // A source that has not produced its FIRST block yet is starting, not
    // stalled — huge files over SMB need many seconds to open, and the
    // subtitles filter opens the same file a second time. Killing it early
    // just restarts the wait from zero, forever.
    const limit = this._sawBlock ? 5000 : 30_000;
    // Health beacon: one line every ~14s into docker logs, so a wedged
    // broadcast leaves evidence of its exact state instead of a mystery.
    this._beat = (this._beat ?? 0) + 1;
    if (this._beat % 7 === 0) {
      this.emit('log', `[health] pos=${this.position.toFixed(1)}s `
        + `timeline=${this.timeline.toFixed(1)}s queue=${this.queue.length} `
        + `srcPid=${this.source?.pid ?? '-'} pubPid=${this.publisher?.pid ?? '-'} `
        + `silent=${(silent / 1000).toFixed(1)}s\n`);
    }
    // Owncast drops after 10s of socket silence — recover well inside that.
    if (silent < 5000) return;

    if (silent < limit) return;
    const now = Date.now();
    // A source that never produced a single block will not start producing
    // on its Nth identical respawn — each restart begins the same doomed
    // startup from zero. The per-minute rule below cannot catch this: with
    // a 30s first-block grace it is exactly 2 respawns/minute, forever.
    if (!this._sawBlock) {
      this._deadSpawns = (this._deadSpawns ?? 0) + 1;
      if (this._deadSpawns >= 3) {
        this.emit('fatal', new Error(
          'The encoder produced no output in 3 attempts (~90s). If this clip '
          + 'burns embedded subtitles, the subtitles filter may be reading '
          + 'the whole file at startup — check the [subs] lines in the '
          + 'console for a failed or disabled extraction.',
        ));
        this.stop();
        return;
      }
    } else {
      this._deadSpawns = 0;
    }
    this._respawns = this._respawns.filter((t) => now - t < 60_000);
    if (this._respawns.length >= 3) {
      this.emit('fatal', new Error(
        'Source stalled 3 times within a minute — giving up. Last position '
        + `${this.position.toFixed(1)}s. Check docker logs for the ffmpeg error.`,
      ));
      this.stop();
      return;
    }
    this._respawns.push(now);
    this.emit('warn', `source silent for ${(silent / 1000).toFixed(0)}s — respawning at ${this.position.toFixed(1)}s`);
    this._lastBlockAt = Date.now();
    if (this.current) {
      this._play(this.current.item, this.position, { duration: this.current.duration });
    }
  }

  stop({ graceful = false } = {}) {
    this._stopping = true;
    this._killSource();
    if (this.publisher) {
      const p = this.publisher;
      try {
        // On a natural end (queue ran dry) the bank holds the closing
        // seconds of the final clip, already encoded but not yet aired —
        // hand it all to the publisher and let it play out to EOF, or the
        // broadcast ends however-many banked seconds before the ending.
        // On a user stop, responsiveness wins and the tail is dropped.
        const tail = graceful ? (this._bank ?? []) : [];
        this._bank = [];
        this._bankBytes = 0;
        for (const c of tail) p.stdin.write(c.data);
        // Closing stdin lets the publisher flush and close the RTMP session
        // cleanly rather than being cut off mid-packet.
        p.stdin.end();
      } catch { /* already gone */ }
      // Graceful gets time to air the tail at realtime; the timer is only a
      // failsafe against a publisher that never sees EOF.
      const killMs = graceful ? 120_000 : 5000;
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, killMs).unref?.();
    }
  }

  snapshot() {
    return {
      status: this.status,
      playing: this.current
        ? { ...this.current.item, duration: this.current.duration }
        : null,
      queue: [...this.queue],
      position: this.position,
    };
  }

  // ── control — none of these touch the publisher ──────────────────────

  /** Jump within the current clip. Relative unless `absolute` is given. */
  seek({ delta = 0, position = null } = {}) {
    if (!this.current) throw new Error('Nothing playing');

    // Flush first: it rewinds the playhead to what has aired, and a
    // relative skip has to count from there or +30 lands a bankful further
    // ahead than the viewer expects.
    this._bankFlush();
    let next = position != null ? Number(position) : this.position + Number(delta);
    next = Math.max(0, next);
    if (this.current.duration) {
      next = Math.min(next, Math.max(0, this.current.duration - 2));
    }

    // Restart only the source; the publisher and its connection are untouched.
    this._play(this.current.item, next, { duration: this.current.duration });
    this.emit('seeked', { position: next });
    return next;
  }

  pause() {
    if (this.status === 'paused' || !this.current) return;
    this.status = 'paused';
    this._bankFlush();
    // Hold the pipe with a card so the publisher keeps writing and Owncast
    // never sees the ten seconds of silence that would end the broadcast.
    this._spawnHold();
    this.emit('status', this.status);
  }

  resume() {
    if (this.status !== 'paused' || !this.current) return;
    this.status = 'running';
    this._play(this.current.item, this.position, { duration: this.current.duration });
    this.emit('status', this.status);
  }

  /** Change audio or subtitle track, continuing from the same instant. */
  setSelection(selection) {
    this.selection = selection;
    if (this.current && this.status === 'running') {
      const item = this.current.item;
      const dur = this.current.duration;
      // Extract BEFORE swapping, while the current source keeps the pipe
      // fed. Swapping first meant the new source's subtitles filter re-read
      // the whole container at init — on an unextracted file that starved
      // the publisher 13s, past Owncast's 10s deadline, and killed a live
      // broadcast. The switch lands a few seconds later instead; the
      // extraction is cached, so only the first change on a file pays it.
      const tok = (this._selToken = (this._selToken ?? 0) + 1);
      this._extract(item).finally(() => {
        if (this._stopping || this._selToken !== tok) return;
        if (this.current?.item !== item || this.status !== 'running') return;
        // Flush first — it rewinds the playhead to the last aired moment —
        // then read the position, so the new track picks up exactly where
        // the picture is rather than where the encoder had run ahead to.
        this._bankFlush();
        this._play(item, this.position, { duration: dur });
      });
    }
    this.emit('selection', selection);
  }

  setQueue(items) {
    this.queue = [...items];
    this.emit('queue', this.snapshot());
  }

  // ── publisher ────────────────────────────────────────────────────────

  _spawnPublisher() {
    const args = [
      '-hide_banner', '-nostdin',
      // The publisher sets the pace for everything. Sources run as fast as
      // they can and are throttled by pipe backpressure — chunk workers must,
      // since the whole point is finishing ahead of the playhead.
      '-re',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-c', 'copy',
      // FLV's codec ids for AVC and AAC. Copying from MPEG-TS carries the TS
      // stream types across, which the flv muxer rejects.
      '-tag:v', '7', '-tag:a', '10',
      '-muxdelay', '0', '-muxpreload', '0', '-max_interleave_delta', '0',
      '-flvflags', 'no_duration_filesize+no_sequence_end',
      ...(/^rtmps?:\/\//i.test(this.target) ? [] : ['-y']),
      '-f', 'flv', this.target,
    ];

    const startedAt = Date.now();
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.publisher = p;

    // A source dying mid-write must not take the publisher down with it.
    p.stdin.on('error', () => { /* EPIPE while swapping sources */ });

    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = this._redact(d.toString());
      stderr += s;
      if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      this.emit('log', s);
    });

    p.on('close', (code) => {
      const ranMs = Date.now() - startedAt;
      this.publisher = null;
      if (this._watch) { clearInterval(this._watch); this._watch = null; }
      this._killSource();

      const wasStopping = this._stopping;
      this.status = 'stopped';
      this.current = null;
      this.emit('status', this.status);

      if (wasStopping || code === 0) return this.emit('ended', { code });
      if (ranMs < PUBLISH_FAIL_MS) {
        return this.emit('fatal', new Error(
          `The server closed the connection after ${ranMs}ms.\n${lastLines(stderr, 6)}`,
        ));
      }
      this.emit('crashed', { code, stderr: lastLines(stderr, 6) });
    });
  }

  // ── source ───────────────────────────────────────────────────────────

  _killSource() {
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    const s = this.source;
    this.source = null;
    if (!s) return;
    // Unhook first so its exit isn't mistaken for the clip finishing.
    s.stdout?.removeAllListeners?.('data');
    try { s.stdout?.resume?.(); } catch { /* already gone */ }
    try { s.kill('SIGKILL'); } catch { /* already gone */ }
  }

  // ── the bank: bounded elastic buffer feeding the publisher ───────────

  _bankPush(src, chunk) {
    if (this.source !== src) return;   // superseded mid-flight
    this._bank ??= [];
    // Each chunk carries the playhead it was encoded at, so we always know
    // how far viewers have actually got — the encoder runs up to a bank
    // ahead of them, and every restart has to resume from what they saw,
    // not from what was encoded.
    this._bank.push({ data: chunk, pos: this.position, tl: this.timeline });
    this._bankBytes = (this._bankBytes ?? 0) + chunk.length;
    // Backpressure moves from the OS pipe to here: past the cap the source
    // pauses, and resumes once half the bank has aired.
    if (this._bankBytes > this._bankMax && !this._srcPaused) {
      this._srcPaused = true;
      try { src.stdout.pause(); } catch { /* dying */ }
    }
    this._bankDrain();
  }

  _bankDrain() {
    if (this._bankDraining) return;
    const w = this.publisher?.stdin;
    if (!w || !w.writable) return;
    this._bankDraining = true;
    while (this._bank?.length) {
      const c = this._bank.shift();
      this._bankBytes -= c.data.length;
      this.aired = c.pos;
      this.airedTimeline = c.tl;
      let ok = false;
      try { ok = w.write(c.data); } catch { break; /* publisher died mid-write */ }
      if (!ok) {
        w.once('drain', () => {
          this._bankDraining = false;
          this._bankResume();
          this._bankDrain();
        });
        return;
      }
    }
    this._bankDraining = false;
    this._bankResume();
  }

  _bankResume() {
    // Resume as soon as there is meaningful room, not at half empty. Wide
    // hysteresis made the encoder work in long bursts — idle while the bank
    // drained to 50%, then a sprint to refill — and a burst cycle that
    // large shows up in any speed reading as a swing between well under and
    // well over realtime, depending on which phase you sampled. Keeping the
    // bank near full couples the encoder to the publisher's actual
    // consumption, which is what the figure should reflect.
    if (this._srcPaused && (this._bankBytes ?? 0) < this._bankMax * 0.9) {
      this._srcPaused = false;
      try { this.source?.stdout?.resume(); } catch { /* gone */ }
    }
  }

  /**
   * Drop everything encoded but not yet aired, and rewind the playhead to
   * the last moment viewers actually saw.
   *
   * Called on every user-visible jump — seek, track change, pause — so the
   * action takes effect now rather than after the bank plays out. The
   * rewind is the half that is easy to forget: discarding the bank throws
   * away real content, so without moving the playhead back to `aired` the
   * next source resumes a bankful LATER than the picture, and viewers see
   * the stream jump forward by however many seconds were buffered. That is
   * the "changing subtitles skips a few seconds" cut.
   */
  _bankFlush() {
    this._bank = [];
    this._bankBytes = 0;
    if (this.aired != null && this.aired < this.position) {
      this.position = this.aired;
    }
    // The OUTPUT timeline has to rewind with it. `timeline` counts encoded
    // seconds, and -output_ts_offset starts each source from it — so after
    // discarding a bankful, a timeline left at the encoded value hands the
    // publisher a stream whose timestamps jump forward by exactly the
    // discarded amount. The content gap and the timestamp gap are two
    // halves of the same mistake; the local-file playout test catches this
    // one as an unreadable output.
    if (this.airedTimeline != null && this.airedTimeline < this.timeline) {
      this.timeline = this.airedTimeline;
    }
    this._bankResume();
  }

  /** Start (or restart) the source at a given offset within a clip. */
  _play(item, offset = 0, { duration = null } = {}) {
    this._killSource();
    this.holding = false;
    this.current = { item, offset, duration: duration ?? item.duration ?? null };
    this.position = offset;

    const cached = this._cachedSubs(item.srcPath);
    const clipDuration = this.current.duration;
    const v = this.selection?.video;
    if (v) {
      const rect = contentRect(v, this.profile);
      this.emit('log', `[geometry] source ${v.width}x${v.height} sar=${v.sar ?? '?'} `
        + `dar=${v.dar ?? '?'} fps=${v.frameRate ?? '?'}${v.hdr ? ' HDR' : ''} `
        + `-> rect ${rect.w}x${rect.h} @${rect.x},${rect.y}`
        + `${rect.bars ? ' (pillarboxed)' : ''}\n`);
    }

    // Several encodes at once when one process cannot keep up. Only worth it
    // when subtitles are being burned — that is what pins the pipeline to a
    // single core.
    const workers = Number(this.profile?.parallelChunks ?? 1);
    if (workers > 1 && this.selection?.subtitle) {
      this._playChunked(item, offset, cached, workers);
      this.emit('nowplaying', this.snapshot());
      this._fillDuration(item);
      return;
    }

    const args = buildSourceArgs({
      srcPath: item.srcPath,
      offset,
      profile: this.profile,
      selection: this.selection,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
      extractedPath: cached?.path ?? null,
      fontsDir: cached?.fontsDir ?? null,
      duration: clipDuration,
    });

    this._spawnSource(args, { kind: 'clip' });
    if (this.queue[0]) { this._warm(this.queue[0]); this._extract(this.queue[0]); }
    this.emit('nowplaying', this.snapshot());

    this._fillDuration(item);
  }

  /**
   * Duration drives seek clamping and the progress bar. The filesystem
   * provider cannot supply it without probing every file during browsing, so
   * fill it in for whatever is actually playing.
   */
  _fillDuration(item) {
    if (this.current?.duration != null) return;
    probeDuration(item.srcPath)
      .then((d) => {
        if (this.current?.item === item) {
          this.current.duration = d;
          if (this.scheduler) this.scheduler.duration = d;
          this.emit('nowplaying', this.snapshot());
        }
      })
      .catch(() => { /* seek simply stays unclamped */ });
  }

  /** Encode this clip as parallel chunks fed to the publisher in order. */
  _playChunked(item, offset, cached, workers) {
    this._clipBase = this.timeline;
    const chunkSeconds = Number(this.profile?.chunkSeconds ?? 20);

    const sched = new ChunkScheduler({
      srcPath: item.srcPath,
      startOffset: offset,
      duration: this.current.duration,
      chunkSeconds,
      workers,
      workDir: join(this.cacheDir ?? '/tmp', `chunks-${process.pid}`),
      buildArgs: ({ start, dur, out }) => buildChunkArgs({
        srcPath: item.srcPath,
        start,
        dur,
        out,
        profile: this.profile,
        selection: this.selection,
        // Absolute placement, so chunks finishing out of order still land in
        // the right place on the timeline.
        tsOffset: this._clipBase + (start - offset),
        extractedPath: cached?.path ?? null,
        fontsDir: cached?.fontsDir ?? null,
      }),
    });

    sched.on('warn', (m) => this.emit('warn', m));
    sched.on('chunk', ({ start }) => {
      // Position is where the newest delivered chunk begins; the publisher is
      // still paying it out, so this leads the viewer by up to one chunk.
      this.position = start;
      this.timeline = this._clipBase + (start - offset) + chunkSeconds;
      this.emit('progress', { position: this.position, speed: null, drops: 0 });
    });
    sched.on('complete', () => {
      if (this.scheduler === sched) this._advance();
    });

    this.scheduler = sched;
    if (this.publisher?.stdin.writable) sched.start(this.publisher.stdin);
  }

  /**
   * Pull the head of a file through the page cache so the source's open and
   * probe are fast. Fire-and-forget for upcoming clips; awaited once for the
   * very first clip before the RTMP connection exists.
   */
  async _warm(item) {
    if (!item?.srcPath || this._warmed?.has(item.srcPath)) return;
    (this._warmed ??= new Set()).add(item.srcPath);
    const t0 = Date.now();
    try {
      const { createReadStream } = await import('fs');
      await new Promise((resolve) => {
        const rs = createReadStream(item.srcPath, { start: 0, end: 48 * 1024 * 1024 });
        rs.on('data', () => {});
        rs.on('end', resolve);
        rs.on('error', resolve);
        setTimeout(() => { rs.destroy(); resolve(); }, 25_000).unref?.();
      });
      this.emit('log', `[warm] ${item.title ?? item.srcPath} head read in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    } catch { /* warming is best-effort */ }
  }

  _subKey(srcPath) {
    const sub = this.selection?.subtitle;
    return sub && !sub.external ? `${srcPath}:${sub.typeIndex}` : null;
  }

  _cachedSubs(srcPath) {
    const k = this._subKey(srcPath);
    return k ? this._subCache.get(k) ?? null : null;
  }

  /**
   * Pull the chosen subtitle track and any embedded fonts out to small files.
   *
   * Done before the source starts, because pointing the filter at the media
   * file costs a second full demux of a multi-gigabyte episode.
   */
  async prepare(item) {
    // Never blocks: extraction runs in the background and the clip simply
    // uses whatever is cached by the time it spawns.
    this._extract(item);
  }

  /**
   * Background-extract the chosen subtitle track (and fonts) to small files.
   *
   * Reading subtitles from the mkv makes ffmpeg demux the WHOLE container a
   * second time, in parallel with playback, over the network — measured at
   * a 24% throughput cost on a Bluray remux. Extraction reads the file once
   * during the PREVIOUS clip's playback, so from the second episode onward
   * the subtitle source is a kilobyte-sized local file. The first episode of
   * a session still reads from the mkv rather than delaying go-live.
   */
  _extract(item) {
    const sub = this.selection?.subtitle;
    const key = this._subKey(item?.srcPath);
    if (!key || !this.cacheDir) return Promise.resolve(null);
    if (this._subCache.has(key)) return Promise.resolve(this._subCache.get(key));
    this._extracting ??= new Map();
    if (this._extracting.has(key)) return this._extracting.get(key);

    const t0 = Date.now();
    // Extraction progress doubles as the "Preparing" progress bar: out_time
    // is the position in the movie's timeline the demux has reached, so the
    // familiar seek strip fills while the one-time read runs. Only wired to
    // the UI when THIS item is what the broadcast is waiting on — background
    // extraction of the next episode stays silent.
    let lastBeat = 0;
    let lastLog = 0;
    const onProgress = (sec) => {
      if (this.status !== 'preparing' || this.current?.item !== item) return;
      this.position = sec;
      const now = Date.now();
      if (now - lastBeat < 3000) return;
      lastBeat = now;
      this.emit('nowplaying', this.snapshot());
      const dur = this.current?.duration;
      if (dur > 0 && now - lastLog > 30_000) {
        lastLog = now;
        this.emit('log', `[subs] extracting… ${Math.min(100, (sec / dur) * 100).toFixed(0)}%\n`);
      }
    };
    const p = Promise.all([
      extractSubtitle(item.srcPath, sub, this.cacheDir, onProgress),
      extractFonts(item.srcPath, this.cacheDir),
    ]).then(([path, fontsDir]) => {
      if (!path) return null;
      const entry = { path, fontsDir };
      this._subCache.set(key, entry);
      this.emit('log', `[subs] extracted for ${item.title ?? item.srcPath} `
        + `in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      return entry;
    }).catch(() => null)
      .finally(() => this._extracting.delete(key));
    this._extracting.set(key, p);
    return p;
  }

  /**
   * Whether going live must wait for extraction: an embedded text subtitle
   * with no cached copy. External subs are already small files, and bitmap
   * subs are composited from the main input, so neither pays the in-band
   * second read that makes waiting necessary.
   */
  _needsExtraction(item) {
    const sub = this.selection?.subtitle;
    const key = this._subKey(item?.srcPath);
    return Boolean(key && this.cacheDir
      && isExtractable(sub)
      && !this._subCache.has(key));
  }

  /** Black card on the pipe, so a pause doesn't starve the publisher. */
  _spawnHold(label = 'Paused') {
    this._killSource();
    this.holding = true;
    this._spawnSource(buildHoldArgs({
      profile: this.profile,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
      label,
    }), { kind: 'hold' });
  }

  _spawnSource(args, { kind }) {
    this.emit('log', `[spawn:${kind}] ffmpeg ${args.join(' ')}\n`);
    // Backpressure state is per-process: carrying a stale `paused` flag into
    // a new source means the bank cap is never applied to it again.
    this._srcPaused = false;
    this._sawBlock = false;
    this._lastBlockAt = Date.now();
    const startedAt = Date.now();
    // fd 3 carries -progress so it doesn't fight stderr for the log stream.
    const s = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    this.source = s;

    // Through the bank, not a direct pipe — see BANK_MAX_BYTES.
    s.stdout.on('data', (d) => this._bankPush(s, d));

    const parser = new ProgressParser();
    const startOffset = kind === 'clip' ? (this.current?.offset ?? 0) : 0;
    let lastOut = 0;
    // Encoding slower than realtime starves the pipe. Owncast ends the
    // broadcast after ten seconds of silence, so this is fatal if sustained —
    // and dying without saying why is the worst version of it.
    let slowSince = null;
    let warnedSlow = false;
    // ffmpeg's own `speed=` is cumulative — encoded time over wall time since
    // the process started — so every startup cost (opening a 50 GiB remux,
    // filter and GPU init) is averaged in forever and the figure only creeps
    // up as it is diluted. That reads as "the machine is warming up" when
    // nothing is warming up. Derive the instantaneous rate from consecutive
    // progress blocks instead, lightly smoothed so it is readable.
    // Samples of (wall clock, encoded position). A rolling average over a
    // window is both steadier to read and still honest — unlike ffmpeg's
    // own cumulative figure, a bad first minute stops counting once it
    // leaves the window.
    const samples = [];
    /** Mean encode rate over roughly the last `ms`, or null if too new. */
    const rateOver = (ms, wall, out) => {
      let i = samples.length - 1;
      while (i > 0 && wall - samples[i].wall < ms) i -= 1;
      const span = wall - samples[i].wall;
      if (span < 900) return null;
      return (out - samples[i].out) / (span / 1000);
    };

    parser.on('block', (b) => {
      if (b.outTimeUs == null) return;
      this._lastBlockAt = Date.now();
      this._sawBlock = true;
      if (this.status === 'starting') {
        this.status = 'running';
        this.emit('status', this.status);
      }
      const out = b.outTimeUs / 1e6;
      // Advance the published timeline by real progress, so the next source
      // continues rather than rewinding.
      this.timeline += Math.max(0, out - lastOut);
      lastOut = out;
      if (kind === 'clip') {
        this.position = startOffset + out;
        if (this.current?.duration) {
          this.position = Math.min(this.position, this.current.duration);
        }
      }

      const wall = Date.now();
      samples.push({ wall, out });
      while (samples.length > 2 && wall - samples[0].wall > SPEED_WINDOW_MS) {
        samples.shift();
      }
      // Shown to the user: a 30s mean. The instantaneous rate swings with
      // every heavy subtitle scene, which is accurate and unreadable.
      // In steady state this sits at ~1.0x by design, not by luck: the
      // publisher paces the output at realtime, so once the pipe is full
      // backpressure throttles the source. Sustained BELOW 1.0 is the
      // problem case; above 1.0 only happens while buffers fill.
      const avg = rateOver(SPEED_WINDOW_MS, wall, out);
      const speed = avg == null ? b.speed : Math.round(avg * 100) / 100;
      // Judged on a shorter window: a 30s mean would take half a minute to
      // notice the stream dying, which is most of Owncast's patience.
      const recent = rateOver(SLOW_WINDOW_MS, wall, out) ?? speed;

      if (kind === 'clip' && recent != null) {
        if (recent < 0.95) {
          slowSince ??= Date.now();
          if (!warnedSlow && Date.now() - slowSince > 8000) {
            warnedSlow = true;
            this.emit('tooslow', { speed: Math.round(recent * 100) / 100 });
            this.emit('warn',
              `Encoding at ${Math.round(recent * 100) / 100}x — slower than realtime, so the stream `
              + 'will stall. Burning subtitles is usually the cause; try a '
              + 'lighter subtitle track, a lower output resolution, or turn '
              + 'subtitles off for this title.');
          }
        } else {
          slowSince = null;
        }
      }

      this.emit('progress', {
        position: this.position, speed, drops: b.dropFrames,
      });
    });
    s.stdio[3]?.on('data', (d) => parser.push(d));

    let stderr = '';
    s.stderr.on('data', (d) => {
      const t = this._redact(d.toString());
      stderr += t;
      if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
    });

    s.on('close', (code) => {
      if (this.source !== s) return;   // superseded by a seek or track change
      this.source = null;
      if (this._stopping || this.status === 'stopped') return;

      if (kind === 'hold') return;     // only ends when we replace it

      const ranMs = Date.now() - startedAt;
      if (code !== 0) {
        const tail = lastLines(stderr, 3);
        // The GPU subtitle composite failing outright (h264_vaapi rejecting
        // every frame) is a driver property, not a file property — the
        // startup probe is supposed to catch it, but a probe that passes on
        // one frame has been wrong about sustained encoding before. The CPU
        // burn path has no such constraint, so demote once and retry the
        // same clip at the same position instead of failing the broadcast.
        if (!this._sawBlock && this.profile?.gpuSubs && this.selection?.subtitle
            && !this._gpuSubsDemoted && this.current) {
          this._gpuSubsDemoted = true;
          // Scope the demotion to what actually failed: the pillarboxed
          // composite failing says nothing about plain 16:9 clips, and
          // demoting everything sent full-HD episodes to the CPU for the
          // rest of the broadcast for no reason.
          if (contentRect(this.selection?.video, this.profile).bars) {
            this.profile.barsFailed = true;
          } else {
            this.profile.gpuSubs = false;
          }
          this.emit('warn', 'GPU subtitle compositing failed on this driver — '
            + `retrying this clip with CPU burn-in. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }
        // A clip that exits with an error before producing a single frame
        // did not "finish" — it failed. Advancing here turns one broken
        // filtergraph into a silent march through the whole queue, each
        // episode dying identically. One bad file among good ones is still
        // skipped (the second failure in a row stops the broadcast).
        if (!this._sawBlock) {
          this._deadClips = (this._deadClips ?? 0) + 1;
          if (this._deadClips >= 2) {
            this.emit('fatal', new Error(
              `Two clips in a row produced no output (last: exit ${code} — ${tail}). `
              + 'Stopping instead of burning through the queue.',
            ));
            this.stop();
            return;
          }
          this.emit('warn', `could not play ${item(this)}: ${tail}`);
          this._advance();
          return;
        }
        if (ranMs < SOURCE_FAIL_MS) {
          this.emit('warn', `could not play ${item(this)}: ${tail}`);
        } else if (tail) {
          this.emit('log', `[source exit ${code} after ${(ranMs / 1000).toFixed(1)}s] ${tail}\n`);
        }
      } else if (this._sawBlock) {
        this._deadClips = 0;
      }
      this._advance();
    });
  }

  /** Move to the next queued clip, or end the broadcast. */
  _advance() {
    const next = this.queue.shift();
    if (!next) {
      this.emit('queue-empty');
      this.stop({ graceful: true });
      return;
    }
    this.emit('queue', this.snapshot());

    // A second advance (or a stop) while this one waits must win.
    const token = (this._advanceToken = (this._advanceToken ?? 0) + 1);
    const stale = () => this._stopping || this._advanceToken !== token;

    // Extraction for the next clip normally finishes during the previous
    // one's playback — but a skip can arrive minutes before that, and
    // playing anyway would burn subtitles straight from the container: the
    // exact stall that makes large files unplayable. Hold the pipe with a
    // card instead. The publisher keeps writing, so Owncast never notices,
    // and the wait is visible rather than a mystery.
    if (this._needsExtraction(next)) {
      this.current = { item: next, offset: 0, duration: next.duration ?? null };
      this.position = 0;
      this.status = 'preparing';
      this._spawnHold('Preparing subtitles');
      this.emit('status', this.status);
      this.emit('nowplaying', this.snapshot());
      this._extract(next).finally(() => {
        if (stale()) return;
        this.status = 'starting';
        this.emit('status', this.status);
        this._play(next, 0);
      });
      return;
    }

    this.prepare(next).finally(() => {
      if (stale()) return;
      this._play(next, 0);
    });
  }

  /**
   * Abandon the clip on air and start the next one.
   *
   * Only the source restarts, exactly as at a normal clip boundary, so the
   * RTMP connection and the viewers' session survive. Refused when nothing
   * is queued — there is no "next" to skip to, and silently ending the
   * broadcast is not what a skip button means.
   *
   * @returns {boolean} whether the skip happened
   */
  skip() {
    if (!this.publisher || this._stopping) return false;
    if (!this.current || !this.queue.length) return false;

    this.emit('log', `[skip] ${this.current.item?.title ?? 'current clip'}\n`);
    // Skipping while paused resumes on the next clip: leaving the engine
    // "paused" while content actually plays would make every later control
    // lie about what is happening.
    if (this.status === 'paused') {
      this.status = 'starting';
      this.emit('status', this.status);
    }
    this._bankFlush();
    this._advance();
    return true;
  }

  _redact(text) {
    if (!text) return text;
    if (!/^rtmps?:\/\//i.test(String(this.target))) return text;
    const key = String(this.target).split('/').pop();
    if (!key || key.length < 4) return text;
    return text.split(key).join('*'.repeat(8));
  }
}

const item = (self) => self.current?.item?.title ?? 'clip';

/**
 * Source: decode → software filters → hardware encode → MPEG-TS on stdout.
 *
 * `-re` lives here because this is what sets the pace; the publisher must not
 * pace as well or it starves.
 */
export function buildSourceArgs({
  srcPath, offset = 0, profile, selection = null, tsOffset = 0, statsPeriodMs = 500,
  hwDecode = null, extractedPath = null, fontsDir = null, duration = null,
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath,
    { extractedPath, fontsDir });
  const audioIdx = selection?.audio?.typeIndex ?? 0;
  // Source-rate matching applies to every path, not just the GPU one —
  // duplicating 24fps to 30 is wasted work and judder wherever it happens.
  const effAll = effectiveFps(selection?.video, profile);
  const profEff = { ...profile, fps: effAll.fps };
  const base = scaleFilter(profEff).replace(`fps=${effAll.fps}`, `fps=${effAll.rate}`);
  const upload = be.uploadFilter(profEff);

  // Fixed-function chain for clips WITHOUT burned subtitles. This used to
  // exist only when subtitles forced it, which left subtitle-free 4K films
  // software-decoding on the CPU at 0.6x while the GPU sat idle.
  if (profile.gpuFull && !sub.filter && !sub.needsComplex) {
    const rect = contentRect(selection?.video, profile);
    const smode = (selection?.video?.width ?? 0) >= rect.w * 1.5 ? ':mode=fast' : '';
    const scalePart = selection?.video?.hdr
      ? `scale_vaapi=w=${rect.w}:h=${rect.h}${smode},`
        + 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'
      : `scale_vaapi=w=${rect.w}:h=${rect.h}:format=nv12${smode}`;
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va',
      '-extra_hw_frames', '8',
      ...(offset > 0 ? ['-ss', Number(offset).toFixed(3)] : []),
      '-i', srcPath,
      '-vf', rect.bars
        ? `${scalePart},pad_vaapi=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`
        : scalePart,
      '-map', '0:v:0', '-map', `0:a:${audioIdx}?`,
      ...be.encoderArgs(profEff),
      '-async_depth', '4',
      ...audioArgs(profile),
      '-r', effAll.rate, '-fps_mode', 'cfr',
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
      '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
      '-f', 'mpegts', 'pipe:1',
    ];
  }

  // Full-GPU path: decode, scale, composite and encode all stay on the GPU,
  // and the CPU renders subtitle alpha frames and nothing else. Measured on
  // the N100 this is the difference between 0.85x (unstreamable) and 1.56x.
  // Text subtitles only; requires the driver to honour overlay alpha, which
  // the caller establishes with vaapiAlphaHonored() before setting gpuSubs.
  if (profile.gpuSubs && sub.filter && !sub.needsComplex
      // barsFailed: the pillarboxed composite died live on this driver, so
      // only clips that need bars take the CPU path; 16:9 stays on the GPU.
      && !(profile.barsFailed && contentRect(selection?.video, profile).bars)) {
    // The canvas is an infinite generated input. Without bounding it, the
    // process NEVER exits when the episode ends — it idles on the canvas
    // forever, _advance() never fires, and the next episode never starts.
    // Reproduced deterministically. Two belts: cap the canvas at the clip
    // duration when known, and -shortest so output ends with the main input.
    const canvasCap = duration != null && duration > 0
      ? ['-t', (Math.max(1, duration - offset) + 5).toFixed(3)]
      : [];
    // Subtitles are rendered at the video's content rectangle, then the
    // composite is placed onto a black frame — positioned ASS for 4:3
    // content lands where the author put it instead of smearing toward the
    // pillarbox bars of the 16:9 output.
    const rect = contentRect(selection?.video, profile);
    const eff = effAll;
    const shift = Number(offset).toFixed(3);
    // HDR sources must be tone-mapped to BT.709 or the SDR stream comes out
    // washed. Fixed-function on Intel VPP, and placed AFTER the scale so it
    // runs at output size, not 4K.
    // mode=fast selects the faster VPP scaler; at a 2:1 downscale (4K to
    // 1080p) the output is visually identical and the EU cost drops.
    const smode = (selection?.video?.width ?? 0) >= rect.w * 1.5 ? ':mode=fast' : '';
    const scalePart = selection?.video?.hdr
      ? `scale_vaapi=w=${rect.w}:h=${rect.h}${smode},`
        + 'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709'
      // format=nv12 is load-bearing: 10-bit sources decode to P010 surfaces,
      // and h264_vaapi accepts only NV12 — without the GPU-side conversion
      // the encoder dies with -22 (Invalid argument) on every 10-bit file.
      : `scale_vaapi=w=${rect.w}:h=${rect.h}:format=nv12${smode}`;
    // The subtitle canvas is always rendered at the video's content
    // rectangle, so ASS positioning is authored-correct; only how that
    // composite gets placed into a pillarboxed output frame varies.
    //
    // Without bars there is one proven shape: scale -> overlay -> encode.
    // WITH bars, every arrangement of pad_vaapi and overlay_vaapi that
    // seemed obviously correct failed on some driver — silently wrong
    // pixels on Mesa (pad_vaapi leaving green bars), a hard
    // `h264_vaapi -22` on Intel iHD. So the shape is not chosen here: the
    // caller probes the actual device (pickPillarboxGraph) and passes the
    // winner, or falls back to the CPU path when the driver can do none.
    const pad = `pad_vaapi=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`;
    const at = `=x=${rect.x}:y=${rect.y}`;
    // Padding the alpha canvas costs one RGBA frame of CPU memcpy and lets
    // the composite land at 0,0 for drivers that dislike an offset overlay.
    const widePad = `,pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black@0.0`;

    let canvasPad = '';
    let bgInput = [];
    let videoChain;
    let composite;
    if (!rect.bars) {
      videoChain = scalePart;
      composite = '[b][ov]overlay_vaapi[v]';
    } else {
      switch (profile.barsGraph) {
        case 'wide-canvas':
          canvasPad = widePad;
          videoChain = `${scalePart},${pad}`;
          composite = '[b][ov]overlay_vaapi[v]';
          break;
        case 'overlay-pad':
          videoChain = scalePart;
          composite = `[b][ov]overlay_vaapi,${pad}[v]`;
          break;
        case 'overlay-scale-pad':
          videoChain = scalePart;
          composite = `[b][ov]overlay_vaapi,${scalePart},${pad}[v]`;
          break;
        case 'bg-composite':
          videoChain = scalePart;
          composite = `[b][ov]overlay_vaapi[vs];[2:v]hwupload[bg];`
            + `[bg][vs]overlay_vaapi${at}[v]`;
          bgInput = ['-f', 'lavfi', ...canvasCap, '-i',
            `color=c=black:s=${profile.width}x${profile.height}:r=${eff.rate},format=nv12`];
          break;
        case 'pad-overlay':
        default:
          videoChain = `${scalePart},${pad}`;
          composite = `[b][ov]overlay_vaapi${at}[v]`;
          break;
      }
    }

    const graph = `[1:v]setpts=PTS+${shift}/TB,${sub.filter}:alpha=1,`
      + `setpts=PTS-STARTPTS,format=rgba${canvasPad},hwupload[ov];`
      + `[0:v]${videoChain}[b];${composite}`;
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va',
      // Extra decode surfaces let decode run ahead of scale/encode instead
      // of lock-stepping — pipelining, not quality.
      '-extra_hw_frames', '8',
      ...(offset > 0 ? ['-ss', shift] : []),
      '-i', srcPath,
      '-f', 'lavfi', ...canvasCap,
      '-i', `color=c=black@0.0:s=${rect.w}x${rect.h}:r=${eff.rate},format=rgba`,
      ...bgInput,
      '-filter_complex', graph,
      '-map', '[v]', '-map', `0:a:${audioIdx}?`, '-shortest',
      ...be.encoderArgs({ ...profile, fps: eff.fps }),
      // Deeper encoder queue overlaps encode with upstream stages.
      '-async_depth', '4',
      ...audioArgs(profile),
      '-r', eff.rate, '-fps_mode', 'cfr',
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
      '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
      '-f', 'mpegts', 'pipe:1',
    ];
  }

  // Subtitles must be burned between scale and pad — on the padded frame,
  // positioned subs for narrow content drift toward the bars.
  const rect = contentRect(selection?.video, profile);
  // Input-side -ss resets frame timestamps to zero, and the subtitles
  // filter picks events by timestamp — without re-shifting, every restart
  // mid-episode (seek, track change, watchdog respawn) burned subtitles
  // from the episode's BEGINNING over video at the restart position. The
  // GPU path has always carried this shift on its canvas; this is the CPU
  // path's equivalent.
  const cpuChain = sub.filter
    ? [
      `scale=${rect.w}:${rect.h},setsar=1`,
      ...(offset > 0 ? [`setpts=PTS+${Number(offset).toFixed(3)}/TB`] : []),
      `${sub.filter}:alpha=0`,
      ...(offset > 0 ? ['setpts=PTS-STARTPTS'] : []),
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${effAll.rate}`,
      upload,
    ]
    : [base, upload];

  const filterArgs = sub.needsComplex
    ? [
      // Bitmap subtitles (DVD/PGS subpictures) carry pixel positions in the
      // SOURCE frame's coordinate space. Compositing after scale+pad placed
      // them at source coordinates on the padded 1080p frame — upper-left,
      // wrong size. Overlay at native size first; scaling then carries the
      // subtitles along with the picture.
      '-filter_complex',
      `[0:v:0][${sub.overlayInput}]overlay[s];[s]${base}[o];[o]${upload}[v]`,
      '-map', '[v]',
    ]
    : [
      '-vf', cpuChain.filter(Boolean).join(','),
      '-map', '0:v:0',
    ];

  // Hardware decode without -hwaccel_output_format, so frames land back in
  // system memory ready for the software filters. libass cannot touch GPU
  // frames, and a manual hwdownload round-trip would cost more than it saves.
  // Worth most on weak CPUs with 10-bit HEVC, where software decode dominates.
  const useHw = hwDecode ?? profile.hwDecode ?? false;
  const decodeArgs = useHw
    ? ['-hwaccel', 'vaapi', '-hwaccel_device', profile.device ?? '/dev/dri/renderD128']
    : [];

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...be.deviceArgs(profile),
    ...decodeArgs,
    // Input-side seek: fast, and the only form that skips decoding work.
    ...(offset > 0 ? ['-ss', Number(offset).toFixed(3)] : []),
    '-i', srcPath,
    ...filterArgs,
    '-map', `0:a:${audioIdx}?`,
    ...be.encoderArgs(profEff),
    ...audioArgs(profile),
    // Continue the published timeline instead of restarting at zero.
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-fps_mode', 'cfr',
    '-muxdelay', '0', '-muxpreload', '0',
    '-mpegts_flags', '+resend_headers',
    '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
    '-f', 'mpegts', 'pipe:1',
  ];
}

/**
 * One chunk of a clip, encoded to a file. Same filters as the streaming
 * source; the difference is a bounded range and a file output, so several can
 * run at once.
 */
export function buildChunkArgs({
  srcPath, start, dur, out, profile, selection = null, tsOffset = 0,
  extractedPath = null, fontsDir = null,
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath,
    { extractedPath, fontsDir });
  const audioIdx = selection?.audio?.typeIndex ?? 0;
  // Source-rate matching applies to every path, not just the GPU one —
  // duplicating 24fps to 30 is wasted work and judder wherever it happens.
  const effAll = effectiveFps(selection?.video, profile);
  const profEff = { ...profile, fps: effAll.fps };
  const base = scaleFilter(profEff).replace(`fps=${effAll.fps}`, `fps=${effAll.rate}`);
  const upload = be.uploadFilter(profEff);

  // Subtitles must be burned between scale and pad — on the padded frame,
  // positioned subs for narrow content drift toward the bars.
  const rect = contentRect(selection?.video, profile);
  // Same timestamp correction as the streaming path: chunks start at -ss
  // `start`, so subtitle timestamps must be shifted to match.
  const cpuChain = sub.filter
    ? [
      `scale=${rect.w}:${rect.h},setsar=1`,
      ...(start > 0 ? [`setpts=PTS+${Number(start).toFixed(3)}/TB`] : []),
      `${sub.filter}:alpha=0`,
      ...(start > 0 ? ['setpts=PTS-STARTPTS'] : []),
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${effAll.rate}`,
      upload,
    ]
    : [base, upload];

  const filterArgs = sub.needsComplex
    ? [
      // Bitmap subtitles (DVD/PGS subpictures) carry pixel positions in the
      // SOURCE frame's coordinate space. Compositing after scale+pad placed
      // them at source coordinates on the padded 1080p frame — upper-left,
      // wrong size. Overlay at native size first; scaling then carries the
      // subtitles along with the picture.
      '-filter_complex',
      `[0:v:0][${sub.overlayInput}]overlay[s];[s]${base}[o];[o]${upload}[v]`,
      '-map', '[v]',
    ]
    : [
      '-vf', cpuChain.filter(Boolean).join(','),
      '-map', '0:v:0',
    ];

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...be.deviceArgs(profile),
    '-ss', Number(start).toFixed(3),
    '-i', srcPath,
    '-t', Number(dur).toFixed(3),
    ...filterArgs,
    '-map', `0:a:${audioIdx}?`,
    ...be.encoderArgs(profile),
    ...audioArgs(profile),
    // Absolute placement on the output timeline. This is what lets chunks be
    // produced out of order and still join exactly.
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-fps_mode', 'cfr',
    '-muxdelay', '0', '-muxpreload', '0',
    '-mpegts_flags', '+resend_headers',
    '-f', 'mpegts', out,
  ];
}

/** Hold card, matching the output profile so the publisher sees no change. */
export function buildHoldArgs({
  profile, tsOffset = 0, statsPeriodMs = 500, label = 'Paused',
}) {
  const gop = String((profile.gopSeconds ?? 2) * (profile.fps ?? 30));
  const text = String(label).replace(/[\\':]/g, '');

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // -re here even though pacing lives on the publisher: black frames are so
    // small that unpaced output lets MINUTES of hold-card fit in the pipe
    // buffers, and on resume all of it plays out before the episode returns.
    '-re',
    '-f', 'lavfi', '-i', `color=c=black:s=${profile.width}x${profile.height}:r=${profile.fps}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', `drawtext=fontfile=${HOLD_FONT}:text='${text}':fontcolor=white:`
      + 'fontsize=h/18:x=(w-text_w)/2:y=(h-text_h)/2',
    // Software x264: the hold has to work even when hardware encoding is what
    // broke, and it costs nothing on a black frame.
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v', profile.videoBitrate, '-maxrate', profile.videoBitrate,
    '-bufsize', profile.videoBitrate,
    '-g', gop, '-keyint_min', gop, '-sc_threshold', '0', '-bf', '0',
    '-c:a', 'aac', '-b:a', profile.audioBitrate ?? '160k', '-ar', '48000', '-ac', '2',
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
    '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
    '-f', 'mpegts', 'pipe:1',
  ];
}

const HOLD_FONT = '/usr/share/fonts/TTF/DejaVuSans.ttf';

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}
