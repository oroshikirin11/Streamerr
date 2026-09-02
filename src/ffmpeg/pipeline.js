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

import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'fs';
import { Writable } from 'stream';
import { availableParallelism, cpus , totalmem } from 'os';
import { EventEmitter } from 'events';
import { basename, join } from 'path';
import { ProgressParser } from './progress.js';
import { probeDuration } from './playout.js';
import { BACKENDS, audioArgs, onAudioGrid, scaleFilter } from './encoders.js';
import { buildSubtitleFilter, escapeFilterPath } from './tracks.js';
import { analyseAssBand, bandScript } from './subband.js';
import { overlayAss } from './overlay-ass.js';
import {
  imageOverlayChain, vaapiImageOverlayChain, canvasImageChain,
  splitStaticImages, staticLayerArgs, isMoving, animBakeArgs, BAKE_MAX_WIDTH,
} from './overlay-image.js';
import { publishOutputArgs, targetUrl, SECRET_FIELDS } from '../publish.js';
import { TcpBridge } from './tcp-bridge.js';
import { OverlayFeed } from './overlay-feed.js';
import { rendererArgs, pipeInputArgs } from './overlay-renderer.js';

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

/**
 * Whether the GPU can decode this source.
 *
 * Intel's H.264 decoder is 8-bit 4:2:0 only, and 10-bit H.264 ("Hi10P") is
 * ubiquitous in anime releases. Handing one to VAAPI fails at hwaccel init;
 * the decoder then emits software frames the VAAPI filter chain cannot
 * accept ("Impossible to convert between the formats"), and the whole thing
 * finally surfaces as an encoder -22 several stages downstream — which is
 * why this looked like a pillarbox or encoder-argument problem for so long.
 *
 * Decoding on the CPU and uploading keeps filters and encode on the GPU,
 * which is where nearly all of the win is.
 */
/**
 * How many cores this process may actually use.
 *
 * NOT `cpus().length` — that reports the HOST's processors, and this
 * service runs in Docker inside an LXC container, so it would happily
 * count cores a cgroup will never let it touch and then start that many
 * encoders. Three sources, whichever is tightest:
 *
 *   - `availableParallelism()`, which follows CPU affinity (cpuset)
 *   - cgroup v2 `cpu.max`  — "quota period", or "max" for unlimited
 *   - cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`
 *
 * A quota is a rate, not a count: 250000/100000 means two and a half
 * cores' worth of time, so it floors to 2. Read once — it cannot change
 * without the container being recreated.
 */
let cachedCores = null;
/**
 * The memory this service actually has, in bytes — the container's cgroup
 * limit when one is set, the machine's total otherwise. Same philosophy as
 * availableCores: ask the environment, never the config.
 */
export function availableMemory() {
  const read = (path) => {
    try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
  };
  const v2 = read('/sys/fs/cgroup/memory.max');
  if (v2 && v2 !== 'max' && Number(v2) > 0) return Number(v2);
  const v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // v1 reports a huge sentinel when unlimited.
  if (v1 && Number(v1) > 0 && Number(v1) < 2 ** 60) return Number(v1);
  return totalmem();
}

/**
 * Recommended RAM budget for the run-ahead cache: half of what remains
 * after a working-set reserve for the encoders, Node and the OS page
 * cache. Clamped so tiny containers still get a useful cushion and huge
 * hosts do not default to hoarding gigabytes.
 */
export function recommendedCacheBytes() {
  const reserve = 1.5 * 1024 ** 3;
  const spare = availableMemory() - reserve;
  return Math.round(Math.min(Math.max(spare * 0.5, 128 * 1024 ** 2), 4 * 1024 ** 3));
}

/** Output bytes per second of broadcast, from the configured bitrates. */
export function streamBytesPerSecond(profile) {
  const rate = (v, dflt) => {
    const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(String(v ?? '').trim());
    if (!m) return dflt;
    return Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1);
  };
  const bits = rate(profile?.videoBitrate, 4.5e6) + rate(profile?.audioBitrate, 160e3);
  return (bits / 8) * 1.15;   // measured MPEG-TS overhead is ~10-15%
}

export function availableCores() {
  if (cachedCores != null) return cachedCores;
  let n = 2;
  try {
    n = typeof availableParallelism === 'function'
      ? availableParallelism()
      : (cpus()?.length || 2);
  } catch { /* keep the floor */ }

  const quota = (text, period) => {
    const q = Number(text);
    const p = Number(period);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
    return Math.max(1, Math.floor(q / p));
  };

  try {                                   // cgroup v2
    const [q, p] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (q !== 'max') {
      const lim = quota(q, p);
      if (lim) n = Math.min(n, lim);
    }
  } catch { /* not v2, or not readable */ }

  try {                                   // cgroup v1
    const lim = quota(
      readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'),
      readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'),
    );
    if (lim) n = Math.min(n, lim);
  } catch { /* not v1, or unlimited */ }

  cachedCores = Math.max(1, n);
  return cachedCores;
}

/**
 * Where an operator reports a title that will not stream.
 *
 * PLACEHOLDER — set this to the project's real issues URL before release.
 * It is printed inside the slow-clip report, which is designed to be pasted
 * straight into an issue: it names the codec, the subtitle decision and the
 * output settings, so a title can be diagnosed without anyone shipping the
 * media.
 */
const ISSUES_URL = 'https://github.com/oroshikirin11/Streamerr/issues';

export function gpuDecodable(video) {
  if (!video) return true;
  const codec = String(video.codec ?? '').toLowerCase();
  const pix = String(video.pixFmt ?? '').toLowerCase();
  if (!pix) return true;                       // unknown: let it try
  if (codec === 'h264') return pix === 'yuv420p' || pix === 'yuvj420p';
  // HEVC/VP9/AV1 10-bit 4:2:0 is fine; anything deeper or wider is not.
  return !/(12|16)le?$/.test(pix) && !/44[04]/.test(pix) && !/422/.test(pix);
}

/**
 * Would scale_vaapi do nothing at all for this clip?
 *
 * The GPU branches always emit `scale_vaapi=w=..:h=..:format=nv12`, and
 * vaapi_vpp does not short-circuit an identity transform — it issues a
 * VAProc pipeline regardless. For an 8-bit 4:2:0 source already at the
 * output size that is a full-frame GPU pass per frame that changes not one
 * pixel, on a device with no headroom to spare. Measured on the deployment
 * from the other direction: ADDING one full-frame GPU pass took Mr. Robot
 * from 1.03x to 0.909x, so this is worth roughly a tenth of the frame rate
 * on every 1080p episode.
 *
 * Every condition here is a case where the filter is NOT a no-op:
 *  - HDR needs the tonemap that rides the same filter.
 *  - 10-bit decodes to P010 surfaces and h264_vaapi takes only NV12, so the
 *    format conversion is load-bearing. Only yuv420p qualifies; anything
 *    else keeps the scale.
 *  - Anamorphic sources fall out for free: rect.w is the DISPLAY width, so
 *    a stored-narrow file never matches its own coded width.
 *  - Pillarboxed clips are excluded outright. The bars shapes are probed
 *    per driver (pickPillarboxGraph) and one of them reuses scalePart after
 *    the composite; replacing it there would silently change a graph whose
 *    whole point is that it was measured, not reasoned about.
 */
/**
 * Halve a frame rate, keeping it exact.
 *
 * Rates arrive as either an integer or an `a/b` string — 24000/1001 for
 * NTSC-rate film. Dividing that as a float would drift against the video's
 * own timeline, so the fraction is halved by doubling its denominator.
 */
export function halfRate(rate) {
  const s = String(rate ?? '').trim();
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) return `${m[1]}/${Number(m[2]) * 2}`;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? `${s}/2` : null;
}

export function scaleIsIdentity(video, profile, rect) {
  if (!video || !profile || profile.noIdentitySkip) return false;
  if (video.hdr || rect.bars) return false;
  const pix = String(video.pixFmt ?? '').toLowerCase();
  if (pix !== 'yuv420p' && pix !== 'yuvj420p') return false;
  return Boolean(video.width) && video.width === rect.w
    && video.height === rect.h;
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
  // Offsets even as well: NV12 chroma is 2x2-subsampled, and placing a
  // surface at an odd x/y is exactly the kind of thing a strict VAAPI
  // driver answers with -22. A scope film (2.35:1 → h=818 → y=131) hits
  // this; being one pixel off exact centre is invisible.
  const x = Math.round((W - w) / 4) * 2;
  const y = Math.round((H - h) / 4) * 2;
  return { w, h, x, y, bars: x > 1 || y > 1 };
}
import { extractSubtitle, extractFonts, isExtractable } from './subcache.js';
import { ChunkScheduler } from './chunker.js';
import { cpuTonemap } from './probe.js';

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
/**
 * How long a clip must stay under realtime before it is worth telling anyone.
 *
 * Was 8s, which fired during the ordinary dip after a splice — the source
 * restarts, the bank refills, and the rate is briefly below 1.0 by design.
 * Reporting that trained the operator to dismiss the one warning that means
 * the broadcast is about to stall.
 */
const SLOW_SUSTAIN_MS = 30_000;

/**
 * How often to repeat the report while a clip stays under realtime. Long
 * enough that a genuinely struggling title takes minutes to raise the popup,
 * short enough that it does eventually.
 */
const SLOW_REPEAT_MS = 120_000;

/** Below this many seconds the cushion has no margin left, whatever the rate. */
const BUFFER_FLOOR_S = 10;

/** How often the publisher's stats line reaches the console. */
const PUBLISHER_STAT_MS = 20_000;
const BANK_SECONDS = 15;
/** Widest the cushion may be configured, in seconds. */
export const BANK_SECONDS_MAX = 60;

/** NUT syncpoint startcode — the splice grid of the AV1 transport, the
 *  same 8 bytes the overlay feed already scans for. */
export const NUT_SYNC = Buffer.from('4e4be4adeeca4569', 'hex');
/** NUT file magic; legal only at byte 0, stripped before banking. */
export const NUT_FILEID = Buffer.from('nut/multimedia container\0', 'latin1');

/**
 * One TS packet carrying an HEVC end-of-sequence NAL, injected at copy
 * splices. A CRA arriving mid-stream does NOT reset a decoder — stale
 * reference buffers and POC collisions smear the picture until an IDR the
 * file may never contain. EOS_NUT ends the coded video sequence, so the
 * next IRAP legally begins a new one: the decoder flushes, skips the
 * leading pictures, and enters clean — the spec's own mechanism for
 * chained streams, with no session churn. The packet flags a TS
 * discontinuity so its continuity counter is exempt from checking.
 */
export function hevcEosPacket(ptsSeconds = 0) {
  const pts = Math.max(0, Math.round(ptsSeconds * 90000)) % (2 ** 33);
  const hi = Math.floor(pts / 2 ** 30);
  // A PES without a timestamp kills the publisher's muxer ("first pts and
  // dts value must be set", measured) — the seam's timeline provides one.
  const p = [
    0x20 | ((hi & 0x07) << 1) | 1,
    (pts / 2 ** 22) & 0xff,
    ((((pts / 2 ** 15) & 0x7f) << 1) | 1) & 0xff,
    (pts / 2 ** 7) & 0xff,
    (((pts & 0x7f) << 1) | 1) & 0xff,
  ].map((v) => Math.floor(v));
  const pes = Buffer.from([
    0x00, 0x00, 0x01, 0xe0, 0x00, 0x0e,     // length 14: 3 hdr + 5 pts + 6
    0x80, 0x80, 0x05,                       // flags: PTS present, len 5
    ...p,
    0x00, 0x00, 0x00, 0x01, 0x48, 0x01,     // Annex-B EOS_NUT (type 36)
  ]);
  const pkt = Buffer.alloc(188, 0xff);
  const afLen = 188 - 4 - pes.length - 1;   // adaptation fills the rest
  pkt[0] = 0x47;
  pkt[1] = 0x41; pkt[2] = 0x00;             // PUSI, pid 0x100
  pkt[3] = 0x30;                            // adaptation + payload, CC 0
  pkt[4] = afLen;
  pkt[5] = 0x80;                            // discontinuity_indicator
  pes.copy(pkt, 4 + 1 + afLen);
  return pkt;
}
const BANK_MIN_BYTES = 2 * 1024 * 1024;
/**
 * A ceiling on the bank, in bytes, derived from the depth actually asked for
 * rather than fixed.
 *
 * It used to be a flat 48MB, which silently truncated any deep cushion: at
 * 12000 kbps a 60s request works out at 90MB and would have been clamped to
 * 48MB — about 32s — with nothing anywhere saying so. Sized from the request
 * with headroom, the number the operator sets is the number they get.
 */
const bankCeiling = (seconds) => Math.max(48, Math.ceil(seconds * 8)) * 1024 * 1024;

/**
 * The pts of the LAST video PES start (pid 0x100, ffmpeg's first-stream
 * default) in a run of TS bytes, in seconds — null when none survives
 * whole. Drained chunks are arbitrary pipe-read splits, so the 188-byte
 * grid rarely begins at byte 0; the caller knows the stream offset and
 * passes the alignment in. A byte that breaks the grid ends the scan —
 * everything before it was verified, everything after it is guesswork.
 */
export /** One 33-bit MPEG timestamp field, in seconds. */
function readTs(buf, at) {
  return (((buf[at] >> 1) & 7) * 2 ** 30
    + (buf[at + 1] << 22) + (((buf[at + 2] >> 1) & 0x7f) << 15)
    + (buf[at + 3] << 7) + (buf[at + 4] >> 1)) / 90000;
}

export function lastVideoPtsIn(buf, gridStart = 0) {
  let dts = null;
  for (let o = gridStart; o + 188 <= buf.length; o += 188) {
    if (buf[o] !== 0x47) return dts;
    const pusi = (buf[o + 1] & 0x40) !== 0;
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    if (!pusi || pid !== 0x100) continue;
    const hasAf = (buf[o + 3] & 0x20) !== 0;
    const p = o + 4 + (hasAf ? 1 + buf[o + 4] : 0);
    if (p + 14 > o + 188) continue;
    if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) continue;
    const flags = buf[p + 7] & 0xc0;
    if (flags === 0xc0) {
      // Both present: the DTS field follows the PTS field. DTS is the
      // one that means "how far the stream has been written" — PTS is
      // presentation order and B-frames reorder it (measured on a real
      // passthrough capture: 166 of 399 successive PTS steps ran
      // BACKWARD), so reading it under-reads the frontier and can move
      // it backward, splicing the successor behind bytes already sent.
      if (p + 19 > o + 188) continue;
      dts = readTs(buf, p + 14);
    } else if (flags === 0x80) {
      // PTS only: an unreordered stream, where pts IS the dts.
      dts = readTs(buf, p + 9);
    }
  }
  return dts;
}

