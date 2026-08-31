/**
 * Per-backend encoder definitions.
 *
 * Everything upstream of `hwupload` is backend-independent — we decode and
 * scale in software deliberately, because the source library is mixed-codec
 * and a file the GPU can't decode would kill the process mid-job instead of
 * degrading. Only the tail of the filter chain and the encoder flags differ.
 *
 * Ladder order matters: VAAPI before QSV on purpose. QSV on Linux is layered
 * on VAAPI internally (it builds a VAAPI display and filters on Intel's PCI
 * vendor id), so if VAAPI fails QSV cannot work either — and QSV's extra
 * rate-control features are useless for a CBR stream.
 */

import { availableParallelism } from 'os';

/** Preference order for `backend: "auto"`. First one that probes clean wins. */
export const LADDER = ['vaapi', 'qsv', 'nvenc', 'amf', 'videotoolbox', 'x264'];

/**
 * @typedef {object} EncodeProfile
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {string} videoBitrate  e.g. "4500k"
 * @property {number} gopSeconds
 * @property {string} device        DRM render node, for vaapi/qsv
 */

/**
 * Normalise a bitrate to a form ffmpeg reads the way a human meant it.
 *
 * ffmpeg treats a bare number as BITS per second, so "12000" means 12 kbps —
 * not 12 Mbps — and produces a picture made of coloured blocks. Nobody typing
 * into a bitrate field means bits, so a unitless value is read as kbps.
 */
export function normalizeBitrate(value, fallback = '4500k') {
  if (value == null || value === '') return fallback;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)(?:b(?:it)?s?(?:\/s)?)?$/);
  if (!m) return fallback;

  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return `${Math.round(n * 1000)}k`;
  if (unit === 'k') return `${Math.round(n)}k`;
  // Unitless. Values this small are certainly kbps; a genuine bits-per-second
  // figure for video would be in the millions.
  return `${Math.round(n)}k`;
}

/**
 * The bitrate the selected codec actually needs.
 *
 * `videoBitrate` is the H.264 anchor — the number the operator tuned and
 * must never lose to a codec switch. HEVC reaches the same quality at
 * roughly 2/3 of it and AV1 at roughly half, so those codecs derive their
 * rate from the anchor unless an explicit `hevcBitrate`/`av1Bitrate`
 * override is set. Fewer bits is also cheaper to encode — this is half of
 * the N100's HEVC performance answer, not just a bandwidth saving.
 */
export function codecBitrate(enc = {}) {
  const codec = enc.codec ?? 'h264';
  const anchor = normalizeBitrate(enc.videoBitrate, '4500k');
  if (codec === 'h264') return anchor;
  const override = enc[`${codec}Bitrate`];
  if (override != null && override !== '') return normalizeBitrate(override, anchor);
  const scale = codec === 'hevc' ? 2 / 3 : 1 / 2;
  return `${Math.round(parseFloat(anchor) * scale)}k`;
}

/**
 * SVT-AV1 preset for a LIVE encode on this host. Explicit override first;
 * otherwise sized by core count: ~8 modern cores hold preset 9 at 1080p,
 * anything smaller gets the faster presets because a softer picture airs
 * and a stalled one does not (an N100 measured 0.74x at 9, 3.2x at 12).
 */
const av1Preset = (p) => {
  const forced = Number(p?.av1Preset);
  if (Number.isFinite(forced) && forced >= 5 && forced <= 13) return Math.round(forced);
  let cores = 4;
  try { cores = availableParallelism(); } catch { /* keep the floor */ }
  return cores >= 12 ? 9 : cores >= 6 ? 10 : 12;
};

const bufsize = (rate) => {
  // Two seconds of video at the target rate. Accepts "4500k" or a raw number.
  const m = String(rate).match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!m) throw new Error(`Unparseable bitrate: ${rate}`);
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return `${Math.round(n * 2)}${unit}`;
};

