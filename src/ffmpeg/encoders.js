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
      '-c:v', 'h264_vaapi',
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
    encoderArgs: (p) => [
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
    ],
  },
};

/** Audio is identical across backends — always software AAC. */
export const audioArgs = (p) => [
  '-af', 'aresample=async=1:first_pts=0,'
       + 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
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