export class PipelinePlayout extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.target    rtmp:// URL, or a local file for testing
   * @param {object} o.profile   encoder profile incl. resolved `backend`
   * @param {object} [o.selection] track selection from selectTracks()
   */
  constructor({
    target = null, destinations = null, profile, selection = null,
    statsPeriodMs = 500, cacheDir = null, buffer = null,
    resolveSelection = null, runAhead = null, overlayDir = null,
  }) {
    super();
    this.target = target;
    /**
     * Where this broadcast goes. A legacy caller passing a bare `target`
     * string still works and is treated as one RTMP destination, so nothing
     * that predates the multi-target model has to change to keep running.
     */
    this.destinations = destinations ?? [{ protocol: 'rtmp', creds: { url: '', key: '' }, primary: true }];
    if (!destinations && target) {
      const m = /^(rtmps?):\/\/(.*)\/([^/]*)$/i.exec(String(target));
      this.destinations = m
        ? [{ protocol: m[1].toLowerCase(), creds: { url: `${m[1]}://${m[2]}`, key: m[3] }, primary: true }]
        : this.destinations;
    }
    /**
     * Every secret across every destination, so none of them can reach a log
     * line. Short values are skipped: replacing a three-character string
     * would mangle unrelated output.
     */
    this._secrets = this.destinations
      .flatMap((d) => SECRET_FIELDS.map((f) => String(d.creds?.[f] ?? '')))
      .filter((v) => v.length >= 6);
    /**
     * The configured output box. `this.profile` is this with the shape of
     * whatever is on air folded in, so every downstream consumer — filters,
     * chunker, hold cards — reads one profile and needs no special case.
     */
    this._box = { ...profile };
    this.profile = profile;
    this.selection = selection;
    /**
     * Re-pick tracks for a clip that is about to play, against that clip's
     * OWN streams. Track indices are per-file: "audio track 8" on a WEBDL
     * release is a different language — or absent — on the Bluray release of
     * the next episode. Reusing the index produced a source with no audio at
     * all, and the publisher then wrote nothing while its audio input sat
     * waiting, so the panel showed playback while Owncast showed nothing.
     */
    this.resolveSelection = resolveSelection;
    this.statsPeriodMs = statsPeriodMs;
    /** Where extracted subtitle tracks and fonts are kept. */
    this.cacheDir = cacheDir;
    /**
     * Uploaded overlay pictures. Deliberately not the cache: the cache is
     * disposable and gets cleared, and a logo the user uploaded is not.
     */
    this.overlayDir = overlayDir;
    // {ramBytes} — resolved by the caller; null disables the run-ahead.
    this.runAhead = runAhead;
    this._subCache = new Map();   // `${srcPath}:${typeIndex}` -> {path, fontsDir}
    /** Still-layer bakes in flight, so restarts do not pile up renders. */
    this._layerBaking = new Set();
    this._animBaking = new Set();
    // Counted on the engine, not per source process: the whole point is to
    // notice a PATTERN across clips, and each clip gets its own process.
    this._slowReports = 0;
    this._slowNoticed = false;
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
    /**
     * The last video pts actually handed to the publisher, read from the
     * drained TS bytes themselves. `timeline` is progress-derived and
     * `airedTimeline` is chunk-stamp-derived; both lag or lead the wire
     * by up to a second, and a splice anchored on either can start the
     * next source BEHIND bytes already published — a backward pts jump.
     * This is the wire's own answer, and the flush/cut paths trust it
     * first.
     */
    this._sentVideoPts = null;
    this._sentPos = null;
    /** Content position a resume returns to; set by pause, cleared by seek. */
    this._pauseResume = null;

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

    // Everything background this engine ever spawns (subtitle and font
    // extraction) hangs off this signal, so stop() actually stops the
    // machine instead of leaving detached ffmpegs demuxing a remux for
    // minutes after the broadcast ended.
    this._abort = new AbortController();

    /**
     * The internal transport between source, bank and publisher.
     *
     * MPEG-TS for H.264/HEVC — the 188-byte packet grid is what the whole
     * splice machinery is built on. AV1 cannot ride it: ffmpeg's mpegts
     * muxer writes AV1 as private data its own demuxer reads back as
     * bin_data (measured), so the publisher mapped audio only and died.
     * AV1 rides NUT instead — ffmpeg-native, carries any codec, and its
     * syncpoints give the bank the same splice grid the TS RAI walk gave
     * it. Every deviation below is gated on this field; the TS paths are
     * byte-identical to before.
     */
    this._fmt = (profile?.codec === 'av1') ? 'nut' : 'ts';
    const kbps = parseInt(String(profile?.videoBitrate ?? '6000'), 10) || 6000;
    this._kbps = kbps;
    /** The configured rate — passthrough clips re-size per clip and this is
     *  what an encoded clip returns to. */
    this._kbpsBase = kbps;
    /**
     * How deep the cushion runs. Configurable, because a title that cannot
     * quite hold realtime survives on cushion depth, while a deeper one also
     * means longer before any change reaches air and more encoded work
     * discarded on every skip.
     */
    this.bufferSeconds = Math.min(BANK_SECONDS_MAX,
      Math.max(1, Number(buffer?.seconds) || BANK_SECONDS));
    this.applySeconds = Number.isFinite(Number(buffer?.applySeconds))
      ? Math.min(this.bufferSeconds, Math.max(0, Number(buffer.applySeconds)))
      : this.bufferSeconds;
    /** ~bufferSeconds of stream at the configured bitrate, clamped. */
    this._bankMax = Math.min(bankCeiling(this.bufferSeconds),
      Math.max(BANK_MIN_BYTES, kbps * 125 * this.bufferSeconds));
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(items = [], { startAt = null } = {}) {
    if (this.status !== 'stopped') throw new Error(`Already ${this.status}`);
    if (!items.length) throw new Error('Nothing to play');

    this.queue = [...items];
    this._stopping = false;
    this._fillDurations();

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
    // Raw-TCP destinations publish through a loopback bridge that owns the
    // real connection (see tcp-bridge.js). Listeners are created once here
    // and survive publisher restarts; only the remote dial is per-session.
    await this._prepareTcpBridges();
    // A chunked clip produces nothing until its first chunk has finished
    // encoding, and then nothing again until the second one does. Opening
    // the RTMP session before that cushion exists put the encode latency
    // inside the live connection, and Owncast drops a session that goes
    // quiet for 10s. Connect once there is something to send instead —
    // _bankFeed spawns the publisher when the bank has enough.
    // Only the chunked path defers this, and it gates on its own `ready`
    // event; every other path spawns the publisher from _spawnSource.
    if (startAt != null) this._spawnPublisher();
    if (startAt != null && startAt - Date.now() / 1000 > 5) {
      // Scheduled start: broadcast the countdown card until the hour hits.
      // The first clip goes back on the queue — the card's natural end is a
      // normal source close, so the ordinary _advance() picks it up.
      this.queue.unshift(first);
      this._playCountdown(startAt);
    } else {
      this._play(first, 0);
    }
    // 'running' is claimed only when the encoder actually produces output
    // (first progress block) — a green "On air" during a startup that later
    // fails is a lie the user rightly called out.
    this.status = 'starting';
    this.emit('status', this.status);

    this._lastBlockAt = Date.now();
    this._lastAiredAt = Date.now();
    this._watch = setInterval(() => this._checkHealth(), 2000);
    this._watch.unref?.();
  }

  /**
   * Encoded-but-unaired content on the chunked path, in seconds: the
   * delivered-but-unaired window plus the cache that has not been handed
   * over yet. Zero on the streaming path, where nothing encodes ahead.
   */
  _cachedAhead(pos = this._onAir().position) {
    const sc = this.scheduler;
    if (!sc) return 0;
    const edge = sc._startOf?.(sc.nextToWrite) ?? pos;
    return Math.max(0, edge - pos) + (sc.cachedSeconds?.() ?? 0);
  }

  /**
   * Reserve the broadcast can spend before a stall reaches air, with the
   * axis it should be drawn against.
   *
   * On the streaming path that is the bank and nothing else. On the chunked
   * path the bank is only a thin delivery window in front of a RAM cushion
   * that can hold minutes, so reporting the bank alone understated the real
   * reserve badly — the meter read near zero while the cache was full.
   *
   * _cachedAhead already spans delivered-but-unaired PLUS the undelivered
   * cache, so it IS the total: adding the bank to it would count the
   * delivery window twice.
   */
  _reserve() {
    const perSecond = this._kbps * 125;
    const sc = this.scheduler;
    if (!sc) {
      return {
        seconds: this._bankSeconds() ?? (this._bankBytes ?? 0) / perSecond,
        max: this.bufferSeconds,
      };
    }
    return {
      seconds: this._cachedAhead(),
      // The cushion the cache is allowed to build, so a minutes-deep
      // reserve is not drawn pegged against a 15-second bank axis.
      max: sc.aheadSeconds ?? (this._bankMax / perSecond),
    };
  }

  _checkHealth() {
    // The chunked path has no single source process, but it still has a
    // bank and a publisher — and those are what the checks below actually
    // examine. Requiring a source here is what left it unsupervised.
    if (this.status !== 'running' || (!this.source && !this.scheduler)) return;
    // A source paused for backpressure is not stalled — it is doing exactly
    // what it was told. ffmpeg reports no progress while its stdout is
    // paused, so without this the watchdog kills every source that encodes
    // faster than realtime (which is most of them) the moment the bank
    // fills, and the broadcast churns through respawns forever.
    if (this._srcPaused) {
      this._lastBlockAt = Date.now();
      return;
    }
    // The source producing frames is not the same as viewers receiving them.
    // A publisher can wedge — waiting on an audio stream a source never
    // supplied, say — and then the encoder happily runs a whole episode
    // while nothing reaches the server. Data piling up in the bank with
    // nothing leaving it is the tell, and it is worth failing loudly over:
    // silently "playing" to an empty stream is the worst outcome there is.
    // This check asks whether a publisher has stopped accepting. Before one
    // exists the question is meaningless, and answering it anyway is what
    // killed chunked clips: the chunked path deliberately waits for two
    // finished chunks before connecting, so on a slow clip chunk 0 lands in
    // the bank while chunk 1 is still encoding. Bank non-empty, no
    // publisher, _lastAiredAt frozen since startup because nothing can
    // accept anything yet — and the broadcast was killed seconds before it
    // would have gone live. Encode failures are the scheduler's `fatal` to
    // report, not this one's.
    if (!this.publisher) return;
    // Chunked delivery wedge: a finished chunk is WAITING while nothing
    // reaches the publisher — seen live on the N100 after an in-cushion
    // seek, where delivery stalled 16s and the next seek killed the
    // broadcast. Content that exists but is not flowing is never a reason
    // to die: rebuild at the aired position instead. Six seconds is three
    // watchdog ticks — far beyond any legitimate delivery pause, well
    // inside Owncast's patience.
    if (this.scheduler && !this.holding && !this.source
        && (this._bankBytes ?? 0) === 0 && this._lastAiredAt
        && Date.now() - this._lastAiredAt > 6_000
        && this.scheduler.chunks?.get?.(this.scheduler.nextToWrite)?.done) {
      this.emit('warn', 'chunk delivery wedged with content in hand — rebuilding in place');
      this._flushed = true;
      this._play(this.current?.item ?? null, this.aired ?? this.position,
        { duration: this.current?.duration });
      return;
    }
    if ((this._bankBytes ?? 0) > 0 && this._lastAiredAt
        && Date.now() - this._lastAiredAt > 20_000) {
      // Distinguish "never got going" from "stopped mid-broadcast". A
      // publisher whose RTMP open hangs is alive and looks healthy: it
      // probes a little input, blocks writing the header, and never drains
      // stdin again. That reads identically to a wedged mux from in here,
      // but the thing to go and look at is the network, not the clip —
      // and the server has no record of the session at all, so blaming the
      // encoder sends you looking in the one place the fault is not.
      const bytes = this._published ?? 0;
      const everConnected = bytes > this._bankMax;
      this.emit('fatal', new Error(everConnected
        ? 'The stream stopped reaching the server: the encoder is still '
          + 'producing, but nothing has been accepted for 20s. If the clip '
          + 'has no audio track this is usually why.'
        : 'Never reached the server: the publisher accepted '
          + `${Math.round(bytes / 1024)} KB and then stopped, which is what `
          + 'an RTMP connection that never completes looks like. The server '
          + 'will have no record of the attempt. Check that the Owncast host '
          + 'is reachable and that the stream key is right.'));
      this.stop();
      return;
    }
    // Everything past here inspects the source process; the chunked path
    // has none, and its own workers report failure through the scheduler.
    if (!this.source) return;
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
    this._abort.abort();     // take background extractions down too
    // The overlay feed dies with the broadcast: its renderer would only
    // stall on a fifo nobody reads.
    try { this._ovFeed?.stopSync(); } catch { /* already down */ }
    this._ovFeed = null;
    this._tcpBridges?.forEach((b) => { try { b.close(); } catch { /* down */ } });
    this._tcpBridges = null;
    // Stopping during an off-air break: no publisher exists, so the close
    // handler that normally finishes a broadcast will never run.
    if (this._break) {
      if (this._break.timer) clearTimeout(this._break.timer);
      this._break = null;
      this.status = 'stopped';
      this.current = null;
      this.emit('status', this.status);
      this.emit('ended', { code: 0 });
      return;
    }
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
        for (const c of tail) {
          // Keep the aired markers moving as the tail goes out, or the
          // panel spends the last clip of a broadcast still reporting the
          // one before it.
          this.aired = c.pos;
          this.airedTimeline = c.tl;
          this.airedItem = c.item;
          p.stdin.write(c.data);
          this._published = (this._published ?? 0) + c.data.length;
          this._emitData(c.data);
        }
        // Closing stdin lets the publisher flush and close the RTMP session
        // cleanly rather than being cut off mid-packet.
        p.stdin.end();
      } catch { /* already gone */ }
      // Graceful gets time to air the tail at realtime; the timer is only a
      // failsafe against a publisher that never sees EOF. Bounded by what
      // the bank can hold (~15s) plus slack — a long fuse here means an old
      // publisher can still own the RTMP connection when the next
      // broadcast starts.
      const killMs = graceful ? 30_000 : 3000;
      setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); }, killMs).unref?.();
    }
  }

  /**
   * The clip and position viewers are actually watching.
   *
   * The encoder runs up to a bankful ahead of the picture, so reporting its
   * progress made the panel read seconds ahead of the stream — and flip to
   * the next episode while the previous one was still going out. What is
   * left is Owncast's own HLS buffering, which is not ours to remove.
   */
  _onAir() {
    const item = this.airedItem ?? this.current?.item ?? null;
    // Paused, the position IS the resume point — by definition, not by
    // bookkeeping. Deriving it from aired stamps raced the card's own
    // bank: chunks stamped before a paused-seek drained after it and
    // dragged the shown position (and the theater veil's) briefly back
    // to the old spot, exactly when the coalesced metadata push read it.
    const position = this.status === 'paused' && this._pauseResume != null
      ? this._pauseResume
      : this.airedItem != null && this.aired != null
        ? this.aired
        : this.position;
    const duration = item === this.current?.item
      ? this.current?.duration ?? item?.duration ?? null
      : item?.duration ?? null;
    return { item, position, duration };
  }

  /**
   * Tear everything down immediately, dropping whatever has not aired.
   *
   * stop() lets the publisher finish airing its buffer, which is right at
   * the end of a queue and wrong the moment another broadcast wants the
   * connection: Owncast accepts one publisher, so a lingering one keeps
   * showing the previous programme while the new stream cannot get in.
   */
  hardStop() {
    this._stopping = true;
    this._abort.abort();
    try { this._ovFeed?.stopSync(); } catch { /* already down */ }
    this._ovFeed = null;
    if (this._break?.timer) clearTimeout(this._break.timer);
    this._break = null;
    this._bank = [];
    this._bankBytes = 0;
    if (this._watch) { clearInterval(this._watch); this._watch = null; }
    this._killSource();
    const p = this.publisher;
    if (p) {
      try { p.stdin.destroy(); } catch { /* already gone */ }
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  snapshot() {
    const air = this._onAir();
    const sched = this._schedule();
    const a = this.selection?.audio ?? null;
    const sub = this.selection?.subtitle ?? null;
    return {
      status: this.status,
      breakUntil: this._break?.until ?? null,
      playing: air.item ? { ...air.item, duration: air.duration } : null,
      queue: this.queue.map((q, i) => ({ ...q, at: sched[i] ?? null })),
      position: air.position,
      // Encoded-but-unaired content in seconds: the run-ahead cushion the
      // player timeline shades ahead of the playhead. Zero on the
      // streaming path, where nothing encodes ahead.
      // A cover card is on air while the scheduler re-encodes ("Loading"
      // after a seek outside the cache): the panel shows the same build
      // indicator it shows before going live, for as long as the card is.
      rebuilding: Boolean(this.holding && this.scheduler),
      // True while the on-air clip ships HDR bits (copy of an HDR file or
      // the main10 encode) — matched against the spawned argv per clip.
      hdrOnAir: Boolean(this.hdrOnAir),
      // Both bands measured from what has actually AIRED, so the shaded
      // regions are exactly the instant-seek territory: 'delivered'
      // content the viewer has not seen yet belongs to the AHEAD band,
      // not the behind one it used to inflate.
      cachedAhead: this._cachedAhead(air.position),
      cachedBehind: (() => {
        const ks = this.scheduler?.keptStart?.();
        return ks == null ? 0 : Math.max(0, air.position - ks);
      })(),
      // What is actually being burned in, so the panel can show it without
      // asking — the choice is baked into the stream and is not something a
      // viewer can change at their end.
      tracks: {
        audio: a && {
          language: a.language ?? null,
          title: a.title ?? null,
          codec: a.codec ?? null,
          channels: a.channels ?? null,
        },
        subtitle: sub && {
          language: sub.language ?? null,
          title: sub.title ?? null,
          codec: sub.codec ?? null,
          forced: Boolean(sub.forced),
          external: Boolean(sub.external),
        },
      },
    };
  }

  // ── control — none of these touch the publisher ──────────────────────

  /** Jump within the current clip. Relative unless `absolute` is given. */
  seek({ delta = 0, position = null } = {}) {
    if (!this.current) throw new Error('Nothing playing');
    // The countdown counts wall-clock time; there is nothing to seek in.
    if (this.current.item?.countdown) return this.position;

    // A fresh seek earns a fresh reconnect (see the copy-seam reshape).
    this._reshapedFor = null;
    /**
     * PAUSED is a state, not an interruption: a seek only moves the point
     * resume() will come back to. Spawning the clip here (the old
     * behaviour) un-paused the broadcast as a side effect — skip to the
     * episode's start while paused and it just started playing. Nothing
     * is flushed and nothing spawns: the card keeps the pipe alive and
     * its timeline running, the aired stamp moves so the panel (and the
     * theater's paused veil, which carries position) shows the new spot,
     * and resume() plays from here — through the retained window when the
     * target is cached, so an un-moved pause resumes as instantly as
     * before.
     */
    if (this.status === 'paused') {
      const base = this._pauseResume ?? this.position ?? 0;
      let next = position != null ? Number(position) : base + Number(delta);
      next = Math.max(0, next);
      if (this.current.duration) {
        next = Math.min(next, Math.max(0, this.current.duration - 2));
      }
      this._pauseResume = next;
      this.position = next;
      this.emit('seeked', { position: next });
      return next;
    }
    // A seek while playing discards any pause bookkeeping outright.
    this._pauseResume = null;
    // Flush first: it rewinds the playhead to what has aired, and a
    // relative skip has to count from there or +30 lands a bankful further
    // ahead than the viewer expects.
    this._bankFlush();
    let next = position != null ? Number(position) : this.position + Number(delta);
    next = Math.max(0, next);
    if (this.current.duration) {
      next = Math.min(next, Math.max(0, this.current.duration - 2));
    }

    // A target already in the run-ahead cache needs no rebuild: the
    // scheduler trims the containing chunk's head to the target (keyframe
    // snap, so at most one GOP early — like any player) and places it at
    // the stream head; every later chunk follows the trimmed chunk's
    // MEASURED end. No cover card, no re-encode. Declined when that one
    // chunk is not encoded yet — a big cushion says nothing about the
    // specific chunk, since workers finish out of order.
    if (this.scheduler) {
      const head = onAudioGrid(this.timeline + 0.064);
      const sched = this.scheduler;
      const at = sched.jumpTo(next, head);
      if (at != null) {
        this.position = next;
        this.emit('log', `[cache] seek to ${next.toFixed(0)}s served from the `
          + `run-ahead cache — no re-encode\n`);
        // Safety net: a jump whose delivery stalls (a wedged remux, a slow
        // disk, anything) starved the publisher in silence until Owncast
        // hung up — seen live on the N100 while the same path passes clean
        // on fast hardware. If no bytes reach the publisher within a few
        // seconds of the jump, abandon it and rebuild through the card
        // path, which is slow but cannot starve.
        const pubAt = this._published ?? 0;
        setTimeout(() => {
          if (this.scheduler !== sched || this._stopping) return;
          if ((this._published ?? 0) > pubAt) return;
          this.emit('warn', 'cache seek stalled — rebuilding at the target instead');
          this._flushed = true;   // the bank is already flushed and empty
          this._play(this.current?.item ?? null, next,
            { duration: this.current?.duration });
        }, 5000);
        this.emit('discontinuity');
        this.emit('seeked', { position: next });
        return next;
      }
    }

    // Restart only the source; the publisher and its connection are untouched.
    this._play(this.current.item, next, { duration: this.current.duration });
    this.emit('seeked', { position: next });
    return next;
  }

  pause() {
    if (this.status === 'paused' || !this.current) return;
    this.status = 'paused';
    // INSTANT pause: flush the cushion rather than airing it out. Keeping
    // the cushion made every pause take up to applySeconds to reach the
    // wire — a pause button that keeps playing for fifteen seconds. The
    // reason the flush was ever unsafe is gone: it now splices at the
    // exact last video pts the publisher was handed (the sent frontier),
    // so the card continues the published timeline monotonically instead
    // of jumping backward by the stamp drift. Viewers lose only bytes
    // they had not seen yet, and the flush rewinds `position` to what
    // actually aired — the moment the card appears for them.
    this._bankFlush();
    // Captured for resume: the card's own bank stamps freeze `pos` while
    // `tl` advances, so nothing at resume time can reconstruct this.
    this._pauseResume = this.position;
    // The scheduler SURVIVES a pause: delivery suspends, the workers keep
    // encoding ahead, and the retained window keeps the position we are
    // pausing at. Killing it here was why resuming took a minute of card —
    // a full rebuild for content the cache was already holding.
    if (this.scheduler) this.scheduler.pauseDelivery();
    // Hold the pipe with a card so the publisher keeps writing and Owncast
    // never sees the ten seconds of silence that would end the broadcast.
    this._spawnHold('Paused', { keepScheduler: true });
    this.emit('status', this.status);
  }

  resume() {
    if (this.status !== 'paused' || !this.current) return;
    // The content position the card appeared at, captured by pause().
    // The card's own stamps cannot provide it (pos frozen, tl advancing),
    // and a seek while paused clears it so the seek wins.
    const at = this._pauseResume ?? this.position ?? 0;
    this._pauseResume = null;
    // Chunked path: the paused position lives in the retained window, so
    // resuming is a cache jump — kill the card, flush its unaired trickle,
    // and deliver from the retained chunk. Instant, no re-encode.
    if (this.scheduler) {
      if (this.holding && this.source) {
        const h = this.source;
        this.source = null;
        this.holding = false;
        this._srcGen = (this._srcGen ?? 0) + 1;
        h.stdout?.removeAllListeners?.('data');
        try { h.stdout?.resume?.(); } catch { /* gone */ }
        try { h.kill('SIGKILL'); } catch { /* gone */ }
      }
      this._bankFlush();
      const jumped = this.scheduler.jumpTo(at, onAudioGrid(this.timeline + 0.064));
      if (jumped != null) {
        this.position = jumped;
        this.status = 'running';
        this.emit('log', '[cache] resumed from the retained window — no re-encode\n');
        this.emit('discontinuity');
        this.emit('status', this.status);
        return;
      }
    }
    // Classic path. First drop the card bytes that never aired — they sit
    // at the BACK of the bank (the card appended behind the cushion), and
    // a card nobody saw is owed to nobody.
    while (this._bank?.length && this._bank[this._bank.length - 1].hold) {
      const c = this._bank.pop();
      this._bankBytes -= c.data.length;
    }
    this.status = 'running';
    if (this._bank?.length) {
      // The pause was shorter than the cushion: clip content is still
      // queued and the card never reached the wire. Same cushion-kept,
      // GOP-aligned splice as a track change — the resumed clip appends
      // behind the remaining cushion, and the content position comes from
      // the CUT (where the kept bytes end), not from the pause point:
      // viewers never saw a card, so they must not see a skip either.
      const { resume } = this._bankCutForApply(this._applyRunway());
      this._play(this.current.item, resume, { duration: this.current.duration });
    } else {
      // The card aired (or the cushion is gone): flush pads the torn
      // packet and rewinds the timeline to the last byte the publisher
      // actually got, and the clip resumes at the content moment the card
      // appeared for viewers.
      this._bankFlush();
      this._play(this.current.item, at, { duration: this.current.duration });
    }
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
      this._detached(this._extract(item).finally(() => {
        if (this._stopping || this._selToken !== tok) return;
        if (this.current?.item !== item || this.status !== 'running') return;
        // The bank SURVIVES a track change — the same trade the classic
        // overlay apply makes, for the same reason. Flushing put the new
        // track on air instantly but left the publisher with nothing to
        // send for the whole respawn: a cover card locally, a buffering
        // spinner for every viewer. Keeping the cushion, the new track
        // appends behind the buffer and surfaces when it drains — a
        // forward seam the publisher's pacer tolerates, and no seam at
        // all for viewers. `applySeconds` bounds the wait, as it does
        // for overlays.
        const runway = this._applyRunway();
        const { rewound, gop, resume } = this._bankCutForApply(runway);
        const ahead = Math.max(0, resume - (this.aired ?? resume));
        this.emit('log', `[tracks] applied — on air in ~${ahead.toFixed(1)}s `
          + (rewound > 0.05
            ? `(cushion cut to ${runway.toFixed(1)}s, ${(rewound + gop).toFixed(1)}s re-encoded)`
            : gop > 0
              ? `(cushion kept, GOP-aligned splice, ${gop.toFixed(1)}s re-encoded)`
              : '(cushion kept)')
          + '\n');
        this._play(item, resume, { duration: dur });
      }), 'changing tracks');
    }
    this.emit('selection', selection);
  }

  /**
   * Change the studio overlays on a broadcast that is already on air.
   *
   * Needed because libass reads the ASS file when the filter is built, not
   * as it goes: writing a new file under a running source changes nothing,
   * and the graph's SHAPE changes anyway when the last overlay is removed
   * or the first one added. So the source is restarted at the playhead,
   * which is the same move a track change makes.
   *
   * Written to `_box` as well as `profile` because a reshape rebuilds the
   * profile from the box, and an overlay that lived only on the profile
   * would vanish the next time an episode of a different shape came up.
   */
  /**
   * Whether the studio holds anything the operator might show, visible or
   * not. Arming rides on this so a hidden studio still spawns WITH the
   * pipe and the first "show" is a renderer swap, not a source respawn.
   * No restart here: it only steers the next planOverlayPipe decision.
   */
  setOverlayConfigured(configured) {
    const v = Boolean(configured);
    this._box.overlayConfigured = v;
    if (this.profile) this.profile.overlayConfigured = v;
  }

  /**
   * The piped apply: replace only the renderer, through the same extract →
   * spec → swap flow every live Apply runs. Shared with the crash handler
   * below, so a renderer that dies mid-clip is rebuilt by exactly the code
   * path that is already proven at every show/hide.
   */
  _pipedOverlayApply(item, dur) {
    const tok = (this._selToken = (this._selToken ?? 0) + 1);
    this._detached(this._extract(item).finally(() => {
      if (this._stopping || this._selToken !== tok) return undefined;
      if (this.current?.item !== item || this.status !== 'running') return undefined;
      if (!this._pipedClip || !this._ovFeed?.active) return undefined;
      /**
       * The continuation point is simply where the encode head IS. The
       * new renderer stamps clip-relative timestamps from here; anything
       * already queued in framesync pairs first, a frame stamped slightly
       * behind is dropped benignly, and the heartbeat covers any gap
       * within half a second. The old byte-counting clock died with the
       * rawvideo pipe.
       */
      // headPts is SOURCE-LOCAL (the canvas clock is 0-based per source);
      // shift is clip-absolute, so the offset goes back on before the max.
      const shift = Math.max(this._pipeClipOffset ?? 0, this.position ?? 0,
        (this._ovFeed?.headPts?.() ?? 0) + (this._pipeClipOffset ?? 0));
      const cached = this._cachedSubs(item.srcPath);
      const overlayFile = this._overlayFile(item, 0);
      /**
       * Timed windows are diffed against the canvas clock, which is
       * clip-relative — NOT this swap's continuation point. Subtracting
       * `shift` here moved every intro/outro window by the swap position,
       * so a timed picture could reappear or vanish after a mid-clip
       * apply. The initial spawn passes the clip offset; so must swaps.
       */
      const overlayImages = this._overlayImages(item, this._pipeClipOffset ?? 0);
      const spec = buildRendererSpec({
        profile: this.profile,
        selection: this.selection,
        srcPath: item.srcPath,
        shift,
        clipOffset: this._pipeClipOffset ?? 0,
        duration: dur,
        extractedPath: cached?.path ?? null,
        fontsDir: cached?.fontsDir ?? null,
        overlayPath: overlayFile,
        overlayImages,
        subBand: this._subtitleBand(
          this.selection?.subtitle?.external
            ? this.selection.subtitle.path ?? null
            : cached?.path ?? null,
          { overlayPath: overlayFile, fontsDir: cached?.fontsDir ?? null },
        ),
        pin: this._pipePin ?? null,
      });
      if (!spec) {
        // Eligibility changed underneath (a demotion mid-clip). The
        // classic restart still works; use it rather than not applying.
        const { resume } = this._bankCutForApply();
        this._play(item, resume, { duration: dur });
        return undefined;
      }
      const swapArgs = rendererArgs(spec.spec);
      this.emit('log', `[swap:overlay] ffmpeg ${this._redact(swapArgs.join(' '))}\n`);
      return this._ovFeed.swap(swapArgs).then(() => {
        this._rendererCrashes = 0;
        const ahead = Math.max(0, (this.position ?? 0) - (this.aired ?? 0));
        this.emit('log', '[overlay] applied live — no restart, reaches air '
          + `in ~${ahead.toFixed(1)}s as the buffer plays out\n`);
      });
    }), 'applying overlays');
  }

  /**
   * An unexpected renderer death used to strand the broadcast: nothing
   * respawned the canvas, the source starved at the NUT join and the bank
   * drained to zero (measured — an ENOSPC crash froze position with every
   * process at 0% CPU). The feed has already cut any torn tail; respawn
   * through the normal apply flow. Three deaths in a row means the pipe
   * itself is sick — fall back to the classic restart, which rebuilds
   * everything the way a track change does.
   */
  _rendererCrashed() {
    if (this._stopping || this.status !== 'running' || !this.current) return;
    if (!this._pipedClip || !this._ovFeed?.active) return;
    const item = this.current.item;
    const n = (this._rendererCrashes = (this._rendererCrashes ?? 0) + 1);
    if (n > 2) {
      this.emit('warn', 'overlay renderer keeps dying — restarting the source');
      const gop = this._bankTrimToAccessPoint();
      this._play(item, Math.max(this.aired ?? 0, (this.position ?? 0) - gop),
        { duration: this.current.duration });
      return;
    }
    this.emit('log', `[overlay-pipe] renderer died — respawning (attempt ${n})\n`);
    setTimeout(() => {
      if (this._stopping || this.status !== 'running') return;
      if (this.current?.item !== item || !this._pipedClip || !this._ovFeed?.active) return;
      this._pipedOverlayApply(item, this.current.duration);
    }, 500);
  }

  setOverlay(items) {
    const next = Array.isArray(items) ? items : [];
    // Applying is a restart, so it must be worth one. The panel saves the
    // whole config on every settings change, and re-cutting the encoder
    // because someone edited an unrelated field is exactly the kind of
    // self-inflicted stall this pipeline is built to avoid.
    const same = JSON.stringify(this.profile?.overlay ?? []) === JSON.stringify(next);
    this._box.overlay = next;
    if (this.profile) this.profile.overlay = next;
    if (same) return false;
    /**
     * A new overlay set is a new experiment, so clear the one-shot picture
     * demotion.
     *
     * Both of these are latched for the whole broadcast, which was right
     * while a refusal was believed to be a driver capability. It is not: a
     * refusal is geometry — an overlay rectangle overhanging the frame edge
     * — and the crop in vaapiImageOverlayChain now makes that
     * unconstructable. Leaving them latched had two costs, both seen live:
     * a picture stayed switched off for the rest of the broadcast even
     * after the operator resized the one that failed, and, worse, the
     * second failure of a broadcast found `_gpuImgDemoted` already true,
     * fell past the handler that exists to drop the picture, and STOPPED
     * the stream. Dropping a logo is the intended failure; ending the
     * broadcast is not.
     */
    this._gpuImgDemoted = false;
    delete this._box.noGpuImages;
    if (this.profile) delete this.profile.noGpuImages;
    if (this._demoted) delete this._demoted.noGpuImages;
    if (!this.current || this.status !== 'running') return true;

    const item = this.current.item;
    const dur = this.current.duration;
    // _play treats a position within a second of the end as "past it" and
    // advances. Restarting here would therefore skip the rest of the
    // episode to apply an overlay — so don't: the next clip picks the
    // change up from the profile anyway, a second later.
    if (dur && this.position >= dur - 1) return true;

    /**
     * The piped apply: nothing restarts.
     *
     * The source, its bank and the publisher never hear about this — only
     * the renderer feeding the overlay fifo is replaced. The new one must
     * continue at exactly the frame the old one stopped at: rawvideo has no
     * timestamps, so the feed's frame count is the shared clock, and the
     * continuation point is clipOffset + frames/rate. Off by one frame and
     * every subtitle drifts by that much for the rest of the clip.
     *
     * The change reaches air when the encoded cushion drains past it —
     * same arrival time as the classic path's "cushion kept" mode, minus
     * the splice, the DTS discontinuities and the re-encode.
     */
    if (this._pipedClip && this._ovFeed?.active) {
      this._pipedOverlayApply(item, dur);
      return true;
    }
    // Same ordering as a track change, and for the same reason: extract
    // while the old source still feeds the pipe, or the new source's
    // subtitle filter re-reads the container and starves the publisher
    // past Owncast's deadline.
    const tok = (this._selToken = (this._selToken ?? 0) + 1);
    this._detached(this._extract(item).finally(() => {
      if (this._stopping || this._selToken !== tok) return;
      if (this.current?.item !== item || this.status !== 'running') return;
      /**
       * The bank SURVIVES an overlay change. This is the whole difference
       * between a seamless apply and a visible stall.
       *
       * _bankFlush throws the cushion away and rewinds `position` back to
       * `aired`, so the new source re-encodes the seconds the old one had
       * already produced. That makes the overlay appear instantly — and
       * leaves the publisher with nothing to send for the entire respawn,
       * which is a buffering spinner for every Owncast viewer.
       *
       * Keeping the bank, `position` still points at where the old source
       * stopped, so the new one continues from exactly there: the same
       * continuation an ordinary episode advance uses, and a FORWARD seam,
       * which is the only kind the publisher's -re pacer tolerates. Cost:
       * the change goes on air when the cushion drains rather than at once.
       * That is the trade the operator is making, and it is the right one
       * for viewers.
       */
      /**
       * How much cushion survives decides when the change is seen. Keeping
       * all of it is seamless and lands when the cushion drains; keeping
       * none puts it on air at once and costs viewers a re-buffer, because
       * the publisher has nothing to send while the encoder catches up.
       */
      // GOP-aligned in every mode: the packet-aligned trim leaves a
      // truncated frame at the junction, and the decoder holds a still
      // frame until it resyncs. Ending the bank on an access point costs
      // up to one GOP of re-encode — the cushion absorbs it.
      const runway = this._applyRunway();
      const { rewound, gop, resume } = this._bankCutForApply(runway);
      const ahead = Math.max(0, resume - (this.aired ?? resume));
      this.emit('log', `[overlay] applied — on air in ~${ahead.toFixed(1)}s `
        + (rewound > 0.05
          ? `(cushion cut to ${runway.toFixed(1)}s, ${(rewound + gop).toFixed(1)}s re-encoded)`
          : gop > 0
            ? `(cushion kept, GOP-aligned splice, ${gop.toFixed(1)}s re-encoded)`
            : '(cushion kept)')
        + '\n');
      this._play(item, resume, { duration: dur });
    }), 'applying overlays');
    return true;
  }

  setQueue(items) {
    this.queue = [...items];
    // An item that left and came back arrives with no duration again;
    // let it be probed afresh rather than staying blank forever.
    for (const it of items) {
      if (it.duration == null) this._durTried?.delete(it.srcPath);
    }
    this._fillDurations();
    this.emit('queue', this.snapshot());
  }

  /**
   * When each queued item is projected to go on air, in epoch seconds.
   *
   * Everything downstream of an item of unknown length is unknowable, so
   * those report null rather than a confident lie — except past a pinned
   * item, whose time is fixed regardless of what came before it.
   */
  _schedule() {
    let t = Date.now() / 1000;
    let known = true;
    const cur = this.current;
    if (cur?.item?.countdown) {
      // A card runs until its target; the show begins exactly then.
      t = cur.item.until ?? t;
    } else if (cur) {
      const dur = cur.duration ?? cur.item?.duration ?? null;
      if (dur == null) known = false;
      else t += Math.max(0, dur - (this.aired ?? this.position ?? 0));
    }
    return this.queue.map((q) => {
      if (q.startAt != null && (!known || q.startAt > t)) {
        t = q.startAt;
        known = true;
      }
      const at = known ? t : null;
      if (known) {
        if (q.duration == null) known = false;
        else t += q.duration;
      }
      return at;
    });
  }

  /**
   * Fill in missing queue durations in the background.
   *
   * The filesystem library deliberately does not probe while browsing — one
   * ffprobe per file would make the grid crawl — so queued items arrive
   * with duration null and the schedule has nothing to add up. Probing
   * reads container headers only, and runs one at a time so it never
   * competes with the broadcast for the disk.
   */
  _fillDurations() {
    if (this._fillingDurations) return;
    this._fillingDurations = true;
    this._detached((async () => {
      try {
        // Tried-and-failed is tracked separately from unknown. Writing 0
        // to stop the search re-matching would have been a lie the
        // schedule believes: a zero-length item makes everything after it
        // project at the same instant.
        this._durTried ??= new Set();
        for (;;) {
          const q = this.queue.find((x) => x.duration == null && x.srcPath
            && !this._durTried.has(x.srcPath));
          if (!q || this._abort.signal.aborted) return;
          this._durTried.add(q.srcPath);
          let d = null;
          try { d = await probeDuration(q.srcPath); } catch { /* stays unknown */ }
          if (this._abort.signal.aborted) return;
          if (d != null) {
            q.duration = d;
            if (this.queue.includes(q)) this.emit('queue', this.snapshot());
          }
        }
      } finally {
        this._fillingDurations = false;
      }
    })(), 'probing queue durations');
  }

  // ── publisher ────────────────────────────────────────────────────────

  /**
   * One loopback bridge per raw-TCP destination, created before the first
   * publisher spawn and kept for the broadcast's life. The bridge reads
   * creds through a closure, so a settings edit reaches the next dial
   * without a rebuild.
   */
  async _prepareTcpBridges() {
    const tcp = this.destinations.filter((d) => d.protocol === 'tcp');
    if (!tcp.length) return;
    this._tcpBridges ??= new Map();
    for (const d of tcp) {
      if (this._tcpBridges.has(d)) continue;
      const bridge = new TcpBridge(() => d.creds, (m) => this.emit('log', m));
      await bridge.listen();
      this._tcpBridges.set(d, bridge);
    }
  }

  /**
   * The destination set as the publisher's ffmpeg sees it: raw-TCP targets
   * swapped for their loopback bridge. The real address and the stream key
   * stay on this side of the process boundary.
   */
  _publishDests() {
    if (!this._tcpBridges?.size) return this.destinations;
    return this.destinations.map((d) => {
      const bridge = this._tcpBridges.get(d);
      return bridge?.port
        ? { ...d, creds: { ...d.creds, url: `tcp://127.0.0.1:${bridge.port}` } }
        : d;
    });
  }

  _spawnPublisher() {
    /**
     * BEFORE the byte counter resets: a replacement publisher must start
     * reading at an ACCESS POINT. The previous one may have consumed the
     * bank's head into its dead stdin before its output ever connected —
     * measured live at a refused reconnect: the retry began at headerless
     * mid-GOP bytes, its probe flooded "PPS id out of range", gave up on
     * codec parameters, and the receiver entered mid-GOP with artifacts.
     */
    this._bankTrimHeadToAccessPoint();
    // Bytes actually handed to this publisher. The mpegts stream is a
    // sequence of 188-byte packets, but the bank stores pipe reads, which
    // land on arbitrary byte boundaries — this counter is what lets a
    // flush cut the stream on a packet boundary instead of mid-packet.
    this._published = 0;
    this._drainGen = 0;
    // A new RTMP session restarts the TS byte stream at zero. Preview
    // clients must be cut AND the fan-out's packet-phase counter reset with
    // it: a rejoining client works out its packet boundary from that count,
    // so a stale one lands it mid-packet, and mpegts.js probes byte 0 for
    // the 0x47 sync marker instead of scanning for it — the picture never
    // comes back.
    this.emit('publisher-restart');
    // Backpressure state belongs to the process that caused it. A drain
    // that parked on the PREVIOUS publisher's stdin left this latched with
    // a 'drain' listener on a pipe that will never fire again, so every
    // drain against the replacement returned at the guard and the source
    // sat blocked forever behind a publisher that was ready and waiting.
    this._bankDraining = false;
    const args = [
      '-hide_banner', '-nostdin',
      // The publisher sets the pace for everything. Sources run as fast as
      // they can and are throttled by pipe backpressure — chunk workers must,
      // since the whole point is finishing ahead of the playhead.
      '-re',
      // Splice seams (skip, pause, chunk flush) deliberately pad the last
      // partial packet with zeros, on the assumption the demuxer drops one
      // bad packet. That drop only happens with this flag — by default
      // ffmpeg FORWARDS packets it has flagged corrupt, and a zero-padded
      // payload can parse as a PES header with a garbage timestamp. On air
      // that produced a 158s offset applied to audio alone: from that seam
      // on, A/V input offsets diverged, audio was discarded as late, and
      // the server dropped the starved stream minutes later.
      '-fflags', '+discardcorrupt',
      '-f', this._fmt === 'nut' ? 'nut' : 'mpegts', '-i', 'pipe:0',
      /**
       * Muxer, flags and target all come from the destination set now — see
       * src/publish.js, which carries the measurements behind the codec tags
       * and the tee. One destination produces exactly the argument list this
       * used to hardcode; several produce a tee.
       */
      ...publishOutputArgs(this._publishDests(), {
        codec: this.profile?.codec ?? 'h264',
        videoBitrate: this.profile?.videoBitrate ?? null,
      }),
    ];

    const startedAt = Date.now();
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.publisher = p;

    // A source dying mid-write must not take the publisher down with it.
    p.stdin.on('error', () => { /* EPIPE while swapping sources */ });

    // A NUT demuxer opening mid-broadcast needs main/stream headers before
    // the first syncpoint it meets — the bank's head is a trim-aligned
    // syncpoint, headers long gone. Prepend the captured block; when the
    // bank still begins with a source's own in-band headers the duplicate
    // is legal (measured).
    if (this._fmt === 'nut' && this._nutHeader) {
      try {
        p.stdin.write(this._nutHeader);
        this._published = (this._published ?? 0) + this._nutHeader.length;
      } catch { /* stdin already broken; supervision handles it */ }
    }

    let stderr = '';
    // -Infinity, not 0: the first stats line of a clip should appear at
    // once rather than 20s in, and that must not depend on the epoch
    // being large.
    let lastStat = -Infinity;
    // Carry the unterminated tail of each read into the next. ffmpeg
    // splits messages across writes, and filtering per-chunk left the
    // FRAGMENTS of a suppressed line in the console — a bare
    // "[vost#0:0/copy @ ...]" here, an orphaned "changing to N" there
    // (operator-reported from a live N100 log).
    let lineTail = '';
    p.stderr.on('data', (d) => {
      const s = this._redact(d.toString());
      stderr += s;
      if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      const whole = lineTail + s;
      const nl = Math.max(whole.lastIndexOf('\n'), whole.lastIndexOf('\r'));
      const complete = nl === -1 ? '' : whole.slice(0, nl + 1);
      lineTail = nl === -1 ? whole : whole.slice(nl + 1);
      if (lineTail.length > 8_000) lineTail = lineTail.slice(-4_000);
      // ffmpeg writes its stats line twice a second, and at that rate it
      // buries every other line in the console. It is also the least
      // informative line here: this is the PUBLISHER, and `-re` pins it to
      // 1.0x by design, so it can never show an encode falling behind —
      // the panel's speed (the source's) is the one that moves. Sample it,
      // and say whose it is, because reading it as the encoder's rate has
      // cost real debugging time.
      const keep = [];
      for (const raw of complete.split(/[\r\n]+/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/^frame=.*\bspeed=/.test(line)) {
          const now = Date.now();
          if (now - lastStat < PUBLISHER_STAT_MS) continue;
          lastStat = now;
          keep.push(`[publisher, paced to 1x] ${line}`);
        } else if (line.includes('Non-monotonic DTS')) {
          // The copy path surfaces duplicate/stepped DTS at splices and
          // resend_headers boundaries that the flv muxer used to swallow
          // silently; ffmpeg self-corrects by one 90kHz tick every time.
          // Once-a-second noise on mpegts, not information — dropped here,
          // the correction itself stays.
          continue;
        } else {
          keep.push(line);
        }
      }
      if (keep.length) this.emit('log', `${keep.join('\n')}\n`);
    });

    p.on('close', (code) => {
      const ranMs = Date.now() - startedAt;
      this.publisher = null;
      if (this._watch) { clearInterval(this._watch); this._watch = null; }
      this._killSource();

      // A deliberate shape swap, not the broadcast ending: the socket is
      // now closed, so the replacement can safely connect.
      if (this._reshaping && !this._stopping) {
        this._finishReshape();
        return;
      }

      // An off-air break, not an ending: hold the engine and set the alarm.
      if (this._break && !this._stopping) {
        this.current = null;
        this._breakWait();
        return;
      }

      /**
       * Fresh death inside the reconnect window: the receiver was still
       * holding the previous session when the replacement knocked —
       * measured live, the refusal comes ~4s in and used to trip the
       * hard-fail heuristic and end the broadcast. Keep knocking until
       * the window closes; the source rebuilds with the publisher.
       */
      if (!this._stopping && ranMs < PUBLISH_FAIL_MS && this.current
          && (this._reconnectUntil ?? 0) > Date.now()) {
        this.emit('warn', 'the receiver refused the new session — the old '
          + 'one may still be draining; knocking again in 3s');
        this._reshaping = this._lastReshape
          && this._lastReshape.at > Date.now() - 60_000
          ? this._lastReshape
          : {
            item: this.current.item, offset: this.position,
            duration: this.current.duration,
          };
        const t = setTimeout(() => {
          if (!this._stopping) this._finishReshape(); else this._reshaping = null;
        }, 3000);
        t.unref?.();
        return;
      }

      /**
       * The receiver went away MID-broadcast — a restart, an update, a
       * blip. A publisher that streamed healthily for minutes and then
       * hit I/O death is not a broken config; it is the other end
       * rebooting, and the show should not die for that (operator-hit:
       * an ingest restart six minutes into a clean 1x broadcast ended
       * it). Open a generous reconnect window and knock: the knock
       * branch above owns the retries, the bank head-trim gives the
       * replacement an enterable stream, and the source resumes at what
       * had actually AIRED so viewers lose nothing but the outage
       * itself. Only when the window closes without a receiver does the
       * broadcast end the old way.
       */
      if (!this._stopping && this.current && ranMs >= PUBLISH_FAIL_MS) {
        this._reconnectUntil = Date.now() + 120_000;
        this._lastReshape = {
          item: this.current.item,
          offset: Math.max(0, this.aired ?? this.position ?? 0),
          duration: this.current.duration,
          at: Date.now(),
        };
        this.emit('warn', 'the receiver dropped mid-broadcast — reconnecting '
          + 'for up to 2 minutes while it comes back');
        this._reshaping = this._lastReshape;
        const t = setTimeout(() => {
          if (!this._stopping) this._finishReshape(); else this._reshaping = null;
        }, 3000);
        t.unref?.();
        return;
      }

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

    // Whatever the bank holds is for THIS publisher — drain it now. The
    // drain otherwise only runs on the next feed, and when the bank filled
    // before the publisher existed (the ramp burst at go-live does exactly
    // this), the feeder is parked on backpressure waiting for the drain:
    // a deadlock where the publisher sits at 0 KB until an unrelated chunk
    // completion kicks the pipeline, if one ever comes.
    this._bankDrain();
  }

  // ── source ───────────────────────────────────────────────────────────

  _killSource({ keepScheduler = false } = {}) {
    if (this.scheduler && !keepScheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }
    // Whoever was waiting on bank room will never be resumed now.
    if (this._bankRoom) { const cb = this._bankRoom; this._bankRoom = null; cb(); }
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
    /**
     * NUT head processing, once per source. The 25-byte fileid magic is
     * only legal at byte 0 of a file, so it is stripped before banking —
     * the demuxer keys on the main-header STARTCODE, measured working
     * without the magic. The header block (main + stream headers, up to
     * the first syncpoint) is captured for publisher restarts: bank trims
     * land on syncpoints, and a fresh demuxer needs headers before one.
     * Duplicate header packets mid-stream are legal (measured), so the
     * in-band copy every source emits stays in.
     */
    if (this._fmt === 'nut' && !src._nutDone) {
      src._nutBuf = src._nutBuf ? Buffer.concat([src._nutBuf, chunk]) : chunk;
      let head = src._nutBuf;
      if (head.length >= NUT_FILEID.length
          && head.subarray(0, NUT_FILEID.length).equals(NUT_FILEID)) {
        head = head.subarray(NUT_FILEID.length);
      }
      const sp = head.indexOf(NUT_SYNC);
      if (sp === -1) {
        // Headers not complete yet — a syncpoint follows within ~400
        // bytes normally; 1MB without one means this is not NUT at all.
        if (head.length < (1 << 20)) return;
      } else {
        this._nutHeader = Buffer.from(head.subarray(0, sp));
      }
      src._nutDone = true;
      src._nutBuf = null;
      chunk = head;
    }
    this._bank ??= [];
    /**
     * Each chunk carries the playhead it was encoded at, so we always know
     * how far viewers have actually got — the encoder runs up to a bank
     * ahead of them, and every restart has to resume from what they saw,
     * not from what was encoded.
     *
     * The TIMELINE stamp is read from the chunk's own bytes rather than
     * from `this.timeline`, which only moves when a progress report
     * arrives. A source that races — any copied clip, since a copy has no
     * -re and is limited only by the disk — pushes megabytes between two
     * reports: measured, 7.8MB (fifteen seconds of content) banked inside
     * 200ms, every chunk of it stamped tl=0. The bank then held nearly a
     * minute of content that claimed to be zero seconds deep, so the
     * depth cap never engaged and a cushion "cut to 3s" left 54s on air
     * ahead of the splice. The bytes cannot lie about their own time.
     */
    const stampAt = (this._published ?? 0) + (this._bankBytes ?? 0);
    const wireTl = this._fmt === 'ts'
      ? lastVideoPtsIn(chunk, (188 - (stampAt % 188)) % 188)
      : null;
    this._bank.push({
      data: chunk, pos: this.position, tl: wireTl ?? this.timeline,
      item: this.current?.item ?? null, gen: this._srcGen ?? 0,
      // Card bytes carry the CLIP's item (a hold never changes `current`),
      // so this flag is the only way resume() can tell a queued card from
      // queued content — a card that never aired is dropped, content is not.
      hold: this.holding === true,
    });
    this._bankBytes = (this._bankBytes ?? 0) + chunk.length;
    // Backpressure moves from the OS pipe to here: past the cap the source
    // pauses, and resumes once half the bank has aired.
    if (this._bankFull() && !this._srcPaused) {
      this._srcPaused = true;
      try { src.stdout.pause(); } catch { /* dying */ }
    }
    this._bankDrain();
  }

  /**
   * Bank bytes that did not come from a source process.
   *
   * The chunk workers used to pipe straight into the publisher, which
   * skipped everything that hangs off the bank: `aired`/`airedItem` never
   * moved, `_published` stayed at zero so the TS packet-alignment repair
   * had a byte count that omitted the whole clip, the preview window got
   * nothing, and `_checkHealth` bailed out because there was no source to
   * inspect — the parallel path ran a live broadcast with no watchdog at
   * all. Feeding the bank instead restores all of it at once.
   *
   * @returns {boolean} false when the bank is full and the caller should
   *   stop writing until `_bankResume` says otherwise.
   */
  _bankFeed(chunk) {
    this._bank ??= [];
    this._bank.push({
      data: chunk, pos: this.position, tl: this.timeline,
      item: this.current?.item ?? null, gen: this._srcGen ?? 0,
    });
    this._bankBytes = (this._bankBytes ?? 0) + chunk.length;
    const room = this._bankBytes <= this._bankMax;
    this._bankDrain();
    return room;
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
      // The clip viewers are watching just changed. Nothing else announces
      // this: status/queue/seek events all fire at the moment the ENCODER
      // moves on, which is a buffer earlier, so without this the panel kept
      // showing the previous episode's title for the whole of the next one.
      if (c.item !== this.airedItem) {
        this.airedItem = c.item;
        this.emit('nowplaying', this.snapshot());
      }
      // Seam between two source processes. A flush keeps this aligned (see
      // _bankFlush), but a source that CRASHED can have ended its output
      // anywhere in a packet — pad to the boundary so the next stream
      // starts clean rather than gluing onto a torn packet.
      if (c.gen !== this._drainGen) {
        this._drainGen = c.gen;
        /**
         * THE seam, announced where it actually is.
         *
         * Preview clients resync on this, and they need it at the splice
         * in the BYTE STREAM — not when a source process was spawned. A
         * cushion-kept change (skip, track or overlay apply) spawns its
         * successor seconds before the first of its bytes airs, so
         * announcing at spawn aimed the preview at the tail of the
         * OUTGOING clip and left the real parameter change unannounced:
         * the preview sat on the old episode while the queued one played.
         * Flush-based changes are unaffected — their bank is empty, so
         * spawn and seam coincide and this fires on the very next chunk.
         */
        this.emit('discontinuity');
        const torn = (this._published ?? 0) % 188;
        if (torn) {
          const pad = Buffer.alloc(188 - torn);
          try { w.write(pad); this._published += pad.length; } catch { break; }
          this._emitData(pad);
        }
        // The end-of-sequence announcement between two HEVC sources — see
        // hevcEosPacket. Injected at the seam so the next stream's CRA
        // resets every decoder downstream, hardware included.
        if (this._fmt === 'ts' && this.profile?.codec === 'hevc') {
          // Stamped at the new stream's own timeline: within a breath of
          // the surrounding packets, so no rebase machinery reacts to it.
          const eos = hevcEosPacket(c.tl ?? 0);
          try { w.write(eos); this._published += eos.length; } catch { break; }
          this._emitData(eos);
        }
      }
      let ok = false;
      try { ok = w.write(c.data); } catch { break; /* publisher died mid-write */ }
      // The wire's own record of how far the published stream reached.
      // `_published` still holds this chunk's start offset, which is what
      // aligns the 188-byte grid inside an arbitrary pipe-read split.
      if (this._fmt === 'ts') {
        const sent = lastVideoPtsIn(c.data, (188 - ((this._published ?? 0) % 188)) % 188);
        // Monotonic by construction: "the furthest the publisher has been
        // fed" cannot shrink within a session, whatever a container says.
        if (sent != null && !(sent < (this._sentVideoPts ?? -Infinity))) {
          this._sentVideoPts = sent;
          // The CONTENT position of that same byte, stamp-lag corrected:
          // pos and tl stamps advance in lockstep from the same progress
          // ticks, so the pts excess over the tl stamp is the same excess
          // in content time. This is what lets a flush rewind the
          // playhead to the byte viewers actually got, not to a stamp
          // that lags it by however much the encoder ran ahead.
          this._sentPos = c.pos != null && c.tl != null
            ? { pos: Math.max(0, c.pos + (sent - c.tl)), item: c.item }
            : null;
        }
      }
      // Bytes the publisher accepted — THAT is the liveness signal the
      // 20s guard wants. It used to key off the playhead moving instead,
      // which holds on the streaming path (position advances with every
      // progress block) but not on the chunked one, where position only
      // moves once per chunk: twenty seconds into a twenty-second chunk
      // the guard concluded nothing had aired and killed a healthy
      // broadcast. A wedged publisher still trips it, because a publisher
      // that has stopped draining stops accepting writes.
      this._lastAiredAt = Date.now();
      this._published = (this._published ?? 0) + c.data.length;
      // The drain runs at the publisher's own pace — the one steady
      // realtime heartbeat the chunked path has. Announcing progress here
      // is what makes the panel's clock tick every half second instead of
      // once per twenty-second chunk (feeding is bursty; airing is not).
      if (this.scheduler) {
        const now = Date.now();
        if (now - (this._airProgAt ?? 0) > 500) {
          this._airProgAt = now;
          const r = this._reserve();
          this.emit('progress', {
            position: this.position, speed: this.scheduler.speed?.() ?? null, drops: 0,
            buffer: r.seconds, bufferMax: r.max,
          });
        }
      }
      // Mirror of the publisher's input for preview windows: the exact bytes
      // going out, tapped after the write so a dead publisher mirrors
      // nothing. With no listener this is a no-op.
      this._emitData(c.data);
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

  /**
   * Is the cushion full? Seconds first, bytes as the ceiling.
   *
   * The byte cap exists to bound memory; the SECONDS cap is the actual
   * policy, and it is the one that must hold whatever the file's bitrate
   * turns out to be. Judging depth by bytes alone banked four times
   * bufferSeconds for a file cheaper than the profile and starved one
   * dearer than the estimate — the same fault in both directions.
   */
  _bankFull(margin = 1) {
    const secs = this._bankSeconds();
    if (secs != null && secs >= this.bufferSeconds * margin) return true;
    return (this._bankBytes ?? 0) >= this._bankMax * margin;
  }

  _bankResume() {
    if (process.env.JSR_TRACE && this._bankRoom) this.emit('log', `[trace] sink resumed bank=${this._bankBytes}\n`);
    // A chunk writer parked because the bank was full.
    if (this._bankRoom && !this._bankFull(0.9)) {
      const cb = this._bankRoom;
      this._bankRoom = null;
      cb();
    }
    // Resume as soon as there is meaningful room, not at half empty. Wide
    // hysteresis made the encoder work in long bursts — idle while the bank
    // drained to 50%, then a sprint to refill — and a burst cycle that
    // large shows up in any speed reading as a swing between well under and
    // well over realtime, depending on which phase you sampled. Keeping the
    // bank near full couples the encoder to the publisher's actual
    // consumption, which is what the figure should reflect.
    if (this._srcPaused && !this._bankFull(0.9)) {
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
  /** A throwing preview listener must never take the drain loop down. */
  _emitData(chunk) {
    // The preview pane is mpegts.js, which probes byte 0 for the 0x47 TS
    // sync marker — NUT bytes would blind it forever. Say so once instead
    // of feeding it garbage.
    if (this._fmt === 'nut') {
      if (!this._previewSaid) {
        this._previewSaid = true;
        this.emit('warn', 'panel preview cannot decode AV1 — preview is off for this broadcast; the stream itself is unaffected');
      }
      return;
    }
    try { this.emit('data', chunk); } catch { /* listener's problem */ }
  }

  /**
   * Make the bank end on a packet boundary WITHOUT discarding it.
   *
   * The seamless-apply counterpart to _bankFlush. A source that is killed
   * mid-write leaves a partial 188-byte packet at the bank's tail; splicing
   * the next source's output straight onto that produces a torn packet,
   * which is what kills the publisher's demuxer ("Error muxing a packet").
   * _bankFlush avoids it by completing the packet and throwing the rest
   * away — but here the rest is exactly what we are keeping, so the fix is
   * the other direction: drop the unfinished tail. Those bytes belong to a
   * packet the dead source was never going to finish anyway.
   *
   * Returns the number of bytes dropped, which is always under 188.
   */
  /**
   * Cut the cushion down to `keepSeconds`, from the NEWEST end.
   *
   * The bank runs oldest-first: the front is about to air, the back is the
   * furthest ahead the encoder has reached. Dropping from the back is what
   * makes a change arrive sooner — those are the frames that would have
   * played before it. Whatever is dropped has to be encoded again, so the
   * resume position moves back by exactly the time those bytes represented.
   *
   * Returns the seconds removed, so the caller can rewind by the same amount.
   */
  /**
   * The timeline of the content about to air — the front of the cushion.
   * `airedTimeline` is the byte-accurate answer once anything has been
   * drained; before that the first chunk's own stamp stands in.
   */
  _bankHeadTl() {
    if (this.airedTimeline != null) return this.airedTimeline;
    return this._bank?.[0]?.tl ?? null;
  }

  /**
   * How many SECONDS of content the bank holds, from its own stamps.
   *
   * Every chunk was stamped with the timeline it was encoded at, so the
   * bank knows the time of its own bytes exactly. Inferring it from a
   * bitrate instead was the bug behind a whole family of faults: the
   * figure was wrong by whatever the estimate was wrong by, in both
   * directions. A 4000 kbps file measured at 1593 made a "3s" cushion
   * really 1.2s, so an apply cut the pipe down to less than a spawn and
   * the publisher ran dry — the receiver looping a few frames at every
   * skip. The same estimate read high (16000 for a 4000 kbps file) had
   * banked four times the configured depth. Stamps have no such failure
   * mode. Null when the stamps cannot answer (a bank of one chunk, or a
   * card whose progress has not ticked), and callers fall back.
   */
  _bankSeconds() {
    const head = this._bankHeadTl();
    const last = this._bank?.[this._bank.length - 1];
    if (head == null || !last || last.tl == null) return null;
    return Math.max(0, last.tl - head);
  }

  /**
   * Cut the cushion down to `keepSeconds`, from the NEWEST end.
   *
   * Whole chunks only, and it stops as soon as the cushion is short
   * enough — so it errs toward keeping slightly MORE than asked, which
   * is the safe direction: the runway exists to cover the successor's
   * spawn, and overshooting costs a fraction of a chunk while
   * undershooting starves the publisher.
   *
   * Returns the seconds actually removed, read from the stamps.
   */
  _bankTrimTo(keepSeconds) {
    const head = this._bankHeadTl();
    const startTl = this._bank?.[this._bank.length - 1]?.tl ?? null;
    if (head == null || startTl == null) return this._bankTrimToBytes(keepSeconds);
    let dropped = 0;
    while (this._bank.length > 1) {
      const last = this._bank[this._bank.length - 1];
      if (last.tl == null) break;                       // unstamped: byte path
      if (last.tl - head <= keepSeconds) break;         // short enough now
      this._bank.pop();
      this._bankBytes -= last.data.length;
      dropped += last.data.length;
    }
    if (!dropped) return 0;
    const endTl = this._bank[this._bank.length - 1]?.tl ?? startTl;
    return Math.max(0, startTl - endTl);
  }

  /** The old byte-budget trim, kept for banks the stamps cannot describe. */
  _bankTrimToBytes(keepSeconds) {
    const perSecond = this._kbps * 125;
    const keepBytes = Math.max(0, Math.round(keepSeconds * perSecond));
    let excess = Math.max(0, (this._bankBytes ?? 0) - keepBytes);
    if (!excess) return 0;
    let dropped = 0;
    while (excess > 0 && this._bank?.length) {
      const last = this._bank[this._bank.length - 1];
      if (last.data.length <= excess) {
        excess -= last.data.length;
        dropped += last.data.length;
        this._bank.pop();
      } else {
        this._chunkShrink(last, excess);
        dropped += excess;
        excess = 0;
      }
    }
    this._bankBytes -= dropped;
    return dropped / perSecond;
  }

  /**
   * Truncating a banked chunk shortens the encode it represents; its
   * pos/tl stamps mark the chunk's END at push time and must shrink with
   * it, or a resume-from-tail lands ahead of the bytes that remain.
   */
  _chunkShrink(last, bytes) {
    last.data = last.data.subarray(0, last.data.length - bytes);
    const dt = bytes / (this._kbps * 125);
    if (last.pos != null) last.pos -= dt;
    if (last.tl != null) last.tl -= dt;
  }

  _bankTrimToPacket() {
    // The NUT equivalent of a packet boundary is a syncpoint: cut the bank
    // at the last one, dropping the partial frame group behind it, so the
    // next source's headers splice onto a complete group (measured clean).
    if (this._fmt === 'nut') {
      if (!this._bank?.length) return 0;
      const whole = Buffer.concat(this._bank.map((c) => c.data));
      const cut = whole.lastIndexOf(NUT_SYNC);
      if (cut <= 0) return 0;
      let excess = whole.length - cut;
      const dropped = excess;
      while (excess > 0 && this._bank?.length) {
        const last = this._bank[this._bank.length - 1];
        if (last.data.length <= excess) { excess -= last.data.length; this._bank.pop(); } else {
          this._chunkShrink(last, excess); excess = 0;
        }
      }
      this._bankBytes -= dropped;
      return dropped;
    }
    let excess = (this._bankBytes ?? 0) % 188;
    if (!excess) return 0;
    const dropped = excess;
    while (excess > 0 && this._bank?.length) {
      const last = this._bank[this._bank.length - 1];
      if (last.data.length <= excess) {
        excess -= last.data.length;
        this._bank.pop();
      } else {
        this._chunkShrink(last, excess);
        excess = 0;
      }
    }
    this._bankBytes -= dropped;
    return dropped;
  }

  /**
   * Trim the bank back to the last VIDEO random-access point, so the
   * splice junction lands on a complete GOP instead of mid-frame.
   *
   * _bankTrimToPacket makes the tail packet-aligned, but a packet
   * boundary is not a frame boundary: the junction truncated whatever
   * frame was in flight, and the decoder aired it as a single black
   * flash — reported by the operator at one-frame precision. Walking
   * back to the last packet with payload_unit_start + the adaptation
   * field's random_access_indicator on the video pid (0x100, ffmpeg's
   * first-stream default) ends the kept bank right before an IDR; the
   * replacement source re-encodes from there and opens with its own
   * fresh IDR, so the decoder never sees a partial frame. Costs up to
   * one GOP (~2s) of re-encode, which the cushion absorbs.
   *
   * Returns seconds dropped, so callers rewind the resume position.
   */
  _bankTrimToAccessPoint() {
    // NUT: the syncpoint trim IS the access-point trim (the live pipe that
    // calls this is vaapi-only and never runs for AV1, but stay safe).
    if (this._fmt === 'nut') {
      return this._bankTrimToPacket() / (this._kbps * 125);
    }
    this._bankTrimToPacket();
    if (!this._bank?.length) return 0;
    const whole = Buffer.concat(this._bank.map((c) => c.data));
    let cut = -1;
    for (let o = 0; o + 188 <= whole.length; o += 188) {
      if (whole[o] !== 0x47) continue;
      const pusi = (whole[o + 1] & 0x40) !== 0;
      const pid = ((whole[o + 1] & 0x1f) << 8) | whole[o + 2];
      const hasAf = (whole[o + 3] & 0x20) !== 0;
      const rai = hasAf && whole[o + 4] > 0 && (whole[o + 5] & 0x40) !== 0;
      if (pusi && rai && pid === 0x100) cut = o;
    }
    if (cut <= 0) return 0;
    const dropBytes = whole.length - cut;
    const perSecond = this._kbps * 125;
    let excess = dropBytes;
    while (excess > 0 && this._bank?.length) {
      const last = this._bank[this._bank.length - 1];
      if (last.data.length <= excess) { excess -= last.data.length; this._bank.pop(); } else {
        this._chunkShrink(last, excess); excess = 0;
      }
    }
    this._bankBytes -= dropBytes;
    return dropBytes / perSecond;
  }

  /**
   * Drop a final AUDIO frame the video trim cut in half.
   *
   * The bank is truncated at a VIDEO random-access point, but audio and
   * video are interleaved: an AAC frame that began before that point and
   * continued past it loses its tail, and the receiver decodes a partial
   * frame — "channel element 0.0 is not allocated", one click per splice,
   * and a decoder error is exactly what makes a player resync a beat
   * later. Measured at every cushion-kept splice before this.
   *
   * The frame cannot be completed, so it is removed: only the TS packets
   * carrying it are spliced out of the tail, which leaves the video
   * untouched and simply ends the audio one frame earlier — the successor
   * starts its own audio there anyway. Nothing moves in time.
   */
  _bankDropPartialAudioTail(pid = 0x101) {
    if (this._fmt !== 'ts' || !this._bank?.length) return 0;
    // One AAC frame is ~400 bytes; a generous window costs nothing.
    let scan = 0;
    const tailChunks = [];
    for (let i = this._bank.length - 1; i >= 0 && scan < 65536; i -= 1) {
      tailChunks.unshift(this._bank[i]);
      scan += this._bank[i].data.length;
    }
    const tail = Buffer.concat(tailChunks.map((c) => c.data));
    // The publisher's byte stream sets the grid; the tail begins wherever
    // the kept chunks do.
    const before = (this._bankBytes ?? 0) - tail.length;
    const grid = (188 - (((this._published ?? 0) + before) % 188)) % 188;

    let pusiAt = -1;
    let declared = 0;
    let payload = 0;
    for (let o = grid; o + 188 <= tail.length; o += 188) {
      if (tail[o] !== 0x47) return 0;                       // torn grid: leave it alone
      if ((((tail[o + 1] & 0x1f) << 8) | tail[o + 2]) !== pid) continue;
      const hasAf = (tail[o + 3] & 0x20) !== 0;
      const start = o + 4 + (hasAf ? 1 + tail[o + 4] : 0);
      if (start > o + 188) continue;
      if ((tail[o + 1] & 0x40) !== 0) {
        // A new PES starts here: the previous one is complete by
        // definition, so only the LAST one can be short.
        if (start + 6 > o + 188) return 0;
        pusiAt = o;
        declared = (tail[start + 4] << 8) | tail[start + 5];  // PES packet_length
        payload = (o + 188) - start;
      } else if (pusiAt >= 0) {
        payload += (o + 188) - start;
      }
    }
    // packet_length 0 means unbounded (video only) — nothing to judge.
    if (pusiAt < 0 || declared === 0 || payload >= declared + 6) return 0;

    // Splice this frame's packets out of the tail, keeping every other pid.
    const kept = [];
    for (let o = 0; o < tail.length; o += 188) {
      const whole = o + 188 <= tail.length;
      const isAudio = whole && tail[o] === 0x47
        && (((tail[o + 1] & 0x1f) << 8) | tail[o + 2]) === pid;
      if (o >= pusiAt && isAudio) continue;
      kept.push(tail.subarray(o, Math.min(o + 188, tail.length)));
    }
    const rebuilt = Buffer.concat(kept);
    const removed = tail.length - rebuilt.length;
    if (removed <= 0) return 0;
    // Put the rebuilt tail back as one chunk, inheriting the last chunk's
    // stamps so nothing downstream sees a new position.
    const last = tailChunks[tailChunks.length - 1];
    this._bank.length -= tailChunks.length;
    this._bank.push({ ...last, data: rebuilt });
    this._bankBytes -= removed;
    return removed;
  }

  /**
   * The splice bookkeeping every cushion-kept apply shares: cut the
   * cushion, GOP-align the junction, and rewind the OUTPUT timeline to
   * the trimmed tail. The trims discard seconds that were already
   * stamped, and a timeline left at the old frontier hands the publisher
   * a forward pts hole exactly that large — measured 10.6s per subtitle
   * switch with applySeconds=5. Players bridge the audio hole silently
   * but stall video on the wall clock, so every apply froze the picture
   * for the hole's length and banked that much A/V desync, sender's own
   * preview included. Same rule _bankFlush documents for the flush path:
   * the content gap and the timestamp gap are two halves of one mistake.
   * Resume comes from the tail chunk's own stamps so the seam's content
   * position and timeline agree with the bytes actually kept.
   */
  /**
   * Runway to keep in front of a cushion-kept apply — the wait the viewer
   * experiences, since the splice airs when the KEPT cushion has drained.
   *
   * The replacement source does not race the frontier: it re-encodes from
   * the splice point onward, so all the runway must cover is the spawn
   * (process start, input open, encoder init, first bytes) with margin,
   * plus a GOP for the aligned junction. That cost is MEASURED — every
   * clip spawn records wall time to its first byte, kept as a decaying
   * maximum so one slow SMB open is remembered and a lucky fast one does
   * not shrink the guard — which makes the runway self-tuning per box and
   * per graph shape. buffer.applySeconds remains the operator's CEILING
   * (never waits longer than configured); before any measurement exists
   * the configured value stands, so the first apply of a broadcast is
   * exactly as safe as it always was.
   */
  _applyRunway() {
    const cap = this.applySeconds ?? this.bufferSeconds ?? 15;
    if (this._spawnMs == null) return cap;
    const floor = (this._spawnMs / 1000) * 2 + (this.profile?.gopSeconds ?? 2) + 1;
    return Math.min(cap, Math.max(3, floor));
  }

  _bankCutForApply(keepSeconds = null) {
    // Timeline-to-content delta, read at the frontier BEFORE rewinding:
    // both advance in lockstep from the same progress reports, so their
    // difference is exact even though each lags the encoder slightly.
    const delta = (this.timeline ?? 0) - (this.position ?? 0);
    const rewound = this._bankTrimTo(keepSeconds ?? this.bufferSeconds);
    const gop = this._bankTrimToAccessPoint();
    const tail = this._bank?.[this._bank.length - 1] ?? null;
    // The kept bytes are the authority on where the splice really is: the
    // last video PES pts in the tail, plus one frame, is the next stamp
    // the publisher expects. Chunk stamps and byte/kbps arithmetic are
    // fallbacks — both lag or drift (measured +0.8..2.5s residual hole on
    // the flash+beep rig; the PES read brings the seam under a frame).
    // Whatever the trims above decided, the kept tail must not end on a
    // half-cut audio frame — including when no access point was found and
    // the RAP trim returned early.
    const audioDropped = this._bankDropPartialAudioTail();
    if (audioDropped) {
      this.emit('log', `[splice] dropped ${audioDropped}B of a half-cut audio frame\n`);
    }
    const exact = this._bankTailVideoPts();
    let tl = exact != null ? exact + this._frameSeconds() : tail?.tl ?? null;
    // Never below the sent frontier: with a THIN bank (the hold card's
    // trickle keeps it near-empty) the GOP trim can walk the kept tail
    // behind bytes the publisher already has, and a splice there is a
    // backward pts jump on the wire. Anything already sent is beyond
    // recall — the floor is one frame after it.
    const sentFloor = this._fmt === 'ts' && this._sentVideoPts != null
      ? this._sentVideoPts + this._frameSeconds()
      : null;
    if (tl != null && sentFloor != null && tl < sentFloor) tl = sentFloor;
    if (tl != null && tl < this.timeline) this.timeline = tl;
    const est = Math.max(this.aired ?? 0, (this.position ?? 0) - rewound - gop);
    // A tail from another clip (bank still carrying the previous episode)
    // cannot anchor a position within THIS one — fall back to arithmetic.
    const resume = tl != null && (tail == null || tail.item === this.current?.item)
      ? Math.max(this.aired ?? 0, Math.min(tl - delta, this.position ?? tl))
      : est;
    return { rewound, gop, resume };
  }

  /** One output frame, in seconds, from the selected video's rate. */
  _frameSeconds() {
    const m = /^(\d+)\/(\d+)$/.exec(this.selection?.video?.frameRate ?? '');
    if (m && +m[1] > 0) return +m[2] / +m[1];
    return 1 / 24;
  }

  /**
   * The pts of the LAST video PES in the bank, in seconds — the exact
   * splice point, read from the kept bytes themselves. Null when the
   * format is not TS or no video PES start survives in the tail chunks.
   */
  _bankTailVideoPts() {
    if (this._fmt !== 'ts' || !this._bank?.length) return null;
    // The bank continues the publisher's byte stream, so its 188-grid is
    // known EXACTLY from `_published` — walk every chunk forward on that
    // grid and keep the last video pts seen. The old version guessed the
    // grid from a tail concat's END and scanned backward; on real pipe
    // splits the guess missed the true tail by a few frames, and a card
    // spliced on the under-read landed ~0.2s behind cushion bytes already
    // sent (measured on the rig as an out-of-order DTS at the seam). A
    // chunk whose grid was torn by a crashed source scans as null and is
    // simply skipped — understating is safe, overstating never happens.
    let streamOff = this._published ?? 0;
    let pts = null;
    for (const c of this._bank) {
      const p = lastVideoPtsIn(c.data, (188 - (streamOff % 188)) % 188);
      if (p != null) pts = p;
      streamOff += c.data.length;
    }
    return pts;
  }

  /**
   * Drop the bank's HEAD forward to the first video access point — TS RAI
   * (or NUT syncpoint) — so a freshly spawned publisher begins at bytes a
   * demuxer can actually enter. The tail trims cut for splices; this is
   * the mirror image, for (re)spawned readers. No-op when the head is
   * already an access point, which a fresh source's start always is.
   */
  _bankTrimHeadToAccessPoint() {
    if (!this._bank?.length) return 0;
    const whole = Buffer.concat(this._bank.map((c) => c.data));
    let cut = -1;
    if (this._fmt === 'nut') {
      cut = whole.indexOf(NUT_SYNC);
      // Headers precede the first syncpoint on a fresh stream — keep them.
      if (cut <= 0 || this._published === 0) cut = -1;
    } else {
      // Cut at the PAT that precedes the first keyframe, not at the
      // keyframe itself: without PAT/PMT the demuxer cannot map the pids
      // and skips forward to the next repeat — landing mid-GOP again.
      // resend_headers re-emits PAT/PMT ahead of every keyframe, so one
      // is always right there.
      let lastPat = -1;
      for (let o = 0; o + 188 <= whole.length; o += 188) {
        if (whole[o] !== 0x47) continue;
        const pusi = (whole[o + 1] & 0x40) !== 0;
        const pid = ((whole[o + 1] & 0x1f) << 8) | whole[o + 2];
        if (pid === 0) lastPat = o;
        const hasAf = (whole[o + 3] & 0x20) !== 0;
        const rai = hasAf && whole[o + 4] > 0 && (whole[o + 5] & 0x40) !== 0;
        if (pusi && rai && pid === 0x100) {
          cut = lastPat !== -1 && lastPat < o ? lastPat : o;
          break;
        }
      }
    }
    if (cut <= 0) {
      if (this._published > 0 && whole.length > 0) {
        /**
         * No keyframe anywhere in the retained window — nothing in it is
         * enterable (measured: a 27MB window of 10s-GOP HEVC had none,
         * and the publisher that read it entered mid-GOP soup). Drop it
         * all: a respawned source is usually PAUSED right behind the full
         * bank with its fresh stream head — PAT/PMT, parameter sets, an
         * IRAP — stuck in the pipe, which is the best first byte a
         * publisher can get. Costs the cushion once, at a moment the
         * viewer is already rebuffering.
         */
        this.emit('log', `[bank] no access point in the retained `
          + `${(whole.length / 1024 / 1024).toFixed(1)}MB — dropping it; `
          + `the stream re-enters at the next clean head\n`);
        this._bank = [];
        this._bankBytes = 0;
        return whole.length;
      }
      return 0;
    }
    let drop = cut;
    const dropped = drop;
    while (drop > 0 && this._bank?.length) {
      const head = this._bank[0];
      if (head.data.length <= drop) { drop -= head.data.length; this._bank.shift(); } else {
        head.data = head.data.subarray(drop); drop = 0;
      }
    }
    this._bankBytes -= dropped;
    this.emit('log', `[bank] head trimmed ${(dropped / 1024 / 1024).toFixed(1)}MB `
      + `forward to the next keyframe for the fresh publisher\n`);
    return dropped;
  }

  _bankFlush() {
    // Discarding the bank cuts the publisher's stream wherever the last
    // drained PIPE READ happened to end — which is mid-packet essentially
    // always, since reads are ~64KiB and packets are 188 bytes. The
    // publisher's demuxer usually resyncs with a warning, but a torn
    // packet can parse as a malformed one and kill the whole broadcast
    // ("Error muxing a packet / Invalid data found"). Complete the
    // in-flight packet with its true bytes from the head of the bank, so
    // every splice lands exactly on a packet boundary.
    const w = this.publisher?.stdin;
    // NUT has no fixed packet size to complete; a torn frame packet at the
    // seam demuxes with a warning and costs at most one glitched frame
    // before the next syncpoint resyncs (measured on a mid-frame splice).
    const torn = this._fmt === 'nut' ? 0 : (this._published ?? 0) % 188;
    if (torn && w?.writable) {
      let need = 188 - torn;
      const head = [];
      for (const c of this._bank ?? []) {
        if (need <= 0) break;
        const take = c.data.subarray(0, need);
        head.push(take);
        need -= take.length;
      }
      // Bank ran out mid-packet (source died as it wrote): zeros keep the
      // alignment; the demuxer drops one bad packet instead of desyncing.
      if (need > 0) head.push(Buffer.alloc(need));
      const fill = Buffer.concat(head);
      try {
        w.write(fill);
        this._published += fill.length;
        this._emitData(fill);
      } catch { /* publisher already gone */ }
    }
    this._bank = [];
    this._bankBytes = 0;
    // The mark a flush leaves behind: whoever plays next starts against an
    // EMPTY pipe, unlike a natural episode advance where the bank still
    // carries the previous clip's tail. The chunked path reads this to
    // decide whether the publisher needs covering while chunks encode.
    this._flushed = true;
    // `aired` is a position WITHIN the clip it was recorded for. Straight
    // after an episode boundary it still refers to the previous episode,
    // and rewinding the new episode's playhead to it would drop playback
    // to an arbitrary offset — reachable by seeking just after a
    // transition, which is exactly when someone tests transitions.
    // The sent-frontier position is the same fact read from the wire —
    // exact where the stamp lags — and wins when it is for this clip.
    const sp = this._sentPos;
    if (sp && sp.item === this.current?.item && sp.pos < this.position) {
      this.position = sp.pos;
    } else if (this.aired != null && this.aired < this.position
        && this.airedItem === this.current?.item) {
      this.position = this.aired;
    }
    // The OUTPUT timeline has to rewind with it. `timeline` counts encoded
    // seconds, and -output_ts_offset starts each source from it — so after
    // discarding a bankful, a timeline left at the encoded value hands the
    // publisher a stream whose timestamps jump forward by exactly the
    // discarded amount. The content gap and the timestamp gap are two
    // halves of the same mistake; the local-file playout test catches this
    // one as an unreadable output.
    //
    // The SENT frontier is the authority when we have it: the next source
    // must continue one frame after the last video pts the publisher was
    // actually given. `airedTimeline` is only the chunk STAMP of that
    // byte, and stamps lag the wire — a hold card spawned on the stamp
    // landed hours behind the published stream once the stamps had gone
    // stale, and the receiver's per-stream offset correction turned the
    // backward jump into a discontinuity storm (video and audio pulled in
    // opposite directions, one line per packet). Stamps remain the
    // fallback for NUT/AV1, where no TS pts can be read.
    const sent = this._fmt === 'ts' && this._sentVideoPts != null
      ? this._sentVideoPts + this._frameSeconds()
      : null;
    if (sent != null) this.timeline = sent;
    else if (this.airedTimeline != null && this.airedTimeline < this.timeline) {
      this.timeline = this.airedTimeline;
    }
    this._bankResume();
  }

  /**
   * The pre-show card: SMPTE bars with a ticking clock until the scheduled
   * start. It is spawned as an ordinary clip so its natural end advances
   * into the first episode through the standard path, and every respawn
   * route (watchdog, crash, resume after pause) funnels back through
   * _play's guard below — which recomputes the remaining time from the
   * wall clock, so a respawned or paused countdown stays on schedule.
   */
  _playCountdown(until, { heading = 'STARTING SOON' } = {}) {
    this._killSource();
    this.holding = false;
    const seconds = Math.max(1, until - Date.now() / 1000);
    const when = new Date(until * 1000)
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    this.current = {
      item: {
        id: '__countdown__',
        title: heading === 'UP NEXT'
          ? `Interval — next at ${when}`
          : `Pre-show — live at ${when}`,
        duration: seconds,
        countdown: true,
        // Carried on the item so a respawn re-derives the wait from the
        // wall clock rather than replaying the original length.
        until,
        heading,
      },
      offset: 0,
      duration: seconds,
    };
    this.position = 0;
    this._spawnSource(buildCountdownArgs({
      profile: this.profile,
      selection: this.selection,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
      seconds,
      heading,
      nextTitle: this.queue[0]?.title ?? '',
    }), { kind: 'clip' });
  }

  /**
   * Off-air break: drain what viewers are owed, let the publisher close
   * its RTMP session cleanly, and come back with a fresh one at the hour.
   * Owncast shows its offline page in between — honest, unlike hours of
   * countdown card. The engine stays alive the whole time; the publisher
   * close handler sees _break and flips to 'break' instead of ending.
   */
  _goOffline(until) {
    this._killSource();
    this._break = { until, timer: null };
    this.current = null;
    // The panel must not go on showing the clip that just ended.
    this.aired = null;
    this.airedTimeline = null;
    this.airedItem = null;
    const p = this.publisher;
    if (!p) { this._breakWait(); return; }
    try {
      const tail = this._bank ?? [];
      this._bank = [];
      this._bankBytes = 0;
      for (const c of tail) {
        p.stdin.write(c.data);
        this._published = (this._published ?? 0) + c.data.length;
        this._emitData(c.data);
      }
      p.stdin.end();
    } catch { /* already gone — close handler still runs */ }
  }

  _breakWait() {
    if (!this._break || this._stopping) return;
    this.status = 'break';
    this.emit('status', this.status);
    const delay = Math.max(0, this._break.until - Date.now() / 1000);
    this._break.timer = setTimeout(
      () => this._detached(this._resumeFromBreak(), 'resuming from break'),
      delay * 1000);
  }

  /** Back on air: new publisher, new RTMP session, straight into the pin. */
  async _resumeFromBreak() {
    if (this._stopping || !this._break) return;
    if (this._break.timer) clearTimeout(this._break.timer);
    this._break = null;
    this.status = 'starting';
    this.emit('status', this.status);
    const first = this.queue[0];
    if (first) {
      try { await this._warm(first); } catch { /* cold start, still fine */ }
    }
    if (this._stopping) return;
    this._spawnPublisher();
    this._advance();
  }

  /**
   * Output frame size for a clip.
   *
   * Default: always the configured box, with bars padded in. With trimBars
   * the frame IS the content rectangle — which contentRect fits inside the
   * box, so this can only ever shrink the frame, never grow it. A 4K source
   * still lands at the configured height.
   */
  /**
   * Write this clip's Studio overlay to disk, or null if there is none.
   *
   * Per clip, because the times are clip-relative, {title} names what is
   * playing, and an input-side -ss rebases timestamps to zero — verified:
   * without that shift an event timed late in a clip never fires after a
   * seek. Failing here returns null rather than throwing: an overlay must
   * never be the reason a broadcast does not start.
   */
  /**
   * Picture overlays, resolved to files on disk and this source's timeline.
   *
   * `offset` shifts the show/hide times for the same reason the ASS events
   * are shifted: an input-side -ss rebases timestamps to zero, so an outro
   * logo written in clip time would be scheduled in the past and never
   * appear. Anything whose window has already closed is dropped rather than
   * handed to ffmpeg as an extra input that draws nothing.
   */
  /**
   * Where will `-ss offset` ACTUALLY land the video, in source time?
   *
   * Asked of ffmpeg itself, with the exact seek the spawn will use —
   * ffprobe's read_intervals seeks differently (measured: inclusive vs
   * a cue-table threshold that put ffmpeg a whole GOP earlier), and only
   * the real path's answer is worth having. -copyts keeps source
   * timestamps so the first packet's pts IS the landing; one keyframe's
   * worth of TS to a pipe, ~150ms. Null on any failure — the caller
   * then seeks unaligned, which is only the old behaviour.
   */
  _probeCopyLanding(srcPath, offset) {
    return new Promise((resolve) => {
      let enc; let probe;
      const done = (v) => { resolve(v); try { enc?.kill('SIGKILL'); } catch { /* gone */ } };
      try {
        enc = spawn('ffmpeg', ['-v', 'error', '-nostdin',
          '-ss', Number(offset).toFixed(3), '-copyts', '-i', srcPath,
          '-map', '0:v:0', '-c', 'copy', '-frames:v', '1',
          '-muxdelay', '0', '-f', 'mpegts', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'ignore'] });
        probe = spawn('ffprobe', ['-v', 'error',
          '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { done(null); return; }
      enc.stdout.pipe(probe.stdin);
      // A dying writer must not take the reader down mid-parse.
      probe.stdin.on('error', () => { /* EPIPE when ffmpeg exits first */ });
      let out = '';
      probe.stdout.on('data', (d) => { out += d; });
      const kill = setTimeout(() => {
        try { enc.kill('SIGKILL'); } catch { /* gone */ }
        try { probe.kill('SIGKILL'); } catch { /* gone */ }
      }, 8000);
      kill.unref?.();
      probe.on('close', () => {
        clearTimeout(kill);
        const v = parseFloat(String(out).trim().split(/[\s,]+/)[0]);
        done(Number.isFinite(v) ? v : null);
      });
      probe.on('error', () => { clearTimeout(kill); done(null); });
      enc.on('error', () => { /* probe's close settles the promise */ });
    });
  }

  _overlayImages(item, offset = 0, span = null) {
    const items = this.profile?.overlay ?? [];
    if (!items.length || !this.overlayDir) return [];
    const duration = this.current?.duration ?? item?.duration ?? null;
    const out = [];
    for (const it of items) {
      if (it?.type !== 'image' || it.enabled === false || !it.file) continue;
      // basename only: the filename reaches here from a client, and a path
      // that could climb out of the uploads directory would let any file on
      // the host be composited into a public broadcast.
      const name = basename(String(it.file));
      if (!name || name.startsWith('.')) continue;
      const path = join(this.overlayDir, name);
      if (!existsSync(path)) continue;

      // A picture is on screen for the whole clip: an overlay stays until
      // the operator removes it — the intro/outro windowing is gone.
      const start = null;
      const end = null;
      const animated = /\.gif$/i.test(name);
      const desc = {
        path,
        x: it.x, y: it.y, size: it.size, rotation: it.rotation,
        opacity: it.opacity,
        // Without these two the whole feature is inert: the builders read
        // the descriptor, not the config item, so a motion left out here
        // never reaches the filter graph however correct the rest is.
        motion: it.motion, speed: it.speed,
        animated,
        start, end,
      };
      // Pre-rendered at its final size, angle and opacity when the cache has
      // one; null on a miss, which starts the bake and composites live this
      // once — the same contract the still layer uses.
      desc.baked = animated ? this._animBaked(desc) : null;
      out.push(desc);
    }
    return out;
  }

  /**
   * Render every still picture into ONE transparent canvas-sized PNG, once,
   * and return its path — or null if there is nothing to bake.
   *
   * The subtitle canvas has to be built and uploaded every frame regardless,
   * so a still picture that is already IN that canvas costs nothing per
   * frame: no extra input, no overlay filter, no colourspace work. Compared
   * against compositing it live, over 720 frames of the real chain, the
   * difference is 1.169 ms/frame against 1.434 — the same as no picture at
   * all (1.164). The picture becomes free rather than cheaper.
   *
   * Cached by content: the key covers the canvas size and every descriptor
   * field that changes a pixel, so re-applying the same overlay reuses the
   * file and only a genuine edit pays the render.
   */
  _overlayLayer(images) {
    if (!this.cacheDir) return null;
    const { baked } = splitStaticImages(images);
    if (!baked.length) return null;
    try {
      const rect = contentRect(this.selection?.video, this.profile);
      const key = createHash('sha1')
        .update(JSON.stringify([rect.w, rect.h, baked]))
        .digest('hex').slice(0, 16);
      const out = join(this.cacheDir, `layer-${key}.png`);
      if (existsSync(out)) return out;
      const args = staticLayerArgs(baked, { width: rect.w, height: rect.h, out });
      if (!args) return null;
      /**
       * A miss bakes in the BACKGROUND and gives this spawn nothing.
       *
       * This used to be spawnSync, on the event loop, inside _play — and
       * _play is what setOverlay calls immediately after flushing the bank.
       * So applying a picture threw away the buffer and then blocked the
       * only thread that refills it, for as long as a full-frame PNG render
       * takes. The publisher had nothing to send for all of it, which is a
       * viewer-visible stall on Owncast, not a local hiccup. Same mistake
       * that parked the decode probe: never run speculative ffmpeg beside a
       * live encoder.
       *
       * Returning null is not a failure path — it is the live composite,
       * which is what already happens whenever the render fails. The clip
       * pays a per-frame picture this once; the next restart finds the file
       * cached and gets the free version.
       */
      if (!this._layerBaking.has(out)) {
        this._layerBaking.add(out);
        this._detached(this._bakeLayer(args, out), 'baking picture layer');
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * A GIF pre-rendered at its final size, angle and opacity — or null.
   *
   * The live graph re-ran scale, rotate and opacity on every GIF frame to
   * produce identical output each time. Measured against a heavily typeset
   * subtitle track over 60s: 2.71s live, 2.01s pre-baked, which is exactly
   * what a moving still costs — so those three filters were the whole
   * remaining penalty. The bake is lossless, so the pixels are the ones the
   * live path would have produced.
   *
   * Null on a miss, exactly like _overlayLayer: the bake runs in the
   * background and this clip composites live once. Never blocks the encoder.
   */
  _animBaked(img) {
    if (!this.cacheDir || !img?.animated || !img.path) return null;
    try {
      const rect = contentRect(this.selection?.video, this.profile);
      const w = Math.max(2, Math.round((Number(img.size) || 0.2) * rect.w));
      // Lossless RGBA is what made the old pre-rendered overlay experiment
      // reach 11GB an episode. A picture this wide is rare and not worth the
      // disk, so it keeps the live path.
      if (w > BAKE_MAX_WIDTH) return null;
      const key = createHash('sha1')
        .update(JSON.stringify([img.path, w, img.rotation ?? 0, img.opacity ?? 1]))
        .digest('hex').slice(0, 16);
      const out = join(this.cacheDir, `anim-${key}.mov`);
      if (existsSync(out)) return out;
      if (!this._animBaking.has(out)) {
        this._animBaking.add(out);
        this._detached(
          this._bakeAnim(animBakeArgs(img, { width: rect.w, out }), out),
          'baking animated picture',
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Render one animated picture off the live path. Never throws at the caller. */
  _bakeAnim(args, out) {
    return new Promise((resolve) => {
      let err = '';
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (d) => { if (err.length < 400) err += String(d); });
      p.on('error', (e) => { err ||= e.message; p.emit('close', -1); });
      p.on('close', (code) => {
        this._animBaking.delete(out);
        // A picture that will not pre-render is composited live, never a
        // broadcast that stops.
        if (code !== 0 || !existsSync(out)) {
          this.emit('warn', `animated overlay bake failed: ${
            err.trim().slice(0, 200) || `exit ${code}`}`);
        }
        resolve();
      });
    });
  }

  /** Render one still layer off the live path. Never throws at the caller. */
  _bakeLayer(args, out) {
    return new Promise((resolve) => {
      let err = '';
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', (d) => { if (err.length < 400) err += String(d); });
      p.on('error', (e) => { err ||= e.message; p.emit('close', -1); });
      p.on('close', (code) => {
        this._layerBaking.delete(out);
        // A layer that will not render is a picture composited live, never a
        // broadcast that stops.
        if (code !== 0 || !existsSync(out)) {
          this.emit('warn', `overlay layer render failed: ${
            err.trim().slice(0, 200) || `exit ${code}`}`);
        }
        resolve();
      });
    });
  }

  /**
   * Shrink the subtitle canvas to the band the script actually draws in.
   *
   * The transparent canvas is the most expensive thing the streaming path
   * does — 1.29 ms/frame of CPU on top of a 0.36 ms/frame floor, measured on
   * the real graph — and dialogue uses about a fifth of it. Rendering onto a
   * short canvas and putting it back at the bottom measured 1.65 -> 1.13
   * ms/frame, a third off the whole pipeline, bit-identical.
   *
   * Returns null for anything not provably safe, which sends the clip back
   * to the full-frame canvas it uses today. See subband.js for why the
   * analysis is a whitelist.
   */
  _subtitleBand(extractedPath, { overlayPath, fontsDir }) {
    if (!this.cacheDir || !extractedPath) return null;
    // A Studio caption is a second libass pass over the same canvas and can
    // sit anywhere on screen, so it keeps the full frame. Pictures do not
    // block a band: the builder moves them to the GPU instead of drawing
    // them into the canvas that is about to be cropped.
    if (overlayPath) { this._bandInfo = { reason: 'a text overlay is in use' }; return null; }
    const sub = this.selection?.subtitle;
    if (!sub || sub.bitmap) return null;
    try {
      const rect = contentRect(this.selection?.video, this.profile);
      // Pillarboxed output pads and repositions the canvas; banding it too
      // is a second geometry change on the same graph, unverified.
      if (rect.bars) { this._bandInfo = { reason: 'the output is pillarboxed' }; return null; }

      let src = readFileSync(extractedPath, 'utf8');
      const key = createHash('sha1')
        .update(src).update(`|${rect.w}x${rect.h}`)
        .digest('hex').slice(0, 16);
      const out = join(this.cacheDir, `band-${key}.ass`);

      /**
       * SubRip carries no geometry, so libass renders it through a generated
       * ASS header there is no way to reach from the filter's options. To
       * band it at all it has to become a real script first.
       *
       * That conversion is not quite free: ASS timestamps are centiseconds
       * where SubRip's are milliseconds, so a cue boundary can land one frame
       * either side of where it did. Measured against the original over 9601
       * frames of a real episode, 17 frames differ — 0.18%, all of them
       * on/off boundaries, every mid-cue frame bit-identical. Nothing about
       * how a subtitle looks or where it sits changes.
       */
      if (!/^\s*\[Script Info\]/im.test(src)) {
        const conv = join(this.cacheDir, `band-${key}.src.ass`);
        if (!existsSync(conv)) {
          // `-f ass` is not optional: the output is written to a .partial
          // first so a crash cannot leave a half-written script in the
          // cache, and that suffix hides the .ass extension ffmpeg would
          // otherwise pick the muxer from. Without it every SubRip track
          // fails this conversion and silently keeps the full canvas.
          const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
            '-nostdin', '-y', '-i', extractedPath, '-f', 'ass', `${conv}.partial`],
          { stdio: ['ignore', 'ignore', 'pipe'] });
          if (r.status !== 0 || !existsSync(`${conv}.partial`)) {
            this.emit('warn', `subtitle band: could not convert ${extractedPath}: ${
              String(r.stderr ?? '').trim().slice(0, 200) || `exit ${r.status}`}`);
            return null;
          }
          renameSync(`${conv}.partial`, conv);
        }
        src = readFileSync(conv, 'utf8');
      }

      this._subInfo = { events: (src.match(/^Dialogue:/gm) ?? []).length };
      const band = analyseAssBand(src, { width: rect.w, height: rect.h });
      /**
       * Say why, because otherwise there is no way to tell.
       *
       * A refused band is invisible from outside: the clip simply runs with
       * a full-height canvas, which is exactly what it looked like before
       * the band existed. Whether that is one stray typeset sign or the
       * dialogue itself decides whether the title is worth doing anything
       * about, and the analyser already knows.
       */
      if (!band.safe) {
        this._bandInfo = { reason: band.reason };
        this.emit('log', `[band] full-height canvas — ${band.reason}\n`);
        return null;
      }
      this._bandInfo = { applied: true, height: band.bandHeight };
      this.emit('log', `[band] ${rect.w}x${band.bandHeight} canvas`
        + ` — ${(100 - (band.bandHeight / rect.h) * 100).toFixed(0)}% less to rasterise\n`);

      if (!existsSync(out)) {
        const text = bandScript(src, band);
        if (!text) return null;
        writeFileSync(`${out}.partial`, text);
        renameSync(`${out}.partial`, out);
      }
      const fonts = fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '';
      return {
        filter: `subtitles=filename=${escapeFilterPath(out)}${fonts}`,
        height: band.bandHeight,
        y: rect.h - band.bandHeight,
        rect: { w: rect.w, h: rect.h },
      };
    } catch {
      return null; // never let an optimisation stop a broadcast
    }
  }

  /**
   * @param {string} [tag] distinguishes the chunked variant, which writes
   *   the same overlay against a different time base. One filename for both
   *   would let a clip transition rewrite the file under workers that are
   *   still opening it.
   */
  _overlayFile(item, offset, tag = '') {
    const items = this.profile?.overlay ?? [];
    if (!items.length || !this.cacheDir) return null;
    try {
      const ass = overlayAss(items, {
        width: this.profile.width,
        height: this.profile.height,
        duration: this.current?.duration ?? item?.duration ?? null,
        startOffset: offset,
      });
      if (!ass) return null;
      const out = join(this.cacheDir, `overlay-${process.pid}${tag}.ass`);
      writeFileSync(out, ass);
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Give up a GPU capability, permanently enough to survive the retry.
   *
   * Writing it to `profile` alone did NOT work, and never has: _play's very
   * first act is `this.profile = { ...this._box, ...shape }`, so a demotion
   * set just before calling _play was erased before the new command was
   * built. The retry then spawned a byte-identical filtergraph and failed
   * exactly the same way — which is how a driver rejecting one graph turned
   * into a dead clip instead of a fallback. The box is the source of truth,
   * so the box is what has to change.
   */
  _demote(fields) {
    Object.assign(this._box, fields);
    Object.assign(this.profile, fields);
    this._demoted = { ...(this._demoted ?? {}), ...fields };
  }

  /**
   * The promotion counterpart of _demote: adopt freshly probed capability
   * flags mid-broadcast. Needed for the very reason _demote writes the
   * box — _play rebuilds the profile from it, so a re-tune written to the
   * profile alone is erased by the exact respawn it was meant to steer.
   * That is how a broadcast started without subtitles (which never probed
   * the subtitle path, leaving gpuSubs=false in the box) sent its first
   * switch onto a subtitle into the chunk fallback, while a broadcast
   * started WITH subtitles switched between them on the GPU all day.
   *
   * Demotions outrank promotions: what this broadcast learned by failing
   * is not un-learned by a probe's promise.
   */
  retune(fields) {
    const upheld = { ...fields, ...(this._demoted ?? {}) };
    Object.assign(this._box, upheld);
    if (this.profile) Object.assign(this.profile, upheld);
  }

  _shapeFor(video) {
    const box = { width: this._box.width, height: this._box.height };
    const mode = this._box.frameSize ?? 'fixed';
    if (mode === 'fixed' || !video?.width || !video?.height) return box;

    if (mode === 'native' || mode === 'source') {
      // The source's DISPLAY size: anamorphic material is stored narrow and
      // stretched at playback, and encoding the stored size would squash it.
      let vw = video.width;
      const m = /^(\d+):(\d+)$/.exec(video.sar ?? '');
      if (m && +m[1] > 0 && +m[2] > 0) vw = vw * (+m[1] / +m[2]);
      const even = (n) => Math.max(2, Math.round(n / 2) * 2);
      // Only ever downscale. Upscaling 640x480 to fill 1080 costs five
      // times the macroblocks and adds no detail the source did not have —
      // the viewer's player does that for free.
      // 'source' has no ceiling at all; bounded only at 8K, past which
      // this is a broken probe rather than a file any encoder will take.
      if (mode === 'source') {
        return { width: Math.min(7680, even(vw)), height: Math.min(4320, even(video.height)) };
      }
      if (vw <= box.width && video.height <= box.height) {
        return { width: even(vw), height: even(video.height) };
      }
      const over = contentRect(video, this._box);
      return { width: over.w, height: over.h };
    }

    const r = contentRect(video, this._box);   // 'fit' — capped by the box
    return { width: r.w, height: r.h };
  }

  /**
   * Swap the publisher to a new frame shape.
   *
   * FLV announces width/height once, at connect, and the publisher owns a
   * single RTMP session — so a clip of a different shape cannot join the
   * one already running. Owncast sees this as the stream ending and a new
   * one starting, which is why trimBars is opt-in. Everything banked
   * belongs to the old shape and is dropped rather than fed to the new
   * session as frames of the wrong size.
   */
  _reshape(item, offset, duration, shape) {
    // Receivers hold the dying session until their own idle timeout
    // (Owncast's single-publisher rule, ~10s) and refuse the replacement
    // meanwhile. Open a window in which a fast publisher death means
    // "knock again", not "the config is broken".
    this._reconnectUntil = Date.now() + 30_000;
    this._reshaping = { item, offset, duration };
    this.emit('warn', `Switching output to ${shape.width}x${shape.height} for `
      + `${item?.title ?? 'the next clip'} — viewers reconnect once.`);
    this._killSource();
    this._bank = [];
    this._bankBytes = 0;
    // The replacement is brought up from the old publisher's close, not
    // here: Owncast accepts a single publisher, so connecting before the
    // previous RTMP session has actually gone is how you get refused.
    const p = this.publisher;
    if (!p) { this._finishReshape(); return; }
    try { p.kill('SIGKILL'); } catch { this._finishReshape(); }
  }

  /** Bring the new session up at the shape the pending clip needs. */
  _finishReshape() {
    const next = this._reshaping;
    if (!next) return;
    this._reshaping = null;
    // Remembered for the knock-again retry: a refused session must come
    // back to THIS offset, not to wherever the playhead drifted while
    // the retry timer ran (measured: the drift caused a second, useless
    // reconnect cycle).
    this._lastReshape = { ...next, at: Date.now() };
    // A fresh RTMP session restarts the viewer's clock, so the published
    // timeline starts over with it rather than resuming mid-episode.
    this.timeline = 0;
    this._clipBase = 0;
    // The sent frontier belongs to the OLD session's timeline — carrying
    // it across would drag every later flush back onto dead numbers.
    this._sentVideoPts = null;
    this._sentPos = null;
    this._spawnPublisher();
    // The publisher's close cleared the watchdog; the broadcast is
    // continuing, so it has to be re-armed or nothing supervises it again.
    if (!this._watch) {
      this._watch = setInterval(() => this._checkHealth(), 2000);
      this._watch.unref?.();
    }
    this._play(next.item, next.offset, { duration: next.duration });
  }

  /** Start (or restart) the source at a given offset within a clip. */
  _play(item, offset = 0, { duration = null } = {}) {
    // Restarting the countdown (watchdog respawn, resume after pause) must
    // re-derive its remaining length — it counts wall-clock time, not media.
    if (item?.countdown) {
      return this._playCountdown(item.until, { heading: item.heading });
    }
    // A playhead past the end of the clip is never a real request: seeking
    // there yields a clip a few seconds long that ends immediately and
    // respawns, over and over. Treat it as "this clip is finished" and let
    // the queue move on rather than grinding on the tail.
    const known = duration ?? item?.duration ?? null;
    if (known != null && offset > 0 && offset >= known - 1) {
      this.emit('warn', `playhead ${offset.toFixed(0)}s is past the end of `
        + `${item?.title ?? 'this clip'} (${known.toFixed(0)}s) — moving on`);
      this.position = 0;
      this._advance();
      return;
    }
    // Fold this clip's shape into the profile before anything reads it.
    // A change needs a new RTMP session, so hand off to _reshape and let it
    // call back into _play once the new publisher is up.
    const shape = this._shapeFor(this.selection?.video);
    const shapeChanged = shape.width !== this.profile.width
      || shape.height !== this.profile.height;
    if (shapeChanged && this.publisher && !this._reshaping) {
      this.profile = { ...this._box, ...shape };
      this._reshape(item, offset, duration ?? item?.duration ?? null, shape);
      return;
    }
    this.profile = { ...this._box, ...shape };
    // What a copied clip would hand the receiver to cut segments on.
    this.profile.srcGopSeconds = this._gopByPath?.get(item?.srcPath) ?? null;

    this._killSource();
    this.holding = false;
    this.current = { item, offset, duration: duration ?? item.duration ?? null };
    // Per clip, not per process: a reason left over from the previous title
    // would be reported as this one's.
    this._bandInfo = null;
    this._subInfo = null;
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
    const flushed = this._flushed === true;
    this._flushed = false;
    const workers = this._chunkWorkers();
    if (workers > 1 && this.selection?.subtitle) {
      // Chunked clips are many parallel encoders; one fifo cannot feed
      // them. They keep the classic apply-by-restart behaviour.
      this._pipedClip = false;
      if (this._ovFeed?.active) this._ovFeed.stopSync();
      this._playChunked(item, offset, cached, workers, flushed);
      this.emit('nowplaying', this.snapshot());
      this._fillDuration(item);
      return;
    }

    const overlayImages = this._overlayImages(item, offset);
    const overlayFile = this._overlayFile(item, 0);
    /**
     * The overlay pipe — the compositor path, and the default.
     *
     * When this clip is eligible, the overlay canvas is not part of the
     * source's command at all: a renderer process feeds it through a fifo,
     * and an overlay change replaces the renderer while THIS process, its
     * bank and the publisher run on untouched. buildRendererSpec and
     * buildSourceArgs both derive geometry from planOverlayPipe, so the
     * two ends of the pipe cannot disagree.
     *
     * Any failure here falls back to the classic restart path for this
     * clip rather than blocking playback — the pipe is an upgrade, never
     * a new way to not broadcast.
     */
    this._pipedClip = false;
    let pipePath = null;
    // Computed once and passed to BOTH the renderer and buildSourceArgs, so
    // the band analysis and the rate decision cannot diverge between them.
    const pipeAnimated = (this.profile?.overlay ?? []).some(
      (i) => i?.type === 'text' && i?.enabled !== false && i?.motion === 'bounce',
    );

    const pipeBand = this.profile?.overlayPipe && this.cacheDir
      ? this._subtitleBand(
        this.selection?.subtitle?.external
          ? this.selection.subtitle.path ?? null
          : cached?.path ?? null,
        { overlayPath: overlayFile, fontsDir: cached?.fontsDir ?? null },
      )
      : null;
    if (this.profile?.overlayPipe && this.cacheDir) {
      const rSpec = buildRendererSpec({
        profile: this.profile,
        selection: this.selection,
        srcPath: item.srcPath,
        shift: offset,
        clipOffset: offset,
        duration: clipDuration,
        extractedPath: cached?.path ?? null,
        fontsDir: cached?.fontsDir ?? null,
        overlayPath: overlayFile,
        overlayImages,
        subBand: pipeBand,
        overlayAnimated: pipeAnimated,
      });
      if (rSpec) {
        try {
          this._ovFeed ??= new OverlayFeed({
            // The canvas lives on the ramdisk: appends are page-cache
            // memcpys and the reaper's punched holes cost nothing.
            path: join(existsSync('/dev/shm') ? '/dev/shm' : this.cacheDir,
              `overlay-${process.pid}.fifo`),
            log: (m) => this.emit('log', m),
          });
          this._ovFeed.onCrash = () => this._rendererCrashed();
          this._ovFeed.resetSync();
          this._rendererCrashes = 0;
          const rArgs = rendererArgs(rSpec.spec);
          // The renderer spawns as visibly as the source: an entire hunt ran
          // blind on which files and filters production actually used.
          this.emit('log', `[spawn:overlay] ffmpeg ${this._redact(rArgs.join(' '))}\n`);
          this._ovFeed.spawnRenderer(rArgs);
          pipePath = this._ovFeed.path;
          this._pipedClip = true;
          this._pipeClipOffset = offset;
          /**
           * The pipe format, frozen for this source's life. Swaps rebuild
           * the renderer's interior against it — geometry and rate can
           * never follow an Apply, only the content can.
           */
          this._pipePin = {
            rect: rSpec.rect, eff: rSpec.eff, wide: rSpec.wide,
            width: rSpec.width, height: rSpec.height,
            rate: rSpec.rate, fps: rSpec.fps,
          };

        } catch (err) {
          this.emit('warn', 'overlay pipe unavailable — applying overlays '
            + `will restart the source: ${err.message}`);
          try { this._ovFeed?.stopSync(); } catch { /* fine */ }
          pipePath = null;
          this._pipedClip = false;
        }
      } else if (this._ovFeed?.active) {
        this._ovFeed.stopSync();
      }
    } else if (this._ovFeed?.active) {
      this._ovFeed.stopSync();
    }
    // The file's average rate, for the passthrough ceiling and the bank's
    // re-size below. Null when unstatable (SMB hiccup) or duration-less.
    let srcKbps = null;
    try {
      if (clipDuration > 0) {
        srcKbps = Math.round((statSync(item.srcPath).size * 8) / clipDuration / 1000);
      }
    } catch { /* keep null */ }

    const args = buildSourceArgs({
      srcPath: item.srcPath,
      srcKbps,
      copyAlign: this._copyAlignFor?.req === offset ? this._copyAlignFor : null,
      offset,
      // Offset 0: every graph restores the clip's timeline before drawing
      // the ASS, so the file is written in clip time. Shifting it here as
      // well applied the correction twice — harmless for an 'always'
      // caption, but it moved an intro/outro window by twice the seek, and
      // setOverlay() made a non-zero offset the normal case rather than a
      // rare one. Pictures below DO take the offset: they are timed by
      // `enable` on the overlay filter, which is read after the restore.
      overlayPath: overlayFile,
      overlayImages,
      subBand: pipeBand,
      // A bouncing CAPTION is drawn by libass onto the same canvas, so it
      // needs every frame exactly as a moving picture does. Without this it
      // was animated at half rate and visibly stepped.
      overlayAnimated: (this.profile?.overlay ?? []).some(
        (i) => i?.type === 'text' && i?.enabled !== false && i?.motion === 'bounce',
      ),
      // Deliberately a thunk, not a path. Baking touches the disk, which a
      // pure argv builder has no business doing — but only the builder knows
      // whether a band is going to be used, and a banded canvas carries no
      // pictures, so its layer would be rendered and then thrown away. Asking
      // lazily means the exact condition decides, with nothing duplicated
      // here to drift out of step with it.
      overlayLayer: () => this._overlayLayer(overlayImages),
      /**
       * A sidecar is already the file the analyser wants.
       *
       * External tracks are deliberately never extracted -- there is nothing
       * to extract, the script exists on disk -- so `cached` is null for
       * them and this used to hand the analyser null and bail at its first
       * guard. The band was therefore unreachable for every sidecar,
       * whatever the script contained, which is most of an anime library.
       * Measured on the box: Evangelion spawned a full 1440x1080 canvas
       * while its .en.ass sat there perfectly bandable.
       *
       * The analyser only reads the file, and the band script it writes
       * still lands in cacheDir, so nothing downstream can tell the
       * difference between this and an extracted one.
       */
      // The same analysis the renderer plan used — running it twice printed
      // two [band] lines and could in principle disagree with itself.
      subBand: pipeBand ?? this._subtitleBand(
        this.selection?.subtitle?.external
          ? this.selection.subtitle.path ?? null
          : cached?.path ?? null,
        { overlayPath: overlayFile, fontsDir: cached?.fontsDir ?? null },
      ),
      profile: this.profile,
      selection: this.selection,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
      extractedPath: cached?.path ?? null,
      fontsDir: cached?.fontsDir ?? null,
      duration: clipDuration,
      overlayPipe: pipePath,
    });

    /**
     * Passthrough housekeeping. The bank is byte-budgeted from the encode
     * bitrate, but a copied clip flows at the FILE's rate — an episode
     * denser than the configured rate would silently shrink the cushion
     * below the 15s the operator was promised. Re-size from the file's
     * measured average for this clip; encoded clips return to the base.
     */
    {
      const ci = args.indexOf('-c:v');
      const isCopy = ci !== -1 && args[ci + 1] === 'copy';
      /**
       * Is the clip going out with its HDR intact? Matched against the
       * spawned argv, not re-derived (the tonemap demotion taught us why):
       * a copied HDR file ships its PQ untouched, and the hdrPass encode
       * keeps the P010 surface with no tone map in the graph. Everything
       * else — including an HDR source being tone-mapped — is SDR on air.
       * The metadata push reads this to tell viewers honestly.
       */
      const argStr = args.join(' ');
      const wasHdrOnAir = Boolean(this.hdrOnAir);
      this.hdrOnAir = Boolean(this.selection?.video?.hdr)
        && (isCopy || (argStr.includes('format=p010') && !/tonemap/.test(argStr)));
      // The nowplaying push that announces a clip fires BEFORE this spawn
      // decides the range — announce again when the answer changes, or the
      // receiver keeps the stale one for the whole clip.
      if (this.hdrOnAir !== wasHdrOnAir) this.emit('nowplaying', this.snapshot());
      /**
       * COPY SEAM ALIGNMENT — the fix for the HEVC seek corruption.
       *
       * A copy-mode `-ss` splits the streams: the demuxer starts VIDEO at
       * a keyframe at-or-before the target (matroska cues, sometimes a
       * whole GOP early — measured 10s on open-GOP x265) while AUDIO
       * starts at the target itself. The publisher's per-stream
       * discontinuity handlers then disagree by exactly that gap and
       * flip-flop the offset on every packet — the receiver's A/V
       * baselines split and every segment is garbage until the broadcast
       * restarts (operator-reported, reproduced locally, 352 rebase lines
       * from one seek). No ffmpeg flag aligns them: -noaccurate_seek and
       * first_pts were both measured changing nothing.
       *
       * So ask the file where video will land (one ffprobe packet read,
       * ~150ms) and request THAT plus a millisecond — under the demuxer's
       * "greatest keyframe before the request" rule both streams then
       * start together, and the seek lands exactly on a keyframe like any
       * player's. The probe is async because _play must not block the
       * event loop; the token guards a supersede while it runs.
       */
      if (isCopy && offset > 0 && this._copyAlignFor?.req !== offset) {
        const tok = this._alignTok = {};
        const dur = clipDuration;
        this._detached((async () => {
          const landing = await this._probeCopyLanding(item.srcPath, offset);
          if (this._alignTok !== tok || this._stopping) return;
          if (landing != null && landing < offset - 0.005) {
            this.emit('log', `[seek] video will land on the keyframe at `
              + `${landing.toFixed(3)}s for a ${offset.toFixed(3)}s request — `
              + `audio seeks there too so the streams stay glued\n`);
          }
          this._copyAlignFor = { req: offset, landing: landing ?? offset };
          /**
           * No reconnect. That was tried — a copy->copy splice starting on
           * a CRA does not reset decoders, so the session was recycled to
           * force one — and the real receiver held its dying session and
           * refused every knock for 30+ seconds, ending broadcasts. The
           * decoder reset now travels IN-BAND instead: the drain injects
           * an end-of-sequence NAL at every HEVC seam (hevcEosPacket), so
           * the new stream's CRA legally begins a fresh coded sequence and
           * every decoder — hardware included — flushes and enters clean.
           */
          this._play(item, offset, { duration: dur });
        })(), 'aligning the copy seek');
        return;
      }
      if (this._copyAlignFor?.req === offset) this._copyAlignFor = null;
      /**
       * A copied clip ships the FILE's bytes, so the file's rate is the
       * one every seconds-from-bytes sum depends on: how deep the bank
       * runs, what a cushion-kept trim really keeps, what the reserve
       * meter reads. Taking the larger of configured and measured looked
       * conservative and was the opposite — a 4000 kbps file copied under
       * a 16000 kbps profile made the bank hold FOUR TIMES bufferSeconds.
       * The source (no -re on a copy) then raced to end-of-file a minute
       * early, the engine advanced while viewers still had a minute of
       * the previous episode banked, and the panel's clock dropped to the
       * new clip's zero while the wire was somewhere else entirely.
       * BANK_MIN_BYTES still floors a very light file.
       */
      /**
       * The byte figure is now only a memory CEILING — the cushion's real
       * limit is its depth in seconds (see _bankFull), read from the
       * chunk stamps. So take the larger of configured and measured: a
       * probe that reads low (Death Note measured 1593 kbps while the
       * wire carried 4000+) can no longer squeeze the bank below the
       * configured depth, and a file dearer than the profile still gets
       * room for its own bytes.
       */
      const kbps = isCopy ? Math.max(this._kbpsBase, srcKbps ?? 0) : this._kbpsBase;
      if (isCopy) {
        this.emit('log', `[passthrough] native HEVC, nothing to draw — source `
          + `bytes ship untouched (~${srcKbps ?? kbps} kbps); encode cost zero. An Apply `
          + `or subtitle switch arms a transcode via the usual respawn.\n`);
      } else if (isCopy && !copyKeyframesFitLive(this.profile)) {
        // Kept on the copy path only because re-encoding it would be
        // worse — say so, since the latency is the visible consequence.
        this.emit('warn', `${this.current?.item?.title ?? 'This title'} keyframes only `
          + `every ${this.profile.srcGopSeconds.toFixed(1)}s, so viewers will sit further `
          + `behind live on it. It is being copied anyway because it is HDR and `
          + `re-encoding would cost the HDR or the broadcast.`);
      } else if (this.profile?.codec === 'hevc'
          && this.selection?.video?.codec === 'hevc' && !this.selection?.subtitle
          && !copyKeyframesFitLive(this.profile)) {
        const cap = Number(this.profile?.copyMaxGopSeconds) > 0
          ? Number(this.profile.copyMaxGopSeconds) : 4;
        this.emit('log', `[passthrough] skipped — this file keyframes only every `
          + `${this.profile.srcGopSeconds.toFixed(1)}s, and a copied stream is cut into `
          + `segments exactly that long, which viewers sit several of behind live. `
          + `Encoding it puts a keyframe every ${this.profile.gopSeconds ?? 2}s instead `
          + `(encoder.copyMaxGopSeconds raises the bar if you prefer the free path).\n`);
      } else if (srcKbps != null && this.profile?.codec === 'hevc'
          && this.selection?.video?.codec === 'hevc' && !this.selection?.subtitle
          && srcKbps > (Number(this.profile?.copyLimitKbps) > 0
            ? Number(this.profile.copyLimitKbps) : 30000)) {
        // The one skip reason worth a sentence: the operator would
        // otherwise wonder why an obviously eligible file is encoding.
        this.emit('log', `[passthrough] skipped — this file averages `
          + `${srcKbps} kbps, over the ${Number(this.profile?.copyLimitKbps) > 0
            ? this.profile.copyLimitKbps : 30000} kbps copy limit; shipping it `
          + `raw would swamp the upload, so it goes through the encoder `
          + `(encoder.copyLimitKbps raises the limit).\n`);
      }
      if (kbps !== this._kbps) {
        this._kbps = kbps;
        this._bankMax = Math.min(bankCeiling(this.bufferSeconds),
          Math.max(BANK_MIN_BYTES, kbps * 125 * this.bufferSeconds));
      }
    }

    this._spawnSource(args, { kind: 'clip' });
    if (this.queue[0]) {
      this._detached(this._warm(this.queue[0]), 'reading ahead');
      this._detached(this._extract(this.queue[0]), 'extracting subtitles');
    }
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
  /**
   * How many chunk workers this clip deserves — decided here, not asked of
   * the user.
   *
   * Chunking only pays when the CPU is burning the subtitles: libass is
   * single-threaded, so one process is capped at one core no matter how
   * many the machine has. But the decision to chunk happens BEFORE the
   * graph is chosen, so switching it on also forces the CPU path and gives
   * up the GPU compositor — which is 2-4x cheaper for ordinary subtitles.
   * As a setting that was a trap: turning it up to use more cores quietly
   * stopped using the GPU, and on the common case made things slower.
   *
   * So: chunk only when this clip was going to burn on the CPU anyway, and
   * leave a core for the publisher, the audio and Node itself.
   */
  /**
   * What the buffer is doing, which is the difference between a warning and
   * an alarm.
   *
   * Falling behind is only fatal once the cushion runs out: at 0.9x with a
   * minute banked nothing is at risk yet, and at 0.99x with two seconds left
   * the broadcast is about to die. Time to empty is the honest number and it
   * is simple arithmetic — the bank drains at (1 - speed) seconds per second
   * of airtime.
   *
   * The absolute floor matters as much as the rate. A 6s cushion draining
   * slowly still reads "five minutes left", and it is one hiccup from empty;
   * anything under BUFFER_FLOOR_S counts as at risk whatever the arithmetic
   * says.
   */
  _bufferRisk(speed) {
    try {
      const left = this._reserve()?.seconds;
      if (!Number.isFinite(left)) return null;
      const drain = Math.max(0, 1 - speed);
      const empty = drain > 0.001 ? left / drain : Infinity;
      return {
        left,
        empty,
        atRisk: left < BUFFER_FLOOR_S || (Number.isFinite(empty) && empty < 60),
        text: `buffer ${left.toFixed(0)}s`
          + (Number.isFinite(empty)
            ? `, draining — empty in ~${Math.round(empty)}s at this rate`
            : ', holding'),
      };
    } catch {
      // Diagnosis must never throw on the warning path.
      return null;
    }
  }

  /**
   * The slow-clip report, tagged like every other engine line.
   *
   * It was framed in box-drawing at first, which fought the console rather
   * than helping it: each emitted line becomes its own timestamped row, so
   * every rule and every `|` was noise around content that was already
   * delimited. A `[perf]` prefix matches [subs], [band], [health] and
   * [cache], reads correctly when the rows are stacked, and still pastes
   * into an issue as a coherent block.
   */
  _slowReport(speed) {
    const secs = Math.round(SLOW_SUSTAIN_MS / 1000);
    /**
     * What the buffer is doing, which is the difference between a warning
     * and an alarm.
     *
     * Falling behind is only fatal once the cushion runs out: at 0.9x with
     * a minute banked nothing is at risk yet, and at 0.99x with two seconds
     * left the broadcast is about to die. The old head said "the stream
     * will stall" in both cases, which is wrong in the first and
     * under-states the second.
     *
     * Time to empty is the honest number and it is simple arithmetic: the
     * bank drains at (1 - speed) seconds per second of airtime.
     */
    let head = `[perf] encoding at ${speed}x — under realtime for ${secs}s`;
    const risk = this._bufferRisk(speed);
    const buffer = risk?.text ?? null;
    if (risk) {
      head += risk.atRisk
        ? ', the stream is about to stall'
        : ', the buffer is absorbing it for now';
    }
    return [
      head,
      ...(buffer ? [`[perf]   ${buffer}`] : []),
      ...this._diagnose().map((l) => `[perf]   ${l}`),
      '[perf] if none of that can change, the machine may simply be too small for',
      '[perf] this title — transcoding hardware is the other half of the equation.',
      '[perf] lowering the output resolution is the cheapest way to buy headroom.',
      `[perf] report it with these lines: ${ISSUES_URL}`,
      '',
    ].join('\n');
  }

  /**
   * Why THIS clip is expensive, assembled from what the engine already
   * decided — printed only when it is actually in trouble.
   *
   * The warning used to end with a fixed sentence naming subtitles as the
   * usual cause. On the one title that has genuinely run at the edge that
   * was wrong twice over: the cost was AV1 10-bit decode, and its subtitle
   * canvas could not have been made cheaper because the ink covers the
   * whole frame. An operator sent to the wrong lever loses an evening, so
   * this reports facts and leaves the conclusion to them.
   */
  _diagnose() {
    const out = [];
    const p0 = this.profile ?? {};
    const v = this.selection?.video ?? null;
    if (v) {
      const hw = !p0.swDecode && gpuDecodable(v);
      const dims = v.width && v.height ? ` ${v.width}x${v.height}` : '';
      let fps = '';
      try {
        const eff = effectiveFps(v, this.profile);
        // 24000/1001 is 23.976023976023978 in full, which is noise in a
        // report meant to be read.
        if (eff?.fps) fps = ` @ ${Number(eff.fps).toFixed(3).replace(/\.?0+$/, '')}fps`;
      } catch { /* diagnosis must never throw on the warning path */ }
      out.push(`source ${v.codec ?? 'unknown'}${v.pixFmt ? ` ${v.pixFmt}` : ''}${dims}${fps}`
        + ` — ${hw ? 'hardware' : 'SOFTWARE'} decode`
        + (/10le|10be|p010/i.test(v.pixFmt ?? '') ? ', 10-bit costs ~1.6x 8-bit' : ''));
      // Decode scales with the SOURCE, not the output. A 4K file downscaled
      // to 1080p costs four times a 1080p one and the old report hid that.
      if (v.width && v.height && p0.width && p0.height
        && (v.width !== p0.width || v.height !== p0.height)) {
        out.push(`scaling ${v.width}x${v.height} -> ${p0.width}x${p0.height} every frame`);
      }
      if (v.hdr) {
        // Which of these is running is a measured property of the driver,
        // and the CPU one is a real cost worth naming when someone is
        // reading this because the stream is struggling.
        out.push(this.profile?.tonemap === 'cpu'
          ? 'HDR source — tonemapped on the CPU every frame (this driver '
            + 'cannot do it on the GPU)'
          : this.profile?.tonemap === 'none'
            ? 'HDR source — NOT tonemapped; this machine cannot, so colours '
              + 'are wrong'
            : 'HDR source — tonemapped on the GPU every frame');
      }
    }
    const sub = this.selection?.subtitle;
    if (!sub) {
      out.push('no subtitles — not the cause');
    } else if (sub.bitmap) {
      out.push(`bitmap subtitles (${sub.codec ?? '?'}) — always CPU, never banded`);
    } else {
      const n = this._subInfo?.events ? ` (${this._subInfo.events} events)` : '';
      out.push(this._bandInfo?.applied
        ? `subtitle band ${this._bandInfo.height}px${n} — already reduced`
        : `full-height subtitle canvas${n}`
          + (this._bandInfo?.reason ? ` — band refused: ${this._bandInfo.reason}` : ''));
    }
    /**
     * What the operator has running in Studio — types and counts only.
     *
     * Never filenames or caption text: this block is meant to be pasted into
     * an issue, and what is on someone's broadcast is their business. The
     * shape is what matters for cost anyway.
     */
    const all = (this.profile?.overlay ?? []).filter((i) => i?.enabled !== false);
    const pics = all.filter((i) => i?.type !== 'text');
    const texts = all.filter((i) => i?.type === 'text');
    if (all.length) {
      const bits = [];
      if (pics.length) {
        const gifs = pics.filter((i) => /\.gif$/i.test(i?.file ?? '')).length;
        const moving = pics.filter((i) => i?.motion === 'bounce').length;
        const detail = [gifs && `${gifs} animated`, moving && `${moving} moving`]
          .filter(Boolean).join(', ');
        bits.push(`${pics.length} picture${pics.length === 1 ? '' : 's'}`
          + (detail ? ` (${detail})` : ''));
      }
      if (texts.length) {
        const moving = texts.filter((i) => i?.motion === 'bounce').length;
        bits.push(`${texts.length} caption${texts.length === 1 ? '' : 's'}`
          + (moving ? ` (${moving} moving)` : ''));
      }
      out.push(`studio: ${bits.join(', ')}`);
      if (pics.some((i) => i?.motion === 'bounce' || /\.gif$/i.test(i?.file ?? ''))) {
        out.push('  a moving or animated picture forces the CPU composite'
          + ' and a full-rate canvas');
      } else if (all.some((i) => i?.motion === 'bounce')) {
        out.push('  a moving caption forces a full-rate canvas so it does not step');
      }
    }

    // The surface libass actually rasterises, which is the number the band
    // exists to shrink — stated so it is obvious whether there is anything
    // left to win there. In pipe mode the truth comes from the PIN: an
    // earlier version of this report described the inline decision while
    // the pipe ran a full-height full-rate canvas, and the lie sent the
    // reader hunting in the wrong place.
    try {
      const rect = contentRect(v, this.profile);
      if (this._pipedClip && this._pipePin) {
        const pin = this._pipePin;
        out.push(`overlay pipe ${pin.width}x${pin.height} RGBA, `
          + 'change-driven — frames cross the pipe and upload only when the '
          + 'canvas changes; the composite itself runs every video frame');
        // A deliberate trade, chosen with the numbers on the table: the
        // always-on composite is what makes overlay changes free, and on a
        // small iGPU it costs real headroom. Say so, with the lever, so an
        // operator reading this at 0.7x knows it is policy rather than a bug.
        out.push('  the always-on overlay pipe trades GPU headroom for '
          + 'restart-free overlay changes; "overlayPipe": false in '
          + 'config.json trades it back');
      } else {
      const h = this._bandInfo?.applied ? this._bandInfo.height : rect.h;
      const halfRate = !all.some((i) => i?.motion === 'bounce'
        || /\.gif$/i.test(i?.file ?? ''));
      if (sub && !sub.bitmap) {
        out.push(`canvas ${rect.w}x${h} RGBA at ${halfRate ? 'half' : 'FULL'} frame rate`
          + `, uploaded and blended every frame`);
      }
      }
      if (rect.bars) out.push('output is pillarboxed — bars cost encode time too');
    } catch { /* diagnosis must never throw on the warning path */ }

    // Which graph ran, and why the alternative was not taken. Chunking looks
    // like the answer whenever a clip is slow and usually is not: it is the
    // CPU path, so it trades a struggling GPU for software decode.
    const workers = this._chunkWorkers();
    out.push(workers > 1
      ? `chunked path, ${workers} workers`
      : 'single process — chunking declined; it is the CPU path, so it would'
        + ' software-decode');

    // The lever, with its current value, so it can be changed without
    // going to look it up.
    // A software encode would dwarf everything above it, so name it.
    // Name the CODEC's actual encoder, not the backend bucket: the x264
    // backend also runs libx265 and libsvtav1, and a perf report that says
    // "x264" about an AV1 encode sends the reader down the wrong road.
    const encName = p0.backend === 'x264'
      ? ({ hevc: 'libx265', av1: 'SVT-AV1' }[p0.codec] ?? 'libx264')
      : p0.backend ?? 'unknown';
    out.push(`output ${p0.width ?? '?'}x${p0.height ?? '?'} at ${p0.videoBitrate ?? '?'}`
      + `, ${encName} encoder — the lever with the most headroom`);

    /**
     * The machine, because everything above is only expensive RELATIVE to it.
     *
     * The same clip streams comfortably on a desktop and stalls on a small
     * mini-PC, so a report without the hardware cannot be judged by anyone
     * reading it later — including us.
     */
    try {
      const cpu = cpus?.()[0]?.model?.replace(/\s+/g, ' ').trim() ?? 'unknown CPU';
      // availableMemory(), NOT totalmem(): under a container the host's total
      // is not what this service may use, and reporting it would have stated
      // a confident wrong number the moment anyone set a memory limit.
      const gb = Math.round(availableMemory() / 1073741824);
      // /dev/shm is separate from that and is what the run-ahead cache lives
      // in, so a small one is its own kind of constraint — and it is the
      // number the operator actually configured, via shm_size.
      let shm = '';
      try {
        const st = statfsSync('/dev/shm');
        const mb = Math.round((st.bsize * st.blocks) / 1024 ** 2);
        if (mb >= 1024) {
          const g = Math.round((mb / 1024) * 10) / 10;
          shm = `, ${String(g).replace(/\.0$/, '')}GB /dev/shm`;
        } else if (mb) shm = `, ${mb}MB /dev/shm`;
      } catch { /* not every host has one */ }
      out.push(`host ${cpu}, ${availableCores()} cores usable`
        + (gb ? `, ${gb}GB RAM for this service` : '')
        + shm
        + `, ${p0.device ?? 'no vaapi device'}`);
    } catch { /* diagnosis must never throw on the warning path */ }
    return out;
  }

  _chunkWorkers() {
    // SVT-AV1 threads itself across every core — parallel chunk workers
    // would fight it for the same cores AND need NUT chunk-file joining
    // the scheduler does not speak. One process is both simpler and right.
    if (this.profile?.codec === 'av1') return 1;
    // An explicit 2+ in the config still wins, for debugging on a box
    // whose behaviour we cannot predict. 0/1/absent means "decide for me".
    const manual = Number(this.profile?.parallelChunks);
    if (Number.isFinite(manual) && manual >= 2) return Math.min(manual, 8);

    const sub = this.selection?.subtitle;
    if (!sub) return 1;

    // Exactly the conditions buildSourceArgs uses to pick the GPU
    // composite. If it is available, it beats any number of CPU workers.
    //
    // Pictures are part of those conditions now: buildSourceArgs refuses
    // the GPU graphs when a clip carries any, because they composite on the
    // CPU. Without mirroring that here this returned 1 for a GPU box, the
    // single-process path was taken, and buildSourceArgs then fell to the
    // CPU anyway — libass burning subtitles on one core with no workers,
    // which is the unstreamable case the GPU graph exists to avoid. One
    // enabled logo was enough to trigger it on every subtitled clip.
    const video = this.selection?.video;
    const gpuComposite = Boolean(this.profile?.gpuSubs)
      && !this.profile?.swDecode
      && gpuDecodable(video)
      && !(this.profile?.barsFailed && contentRect(video, this.profile).bars);
    if (gpuComposite) return 1;

    // Every core burns subtitles. The old rule reserved one for the
    // publisher — but the publisher is a copy remux costing a few percent
    // of a core, and on a 4-core N100 that reservation was the difference
    // between 0.96x sustained (measured: cushion drained over six minutes,
    // then Owncast hung up) and ~1.28x. The publisher is protected by
    // PRIORITY instead: chunk encoders run niced below it, so its tiny
    // share is always served first and the workers soak up the rest.
    return Math.max(1, availableCores());
  }

  _playChunked(item, offset, cached, workers, flushed = false) {
    this._clipBase = this.timeline;
    const chunkSeconds = Number(this.profile?.chunkSeconds ?? 20);

    // Whether a cover card will feed the publisher while chunks encode —
    // see below. The scheduler must know: with a card up it must not
    // deliver until two chunks are in hand, or the card dies after the
    // short opener and the publisher starves through chunk 1's encode.
    const cover = flushed && Boolean(this.publisher) && !this._stopping;
    // A fresh name per scheduler, not one shared "-chunk" file. Stopping a
    // scheduler SIGKILLs its workers, but delivery is asynchronous relative
    // to us — so the next _playChunked could rewrite the file underneath a
    // worker still opening it. A counter makes that impossible instead of
    // unlikely.
    this._chunkGen = (this._chunkGen ?? 0) + 1;
    const chunkOverlay = this._overlayFile(item, 0, `-chunk${this._chunkGen}`);

    const sched = new ChunkScheduler({
      srcPath: item.srcPath,
      startOffset: offset,
      duration: this.current.duration,
      chunkSeconds,
      workers,
      holdUntilReady: cover,
      workDir: this._chunkPlan().dir,
      // A quarter of the budget retains what has already aired, so a
      // backward seek is served as cheaply as a forward one; the rest
      // runs ahead.
      ...(this._chunkPlan().ramBytes ? {
        aheadBytes: Math.ceil(this._chunkPlan().ramBytes * 0.75),
        aheadSeconds: (this._chunkPlan().ramBytes * 0.75) / streamBytesPerSecond(this.profile),
        keepBytes: Math.floor(this._chunkPlan().ramBytes * 0.25),
      } : {}),
      tsOffsetOf: (start) => this._clipBase + (start - offset),
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
        // Written once, outside this callback: workers run in parallel and
        // rewriting the file underneath one that is opening it is a race.
        // Offset 0, not the chunk's start — every chunk graph restores the
        // clip's own timeline before the overlay is drawn.
        overlayPath: chunkOverlay,
        // Per chunk, unlike the ASS above: pictures are timed by `enable`
        // on the overlay filter, which reads `t` AFTER the chain has undone
        // the -ss rebasing — so it counts from this chunk's own start, not
        // the clip's. These are plain descriptors with nothing written to
        // disk, so building them per chunk costs nothing and races nothing.
        overlayImages: this._overlayImages(item, start, dur),
      }),
    });

    sched.on('warn', (m) => this.emit('warn', m));
    // Two chunks encoded: one to send, one in hand. Only now is it safe to
    // open the RTMP session — before this the publisher would consume the
    // opening chunk at realtime and then sit silent through the next
    // chunk's encode, which is what Owncast drops a connection for. Not a
    // delay or a byte threshold: the condition is that the content
    // actually exists.
    sched.on('ready', () => {
      if (this._stopping || this.scheduler !== sched) return;
      // Mid-broadcast recovery: the card has covered the encode window and
      // real content is about to flow. Kill it BEFORE the first delivery
      // and shift every chunk to land just past it — the chunks were baked
      // before the card ran, and splicing them at their baked positions
      // steps the stream backwards by the card's whole duration, which the
      // publisher's -re pacer answers by sleeping exactly that long. The
      // margin covers the card's progress-report cadence (500ms, so its
      // true content end can exceed the timeline by up to that much),
      // rounded onto the audio grid; the seam becomes a small FORWARD gap,
      // which the pacer reads straight through.
      if (this.holding && this.source) {
        const h = this.source;
        this.source = null;
        this.holding = false;
        this._srcGen = (this._srcGen ?? 0) + 1;
        h.stdout?.removeAllListeners?.('data');
        try { h.stdout?.resume?.(); } catch { /* gone */ }
        try { h.kill('SIGKILL'); } catch { /* gone */ }
        sched.setShift(onAudioGrid(
          Math.max(0, this.timeline - this._clipBase) + 0.576,
        ));
        this.emit('discontinuity');
        this.emit('log', '[cover] card released — content shifted '
          + `${sched.shift.toFixed(3)}s to follow it\n`);
      }
      if (this.publisher) return;
      this.emit('log', '[chunks] cushion encoded — connecting\n');
      this._spawnPublisher();
      if (this.status === 'starting') {
        this.status = 'running';
        this._lastBlockAt = Date.now();
        this._lastAiredAt = Date.now();
        this.emit('status', this.status);
      }
    });
    // Chunk workers that keep failing must end the broadcast rather than
    // marching silently through the queue: the streaming path has this
    // guard (_deadClips) and lives in _spawnSource, which chunks never run.
    sched.on('fatal', (err) => {
      if (this.scheduler !== sched || this._stopping) return;
      this.emit('fatal', err);
      this.stop();
    });
    sched.on('chunkstart', (c) => {
      if (this.scheduler !== sched) return;
      this._feedChunk = { ...c, fed: 0 };
    });
    sched.on('chunk', ({ start }) => {
      if (this.scheduler !== sched) return;   // superseded mid-delivery
      // Never backwards: the within-chunk interpolation has already walked
      // the playhead to this chunk's end, and rewinding to its start here
      // made the timeline visibly jump back at every delivery.
      this.position = Math.max(this.position, start);
      this.timeline = this._clipBase + (start - offset) + chunkSeconds
        + (sched.shift || 0);
      const r = this._reserve();
      this.emit('progress', {
        position: this.position, speed: sched.speed(), drops: 0,
        buffer: r.seconds, bufferMax: r.max,
      });
    });
    sched.on('complete', () => {
      if (this.scheduler === sched) this._advance();
    });

    this.scheduler = sched;

    // A flush emptied the pipe, and nothing reaches it again until the
    // first chunk at the new offset finishes encoding — ~6s per seek on an
    // N100, and spammed seeks or pause/resume cycles stack those gaps past
    // the ~10s of silence after which Owncast hangs up. That is why seeking
    // worked on the streaming path (sub-second source respawn) and died on
    // the chunked one. A card at the current timeline keeps the publisher
    // fed for exactly that window; the sink kills it the moment real bytes
    // arrive. A natural episode advance never flushes, so it never shows a
    // card — the bank's tail of the previous episode covers it instead.
    if (cover) {
      this.holding = true;
      this._spawnSource(buildHoldArgs({
        profile: this.profile,
        selection: this.selection,
        tsOffset: this.timeline,
        statsPeriodMs: this.statsPeriodMs,
        label: 'Loading',
      }), { kind: 'hold' });
    }

    // Into the bank, not straight at the publisher — see _bankFeed. A
    // Writable keeps pipe() backpressure working, so a fast worker cannot
    // outrun the bank cap.
    const sink = new Writable({
      // Small on purpose. Everything the sink QUEUES is beyond the reach
      // of a flush — the bank can be emptied and the source unpiped, but
      // slices already inside this buffer still arrive afterwards, and
      // after a cache seek that was up to 1MB of the OLD chunk landing
      // behind the seek's aligned cut: the preview mirror lost its
      // 188-byte phase permanently and every client joining after a seek
      // showed a frozen picture. Kept tiny, backpressure parks data in
      // the readable side instead, which a destroy actually discards.
      highWaterMark: 16 * 1024,
      write: (chunk, _enc, cb) => {
        // Superseded mid-flight. A skip flushes the bank and then starts
        // the next clip, but this scheduler keeps writing until it is
        // stopped — and those bytes would land AFTER the discard, in
        // front of the new source, to be decoded against its timestamps.
        // That is the "timestamp discontinuity" then h264 reference
        // overflow then frozen picture seen when skipping mid-clip.
        // _bankPush has always had this guard; the chunk sink had not.
        if (this.scheduler !== sched || this._stopping) return cb();
        // Real content has arrived — the cover card has done its job. Kill
        // it without touching the scheduler, and bump the generation so
        // the drain pads the card's final partial packet instead of
        // splicing chunk bytes into the middle of it.
        if (this.holding && this.source) {
          const h = this.source;
          this.source = null;
          this.holding = false;
          this._srcGen = (this._srcGen ?? 0) + 1;
          h.stdout?.removeAllListeners?.('data');
          try { h.stdout?.resume?.(); } catch { /* gone */ }
          try { h.kill('SIGKILL'); } catch { /* gone */ }
          // Safety net: ready normally releases the card first (and sets
          // the placement shift); this catches a card that somehow
          // survived to the first delivery.
          this.emit('discontinuity');
        }
        if (this.status === 'starting' && this.publisher) {
          // Running means AIRING. Flipping on the first encoded byte —
          // before the publisher even existed — made the panel's clock
          // track the encoder through the pre-live minute and then snap
          // back to 0:00 at connect. Until the publisher is up, the
          // broadcast is honestly still starting: the clock sits at 0:00
          // and the cache band shows the cushion being built.
          this.status = 'running';
          this._lastBlockAt = Date.now();
          this._lastAiredAt = Date.now();
          this.emit('status', this.status);
        }
        this._sawBlock = true;
        // Playhead interpolation within the streaming chunk, so the time
        // display moves every half second instead of once per chunk.
        const fc = this._feedChunk;
        if (fc?.bytes) {
          fc.fed += chunk.length;
          this.position = fc.start + fc.dur * Math.min(1, fc.fed / fc.bytes);
        }
        if (this._bankFeed(chunk)) return cb();
        if (process.env.JSR_TRACE) this.emit('log', `[trace] sink parked bank=${this._bankBytes}\n`);
        this._bankRoom = cb;      // released by _bankResume
        return undefined;
      },
    });
    sink.on('error', () => { /* publisher gone; close handler deals with it */ });
    sched.start(sink);

    // Before the publisher exists nothing else emits progress, so the
    // panel's pre-live chip and cache band froze at their first values
    // while the cushion silently grew. Tick once a second until connect.
    const preTick = setInterval(() => {
      if (this.publisher || this.scheduler !== sched || this._stopping) {
        clearInterval(preTick);
        return;
      }
      const r = this._reserve();
      this.emit('progress', {
        position: 0, speed: sched.speed(), drops: 0,
        buffer: r.seconds, bufferMax: r.max,
      });
    }, 1000);
    preTick.unref?.();
  }

  /**
   * Where chunk files live. With the run-ahead cache on, that should be
   * RAM: /dev/shm is tmpfs everywhere this runs, so files there ARE
   * memory, and the failing disk under the cinema container never sees
   * the churn. Falls back to the cache dir when /dev/shm is missing or
   * too small for the budget (a Docker default of 64MB shm is the common
   * case — raising shm_size fixes it).
   */
  _chunkPlan() {
    if (this._chunkPlanPick) return this._chunkPlanPick;
    const disk = join(this.cacheDir ?? '/tmp', `chunks-${process.pid}`);
    const shm = `/dev/shm/streamerr-${process.pid}`;
    const budget = this.runAhead?.ramBytes ?? null;
    let plan = { dir: disk, ramBytes: null };
    // The cache NEVER falls back to disk — a cushion of minutes churning
    // gigabytes through a drive is exactly the wear the RAM cache exists
    // to avoid, and the cinema box's disk is already dying. No room in
    // RAM means no cushion: the legacy near-sighted bound, whose handful
    // of transient chunks still prefer tmpfs when any is available.
    try {
      const st = statfsSync('/dev/shm');
      const free = st.bavail * st.bsize;
      // What the tmpfs can actually carry, with headroom for the transient
      // remux copies made at delivery. A budget larger than reality is
      // clamped, not refused — the whole point of 'auto' is fitting what
      // the machine has, and 4GB of shm serving a 4.9GB ask by switching
      // OFF was the opposite of that.
      const usable = Math.floor(free / 1.3);
      if (budget && usable >= 128 * 1024 ** 2) {
        plan = { dir: shm, ramBytes: Math.min(budget, usable) };
        if (usable < budget) {
          this.emit('log', `[cache] budget clamped to ${Math.round(usable / 1024 ** 2)}MB — `
            + `/dev/shm holds ${Math.round(free / 1024 ** 2)}MB (raise shm_size for the full `
            + `${Math.round(budget / 1024 ** 2)}MB)\n`);
        }
      } else if (free > 256 * 1024 ** 2) {
        plan = { dir: shm, ramBytes: null };
        if (budget) {
          this.emit('warn', 'run-ahead cache off: /dev/shm too small to be worth using '
            + `(${Math.round(free / 1024 ** 2)}MB free). Not falling back to disk.`);
        }
      } else if (budget) {
        this.emit('warn', 'run-ahead cache off: no usable /dev/shm. Not falling back to disk.');
      }
    } catch {
      if (budget) this.emit('warn', 'run-ahead cache off: no /dev/shm. Not falling back to disk.');
    }
    this._chunkPlanPick = plan;
    return plan;
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
    // AWAITED, not detached: the copy decision is made when the clip
    // spawns, and _warm is what runs before it. Detached, the answer for
    // the first clip of a broadcast always arrived too late and it shipped
    // untouched whatever its keyframes looked like. The probe reads the
    // head the warm pass just pulled into cache, so it costs little, and
    // it is bounded — a file it cannot measure simply keeps the old
    // behaviour.
    await this._measureGop(item.srcPath);
  }

  /**
   * How often this file carries a keyframe, in seconds.
   *
   * Only a COPIED clip needs it, and it decides whether copying is
   * viable at all. Live delivery cuts segments at keyframes — HLS, DASH,
   * every packager, which is why this is not a question about any one
   * ingest — so a copied stream's segment length IS the file's keyframe
   * interval, and nothing downstream can shorten it. Measured against a
   * real receiver: a 3.5s-keyframe source produced 3.5s segments even
   * with the segment target set to 1s. A viewer then sits several of
   * those behind the edge, and a file with sparse or uneven keyframes
   * gives uneven segments, which is what makes a player stall and snap.
   * Our own encode emits a keyframe every gopSeconds, which is why the
   * same title behaves the moment anything forces a transcode.
   *
   * One ffprobe of the first seconds, cached per path, off the spawn
   * path entirely.
   */
  async _measureGop(srcPath) {
    if (!srcPath) return null;
    this._gopByPath ??= new Map();
    if (this._gopByPath.has(srcPath)) return this._gopByPath.get(srcPath);
    this._gopByPath.set(srcPath, null);
    try {
      const { execFile } = await import('child_process');
      const out = await new Promise((resolve) => {
        // PACKET FLAGS, not `-skip_frame nokey`: the latter has to DECODE
        // to find keyframes, and on a build without that decoder it
        // returns nothing at all — silently, so the measurement would
        // read "unknown" and the copy path would never be gated on the
        // very machines this matters for (observed on the deploy box:
        // empty output, no error). A packet's keyframe flag needs no
        // decoder and measured identically here on both fixtures.
        const c = execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-read_intervals', '%+30', '-show_packets',
          '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', srcPath],
        { maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
        setTimeout(() => { try { c.kill(); } catch { /* gone */ } resolve(''); }, 15_000).unref?.();
      });
      let packets = [];
      try { packets = JSON.parse(out || '{}').packets ?? []; } catch { return null; }
      const ks = packets
        .filter((k) => String(k.flags ?? '').includes('K'))
        .map((k) => parseFloat(k.pts_time ?? k.dts_time))
        .filter((n) => Number.isFinite(n));
      if (ks.length < 3) return null;
      // SORT first: ffprobe reports frames in DECODE order and a
      // reordered stream's presentation stamps run out of order there,
      // so raw consecutive differences are not intervals at all — they
      // come out negative and, once those are dropped, two and three
      // times the real gap. Measured on a 6s-keyframe file: unsorted it
      // read 12s and 18s.
      ks.sort((a, b) => a - b);
      const gaps = ks.slice(1).map((v, i) => v - ks[i]).filter((g) => g > 0.02);
      if (gaps.length < 2) return null;
      // The worst ordinary gap, not the mean: one long stretch without a
      // keyframe is one long segment, and that is what viewers feel.
      gaps.sort((a, b) => a - b);
      const gop = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.9))];
      this._gopByPath.set(srcPath, gop);
      this.emit('log', `[keyframes] ${srcPath.split('/').pop()} — one every `
        + `${gop.toFixed(2)}s\n`);
      return gop;
    } catch { return null; }
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
    this._detached(this._extract(item), 'extracting subtitles');
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
      // Only before the broadcast exists. `position` is the live playhead
      // once anything is on air, and extraction sweeps the WHOLE file in
      // seconds — writing that here told the engine the viewer was at the
      // end of the episode, so the next respawn seeked there: -ss 1523 on a
      // 1547s file, a 24-second clip, another respawn, and the publisher
      // fed a splice every few seconds until Owncast dropped the stream.
      // The progress bar this drives only exists before going live anyway.
      if (this.publisher) return;
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
      extractSubtitle(item.srcPath, sub, this.cacheDir, onProgress, this._abort.signal),
      extractFonts(item.srcPath, this.cacheDir, this._abort.signal),
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
  _spawnHold(label = 'Paused', { keepScheduler = false } = {}) {
    this._killSource({ keepScheduler });
    this.holding = true;
    this._spawnSource(buildHoldArgs({
      profile: this.profile,
      selection: this.selection,
      tsOffset: this.timeline,
      statsPeriodMs: this.statsPeriodMs,
      label,
    }), { kind: 'hold' });
  }

  _spawnSource(args, { kind }) {
    // A source process implies a publisher, always. Deciding that earlier —
    // from _chunkWorkers, before _play has resolved the geometry — was a
    // prediction, and it could disagree with the branch actually taken: a
    // clip whose worker count collapses to 1 once the video is known takes
    // this path, which has no `ready` event to fall back on, and the
    // publisher was never spawned at all. The bank then filled against a
    // drain that bails on a missing stdin, so nothing was ever published
    // and the only symptom was the 20s liveness guard. Tie it to the fact
    // instead of the forecast.
    if (!this.publisher && !this._stopping) this._spawnPublisher();
    this.emit('log', `[spawn:${kind}] ffmpeg ${args.join(' ')}\n`);
    // The splice this process causes is announced when its bytes actually
    // reach the publisher (the generation change in _bankDrain), not here:
    // with a cushion kept that is seconds later, and resyncing the preview
    // now would aim it at the outgoing clip.
    // Generation tag: lets the drain notice the seam between two source
    // processes and repair packet alignment there if the old one ended
    // mid-packet (a crash can cut its output anywhere).
    this._srcGen = (this._srcGen ?? 0) + 1;
    // Backpressure state is per-process: carrying a stale `paused` flag into
    // a new source means the bank cap is never applied to it again.
    this._srcPaused = false;
    this._sawBlock = false;
    // What we ACTUALLY spawned. The failure handlers below used to key off
    // this.selection and this.profile, which are rebuilt from a copy of the
    // box and can drift from the command that is really running — a forced
    // GPU tone map died twice in a row on Mesa without ever demoting,
    // because some condition describing the intended state was false while
    // tonemap_vaapi sat in the argv all along. Match the argv.
    this._lastArgs = Array.isArray(args) ? args.join(' ') : '';
    this._lastBlockAt = Date.now();
    const startedAt = Date.now();
    // fd 3 carries -progress so it doesn't fight stderr for the log stream.
    const s = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    this.source = s;

    // Through the bank, not a direct pipe — see BANK_MAX_BYTES.
    // The first byte also closes the spawn-cost measurement that feeds
    // _applyRunway — clip sources only, since cards and holds are not
    // what a cushion-kept apply respawns.
    let sawFirstByte = false;
    s.stdout.on('data', (d) => {
      if (!sawFirstByte) {
        sawFirstByte = true;
        if (kind === 'clip') {
          const ms = Date.now() - startedAt;
          this._spawnMs = this._spawnMs == null ? ms : Math.max(ms, this._spawnMs * 0.7);
          // The number behind every "feels sluggish": seeks and applies
          // cannot land on the wire faster than this.
          this.emit('log', `[spawn] first byte in ${ms}ms (runway ${this._applyRunway().toFixed(1)}s)\n`);
        }
      }
      this._bankPush(s, d);
    });

    const parser = new ProgressParser();
    const startOffset = kind === 'clip' ? (this.current?.offset ?? 0) : 0;
    let lastOut = 0;
    // Encoding slower than realtime starves the pipe. Owncast ends the
    // broadcast after ten seconds of silence, so this is fatal if sustained —
    // and dying without saying why is the worst version of it.
    let slowSince = null;
    let lastSlowReport = null;
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
        // Consumption-paced canvas: hold the renderer's lead near the
        // encode head so an Apply's continuation point is always close.
        //
        // SOURCE-LOCAL time, not clip-absolute: the canvas clock restarts
        // with each source (-ss makes the video 0-based, NUT carries those
        // pts). Feeding clip-absolute position here after a SEEK made the
        // reaper believe every canvas byte was ~600s consumed — it punched
        // the whole file to zeros under the reader and the broadcast froze
        // at the seek point (measured live on the N100, pos pinned for 98s
        // while the source idled). clipOffset 0 hid this on every unseeked
        // clip.
        this._ovFeed?.pace?.(this.position - (this._pipeClipOffset ?? 0));
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
          /**
           * Repeats while it stays bad, rather than once per process.
           *
           * This used to latch: one report per source process and no more.
           * A single title struggling for twenty minutes produced exactly
           * one line, so "three reports" could only ever mean three
           * different clips — the sustained case, which is the one worth
           * interrupting over, could never reach it.
           *
           * Recovery clears slowSince below, so a brief dip still has to
           * re-earn its first report with another full SLOW_SUSTAIN_MS.
           */
          const due = lastSlowReport == null
            || Date.now() - lastSlowReport >= SLOW_REPEAT_MS;
          if (due && Date.now() - slowSince > SLOW_SUSTAIN_MS) {
            lastSlowReport = Date.now();
            const x = Math.round(recent * 100) / 100;
            this.emit('tooslow', { speed: x });
            this.emit('log', this._slowReport(x));
            /**
             * The breakdown goes to the console; the popup only says to look
             * there, and only once a pattern is established.
             *
             * One slow clip is worth recording and not worth interrupting
             * anyone over — it can be a single heavy title in an otherwise
             * fine library. Three is a pattern. And the console is hidden
             * behind Developer mode, so an operator who has never turned it
             * on would otherwise be pointed at a page that is not in their
             * sidebar.
             */
            this._slowReports = (this._slowReports ?? 0) + 1;
            // A cushion about to run out is not a pattern to confirm over
            // four minutes — it is the emergency the popup exists for.
            const urgent = this._bufferRisk(x)?.atRisk === true;
            if ((urgent || this._slowReports === 3) && !this._slowNoticed) {
              this._slowNoticed = true;
              this.emit('warn', 'Playback keeps falling behind. Details are in '
                + 'the console — enable Developer mode in Settings to see it.');
            }
            /**
             * A sustained-slow clip whose pipe is compositing NOTHING is
             * paying the idle arming pass for a studio that is hidden —
             * headroom a marginal title (4K HDR: 1.02x -> 0.78x from the
             * pass alone) cannot spare. Shed it: demote the idle arming
             * for the rest of the broadcast and respawn cushion-kept at a
             * GOP boundary, the same move an overlay apply makes. The
             * next "show" on this broadcast pays the classic respawn —
             * the old behaviour, on exactly the titles that always had it.
             * Visible overlays are the operator's explicit choice and are
             * never shed here.
             */
            const idleArmed = this._pipedClip && this.profile?.overlayConfigured
              && !this.profile?.noIdleArm
              && !(this.profile?.overlay ?? []).some((i) => i?.enabled !== false);
            if (idleArmed && this.current && this.status === 'running') {
              this._demote({ noIdleArm: true });
              this.emit('log', '[overlay] idle pipe shed — this title cannot '
                + 'afford the armed composite pass; show/hide costs a respawn '
                + 'for the rest of the broadcast\n');
              const item = this.current.item;
              const dur = this.current.duration;
              const tok = (this._selToken = (this._selToken ?? 0) + 1);
              this._detached(this._extract(item).finally(() => {
                if (this._stopping || this._selToken !== tok) return;
                if (this.current?.item !== item || this.status !== 'running') return;
                const { resume } = this._bankCutForApply();
                this._play(item, resume, { duration: dur });
              }), 'shedding the idle overlay pipe');
            }
          }
        } else {
          slowSince = null;
        }
      }

      const reserve = this._reserve();
      this.emit('progress', {
        position: this._onAir().position,
        // While a scheduler is working, ITS throughput is the only honest
        // ratio. A cover card is a live source too, and its own encode
        // speed (~1x for black frames) alternated with the scheduler's
        // real number on the panel — 1x and 0.7x blinking in quick
        // succession through every rebuild.
        speed: this.scheduler ? (this.scheduler.speed?.() ?? speed) : speed,
        drops: b.dropFrames,
        // Reserve in seconds — how much stall the broadcast can absorb.
        // Bank on the streaming path, bank+cache on the chunked one.
        buffer: reserve.seconds,
        bufferMax: reserve.max,
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
        // Hardware DECODE failing is its own fault, and a different one
        // from the composite failing: the driver cannot read this file at
        // all. It surfaces far downstream — the decoder falls back to
        // software frames, the VAAPI filters reject them, and the encoder
        // reports -22 — so match on the real message, not the symptom.
        // Decoding on the CPU keeps filters and encode on the GPU.
        if (!this._sawBlock && !this.profile?.swDecode && this.current
            && /hwaccel initialisation returned error|Failed setup for format vaapi/i.test(stderr)) {
          this.profile.swDecode = true;
          this.emit('warn', 'This file cannot be decoded by the GPU '
            + '(10-bit H.264 is the usual reason) — decoding on the CPU and '
            + 'keeping the rest on the GPU.');
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }

        /**
         * Tone mapping is demoted before anything else, because on an HDR
         * source it is the likeliest thing to have killed the clip and the
         * cheapest to give up — the CPU route produces the same picture.
         *
         * This exists because a PROBE cannot answer this question for
         * hardware nobody has tested. Two drivers refuse in two different
         * ways and at two different stages: Mesa fails the capability query
         * outright, Intel's iHD builds the filter happily and then rejects
         * a frame that carries no mastering-display metadata. A third
         * driver will invent a third way, and every one of them surfaces as
         * -22 on the ENCODER, several stages downstream from the cause.
         *
         * So the graph is attempted and the result is believed. Anything
         * that cannot tone map on the GPU — for any reason, known or not —
         * lands here and keeps broadcasting.
         */
        if (!this._sawBlock && this.current && !this._tonemapDemoted
            && /tonemap_vaapi/.test(this._lastArgs ?? '')) {
          this._tonemapDemoted = true;
          this._demote({ tonemap: 'cpu' });
          this.emit('warn', (this.profile?.tonemapForced
            ? 'HDR tone mapping is set to "GPU" in Settings, but this driver '
              + 'would not do it for this file — falling back to the CPU so the '
              + 'broadcast keeps running. Change the setting to Auto to stop '
              + 'seeing this.'
            : 'This driver would not tone map this HDR file on the GPU — doing '
              + 'it on the CPU for this broadcast.')
            + ' That costs real headroom at 4K; a 1080p output frame size gives '
            + `it back. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }

        /**
         * And if the CPU route cannot run either, go out washed rather than
         * not at all. A build without zscale has no third option.
         */
        if (!this._sawBlock && this.current && !this._tonemapGaveUp
            && /,tonemap=\w+/.test(this._lastArgs ?? '')) {
          this._tonemapGaveUp = true;
          this._demote({ tonemap: 'none' });
          this.emit('warn', (this.profile?.tonemapForced
            ? 'The HDR tone mapping chosen in Settings could not run on this '
              + 'machine, and neither could the CPU fallback. '
            : 'Tone mapping failed on the GPU and the CPU. ')
            + 'This HDR title will go out with washed-out colours rather than '
            + `not at all. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }

        /**
         * Demoted FIRST, before pictures and subtitles, because it is the
         * only one of the three the viewer cannot see us give up.
         *
         * Skipping an identity scale_vaapi hands the decoder's own surfaces
         * straight to the composite and the encoder, and a driver that
         * dislikes that pool answers the way this driver answers everything
         * it dislikes: -22, several stages downstream. Putting the pass back
         * costs a tenth of the frame rate; dropping a picture or falling to
         * CPU burn-in costs far more, so this is the cheapest thing to try
         * before either of those.
         */
        if (!this._sawBlock && this.current && !this.profile?.noIdentitySkip
            && !this._identityDemoted
            && scaleIsIdentity(this.selection?.video, this.profile,
              contentRect(this.selection?.video, this.profile))) {
          this._identityDemoted = true;
          this._demote({ noIdentitySkip: true });
          this.emit('warn', 'This driver would not encode straight from the '
            + `decoder's surfaces — restoring the scaling pass. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }

        // Pictures are demoted BEFORE subtitles, and separately. A picture
        // composite failing says nothing about the subtitle composite, and
        // the subtitle one is the expensive thing to give up — dropping it
        // sends a 1080p episode to CPU burn-in for the rest of the
        // broadcast. Retrying without the picture keeps everything else on
        // the GPU and costs the viewer one logo.
        if (!this._sawBlock && this.current
            && !this.profile?.noGpuImages && !this._gpuImgDemoted
            && (this.profile?.overlay ?? []).some(
              (i) => i?.type === 'image' && i.enabled !== false && i.file)) {
          this._gpuImgDemoted = true;
          this._demote({ noGpuImages: true });
          this.emit('warn', 'This driver would not composite a picture overlay on '
            + `the GPU — drawing it on the CPU instead for this broadcast. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }

        if (!this._sawBlock && this.profile?.gpuSubs && this.selection?.subtitle
            && !this._gpuSubsDemoted && this.current) {
          this._gpuSubsDemoted = true;
          this._gpuSubFails = (this._gpuSubFails ?? 0) + 1;
          // Scope the demotion to what actually failed: the pillarboxed
          // composite failing says nothing about plain 16:9 clips, and
          // demoting everything sent full-HD episodes to the CPU for the
          // rest of the broadcast for no reason.
          if (contentRect(this.selection?.video, this.profile).bars) {
            this._demote({ barsFailed: true });
          } else {
            this._demote({ gpuSubs: false });
          }
          this.emit('warn', 'GPU subtitle compositing failed on this driver — '
            + `retrying this clip with CPU burn-in. (${tail})`);
          this._play(this.current.item, this.position,
            { duration: this.current.duration });
          return;
        }
        /**
         * The overlay pipe is demoted LAST, after every more specific
         * demotion has had its claim: a piped HDR clip dying at the tone
         * map should lose the tone map, not the pipe. What lands here is a
         * driver refusing the piped composite itself — a graph shape no
         * probe has vouched for on hardware nobody tested.
         *
         * Matched on the argv that actually ran, not on intended state:
         * profile flags are rebuilt from a copy per clip and have drifted
         * from the running command before (see the tonemap demotion).
         */
        if (!this._sawBlock && this.current && !this._pipeDemoted
            && /overlay-\d+\.fifo/.test(this._lastArgs ?? '')) {
          this._pipeDemoted = true;
          this._demote({ overlayPipe: false });
          try { this._ovFeed?.stopSync(); } catch { /* already down */ }
          this._pipedClip = false;
          this.emit('warn', 'This driver would not run the overlay pipe — '
            + 'falling back to classic overlay applies (with restarts) for '
            + `this broadcast. (${tail})`);
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

  /**
   * Report a fault from a detached promise instead of letting it end the
   * process. Anything the engine kicks off outside a request — advancing a
   * clip, warming a file, extracting subtitles — runs with no caller to
   * catch it, and Node treats an unhandled rejection as fatal. Losing the
   * broadcast AND the panel because one clip failed to start is the worst
   * possible trade.
   */
  _detached(promise, what) {
    Promise.resolve(promise).catch((err) => {
      this.emit('warn', `${what} failed: ${err?.message ?? err}`);
    });
    return promise;
  }

  /**
   * Give the GPU a clean try at every clip.
   *
   * Whether a clip can composite on the GPU is a property of THAT clip —
   * its pixel format, its geometry, whether it is pillarboxed — so a
   * failure carries no information about the next one. This used to latch
   * after two failures and send the rest of the broadcast to the CPU,
   * which meant two bad clips early in a 30-episode queue cost the other
   * 28 their hardware path for the whole evening.
   *
   * Re-checking is nearly free: a composite that is going to fail does so
   * before producing a single block, so the wasted work is one short-lived
   * ffmpeg. Paying that per clip is far cheaper than burning hours of
   * episodes on the CPU because of a transient at the start.
   *
   * The per-clip flag still stands, so a clip that fails falls back once
   * and does not loop.
   */
  _rearmGpu() {
    if (this.profile?.swDecode) delete this.profile.swDecode;
    if (!this._demoted) return;
    // Both, or the next _play rebuilds the profile from the box and undoes
    // the re-arm exactly as it used to undo the demotion.
    for (const store of [this.profile, this._box]) {
      if (this._demoted.barsFailed) delete store.barsFailed;
      if (this._demoted.gpuSubs === false) store.gpuSubs = true;
    }
    // noGpuImages is deliberately NOT re-armed. A driver that refused the
    // picture composite will refuse it on the next clip too, and re-arming
    // would buy a failed spawn and a stumble at every episode boundary for
    // a capability we already know is absent. It resets when the broadcast
    // does, which is when the device might genuinely be different.
    //
    // noIdentitySkip is kept for the same reason: whether the encoder will
    // take the decoder's surfaces is a property of the driver, not of the
    // clip, so re-arming buys one dead spawn per episode to relearn it.
    const keep = this._demoted.noGpuImages || this._demoted.noIdentitySkip
      || this._demoted.overlayPipe === false || this._demoted.noIdleArm
      ? {
        ...(this._demoted.noGpuImages ? { noGpuImages: true } : null),
        ...(this._demoted.noIdentitySkip ? { noIdentitySkip: true } : null),
        // A driver that refused the piped composite once will refuse it on
        // the next clip too; re-arming would buy a dead spawn per episode.
        ...(this._demoted.overlayPipe === false ? { overlayPipe: false } : null),
        // Shed once, shed for the broadcast: re-arming the idle pass per
        // clip would relearn the same 30s slow verdict at every episode
        // boundary of a heavy queue.
        ...(this._demoted.noIdleArm ? { noIdleArm: true } : null),
      }
      : null;
    this._demoted = keep;
    this._gpuSubsDemoted = false;
    this._tonemapDemoted = false;
    this._tonemapGaveUp = false;
  }

  /** Move to the next queued clip, or end the broadcast. */
  _advance() {
    this._rearmGpu();
    // A pinned item waits for its wall-clock time behind an interval card
    // rather than starting early. Peek, don't shift: the card's natural end
    // re-enters here, and by then the time has arrived.
    const pinned = this.queue[0];
    if (pinned?.startAt != null && pinned.startAt - Date.now() / 1000 > 5) {
      this.emit('queue', this.snapshot());
      // Two kinds of break: a card keeps the stream up with a countdown,
      // going offline actually ends the session until the hour — the right
      // choice for a long pause, where hours of card is just dead air.
      if (pinned.breakOffline) this._goOffline(pinned.startAt);
      else this._playCountdown(pinned.startAt, { heading: 'UP NEXT' });
      return;
    }

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

    // Tracks are re-resolved per clip; see resolveSelection.
    const withTracks = async () => {
      if (!this.resolveSelection) return;
      try {
        const sel = await this.resolveSelection(next);
        if (sel && !stale()) {
          this.selection = sel;
          this.emit('selection', sel);
        }
      } catch (err) {
        this.emit('warn', `could not re-check tracks for ${next.title}: ${err.message}`);
      }
    };

    // Extraction for the next clip normally finishes during the previous
    // one's playback — but a skip can arrive minutes before that, and
    // playing anyway would burn subtitles straight from the container: the
    // exact stall that makes large files unplayable. Hold the pipe with a
    // card instead. The publisher keeps writing, so Owncast never notices,
    // and the wait is visible rather than a mystery.
    this._detached(withTracks().then(() => {
      if (stale()) return;
      if (this._needsExtraction(next)) {
        this.current = { item: next, offset: 0, duration: next.duration ?? null };
        this.position = 0;
        this.status = 'preparing';
        this._spawnHold('Preparing subtitles');
        this.emit('status', this.status);
        this.emit('nowplaying', this.snapshot());
        this._detached(this._extract(next).finally(() => {
          if (stale()) return;
          this.status = 'starting';
          this.emit('status', this.status);
          this._play(next, 0);
        }), `preparing ${next.title ?? 'the next clip'}`);
        return;
      }
      this.prepare(next).finally(() => {
        if (stale()) return;
        this._play(next, 0);
      });
    }), `starting ${next.title ?? 'the next clip'}`);
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
    // "Start now" while a pre-show or interval card is on air. Without
    // clearing the pin, _advance sees the same future time and simply
    // starts another card — the button appeared to do nothing. The
    // off-air branch below already did this; the card path did not.
    if (this.current?.item?.countdown) {
      const first = this.queue[0];
      if (first) {
        delete first.startAt;
        delete first.breakOffline;
      }
      this._bankFlush();
      this._advance();
      return true;
    }
    if (this._break) {
      // "Go live now" means NOW: without clearing the pin, the resume
      // advances, sees the same future time, and dives straight back
      // offline — measured, not hypothetical.
      const first = this.queue[0];
      if (first) {
        delete first.startAt;
        delete first.breakOffline;
      }
      this._detached(this._resumeFromBreak(), 'going live from break');
      return true;
    }
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
    /**
     * The cushion-kept, GOP-aligned splice — the same move a natural
     * episode end makes (which never flushes, and is seamless because of
     * it). A flush anchors the successor on the frontier of bytes already
     * SENT, and a reordered stream opens several frames below its own
     * stamp, so those frames land behind delivered content. Anchoring on
     * the kept TAIL instead leaves that opening inside the cushion, where
     * it costs nothing.
     */
    const { rewound, gop } = this._bankCutForApply(this._applyRunway());
    if (rewound + gop > 0.05) {
      this.emit('log', `[skip] cushion cut to ${this._applyRunway().toFixed(1)}s\n`);
    }
    this._advance();
    return true;
  }

  _redact(text) {
    if (!text) return text;
    let out = String(text);
    for (const secret of this._secrets ?? []) {
      out = out.split(secret).join('*'.repeat(8));
    }
    return out;
  }
}

const item = (self) => self.current?.item?.title ?? 'clip';

/**
 * Whether — and at what geometry — this clip can take the overlay pipe.
 *
 * The pipe keeps the main graph's SHAPE fixed for the life of the source, so
 * nothing an Apply can change is allowed to influence the answer: no band
 * (its height depends on what the overlays currently are), no half-rate
 * canvas (a bouncing picture added later needs every frame), no baked still
 * layer. The canvas is always the full content rectangle at the full
 * effective rate. That costs some of the optimisations the inline path has,
 * which is the honest price of never restarting for an overlay.
 *
 * Null means "use the ordinary paths": the guards mirror the inline canvas
 * path exactly, plus two of the pipe's own —
 *  - a pillarboxed clip WITHOUT subtitles has no probed barsGraph (the
 *    probe only runs when subtitles exist), and an unprobed composite shape
 *    is how this project earned its -22 scars; and
 *  - bitmap subtitles need the video frames themselves and cannot move into
 *    a renderer that has no access to them.
 */
export function planOverlayPipe({
  profile, selection, sub, duration = null,
  overlayImages = [], overlayAnimated = false,
}) {
  if (!profile?.overlayPipe || profile.backend !== 'vaapi' || !profile.gpuFull) return null;
  if (sub?.needsComplex) return null;

  // The pipe input must be BOUNDED or the main process cannot exit — see
  // pipeInputArgs. No known duration, no bound, no pipe.
  if (!(duration > 0)) return null;
  /**
   * Nothing to draw, no pipe — the composite pass is never free.
   *
   * Measured on the N100: Backrooms (4K HDR, no subtitles, no overlays)
   * ran 1.02x on the plain fast path and 0.78x with the pipe attached,
   * with the canvas at two heartbeat frames a second. The whole gap is
   * ONE extra full-frame VPP pass on an iGPU already saturated by decode,
   * scale, tonemap and encode, and no fixed graph can skip a pass
   * conditionally. A clip with nothing to composite therefore takes the
   * EXACT pre-pipe graph — for bare playback this is not "as fast as the
   * old setup", it IS the old setup.
   *
   * The first overlay on such a clip goes out through the classic
   * cushion-kept respawn — invisible to viewers, the bank covers it — and
   * from then on the pipe is armed and every apply is a free swap.
   * Configured-but-hidden overlays count as something to draw (the
   * overlayConfigured clause below — for a long time this sentence was
   * an aspiration the code did not honour, and every first "show" of a
   * broadcast paid the respawn), so the show/hide toggle stays free.
   */
  /**
   * STUDIO content only — subtitles alone never arm the pipe. Operator
   * decree after Jujutsu Kaisen regressed: the proven inline graphs are
   * the default for plain playback, subtitled or not, and the compositor
   * machinery exists exactly when the operator is compositing. A clip
   * with subtitles and no studio overlays runs the same graph it ran
   * before Phase 1; the first studio apply arms the pipe through the
   * cushion-kept respawn, and from then on applies are live swaps.
   */
  const anythingToDraw = (overlayImages ?? []).length > 0
    || Boolean(overlayAnimated)
    || (profile.overlay ?? []).some((i) => i?.enabled !== false)
    // Configured-but-hidden arms the pipe too — measured armed-idle at
    // ~20% source CPU on a 1080p title, against a full source respawn
    // (splice + re-encode) for the first "show" without it. overlayAlways
    // goes further — OBS semantics, the compositor rides every eligible
    // clip so even a first add from an EMPTY studio is a swap. noIdleArm
    // is the escape hatch for both: a title that cannot afford the idle
    // composite pass (4K HDR measured 1.02x -> 0.78x from the pass
    // alone) sheds it via the slow handler and falls back to the old
    // first-show respawn.
    || ((Boolean(profile.overlayConfigured) || Boolean(profile.overlayAlways))
      && !profile.noIdleArm);
  if (!anythingToDraw) return null;
  const rect = contentRect(selection?.video, profile);

  if (sub?.filter) {
    // Same conditions the inline GPU canvas demands, for the same reasons.
    if (!profile.gpuSubs) return null;
    if (!gpuDecodable(selection?.video) || profile.swDecode) return null;
    if (profile.barsFailed && rect.bars) return null;
    if (rect.bars && !profile.barsGraph) return null;
  } else if (rect.bars) {
    return null;
  }
  const eff = effectiveFps(selection?.video, profile);
  // wide-canvas is the one probed shape where the CANVAS carries the
  // pillarbox padding, so the pipe has to carry the full output frame.
  const wide = rect.bars && profile.barsGraph === 'wide-canvas';
  const width = wide ? profile.width : rect.w;
  const height = wide ? profile.height : rect.h;
  /**
   * Rate is NOT part of the pipe's format any more. The canvas travels as
   * VFR NUT: the renderer's chain runs at the full effective rate and
   * mpdecimate forwards a frame only when the picture CHANGED, so a static
   * canvas costs ~2 small uploads a second (the heartbeat) and a moving one
   * costs exactly its real new pixels. Half-rate pinning — and the stepped
   * motion it forced on mid-clip applies — is gone with it.
   */
  return { rect, eff, wide, width, height, rate: eff.rate, fps: eff.fps };
}

/**
 * The renderer's own command spec: the overlay canvas as a standalone
 * process emitting RGBA to a pipe.
 *
 * `shift` is the media time of the FIRST frame this renderer will produce.
 * At clip start that is the clip offset; at an Apply it is the continuation
 * point, computed by the caller from the feed's frame count — rawvideo has
 * no timestamps, so the frame count is the only clock both sides share.
 * Subtitle events and picture motion both key off it, exactly as the inline
 * canvas keys off the spawn offset.
 */
export function buildRendererSpec({
  profile, selection, srcPath, shift = 0, clipOffset = null, duration = null,
  extractedPath = null, fontsDir = null, overlayPath = null,
  overlayImages = [], subBand = null, overlayAnimated = false, pin = null,
}) {
  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath,
    { extractedPath, fontsDir, overlayPath });
  /**
   * `pin` is the pipe format fixed when the SOURCE spawned. A swap must
   * reproduce it exactly whatever the overlays now are — the reader's
   * format cannot change — so geometry and rate come from the pin, and only
   * the renderer's INTERIOR follows the new overlay state. That interior
   * freedom is what keeps applies cheap: the band can come and go per swap,
   * pictures can appear, and the pipe never notices.
   */
  const plan = pin ?? planOverlayPipe({
    profile, selection, sub, duration, overlayImages, overlayAnimated,
  });
  if (!plan) return null;
  const { rect, wide } = plan;
  /**
   * The canvas draws EVERYTHING again — stills after the thin (one blend
   * per heartbeat), moving and animated pictures at full chain rate.
   * The shm transport made full-rate affordable: appends are page-cache
   * memcpys with no lockstep, the renderer is consumption-paced by
   * SIGSTOP, and swaps stamp from the written head. Zero restarts in
   * live mode is the contract; this is where it is honoured.
   */
  const imgList = (overlayImages ?? []).filter((i) => i?.path);
  const stillImgs = imgList.filter((i) => !(i?.animated || isMoving(i)));
  const movingImgs = imgList.filter((i) => i?.animated || isMoving(i));
  // Bound the generated base or the renderer never exits on its own; +5 so
  // it always outlives the clip rather than starving the composite's tail.
  const cap = duration != null && duration > 0
    ? ['-t', (Math.max(1, duration - shift) + 5).toFixed(3)]
    : [];
  const sh = Number(shift).toFixed(3);
  /**
   * The band, restored — inside the renderer.
   *
   * Rasterising a 1080-row canvas where a 420-row band carries every
   * subtitle is what took Mr. Robot on the N100 from 1.03x to 0.62x. The
   * pipe's FORMAT stays full-rect (a later picture must be placeable
   * anywhere without a restart), but the expensive part — libass and the
   * canvas filters — runs at band height and a pad lifts the result into
   * the full frame. Same conditions as the inline band, minus the
   * picture clause: pictures always put the canvas back to full height.
   */
  const band = subBand && sub.filter && !wide && !plan.rect.bars
    && subBand.rect.w === rect.w && subBand.rect.h === rect.h
    && !overlayAnimated
    && !(overlayImages ?? []).some((i) => i?.path && (i?.animated || isMoving(i)))
    ? subBand : null;
  const baseH = band ? band.height : rect.h;
  /**
   * Two renderer-side economies, reapplied on the clean base after the
   * operator's bisection isolated the green-ghost regression to the batch
   * of commits that first carried them. Both are innocent by construction —
   * they change WHICH frames the chain renders, never their pixels — but
   * each returns as its own commit so a live test can convict or acquit it
   * individually.
   *
   * -readrate 2.0: unpaced, the renderer strip-mined a full E-core
   * rendering canvas hours ahead of air (measured on the N100: 98.7% CPU,
   * node at 64% ferrying frames nobody needed, encoder starving at 0.69x)
   * — during static stretches mpdecimate emits no bytes, so backpressure
   * never binds and only the readrate holds the rasteriser back. But the
   * cap is also a lid on the SOURCE: framesync cannot advance video past
   * the canvas timestamps it has received, so the whole encoder is capped
   * at the renderer's pace. At 1.1 that pinned every cushion rebuild to
   * ~1.05x observed. 1.3 clears the measured recovery ceiling (~1.2x) while letting the
   * encoder run at the hardware's real speed when it has surplus.
   *
   * Half cadence when nothing moves: a static canvas rendered 36 frames a
   * second at 1.5x pacing to keep about two. Half rate is the same 83ms
   * cue-boundary slop the inline band always accepted. Anything moving
   * renders at the full effective rate, decided fresh at every swap — the
   * cadence is renderer-internal, never pipe format.
   */
  /**
   * encoder.pipeTuning — measurement knobs, PUT-able through the config
   * API so pipe internals can be A/B'd against the legacy graph live on
   * the deployment without a rebuild per trial. Absent keys = shipped
   * behaviour. {readrate, beat, fullRate, hwFrames}.
   */
  const tune = profile.pipeTuning ?? {};
  const perFrame = Boolean(overlayAnimated) || movingImgs.length > 0;
  const chainRate = (tune.fullRate || perFrame ? plan.rate : halfRate(plan.rate)) || plan.rate;
  const beat = Number(tune.beat) > 0 ? Number(tune.beat) : 6;
  const readrate = Number(tune.readrate) > 0 ? String(tune.readrate) : '2.5';
  /**
   * -readrate_catchup bounds the burst after a SIGSTOP. ffmpeg's readrate
   * budget is wall-clock — stopped time counts as elapsed — so a paced
   * renderer that sat frozen for 15s wakes up "behind" and, uncapped,
   * sprints at machine speed to make it up. Measured on a 7800X3D: a
   * full-rate 1080p RGBA canvas (~8.3MB/frame) flooded a 2GB /dev/shm in
   * seconds, the writer died on ENOSPC mid-frame, and the torn tail hung
   * the reader at the join. Capped, each CONT cycle writes at most a
   * couple of seconds of canvas before pace() STOPs it again.
   */
  const catchup = Number(tune.catchup) > 0 ? String(tune.catchup)
    : String(Math.max(Number(readrate), 3));
  const inputs = ['-f', 'lavfi', '-readrate', readrate,
    '-readrate_catchup', catchup, ...cap, '-i',
    `color=c=black@0.0:s=${rect.w}x${baseH}:r=${chainRate},format=rgba`];
  /**
   * Timestamps are the continuation clock now, and they are CLIP-relative:
   * the main graph's video starts at zero after its -ss, and NUT carries
   * these pts across, so a replacement renderer that starts stamping at
   * (shift - clipOffset) continues the stream exactly where the last one
   * stopped. No byte counting, no padding, no drift — the timestamps ARE
   * the alignment.
   */
  const rebase = Number(shift - (clipOffset ?? shift)).toFixed(3);
  // The same head the inline canvas builds, with the base at input 0
  // instead of 1 — the renderer is its own process and numbers from zero.
  const head = sub.filter
    ? `[0:v]setpts=PTS+${sh}/TB,${band ? band.filter : sub.filter}:alpha=1,`
      + `setpts=PTS-STARTPTS+${rebase}/TB,format=rgba`
    : `[0:v]setpts=PTS+${rebase}/TB`;
  /**
   * phase must complete the canvas clock back to CLIP time, and the canvas
   * clock is rebase-based: t = clipTime - (clipOffset ?? shift). Passing
   * `shift` here double-counted the continuation point — right at the
   * initial spawn (where shift == clipOffset) and wrong by (shift -
   * clipOffset) at every swap, so each show/hide teleported a bouncing
   * picture along its path by exactly the swap position.
   */
  const movers = canvasImageChain(movingImgs, {
    width: rect.w, firstInput: 1, inLabel: 'sub0', outLabel: 'mv',
    phase: clipOffset ?? shift,
  });
  const stillsRaw = canvasImageChain(stillImgs, {
    width: rect.w, firstInput: 1 + movingImgs.length,
    inLabel: 'sub', outLabel: 'cv', phase: clipOffset ?? shift,
  });
  // Two chains mint img0/ov0 labels independently; keep the stills' unique.
  const imgs = {
    ...stillsRaw,
    filters: stillsRaw.filters.map((f) => f
      .replace(/\[img(\d+)\]/g, '[simg$1]')
      .replace(/\[ov(\d+)\]/g, '[sov$1]')),
  };
  const pad = wide
    ? `,pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black@0.0`
    : band
      ? `,pad=${rect.w}:${rect.h}:0:${band.y}:color=black@0.0`
      : '';
  // No trailing format=rgba: the subtitle head ends on one, the image
  // chain guarantees one, and the bare-transparent base IS one. pad of an
  // rgba frame stays rgba.
  /**
   * mpdecimate is the whole economy: it forwards a frame only when the
   * canvas actually changed, and max=12 forces one through every half
   * second so framesync's pairing never waits long (the wait is pipeline
   * latency, absorbed by the bank — never throughput). A static canvas
   * therefore costs ~2 uploads a second; a bouncing logo passes every
   * frame, full rate, because its pixels genuinely differ. Its own compare
   * cost lives in the renderer process where there is headroom, not in the
   * encode loop where there is none — the old in-graph measurement that
   * rejected mpdecimate does not apply here.
   */
  // The heartbeat tracks the cadence so framesync's pairing queue stays at
  // half a second of media either way. mpdecimate stays on the moving chain
  // too, and this is EMPIRICAL, not caution: removing it is now 3-for-3.
  // Twice (63d5fe9 and again after the swap-time guard landed) the live
  // bounce showed green corruption on the N100; the third trial — a
  // pipeTuning knob on the append-file transport, dropped into a live
  // swap — hung the encoder DEAD at the renderer join: position frozen at
  // the continuation point, source and renderer both alive at 0% CPU, and
  // a swap back to the thinned chain could not unstick it. All three
  // failures sit at the NUT stream JOIN, not in the pixels: the reader
  // only resyncs onto a successor stream whose framing matches what the
  // thinned chain produces (fifo era: misread frames — the green; append
  // era: a demuxer that never accepts the join at all). The SAD cost is
  // real (~130% renderer CPU at full rate where nothing is ever dropped),
  // but this filter is load-bearing for the transport. Do not remove it.
  const thin = `,mpdecimate=max=${beat}`;
  /**
   * Thin BEFORE pad — worth ~85MB/s of renderer memcpy on a banded title:
   * SAD compares the 420px band instead of the padded 1080p frame, and the
   * full-frame pad runs only for the ~2 frames a second that survive.
   * Bisection suspect three of four, returning alone.
   */
  /**
   * Stills AFTER the thin and the pad: the SAD compares only the subtitle
   * band, and the picture blend runs on the ~2 frames a second that
   * survive — effectively free — instead of forcing the canvas back to
   * full height and full compare. A timed picture (intro/outro window)
   * pops on the next heartbeat, at most half a second late, the same slop
   * the band always accepted for cue boundaries.
   */
  /**
   * Chain order: subtitles -> MOVING pictures (per frame, before the
   * thin: their motion makes every frame differ, so mpdecimate passes
   * the full rate through exactly when motion is live and the trickle
   * economy returns by itself the moment it is not) -> thin -> pad ->
   * stills (one blend per surviving frame).
   */
  const headOut = movers.filters.length ? '[sub0]' : '[sub]';
  const preThin = movers.filters.length ? '[mv]' : '[sub]';
  const filters = imgs.filters.length || movers.filters.length
    ? [`${head}${headOut}`,
      ...movers.filters,
      `${preThin}null${thin}${pad}${imgs.filters.length ? '[sub]' : '[out]'}`,
      ...(imgs.filters.length ? [...imgs.filters, '[cv]null[out]'] : [])]
    : [`${head}${thin}${pad}[out]`];
  inputs.push(...movers.inputs, ...imgs.inputs);
  return {
    ...plan,
    band: Boolean(band),
    spec: {
      inputs, filters, out: 'out',
      width: plan.width, height: plan.height, rate: plan.rate,
    },
  };
}

/**
 * Source: decode → software filters → hardware encode → MPEG-TS on stdout.
 *
 * `-re` lives here because this is what sets the pace; the publisher must not
 * pace as well or it starves.
 */
export function buildSourceArgs({
  srcPath, offset = 0, profile, selection = null, tsOffset = 0, statsPeriodMs = 500,
  hwDecode = null, extractedPath = null, fontsDir = null, duration = null,
  overlayPath = null, overlayImages = [], overlayLayer = null, subBand = null,
  overlayAnimated = false, overlayPipe = null, srcKbps = null, copyAlign = null,
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const imgList = (overlayImages ?? []).filter((i) => i?.path);
  /**
   * Can the GPU composite these pictures itself?
   *
   * It matters a lot: dropping a clip to the software path because it
   * carries a logo turns a comfortable GPU episode into an unwatchable one,
   * and a still picture costs the CPU nothing per frame anyway.
   *
   * Two conditions. `gpuSubs` is the caller's verdict that this driver
   * honours overlay alpha — the same thing subtitles need, established by
   * probing the device, so a driver that would composite a logo as an
   * opaque black box never gets the chance. And overlay_vaapi has no
   * `enable` option, so a picture with intro/outro timing cannot be done
   * here at all and sends the whole clip to the software path.
   *
   * A third: overlay_vaapi takes x/y as expressions but has no `eval`
   * option, so it resolves them ONCE at init and the picture never moves.
   * Verified against the filter's own option list. A bouncing picture
   * therefore has to be drawn on the canvas, where `overlay` evaluates per
   * frame — measured moving, two frames a second apart differ. It costs
   * that clip the CPU composite, which is the honest price of the effect.
   */
  const gpuImages = imgList.length > 0
    && Boolean(profile.gpuSubs) && !profile.noGpuImages
    && !imgList.some(isMoving);
  /**
   * Pictures the software chain draws — which is all of them.
   *
   * That reads wrong until you notice WHERE this is used: only in the CPU
   * fallthrough at the bottom, which a clip reaches for its own reasons —
   * bitmap subtitles, a file the GPU cannot decode, a driver that failed
   * the pillarbox probe. A clip already down there costs nothing extra to
   * draw a picture on, so it gets one.
   *
   * What must never happen is a picture being the REASON. The GPU branches
   * no longer refuse a clip for carrying one: they draw it with
   * overlay_vaapi, or — if the driver will not — drop it and play the
   * episode at full speed without it. Never a logo bought with the frame
   * rate of the whole episode.
   */
  const cpuImgs = imgList;

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath,
    { extractedPath, fontsDir, overlayPath });
  // The overlay pipe: when a fifo path arrives AND this clip is eligible,
  // the canvas is not built here at all — a renderer process feeds it in as
  // input 1, and the graph's shape stops depending on what the overlays
  // are. planOverlayPipe is the single authority on eligibility and
  // geometry; the engine calls the same function to size the pipe, so the
  // two ends cannot disagree.
  const pipePlan = overlayPipe
    ? planOverlayPipe({
      profile, selection, sub, duration,
      overlayImages: imgList, overlayAnimated,
    })
    : null;
  const audioIdx = selection?.audio?.typeIndex ?? 0;
  /**
   * HEVC seams announce themselves. Every respawn starts fresh continuity
   * counters and cuts the old PES mid-frame; the publisher logged "Packet
   * corrupt ... dropping it" at every splice, and at 4K HEVC rates that
   * dropped packet is a visible rainbow band (operator screenshots). The
   * discontinuity indicator is the container's own way of saying the jump
   * is intentional — the exact fix the chunk files already ship. H.264 is
   * left untouched (tuned path, byte-identical by test).
   */
  const tsFlags = profile.codec === 'hevc'
    ? '+resend_headers+initial_discontinuity' : '+resend_headers';

  /**
   * PASSTHROUGH: an HEVC-native file under codec=hevc with nothing to draw
   * — no subtitle burn, empty studio, no pipe — needs no transcode at all.
   * The video stream ships untouched (-c:v copy): zero encode cost, source
   * quality bit-exact, HDR included. Audio still conforms to AAC/48k so
   * clip seams keep the seam discipline the encode path established.
   *
   * Boundaries this accepts, deliberately: seeks land on the source's own
   * keyframes (input -ss with copy cannot cut mid-GOP), the file's native
   * geometry/fps go out as-is, and the moment anything must be drawn — an
   * Apply, a subtitle switch — the respawn falls through to a transcode
   * exactly like any other source restart. Gated to HEVC on purpose:
   * H.264 is the tuned, working default path and stays untouched.
   */
  if (profile.codec === 'hevc' && selection?.video?.codec === 'hevc'
      && !selection?.subtitle && !sub.filter && !sub.needsComplex
      && imgList.length === 0 && !overlayAnimated && !pipePlan
      // An HDR file may only ship untouched when the operator asked for
      // HDR output — with it off the promise is SDR, so the clip goes to
      // the tone-mapped transcode instead of quietly leaking PQ on air.
      && (!selection?.video?.hdr || profile.hdrWanted)
      // The bitrate ceiling: copy ships the FILE's rate, and a 54 Mbps
      // remux against a ~53 Mbps home upload would saturate the line and
      // stall every viewer. ABSOLUTE, not a multiple of the encode rate:
      // a 25 Mbps 4K HDR film passing through is a verified, wanted case
      // and must not fall off passthrough because the operator lowered
      // the 1080p encode anchor. 30000k default; encoder.copyLimitKbps
      // overrides for a different line.
      && (srcKbps == null
        || srcKbps <= (Number(profile.copyLimitKbps) > 0
          ? Number(profile.copyLimitKbps) : 30000))
      // Keyframes decide segment length, everywhere. A copied stream is
      // cut where the FILE has keyframes, so its segments are that long
      // and no latency setting downstream can shorten them; sparse or
      // uneven ones give long, uneven segments, and that is what a player
      // reports as a stall and a snap. Encoding costs the GPU and buys a
      // keyframe every gopSeconds — which is exactly why one of these
      // titles behaves the moment subtitles force a transcode.
      // ...unless copying is the only way this clip can go out at all.
      // An HDR file the operator asked to keep HDR has no cheap encode:
      // the alternative is a main10 re-encode or a tone map, one of which
      // measured 0.55x on the deploy box (the broadcast dies) and the
      // other of which throws the HDR away. Long segments are a worse
      // experience; a dead or downgraded broadcast is a worse outcome.
      && (copyKeyframesFitLive(profile)
        || (selection?.video?.hdr && profile.hdrWanted))) {
    /**
     * THE SEAM ALIGNMENT. A copy-mode `-ss` splits the streams: the
     * demuxer starts VIDEO at whatever keyframe the cue table picks —
     * measured up to a full GOP before the request, with an arbitrary
     * per-file threshold — while AUDIO is trimmed to the request itself.
     * The publisher's per-stream discontinuity handlers then disagree by
     * that gap and flip-flop the offset on EVERY packet; the receiver's
     * A/V baselines split and the picture is garbage until the broadcast
     * restarts (operator-reported fatal mode, reproduced: 350+ rebase
     * lines from one seek). No single-input flag fixes it — measured:
     * -noaccurate_seek, first_pts, exact-keyframe requests, output -ss
     * (drops ALL copied video) all fail.
     *
     * So the engine probes where video will actually land (copyAlign,
     * one tiny ffmpeg run) and opens the file TWICE: video seeks by the
     * original request with -itsoffset folding the landing gap away,
     * audio seeks directly to the landing. Both streams then start on
     * the same tick, and the seam is one announced discontinuity instead
     * of a war.
     */
    const gap = copyAlign && Number.isFinite(copyAlign.landing)
      && copyAlign.landing < offset - 0.005
      ? offset - copyAlign.landing : 0;
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(gap > 0 ? ['-itsoffset', gap.toFixed(3)] : []),
      ...(offset > 0 ? ['-ss', Number(offset).toFixed(3)] : []),
      '-i', srcPath,
      ...(gap > 0 ? ['-ss', copyAlign.landing.toFixed(3), '-i', srcPath] : []),
      '-map', '0:v:0', '-c:v', 'copy',
      '-map', `${gap > 0 ? 1 : 0}:a:${audioIdx}?`,
      ...audioArgs(profile),
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', tsFlags,
      '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
      '-f', 'mpegts', 'pipe:1',
    ];
  }
  // Source-rate matching applies to every path, not just the GPU one —
  // duplicating 24fps to 30 is wasted work and judder wherever it happens.
  const effAll = effectiveFps(selection?.video, profile);
  const profEff = { ...profile, fps: effAll.fps };
  const base = scaleFilter(profEff).replace(`fps=${effAll.fps}`, `fps=${effAll.rate}`);
  const upload = be.uploadFilter(profEff);

  // Fixed-function chain for clips WITHOUT burned subtitles. This used to
  // exist only when subtitles forced it, which left subtitle-free 4K films
  // software-decoding on the CPU at 0.6x while the GPU sat idle.
  /**
   * A picture that must be drawn per frame cannot take the fixed-function
   * path: it composites once, on the GPU, from a single uploaded frame.
   *
   * Dropping a picture the DRIVER will not composite is deliberate — a logo
   * is not worth the frame rate of the whole episode. Dropping one that
   * merely moves is not: nothing downstream would draw it, because the
   * canvas branch below needs subtitles to exist, so a bouncing picture on
   * a subtitle-free clip disappeared with nothing logged.
   */
  const imagesNeedPerFrame = imgList.some((i) => isMoving(i) || i?.animated);
  /**
   * Deinterlacing, at last — there was NONE anywhere before this. 'auto'
   * trusts the probe's field_order (interlaced sources comb without it);
   * 'on' forces it for the mislabeled-progressive files every DVD-era
   * library has; 'off' is off. GPU chains use deinterlace_vaapi right
   * after decode (fields must be intact — deinterlacing scaled frames is
   * garbage), CPU chains bwdif at the head for the same reason.
   */
  const wantDeint = profile.deinterlace === 'on'
    || ((profile.deinterlace ?? 'auto') === 'auto'
      && selection?.video?.interlaced === true);
  const gpuDeint = wantDeint ? 'deinterlace_vaapi,' : '';
  const cpuDeint = wantDeint ? 'bwdif,' : '';
  /**
   * The CPU chains tone-map now too. They never did — an HDR source that
   * fell through here (bitmap subs, software backend, a GPU that failed
   * its probes) went out with PQ pixels in an SDR stream, washed out.
   * Placed AFTER the scale like the GPU path, so the mapper works at
   * output size rather than 4K, and BEFORE the subtitle burn so text
   * lands on SDR. format=yuv420p pins the depth for everything after.
   */
  const cpuToneFilter = selection?.video?.hdr
    && (profile.tonemap ?? 'auto') !== 'none'
    ? `${cpuTonemap(profile.tonemapCurve)},format=yuv420p` : '';
  /**
   * HDR OUT: keep the 10-bit P010 surface through the scale, no tone map,
   * and let hevc_vaapi derive main10 from the format. Probe-gated in
   * tuneProfile (hdrOut only set when the driver encodes main10) and
   * draw-gated here: SDR RGBA — subtitles, studio, even a still logo via
   * overlay_vaapi — blended into a PQ surface renders searing or dim, so
   * any drawing keeps the clip on the tone-mapped SDR path it always had.
   */
  const hdrPass = Boolean(profile.hdrOut) && Boolean(selection?.video?.hdr)
    && imgList.length === 0;
  if (profile.gpuFull && !sub.filter && !sub.needsComplex && !imagesNeedPerFrame
      // Piped clips always carry the overlay input, so the first overlay of
      // a broadcast lands without a restart. That is the feature.
      && !pipePlan) {
    const rect = contentRect(selection?.video, profile);
    const smode = (selection?.video?.width ?? 0) >= rect.w * 1.5 ? ':mode=fast' : '';
    // null, not the scale: a full-frame VPP pass that changes nothing is
    // still a full-frame VPP pass. See scaleIsIdentity.
    const scalePart = hdrPass
      ? `scale_vaapi=w=${rect.w}:h=${rect.h}:format=p010${smode}`
      : scaleIsIdentity(selection?.video, profile, rect) ? 'null'
        : scaleAndTonemap(selection?.video, profile, rect, smode);
    const hwDec = gpuDecodable(selection?.video) && !profile.swDecode;
    const vaapiChain = (hwDec ? '' : `format=${hdrPass ? 'p010le' : 'nv12'},hwupload,`)
      + gpuDeint + (rect.bars
        ? `${scalePart},pad_vaapi=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`
        : scalePart);
    // No subtitles means no canvas is needed at all: the picture uploads
    // once as a single frame and the GPU composites it straight onto the
    // video. One overlay_vaapi — the same count as the subtitle path the
    // device already runs — and nothing per-frame on the CPU. This is the
    // cheapest the feature can be.
    const gpuImgs = vaapiImageOverlayChain(gpuImages ? imgList : [], {
      width: profile.width, height: profile.height, firstInput: 1, inLabel: 'b', outLabel: 'v',
    });
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
      ...(hwDec
        ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va']
        : []),
      '-extra_hw_frames', '8',
      ...(offset > 0 ? ['-ss', Number(offset).toFixed(3)] : []),
      '-i', srcPath,
      ...gpuImgs.inputs,
      // Software-decoded frames have to be handed to the GPU explicitly.
      ...(gpuImgs.filters.length
        ? ['-filter_complex',
          [`[0:v]${vaapiChain}[b]`, ...gpuImgs.filters].join(';'), '-map', '[v]']
        : ['-vf', vaapiChain, '-map', '0:v:0']),
      '-map', `0:a:${audioIdx}?`,
      ...(gpuImgs.looping ? ['-shortest'] : []),
      ...be.encoderArgs(profEff),
      // The PQ tags travel in the bitstream; without them a correct 10-bit
      // encode still displays as washed SDR because no player is told it
      // is HDR. Mastering-display/CLL side data rides the frames (measured
      // preserved through a re-encode on this driver).
      ...(hdrPass ? [
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc',
      ] : []),
      '-async_depth', '4',
      ...audioArgs(profile),
      '-r', effAll.rate, '-fps_mode', 'cfr',
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', tsFlags,
      '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
      '-f', 'mpegts', 'pipe:1',
    ];
  }

  // Full-GPU path: decode, scale, composite and encode all stay on the GPU,
  // and the CPU renders subtitle alpha frames and nothing else. Measured on
  // the N100 this is the difference between 0.85x (unstreamable) and 1.56x.
  // Text subtitles only; requires the driver to honour overlay alpha, which
  // the caller establishes with vaapiAlphaHonored() before setting gpuSubs.
  if (pipePlan || (profile.gpuSubs && sub.filter && !sub.needsComplex
      // The composite only wins when frames are already ON the GPU. A
      // source the GPU cannot decode would pay two uploads (video + alpha
      // canvas) per frame here; burning during the CPU decode chain and
      // uploading once is measurably faster on exactly those files.
      && gpuDecodable(selection?.video) && !profile.swDecode
      // barsFailed: the pillarboxed composite died live on this driver, so
      // only clips that need bars take the CPU path; 16:9 stays on the GPU.
      && !(profile.barsFailed && contentRect(selection?.video, profile).bars))) {
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
    // null when the scale would be an identity transform — a VPP pass that
    // changes nothing still costs a full frame. See scaleIsIdentity, which
    // excludes every case where this filter is actually doing something,
    // pillarboxed clips included.
    const scalePart = scaleIsIdentity(selection?.video, profile, rect) ? 'null'
      : scaleAndTonemap(selection?.video, profile, rect, smode);
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

    // Fields must be intact when the deinterlacer sees them, so it goes
    // before the scale in whichever shape the driver probe picked.
    videoChain = gpuDeint + videoChain;
    const hwDec = gpuDecodable(selection?.video) && !profile.swDecode;
    if (pipePlan) {
      /**
       * The piped graph. Identical to the inline one downstream of the
       * upload — same videoChain, same probed composite shape — but input 1
       * is a rawvideo fifo a renderer process fills, so nothing about the
       * overlays is baked into this command. Changing them means replacing
       * the renderer; this process never hears about it.
       */
      const graph = '[1:v]format=rgba,hwupload[ov];'
        + `[0:v]${hwDec ? '' : 'format=nv12,hwupload,'}${videoChain}[b];`
        + composite;
      return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
        ...(hwDec
          ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va']
          : []),
        // Deeper than the classic path's 8, for the piped graph only: frames
        // wait in framesync while the VFR canvas is between heartbeats, and
        // each queued frame pins a decoder surface. Tunable for live A/B —
        // GTT pressure from the deeper pool is a candidate for the
        // pipe-vs-legacy gap on iHD.
        '-extra_hw_frames',
        String(Number(profile.pipeTuning?.hwFrames) > 0
          ? profile.pipeTuning.hwFrames : 8),
        ...(offset > 0 ? ['-ss', shift] : []),
        '-i', srcPath,
        ...pipeInputArgs(pipePlan, overlayPipe,
          { capSecs: Math.max(1, duration - offset) + 2 }),
        ...bgInput,
        '-filter_complex', graph,
        '-map', '[v]', '-map', `0:a:${audioIdx}?`, '-shortest',
        ...be.encoderArgs({ ...profile, fps: eff.fps }),
        '-async_depth', '4',
        ...audioArgs(profile),
        '-r', eff.rate, '-fps_mode', 'cfr',
        '-output_ts_offset', Number(tsOffset).toFixed(3),
        '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', tsFlags,
        '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
        '-f', 'mpegts', 'pipe:1',
      ];
    }
    // Input 0 is the clip, 1 the subtitle canvas, and 2 the black background
    // when the driver's pillarbox shape needs one — so pictures start after
    // whichever of those exist, or they would read the wrong stream.
    //
    // Pictures are drawn ONTO the subtitle canvas, on the CPU, before it is
    // uploaded — NOT as a second overlay_vaapi after the composite. Chaining
    // two of them looked clean and cost a live broadcast: it worked on the
    // development GPU and returned -22 from h264_vaapi on the deployment's
    // iHD driver. This keeps the graph at exactly ONE overlay_vaapi, which
    // is the shape the device has already proven it can do, and the extra
    // work is a small picture composited onto a canvas that is being built
    // and uploaded regardless.
    // A second overlay_vaapi after the subtitle composite: the picture
    // uploads once and the GPU does one more pass per frame, which is as
    // close to free as this gets. There is deliberately no software
    // fallback — see gpuImages above. If the driver will not do it, the
    // picture is simply absent and the episode plays at full speed.
    /**
     * Pictures are drawn onto the subtitle canvas, on the CPU, before it is
     * uploaded — NOT as a second overlay_vaapi chained after the composite.
     *
     * Measured on the deployment, and the cost is per-PASS, not per-pixel:
     * a picture scaled to 1306px and one at 384px slowed Mr. Robot by the
     * same margin, which a blend proportional to area cannot explain.
     * overlay_vaapi blends the whole 1920x1080 surface however small the
     * logo is, so the second pass costs a full frame either way. Mr. Robot
     * with burned subtitles already runs at 1.03x, so that pass puts it
     * under realtime — 0.909x observed, stuttering, bank never refilling —
     * while the same picture on Attack on Titan, which had 1.13x of
     * headroom, cost nothing measurable. Subtitles off was fast for the
     * same reason: no canvas, so the picture was the only pass.
     *
     * The canvas is already generated, drawn on and uploaded every frame
     * for the subtitles. Compositing into it is close to free, because CPU
     * overlay touches only the picture's own bounding box rather than the
     * frame — so this trades a full-frame GPU pass for a few hundred
     * thousand CPU pixels, and the GPU is the side with no headroom left.
     *
     * It also covers timed pictures, which the GPU path had to express by
     * withholding an input because overlay_vaapi has no `enable`.
     */
    /**
     * Still pictures are pre-rendered into the canvas instead of being
     * blended into it 24 times a second.
     *
     * A still contributes the same pixels to every frame of the clip, so
     * per-frame compositing recomputes an identical result all episode. The
     * canvas is generated and uploaded regardless for the subtitles, so a
     * picture that is already part of it is genuinely free: measured over
     * 720 frames of this exact chain, seeding the canvas costs 1.169
     * ms/frame against 1.164 with no picture at all, where compositing live
     * costs 1.434. Verified pixel-identical to the live composite (PSNR inf)
     * wherever a picture does not overlap a subtitle; where it does, the
     * subtitle now draws ON TOP of the picture rather than under it.
     *
     * Bounded by `-t` on the layer input having no effect on a `loop`
     * filter, this needs the trim below instead. Requiring a known duration
     * keeps that guarantee simple — an unbounded canvas is what makes the
     * process outlive the episode and stall the whole playlist.
     *
     * The loop FILTER, never `-loop 1` on the input: the input-side form
     * re-decodes the PNG on every frame and measured 6.570 ms/frame, five
     * times worse than doing nothing at all.
     */
    /**
     * The subtitle canvas, shrunk to the rows the script actually draws in.
     *
     * Taken only when the caller proved the script is bottom-anchored AND
     * the geometry it was analysed against is the geometry being built now —
     * the band is a position on this frame, so a rect that changed under it
     * would put the subtitles somewhere else entirely.
     *
     * Pictures are the other thing living on this canvas, and cropping the
     * canvas would crop them with it. They do not have to live there: the
     * GPU can composite them itself, after the band lands, exactly as the
     * subtitle-free path already does. That is strictly cheaper than drawing
     * them on the CPU every frame, so when the driver will take them the
     * canvas goes back to carrying nothing but subtitles and the band
     * applies to a clip with a picture on it too.
     */
    const band = subBand && !canvasPad && !rect.bars
      && subBand.rect.w === rect.w && subBand.rect.h === rect.h
      && (!imgList.length || gpuImages) ? subBand : null;

    const gpuImgs = band && imgList.length
      ? vaapiImageOverlayChain(imgList, {
        width: rect.w, height: rect.h, firstInput: 2,
        // Pictures go UNDER the band: they composite onto the bare video and
        // hand it on, then the subtitle band lands on the result. Subtitles
        // have to stay readable, so nothing is allowed to cover them.
        inLabel: 'b', outLabel: 'vb',
      })
      : { inputs: [], filters: [], looping: false };

    // A banded canvas carries subtitles alone, so it needs neither the
    // pre-rendered picture layer nor a per-frame picture composite.
    // Asked for only when it can actually be used: resolving this is what
    // triggers the bake, and a banded canvas has no pictures drawn into it.
    const layerPath = band || duration == null || !(duration > 0) ? null
      : (typeof overlayLayer === 'function' ? overlayLayer() : overlayLayer);
    const layer = layerPath && existsSync(layerPath) ? layerPath : null;
    // Timed and animated pictures cannot be baked into a still, so they keep
    // the per-frame path on top of the layer.
    const canvasImgs = band ? { inputs: [], filters: [] } : canvasImageChain(
      layer ? splitStaticImages(imgList).live : imgList, {
        width: rect.w, firstInput: bgInput.length ? 3 : 2,
        inLabel: 'sub', outLabel: 'cv',
        // Motion follows the MEDIA timeline, not this spawn's. `t` restarts
        // at zero every time the source restarts, so without this a bouncing
        // picture would jump back to its starting corner on every Apply,
        // track change and seek — and the pre-encoded cushion would disagree
        // with a re-encode of the same moment.
        phase: offset,
      },
    );
    /**
     * The canvas does not have to keep up with the video.
     *
     * Subtitles change a few times a second, so most canvas frames are
     * redundant: libass rasterises, the CPU copies and the driver uploads an
     * image identical to the last one. Running the canvas at half rate and
     * letting the composite hold each frame for two video frames halves all
     * of that — measured 1.203 -> 0.911 ms/frame on top of the band, from a
     * 0.350 floor.
     *
     * What it costs is that a cue can switch on or off one frame from where
     * it did. Measured over 480 frames of a real encode, 13 differ (2.7%),
     * all of them boundaries, in pairs one frame apart — nothing about the
     * text, its position or its appearance changes. Dropping unchanged
     * frames instead with `mpdecimate` was measured at 4.748 ms/frame, four
     * times worse than doing nothing: the comparison costs more than the
     * upload it saves.
     *
     * Not applied to a canvas carrying timed or animated pictures, whose
     * motion is the one thing on this surface that does need every frame.
     */
    /**
     * Only a picture whose APPEARANCE changes per frame needs full rate.
     *
     * This used to trip on any picture drawn live, which quietly doubled the
     * subtitle rasterisation too — the expensive half on a heavily typeset
     * title — for pictures that look identical on every frame. A still is
     * unaffected by the canvas being held for two video frames, and a timed
     * one only switches at a boundary, which is the same one-frame tolerance
     * already accepted for subtitle cues. An animated GIF and a moving
     * picture are the two that genuinely change.
     */
    const perFrameImgs = imgList.some((i) => i?.animated || isMoving(i));
    // A moving caption lives in the ASS script rather than in imgList, so it
    // has to be asked about separately — it is drawn onto this same canvas
    // and is just as stepped at half rate.
    const perFrame = overlayAnimated || (canvasImgs.filters.length && perFrameImgs);
    const canvasRate = (!perFrame && halfRate(eff.rate)) || eff.rate;
    const layerSrc = layer
      ? `[1:v]loop=loop=-1:size=1:start=0,setpts=N/(${canvasRate})/TB,`
        + `trim=end=${(Math.max(1, duration - offset) + 5).toFixed(3)},`
      : '[1:v]';
    const canvasH = band ? band.height : rect.h;
    const canvasHead = `${layerSrc}setpts=PTS+${shift}/TB,`
      + `${band ? band.filter : sub.filter}:alpha=1,`
      + 'setpts=PTS-STARTPTS,format=rgba';
    const canvasChain = canvasImgs.filters.length
      // null carries the padding step across the relabel; the canvas has to
      // stay RGBA to the upload or the composite becomes an opaque box.
      ? `${canvasHead}[sub];${canvasImgs.filters.join(';')};`
        + `[cv]null${canvasPad},hwupload[ov];`
      : `${canvasHead}${canvasPad},hwupload[ov];`;
    // A band is a shorter surface than the frame, so it has to be told where
    // to land. Reachable only when there are no bars, which is the one case
    // whose composite is a bare overlay_vaapi. Pictures, when there are any,
    // go on FIRST — onto the decoded frame, at frame coordinates, which is
    // where they were placed — and the band composites over the result, so
    // a picture can never cover a subtitle.
    const bandComposite = band
      ? (gpuImgs.filters.length
        ? `${gpuImgs.filters.join(';')};[vb][ov]overlay_vaapi=x=0:y=${band.y}[v]`
        : `[b][ov]overlay_vaapi=x=0:y=${band.y}[v]`)
      : composite;
    const graph = `${canvasChain}`
      + `[0:v]${hwDec ? '' : 'format=nv12,hwupload,'}${videoChain}[b];`
      + `${bandComposite}`;
    return [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-init_hw_device', `vaapi=va:${profile.device}`, '-filter_hw_device', 'va',
      ...(hwDec
        ? ['-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi', '-hwaccel_device', 'va']
        : []),
      // Extra decode surfaces let decode run ahead of scale/encode instead
      // of lock-stepping — pipelining, not quality.
      '-extra_hw_frames', '8',
      ...(offset > 0 ? ['-ss', shift] : []),
      '-i', srcPath,
      // Input 1 is the canvas base: the pre-rendered picture layer when
      // there is one, otherwise a transparent frame. Same size, same rate,
      // same RGBA — everything downstream is identical either way.
      ...(layer
        ? ['-r', canvasRate, '-i', layer]
        : ['-f', 'lavfi', ...canvasCap,
          '-i', `color=c=black@0.0:s=${rect.w}x${canvasH}:r=${canvasRate},format=rgba`]),
      ...bgInput,
      // Mutually exclusive: a banded canvas has no pictures drawn into it,
      // and an unbanded one composites none on the GPU. Either way the first
      // picture input lands at index 2, which is what both chains were
      // numbered against.
      ...canvasImgs.inputs,
      ...gpuImgs.inputs,
      '-filter_complex', graph,
      '-map', '[v]', '-map', `0:a:${audioIdx}?`, '-shortest',
      ...be.encoderArgs({ ...profile, fps: eff.fps }),
      // Deeper encoder queue overlaps encode with upstream stages.
      '-async_depth', '4',
      ...audioArgs(profile),
      '-r', eff.rate, '-fps_mode', 'cfr',
      '-output_ts_offset', Number(tsOffset).toFixed(3),
      '-muxdelay', '0', '-muxpreload', '0', '-mpegts_flags', tsFlags,
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
  // Everything up to the encoder's own upload/format step. Pictures have to
  // land after scale and pad — on the padded frame, so a corner logo sits in
  // the corner of what viewers see — but before the frame is handed to the
  // encoder, which on the GPU backends is no longer something libav filters
  // can draw on.
  const preUpload = sub.filter
    ? [
      `${cpuDeint}scale=${rect.w}:${rect.h},setsar=1${cpuToneFilter ? `,${cpuToneFilter}` : ''}`,
      ...(offset > 0 ? [`setpts=PTS+${Number(offset).toFixed(3)}/TB`] : []),
      `${sub.filter}:alpha=0`,
      ...(offset > 0 ? ['setpts=PTS-STARTPTS'] : []),
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${effAll.rate}`,
    ]
    // Tone map between scale and pad — same output-size placement.
    : [cpuDeint + (cpuToneFilter ? base.replace(',pad=', `,${cpuToneFilter},pad=`) : base)];
  const cpuChain = [...preUpload, upload];

  // The overlay ASS is written in the CLIP's timeline, and every graph that
  // burns it has to be looking at clip time when it does. The chains above
  // already are — they re-add `offset` around their subtitles filter — but
  // the bitmap graph has no such shift, so it needs its own. Without this
  // the two branches would want the file written on two different time
  // bases, which is exactly how an outro caption ended up firing early.
  const ovPost = !sub.postFilter ? ''
    : offset > 0
      ? `,setpts=PTS+${Number(offset).toFixed(3)}/TB${sub.postFilter},setpts=PTS-STARTPTS`
      : sub.postFilter;

  // A no-op rather than an empty label: a backend with nothing to upload
  // would otherwise produce "[o][v]", which is a parse error and not an
  // obviously wrong-looking one.
  const up = upload || 'null';
  const imgs = imageOverlayChain(cpuImgs, {
    width: profile.width, firstInput: 1, inLabel: 'o', outLabel: 'vi',
    phase: offset,
  });

  let filterArgs;
  if (sub.needsComplex || imgs.filters.length) {
    const parts = [];
    if (sub.needsComplex) {
      // Bitmap subtitles (DVD/PGS subpictures) carry pixel positions in the
      // SOURCE frame's coordinate space. Compositing after scale+pad placed
      // them at source coordinates on the padded 1080p frame — upper-left,
      // wrong size. Overlay at native size first; scaling then carries the
      // subtitles along with the picture.
      parts.push(`[0:v:0][${sub.overlayInput}]overlay[s]`);
      // Deinterlace and tone-map inside the base: after the bitmap
      // composite, since the subpicture stream has no fields of its own to
      // preserve. The subpicture rides through the tone map with the frame
      // — marginally dimmer text on an HDR title beats PQ leaking out.
      parts.push(`[s]${cpuDeint}${cpuToneFilter ? base.replace(',pad=', `,${cpuToneFilter},pad=`) : base}${ovPost}[o]`);
    } else {
      parts.push(`[0:v:0]${preUpload.filter(Boolean).join(',')}[o]`);
    }
    parts.push(...imgs.filters);
    parts.push(`[${imgs.filters.length ? 'vi' : 'o'}]${up}[v]`);
    filterArgs = ['-filter_complex', parts.join(';'), '-map', '[v]'];
  } else {
    filterArgs = ['-vf', cpuChain.filter(Boolean).join(','), '-map', '0:v:0'];
  }

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
    ...imgs.inputs,
    ...filterArgs,
    '-map', `0:a:${audioIdx}?`,
    // A looping GIF is an infinite input: without this the process outlives
    // the episode, _advance() never fires and the next clip never starts.
    // The same trap the generated subtitle canvas had to be bounded against.
    ...(imgs.looping ? ['-shortest'] : []),
    ...be.encoderArgs(profEff),
    ...audioArgs(profile),
    // Continue the published timeline instead of restarting at zero.
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-fps_mode', 'cfr',
    '-muxdelay', '0', '-muxpreload', '0',
    // AV1 rides NUT — mpegts writes it as private data its own demuxer
    // cannot read back. Timestamps behave identically (measured).
    ...(profile.codec === 'av1' ? [] : ['-mpegts_flags', tsFlags]),
    '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
    '-f', profile.codec === 'av1' ? 'nut' : 'mpegts', 'pipe:1',
  ];
}

/**
 * One chunk of a clip, encoded to a file. Same filters as the streaming
 * source; the difference is a bounded range and a file output, so several can
 * run at once.
 */
export function buildChunkArgs({
  srcPath, start, dur, out, profile, selection = null, tsOffset = 0,
  extractedPath = null, fontsDir = null, overlayPath = null, overlayImages = [],
}) {
  const be = BACKENDS[profile.backend];
  if (!be) throw new Error(`Unknown encoder backend: ${profile.backend}`);

  const sub = buildSubtitleFilter(selection?.subtitle ?? null, srcPath,
    { extractedPath, fontsDir, overlayPath });
  const audioIdx = selection?.audio?.typeIndex ?? 0;
  // Same rules as the streaming path: deinterlace before anything scales,
  // tone-map HDR after the scale so chunks match the stream's colours.
  const wantDeint = profile.deinterlace === 'on'
    || ((profile.deinterlace ?? 'auto') === 'auto'
      && selection?.video?.interlaced === true);
  const cpuDeint = wantDeint ? 'bwdif,' : '';
  const cpuToneFilter = selection?.video?.hdr
    && (profile.tonemap ?? 'auto') !== 'none'
    ? `${cpuTonemap(profile.tonemapCurve)},format=yuv420p` : '';
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
  const preUpload = sub.filter
    ? [
      `${cpuDeint}scale=${rect.w}:${rect.h},setsar=1${cpuToneFilter ? `,${cpuToneFilter}` : ''}`,
      ...(start > 0 ? [`setpts=PTS+${Number(start).toFixed(3)}/TB`] : []),
      `${sub.filter}:alpha=0`,
      ...(start > 0 ? ['setpts=PTS-STARTPTS'] : []),
      `pad=${profile.width}:${profile.height}:${rect.x}:${rect.y}:color=black`,
      `fps=${effAll.rate}`,
    ]
    : [cpuDeint + (cpuToneFilter ? base.replace(',pad=', `,${cpuToneFilter},pad=`) : base)];
  const cpuChain = [...preUpload, upload];

  // The overlay's ASS is written in the CLIP's own timeline, so its event
  // times only line up where the source's `-ss` rebasing has been undone.
  // The CPU chain above already does that around its subtitles filter and
  // gets this for nothing; the bitmap graph has no such shift, so an
  // intro/outro overlay on a chunk starting at 300s would sit 300s in the
  // past and never fire. 'always' events survive either way, which is
  // exactly why this is worth stating rather than testing once and trusting.
  const ovPost = !sub.postFilter ? ''
    : Number(start) > 0
      ? `,setpts=PTS+${Number(start).toFixed(3)}/TB${sub.postFilter},setpts=PTS-STARTPTS`
      : sub.postFilter;

  const up = upload || 'null';
  const imgs = imageOverlayChain((overlayImages ?? []).filter((i) => i?.path), {
    width: profile.width, firstInput: 1, inLabel: 'o', outLabel: 'vi',
    // Each chunk starts at its own point in the episode, so the bounce
    // continues across a chunk boundary instead of restarting inside it.
    phase: start,
  });

  let filterArgs;
  if (sub.needsComplex || imgs.filters.length) {
    const parts = [];
    if (sub.needsComplex) {
      // Bitmap subtitles (DVD/PGS subpictures) carry pixel positions in the
      // SOURCE frame's coordinate space. Compositing after scale+pad placed
      // them at source coordinates on the padded 1080p frame — upper-left,
      // wrong size. Overlay at native size first; scaling then carries the
      // subtitles along with the picture.
      parts.push(`[0:v:0][${sub.overlayInput}]overlay[s]`);
      parts.push(`[s]${cpuDeint}${cpuToneFilter ? base.replace(',pad=', `,${cpuToneFilter},pad=`) : base}${ovPost}[o]`);
    } else {
      parts.push(`[0:v:0]${preUpload.filter(Boolean).join(',')}[o]`);
    }
    parts.push(...imgs.filters);
    parts.push(`[${imgs.filters.length ? 'vi' : 'o'}]${up}[v]`);
    filterArgs = ['-filter_complex', parts.join(';'), '-map', '[v]'];
  } else {
    filterArgs = ['-vf', cpuChain.filter(Boolean).join(','), '-map', '0:v:0'];
  }

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...be.deviceArgs(profile),
    '-ss', Number(start).toFixed(3),
    '-i', srcPath,
    ...imgs.inputs,
    // After every input, or ffmpeg reads it as an input option belonging to
    // whichever -i follows and the chunk stops being bounded.
    '-t', Number(dur).toFixed(3),
    ...filterArgs,
    '-map', `0:a:${audioIdx}?`,
    ...be.encoderArgs(profEff),
    // Bounded to the chunk window so it cannot overlap its neighbours.
    ...audioArgs(profile, { trimTo: dur, head: Number(start) <= 0 }),
    // Absolute placement on the output timeline. This is what lets chunks be
    // produced out of order and still join exactly.
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-fps_mode', 'cfr',
    '-muxdelay', '0', '-muxpreload', '0',
    // Each chunk is an independent TS file, so its continuity counters start
    // over. Byte-joining them steps the counter at every seam and a demuxer
    // reports the packet there as corrupt — which is what the `Packet
    // corrupt` once per chunk actually was. The discontinuity indicator is
    // the container's own way of saying the jump is intentional.
    '-mpegts_flags', '+resend_headers+initial_discontinuity',
    '-f', 'mpegts', out,
  ];
}

/** Hold card, matching the output profile so the publisher sees no change. */
/** drawtext font argument that works across distros: the well-known DejaVu
 *  locations first, fontconfig's default face when none of them exist. */
function fontArg() {
  const f = HOLD_FONTS.find((p) => { try { return existsSync(p); } catch { return false; } });
  return f ? `fontfile=${f}:` : '';
}

/** Card encoder: software x264 so cards work even when hardware encoding is
 *  what broke, matched to the profile so the publisher never sees a seam. */
/**
 * How a card (hold or countdown) is encoded: from the SAME template as the
 * clip spawn — the broadcast's own backend entry supplies -c:v, the encoder
 * flags, and the upload filter, so the card is bitstream-compatible with
 * any broadcast BY CONSTRUCTION (a codec, bit-depth or cadence flip
 * mid-stream is fatal downstream: an H.264 card in an HEVC broadcast
 * flooded the receiver with per-packet NALU parse errors, and
 * fMP4/Matroska paths tolerate no mid-stream parameter change at all).
 *
 * Three deliberate deltas from a clip, none of which touch the bitstream
 * class: the input is a generated still (drawn on the CPU and pushed up
 * through the backend's own uploadFilter — the same canvas→hwupload shape
 * the subtitle chain uses); the rate is the CLIP's effective rate rather
 * than the profile cap (a 30fps card against a 23.976 stream changes the
 * cadence at both seams); and a software-AV1 card pins the fast preset —
 * clips scale the preset to the host, but a static frame has nothing to
 * polish. When the broadcast is HDR the card uploads p010 and tags
 * BT.2020/PQ, so Main10 stays Main10 and the VUI does not flip either.
 */
function cardVideoPlan(profile, selection = null) {
  const eff = effectiveFps(selection?.video, profile);
  const audio = ['-c:a', 'aac', '-b:a', profile.audioBitrate ?? '160k', '-ar', '48000', '-ac', '2'];
  const be = BACKENDS[profile.backend] ?? BACKENDS.x264;
  const p = {
    ...profile,
    fps: eff.fps,
    ...(profile.codec === 'av1' ? { av1Preset: 12 } : {}),
  };
  const hdr = Boolean(profile.hdrOut);
  const upload = be.uploadFilter();
  return {
    rate: eff.rate,
    deviceArgs: be.deviceArgs(profile),
    vfTail: ',' + (hdr ? upload.replace(/nv12|yuv420p/, 'p010le') : upload),
    encodeArgs: [
      ...be.encoderArgs(p),
      ...(hdr ? [
        '-color_primaries', 'bt2020',
        '-color_trc', 'smpte2084',
        '-colorspace', 'bt2020nc',
      ] : []),
      ...audio,
    ],
  };
}

/** The stream-tail every feeder shares: TS with repeating headers, or NUT
 *  for AV1 (see the transport note on the engine). */
const cardMuxArgs = (profile) => (profile.codec === 'av1'
  ? ['-f', 'nut', 'pipe:1']
  : ['-mpegts_flags', '+resend_headers', '-f', 'mpegts', 'pipe:1']);

export function buildHoldArgs({
  profile, selection = null, tsOffset = 0, statsPeriodMs = 500, label = 'Paused',
}) {
  const text = String(label).replace(/[\\':]/g, '');
  const plan = cardVideoPlan(profile, selection);

  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...plan.deviceArgs,
    // -re here even though pacing lives on the publisher: black frames are so
    // small that unpaced output lets MINUTES of hold-card fit in the pipe
    // buffers, and on resume all of it plays out before the episode returns.
    '-re',
    '-f', 'lavfi', '-i', `color=c=black:s=${profile.width}x${profile.height}:r=${plan.rate}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', `drawtext=${fontArg()}text='${text}':fontcolor=white:`
      + 'fontsize=h/18:x=(w-text_w)/2:y=(h-text_h)/2'
      + plan.vfTail,
    ...plan.encodeArgs,
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-muxdelay', '0', '-muxpreload', '0',
    '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
    ...cardMuxArgs(profile),
  ];
}

const HOLD_FONTS = [
  '/usr/share/fonts/TTF/DejaVuSans.ttf',                       // Arch
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',           // Debian/Ubuntu
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',                    // Fedora
];

/**
 * The pre-show card: SMPTE bars, a big clock counting down to the scheduled
 * start, and the first title underneath. Runs exactly `seconds` and exits 0,
 * which the ordinary clip-close path treats as a natural end — _advance()
 * then rolls straight into the show.
 */
export function buildCountdownArgs({
  profile, selection = null, tsOffset = 0, statsPeriodMs = 500, seconds, nextTitle = '',
  heading = 'STARTING SOON',
}) {
  const W = profile.width;
  const H = profile.height;
  const R = Math.ceil(seconds);
  const font = fontArg();
  // Remaining time, rendered live by drawtext: R counts down with stream
  // time. Hours appear only when the wait is that long.
  const clock = R >= 3600
    ? `%{eif\\:trunc((${R}-t)/3600)\\:d\\:1}\\:%{eif\\:mod(trunc((${R}-t)/60),60)\\:d\\:2}\\:%{eif\\:mod(trunc(${R}-t),60)\\:d\\:2}`
    : `%{eif\\:trunc((${R}-t)/60)\\:d\\:2}\\:%{eif\\:mod(trunc(${R}-t),60)\\:d\\:2}`;
  const title = String(nextTitle).replace(/[\\':%]/g, '').slice(0, 70);
  const vf = [
    // The dark band the text sits on, so the clock reads over any bar color.
    `drawbox=x=0:y=ih*0.30:w=iw:h=ih*0.40:color=black@0.72:t=fill`,
    `drawtext=${font}text='${String(heading).replace(/[\\':%]/g, '')}':fontcolor=white@0.85:`
      + 'fontsize=h/22:x=(w-text_w)/2:y=h*0.345',
    `drawtext=${font}text='${clock}':fontcolor=white:`
      + 'fontsize=h/5:x=(w-text_w)/2:y=h*0.42',
    ...(title ? [
      `drawtext=${font}text='${title}':fontcolor=white@0.85:`
        + 'fontsize=h/26:x=(w-text_w)/2:y=h*0.625',
    ] : []),
  ].join(',');

  const plan = cardVideoPlan(profile, selection);
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...plan.deviceArgs,
    '-re',
    '-f', 'lavfi', '-t', String(R),
    '-i', `smptehdbars=s=${W}x${H}:r=${plan.rate}`,
    '-f', 'lavfi', '-t', String(R),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', vf + plan.vfTail,
    ...plan.encodeArgs,
    '-output_ts_offset', Number(tsOffset).toFixed(3),
    '-muxdelay', '0', '-muxpreload', '0',
    '-progress', 'pipe:3', '-stats_period', String(statsPeriodMs / 1000),
    ...cardMuxArgs(profile),
  ];
}

function lastLines(s, n) {
  return (s || '').split('\n').filter(Boolean).slice(-n).join('\n');
}

/**
 * Are this file's keyframes frequent enough to deliver live by copying?
 *
 * `encoder.copyMaxGopSeconds` is the bar (default 4s). It is not a guess
 * about any particular ingest: every live packager — HLS, DASH — starts
 * segments on keyframes, so the interval IS the segment length, and a
 * viewer sits a few segments behind it. Four seconds keeps the common
 * WEB-DL and remux cases (1-2s keyframes) on the free path and sends the
 * long-GOP encodes, where copying cannot be delivered smoothly at any
 * latency, to the encoder. An unmeasured file answers yes, so a probe
 * that could not run never silently disables passthrough.
 */
export function copyKeyframesFitLive(profile) {
  const gop = Number(profile?.srcGopSeconds);
  if (!Number.isFinite(gop) || gop <= 0) return true;
  const cap = Number(profile?.copyMaxGopSeconds) > 0
    ? Number(profile.copyMaxGopSeconds) : 4;
  return gop <= cap;
}

/**
 * Scale to output size and, for HDR sources, get to BT.709 somehow.
 *
 * "Somehow" is the point: tonemap_vaapi exists on Intel and not on Mesa, so
 * the strategy is measured once per device by pickTonemap() and arrives here
 * as profile.tonemap. Building the Intel filter on an AMD box does not
 * degrade the picture — it kills the clip at -22 before any frame exists.
 *
 * The CPU route deliberately runs AFTER the GPU scale, so the tone mapper
 * sees 1080p rather than 4K, and re-uploads so everything downstream still
 * composites on the GPU.
 */
export function scaleAndTonemap(video, profile, rect, smode) {
  const scale = `scale_vaapi=w=${rect.w}:h=${rect.h}`;
  if (!video?.hdr) {
    // format=nv12 is load-bearing: 10-bit sources decode to P010 surfaces,
    // and h264_vaapi accepts only NV12 — without the GPU-side conversion
    // the encoder dies with -22 (Invalid argument) on every 10-bit file.
    return `${scale}:format=nv12${smode}`;
  }
  const how = profile?.tonemap ?? 'vaapi';
  if (how === 'vaapi') {
    return `${scale}${smode},tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709`;
  }
  if (how === 'cpu') {
    return `${scale}${smode},hwdownload,format=p010le,${cpuTonemap(profile?.tonemapCurve)},format=nv12,hwupload`;
  }
  // Nothing on this box can tone map. Washed-out beats dead air, and the
  // operator was told why when the strategy was chosen.
  return `${scale}:format=nv12${smode}`;
}

