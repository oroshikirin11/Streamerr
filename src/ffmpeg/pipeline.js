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
import { ProgressParser } from './progress.js';
import { probeDuration } from './playout.js';
import { BACKENDS, audioArgs, scaleFilter } from './encoders.js';
import { buildSubtitleFilter } from './tracks.js';

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
  constructor({ target, profile, selection = null, statsPeriodMs = 500 }) {
    super();
    this.target = target;
    this.profile = profile;
    this.selection = selection;
    this.statsPeriodMs = statsPeriodMs;

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
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(items = []) {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!items.length) throw new Error('Nothing to play');

    this.queue = [...items];
    this._stopping = false;
    this._spawnPublisher();

    const first = this.queue.shift();
    this._play(first, 0);
    this.status = 'running';
    this.emit('status', this.status);
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
      this._play(this.current.item, this.position, { duration: this.current.duration });
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
      // Read the source's already-encoded MPEG-TS. No -re here: the source
      // paces in realtime, and pacing twice would starve the output.
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

    const args = buildSourceArgs({
      srcPath: item.srcPath,
      offset,
      profile: this.profile,
      selection: this.selection,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
    });

    this._spawnSource(args, { kind: 'clip' });
    this.emit('nowplaying', this.snapshot());

    // Duration drives seek clamping and the progress bar. The filesystem
    // provider cannot supply it without probing every file during browsing,
    // so fill it in here for whatever is actually playing.
    if (this.current.duration == null) {
      probeDuration(item.srcPath)
        .then((d) => {
          if (this.current?.item === item) {
            this.current.duration = d;
            this.emit('nowplaying', this.snapshot());
          }
        })
        .catch(() => { /* seek simply stays unclamped */ });
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

    parser.on('block', (b) => {
      if (b.outTimeUs == null) return;
      const out = b.outTimeUs / 1e6;
      // Advance the published timeline by real progress, so the next source
      // continues rather than rewinding.
      this.timeline += Math.max(0, out - lastOut);
      lastOut = out;
      if (kind === 'clip') this.position = startOffset + out;
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
    this._play(next, 0);
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
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath);
  const audioIdx = selection?.audio?.typeIndex ?? 0;
  const base = scaleFilter(profile);
  const upload = be.uploadFilter(profile);

  const filterArgs = sub.needsComplex
    ? [
      '-filter_complex',
      `[0:v:0]${base}[b];[b][${sub.overlayInput}]overlay[o];[o]${upload}[v]`,
      '-map', '[v]',
    ]
    : [
      '-vf', [base, sub.filter, upload].filter(Boolean).join(','),
      '-map', '0:v:0',
    ];

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...be.deviceArgs(profile),
    // Input-side seek: fast, and the only form that skips decoding work.
    ...(offset > 0 ? ['-ss', Number(offset).toFixed(3)] : []),
    '-re',
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

/** Hold card, matching the output profile so the publisher sees no change. */
export function buildHoldArgs({
  profile, tsOffset = 0, statsPeriodMs = 500, label = 'Paused',
}) {
  const gop = String((profile.gopSeconds ?? 2) * (profile.fps ?? 30));
  const text = String(label).replace(/[\\':]/g, '');

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
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