export const BACKENDS = {
  vaapi: {
    label: 'VAAPI (Intel/AMD)',
    hwaccel: true,
    /** Args that must appear before -i. */
    deviceArgs: (p) => [
      '-init_hw_device', `vaapi=va:${p.device}`,
      '-filter_hw_device', 'va',
    ],
    /** Tail of the video filter chain — hands software frames to the GPU. */
    uploadFilter: () => 'format=nv12,hwupload',
    encoderArgs: (p) => [
      /**
       * The output CODEC is a setting now (encoder.codec): h264 stays the
       * universal default (99.9% browser decode), hevc buys ~35% bitrate
       * at the same quality where the audience allows it, av1 more still.
       * Hardware support is probed by doing at the check endpoint — RDNA2
       * has no AV1 encode, Alder Lake-N neither; where vaapi lacks the
       * codec the operator sees the probe fail rather than a demotion.
       */
      '-c:v', { h264: 'h264_vaapi', hevc: 'hevc_vaapi', av1: 'av1_vaapi' }[p.codec ?? 'h264'] ?? 'h264_vaapi',
      /**
       * VDENC for HEVC where the driver has it (probed at start, never
       * assumed): -low_power routes encode through the fixed-function
       * media block instead of the EUs — on an N100 that is the
       * difference between HEVC costing more than H.264 and costing
       * less. H.264 is left alone: that path is tuned and working.
       */
      ...(p.lowPower && p.codec === 'hevc' ? ['-low_power', '1'] : []),
      '-rc_mode', 'CBR',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      // Hardware encoders do fixed GOP with no scene-cut insertion by
      // default, which is exactly what HLS segmenting wants. -keyint_min
      // and -sc_threshold do not exist here and are silently ignored.
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-bf', '0',
    ],
  },

  qsv: {
    label: 'QuickSync (Intel)',
    hwaccel: true,
    deviceArgs: () => ['-init_hw_device', 'qsv=hw'],
    uploadFilter: () => 'format=nv12,hwupload=extra_hw_frames=64',
    encoderArgs: (p) => [
      '-c:v', 'h264_qsv',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      '-low_delay_brc', '1',
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-adaptive_i', '0',
      // Without this, -force_key_frames emits plain I-frames rather than
      // IDRs, which segmenters cannot cut on.
      '-forced_idr', '1',
      '-bf', '0',
    ],
  },

  nvenc: {
    label: 'NVENC (NVIDIA)',
    hwaccel: true,
    deviceArgs: () => [],
    uploadFilter: () => 'format=yuv420p',
    encoderArgs: (p) => [
      '-c:v', 'h264_nvenc',
      '-rc', 'cbr',
      '-preset', 'p4',
      '-tune', 'll',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-no-scenecut', '1',
      '-forced-idr', '1',
      '-bf', '0',
    ],
  },

  amf: {
    label: 'AMF (AMD)',
    hwaccel: true,
    deviceArgs: () => [],
    uploadFilter: () => 'format=nv12',
    encoderArgs: (p) => [
      '-c:v', 'h264_amf',
      '-rc', 'cbr',
      '-quality', 'balanced',
      '-b:v', p.videoBitrate,
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-bf', '0',
    ],
  },

  videotoolbox: {
    label: 'VideoToolbox (macOS)',
    hwaccel: true,
    deviceArgs: () => [],
    uploadFilter: () => 'format=nv12',
    encoderArgs: (p) => [
      '-c:v', 'h264_videotoolbox',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-bf', '0',
    ],
  },

  x264: {
    label: 'libx264 (software)',
    hwaccel: false,
    deviceArgs: () => [],
    uploadFilter: () => 'format=yuv420p',
    encoderArgs: (p) => (p.codec === 'av1' ? [
      // Software AV1 = SVT-AV1: the only AV1 path on pre-RDNA3 / N-series
      // hosts. The preset scales with the host — 9 holds realtime 1080p on
      // ~8 modern cores, but an N100's four E-cores ran it at 0.74x under
      // a subtitle canvas (measured live, broadcast crawled to death)
      // while preset 12 measured 3.2x on the same box. Speed beats polish
      // for a LIVE encode: a softer picture airs, a stalled one does not.
      // encoder.av1Preset overrides for boxes that want it pinned.
      '-c:v', 'libsvtav1',
      '-preset', String(av1Preset(p)),
      '-b:v', p.videoBitrate,
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      // SVT rejects -maxrate outside CRF and allows CBR only with the
      // low-delay prediction structure — which is what live wants anyway.
      '-svtav1-params', 'rc=2:pred-struct=1',
    ] : p.codec === 'hevc' ? [
      '-c:v', 'libx265',
      '-preset', 'veryfast',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-x265-params', `keyint=${Math.round(p.gopSeconds * p.fps)}:min-keyint=${Math.round(p.gopSeconds * p.fps)}:scenecut=0:bframes=0`,
    ] : [
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', p.videoBitrate,
      '-maxrate', p.videoBitrate,
      '-bufsize', bufsize(p.videoBitrate),
      '-x264-params', 'nal-hrd=cbr',
      // Only libx264 has these. Scene detection would otherwise insert
      // unscheduled keyframes and desynchronise HLS segment boundaries.
      '-g', String(Math.round(p.gopSeconds * p.fps)),
      '-keyint_min', String(Math.round(p.gopSeconds * p.fps)),
      '-sc_threshold', '0',
      '-bf', '0',
    ]),
  },
};

