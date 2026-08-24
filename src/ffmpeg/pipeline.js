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
import { extractSubtitle, extractFonts } from './subcache.js';
import { ChunkScheduler } from './chunker.js';

/** Treat a source that dies this fast as broken rather than finished. */
const SOURCE_FAIL_MS = 2_000;
/** Publisher exiting this fast means the RTMP target rejected us. */
const PUBLISH_FAIL_MS = 5_000;

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
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(items = []) {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!items.length) throw new Error('Nothing to play');

    this.queue = [...items];
    this._stopping = false;
    this._spawnPublisher();

    const first = this.queue.shift();
    await this.prepare(first);
    this._play(first, 0);
    this.status = 'running';
    this.emit('status', this.status);

    this._lastBlockAt = Date.now();
    this._watch = setInterval(() => this._checkHealth(), 2000);
    this._watch.unref?.();
  }

  _checkHealth() {
    if (this.status !== 'running' || !this.source) return;
    const silent = Date.now() - (this._lastBlockAt ?? Date.now());
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

    // Owncast drops the broadcast after 10s of socket silence, so recovery
    // has to move before that. Respawning the source at the current position
    // is cheap and the publisher keeps the connection.
    const now = Date.now();
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

  stop() {
    this._stopping = true;
    this._killSource();
    if (this.publisher) {
      // Closing stdin lets the publisher flush and close the RTMP session
      // cleanly rather than being cut off mid-packet.
      try { this.publisher.stdin.end(); } catch { /* already gone */ }
      const p = this.publisher;
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, 5000).unref?.();
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
      const pos = this.position;
      const dur = this.current.duration;
      this.prepare(item).finally(() => this._play(item, pos, { duration: dur }));
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
    s.stdout?.unpipe?.();
    try { s.kill('SIGKILL'); } catch { /* already gone */ }
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
        + `dar=${v.dar ?? '?'} -> rect ${rect.w}x${rect.h} @${rect.x},${rect.y}`
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
    const sub = this.selection?.subtitle;
    const key = this._subKey(item.srcPath);
    if (!key || !this.cacheDir || this._subCache.has(key)) return;
    // Off by default: extraction reads the whole file, which on a network
    // mount costs minutes before playback can start, for a gain that measured
    // at 6%. Enable only where the benchmark shows it pays.
    if (!this.profile?.extractSubtitles) return;

    try {
      const [path, fontsDir] = await Promise.all([
        extractSubtitle(item.srcPath, sub, this.cacheDir),
        extractFonts(item.srcPath, this.cacheDir),
      ]);
      if (path) this._subCache.set(key, { path, fontsDir });
    } catch {
      // Falling back to reading from the media file is slower, not broken.
    }
  }

  /** Black card on the pipe, so a pause doesn't starve the publisher. */
  _spawnHold() {
    this._killSource();
    this.holding = true;
    this._spawnSource(buildHoldArgs({
      profile: this.profile,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
    }), { kind: 'hold' });
  }

  _spawnSource(args, { kind }) {
    this.emit('log', `[spawn:${kind}] ffmpeg ${args.join(' ')}\n`);
    const startedAt = Date.now();
    // fd 3 carries -progress so it doesn't fight stderr for the log stream.
    const s = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    this.source = s;

    if (this.publisher?.stdin.writable) {
      // end:false is essential — the publisher must survive this source.
      s.stdout.pipe(this.publisher.stdin, { end: false });
    }

    const parser = new ProgressParser();
    const startOffset = kind === 'clip' ? (this.current?.offset ?? 0) : 0;
    let lastOut = 0;
    // Encoding slower than realtime starves the pipe. Owncast ends the
    // broadcast after ten seconds of silence, so this is fatal if sustained —
    // and dying without saying why is the worst version of it.
    let slowSince = null;
    let warnedSlow = false;

    parser.on('block', (b) => {
      if (b.outTimeUs == null) return;
      this._lastBlockAt = Date.now();
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

      if (kind === 'clip' && b.speed != null) {
        if (b.speed < 0.95) {
          slowSince ??= Date.now();
          if (!warnedSlow && Date.now() - slowSince > 8000) {
            warnedSlow = true;
            this.emit('tooslow', { speed: b.speed });
            this.emit('warn',
              `Encoding at ${b.speed}x — slower than realtime, so the stream `
              + 'will stall. Burning subtitles is usually the cause; try a '
              + 'lighter subtitle track, a lower output resolution, or turn '
              + 'subtitles off for this title.');
          }
        } else {
          slowSince = null;
        }
      }

      this.emit('progress', {
        position: this.position, speed: b.speed, drops: b.dropFrames,
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
      if (code !== 0 && ranMs < SOURCE_FAIL_MS) {
        this.emit('warn', `could not play ${item(this)}: ${lastLines(stderr, 3)}`);
      }
      this._advance();
    });
  }

  /** Move to the next queued clip, or end the broadcast. */
  _advance() {
    const next = this.queue.shift();
    if (!next) {
      this.emit('queue-empty');
      this.stop();
      return;
    }
    this.prepare(next).finally(() => this._play(next, 0));
    this.emit('queue', this.snapshot());
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
  const base = scaleFilter(profile);
  const upload = be.uploadFilter(profile);

  // Full-GPU path: decode, scale, composite and encode all stay on the GPU,
  // and the CPU renders subtitle alpha frames and nothing else. Measured on
  // the N100 this is the difference between 0.85x (unstreamable) and 1.56x.
  // Text subtitles only; requires the driver to honour overlay alpha, which
  // the caller establishes with vaapiAlphaHonored() before setting gpuSubs.
  if (profile.gpuSubs && sub.filter && !sub.needsComplex) {
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
    const shift = Number(offset).toFixed(3);
    const subChain = `[1:v]setpts=PTS+${shift}/TB,${sub.filter}:alpha=1,`
      + `setpts=PTS-STARTPTS,format=rgba,hwupload[ov];`
      + `[0:v]scale_vaapi=w=${rect.w}:h=${rect.h}[b];[b][ov]overlay_vaapi`;
    const graph = rect.bars
      ? `${subChain}[vs];[2:v]hwupload[bg];[bg][vs]overlay_vaapi=x=${rect.x}:y=${rect.y}[v]`
      : `${subChain}[v]`;
    const bgInput = rect.bars
      ? ['-f', 'lavfi', ...canvasCap,
        '-i', `color=c=black:s=${profile.width}x${profile.height}:r=${profile.fps},format=nv12`]
      : [];
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
      '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va',
      ...(offset > 0 ? ['-ss', shift] : []),
      '-i', srcPath,
      '-f', 'lavfi', ...canvasCap,
      '-i', `color=c=black@0.0:s=${rect.w}x${rect.h}:r=${profile.fps},format=rgba`,
      ...bgInput,
      '-filter_complex', graph,
      '-map', '[v]', '-map', `0:a:${audioIdx}?`, '-shortest',
      ...be.encoderArgs(profile),
      ...audioArgs(profile),
      '-r', String(profile.fps), '-fps_mode', 'cfr',
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', '+resend_headers',
      '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
      '-f', 'mpegts', 'pipe:1',
    ];
  }

  // Subtitles must be burned between scale and pad — on the padded frame,
  // positioned subs for narrow content drift toward the bars.
  const rect = contentRect(selection?.video, profile);
  const cpuChain = sub.filter
    ? [
      `scale=${rect.w}:${rect.h},setsar=1`,
      `${sub.filter}:alpha=0`,
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${profile.fps}`,
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
    ...be.encoderArgs(profile),
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
  const base = scaleFilter(profile);
  const upload = be.uploadFilter(profile);

  // Subtitles must be burned between scale and pad — on the padded frame,
  // positioned subs for narrow content drift toward the bars.
  const rect = contentRect(selection?.video, profile);
  const cpuChain = sub.filter
    ? [
      `scale=${rect.w}:${rect.h},setsar=1`,
      `${sub.filter}:alpha=0`,
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${profile.fps}`,
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