/** Audio is identical across backends — always software AAC. */
/**
 * Chunk boundaries must land on a whole number of AAC frames.
 *
 * AAC codes 1024 samples at a time, so at 48 kHz a frame is 1024/48000s and
 * the encoder can only end on a multiple of it. Ask for a round 20s chunk
 * and it pads out to 20.035 while the next chunk is placed at exactly 20.0,
 * so every seam steps 35ms BACKWARDS in audio — the non-monotonic DTS and
 * `Packet corrupt` that showed up once per chunk, forever.
 *
 * Three AAC frames come to 0.064s exactly, so quantizing to that keeps the
 * boundaries exact in the 3-decimal form the ffmpeg arguments use — at finer
 * granularity the rounding in `-t` would reintroduce the very drift this
 * removes.
 */
export const CHUNK_GRID = 0.064;

/** Nearest chunk boundary that an AAC encoder can actually hit. */
export const onAudioGrid = (seconds) => Number(
  (Math.max(1, Math.round(seconds / CHUNK_GRID)) * CHUNK_GRID).toFixed(3),
);

/** One AAC frame at 48 kHz. */
export const AAC_FRAME = 1024 / 48000;

/**
 * `trimTo` bounds a chunk's audio so it abuts its neighbours exactly.
 *
 * The trim is one frame SHORT of the window on purpose. An AAC encoder
 * emits a priming frame ahead of the audio proper, so a chunk asked for
 * exactly its window comes back one frame long and overlaps the chunk
 * placed after it. Every chunk is primed identically, so giving the
 * encoder one frame less input leaves the whole stream uniformly shifted
 * by that frame — and uniform is the point: the seams line up.
 *
 * `head` is the exception that proves it. A chunk at offset zero is not
 * seeked, so its priming frame is clamped up to zero rather than sitting
 * one frame negative like every other chunk's. It is the one chunk NOT
 * shifted, and it needs the extra frame taken off to match.
 */
export const audioArgs = (p, { trimTo = null, head = false } = {}) => [
  '-af', 'aresample=async=1:first_pts=0,'
       + 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'
       + (trimTo
         ? `,atrim=end=${Math.max(
           AAC_FRAME, Number(trimTo) - AAC_FRAME * (head ? 2 : 1),
         ).toFixed(6)}`
           + ',asetpts=N/SR/TB'
         : ''),
  '-c:a', 'aac',
  '-b:a', p.audioBitrate ?? '160k',
  '-ar', '48000',
  '-ac', '2',
];

/**
 * The software half of the filter chain: fit into the target frame without
 * distortion, pillar/letterbox the remainder, pin the framerate.
 *
 * Every clip must come out bit-identical in geometry and timebase, because
 * the concat demuxer takes its parameters from the first file and silently
 * reinterprets every later one in that timebase.
 */
export const scaleFilter = (p) =>
  `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,`
  + `pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=black,`
  + `setsar=1,fps=${p.fps}`;
