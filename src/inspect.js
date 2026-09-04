/**
 * Media inspection: the facts about a file, and what the encoder will do
 * with it on air. The verdict mirrors the passthrough gate in
 * buildSourceArgs — same conditions, in words — so the sheet never
 * disagrees with the log.
 */

const up = (s) => String(s ?? '').toUpperCase();

/**
 * Bits per component: 10 from "yuv420p10le", 16 from "gray16le", null when
 * unknown. Only formats that SPELL a depth report more than 8 — the digits
 * in "rgb24", "yuyv422" and "nv12" are bits per pixel or chroma layout,
 * and reading them as a depth put "24-bit decode" warnings on plain RGB.
 */
export function bitDepthOf(pixFmt) {
  if (!pixFmt) return null;
  const f = String(pixFmt).toLowerCase();
  const depth = (re) => { const m = re.exec(f); return m ? Number(m[1]) : null; };
  // Planar: the depth follows the 'p' — yuv420p10le, gbrp12, yuva444p16be.
  return depth(/p(9|1[0-6])(?:le|be)?$/)
    // Grey and grey+alpha: gray10le, gray16be, ya16le.
    ?? depth(/^(?:gray|ya)(9|1[0-6])(?:le|be)?$/)
    // Semi-planar 10/12/16-bit: p010le, p012le, p016le, p210le, p416be.
    ?? depth(/^p[024](1[026])(?:le|be)?$/)
    // Packed high-depth RGB: rgb48le, bgra64be (16 per component),
    // x2rgb10le (10 per component).
    ?? (/^(?:rgb|bgr)a?(?:48|64)(?:le|be)?$/.test(f) ? 16 : null)
    ?? (/^x2(?:rgb|bgr)10(?:le|be)?$/.test(f) ? 10 : null)
    ?? 8;
}

/** "24000/1001" → 23.976, "25/1" → 25. */
export function fpsOf(rate) {
  if (!rate) return null;
  const [n, d] = String(rate).split('/').map(Number);
  if (!n) return null;
  return d ? Math.round((n / d) * 1000) / 1000 : n;
}

export function langLabel(t) {
  return up(t?.language ?? '?');
}

/**
 * @param video   the probed video stream (codec, width, height, hdr, pixFmt, frameRate)
 * @param audio   probed audio streams
 * @param chosen  { audio, subtitle } as selectTracks would pick by default
 * @param kbps    the file's overall bitrate
 * @param encoder config.encoder
 * @param overlaysOn whether any Studio overlay is switched on
 */
export function inspectVerdict({ video, audio = [], chosen = {}, kbps = null, encoder = {}, overlaysOn = false }) {
  const codec = encoder.codec ?? 'h264';
  const reasons = [];
  const notes = [];
  if (!video) return { passthrough: false, will: 'Cannot play: no video stream', reasons: ['no video stream found'], notes };

  if (codec !== 'hevc') {
    reasons.push(`passthrough exists only for an HEVC output; the encoder is set to ${up(codec)}`);
  } else if (video.codec !== 'hevc') {
    reasons.push(`the source is ${up(video.codec)} and the output is HEVC`);
  }
  if (chosen.subtitle) {
    const s = chosen.subtitle;
    reasons.push(`subtitles would be burned in (${langLabel(s)} ${up(s.codec)}${s.external ? ' sidecar' : ''}, chosen by default)`);
  }
  if (overlaysOn) reasons.push('overlays are on air — hide them from the broadcast in the Studio to pass through');
  if (video.hdr && !encoder.hdrOutput) reasons.push('the source is HDR and HDR output is off, so it is tone-mapped to SDR');
  const limit = Number(encoder.copyLimitKbps) > 0 ? Number(encoder.copyLimitKbps) : 30000;
  if (kbps != null && kbps > limit) reasons.push(`${kbps} kbps is above the ${limit} kbps copy limit`);

  const passthrough = reasons.length === 0;
  const depth = bitDepthOf(video.pixFmt);
  if (!passthrough) {
    if (depth && depth > 8) notes.push(`${depth}-bit decode costs about 1.6× an 8-bit one`);
    if (video.hdr && encoder.hdrOutput) notes.push('HDR in, HDR out: encoded 10-bit');
    if (video.width && encoder.width && video.width > encoder.width * 1.2) {
      notes.push(`${video.height}p scaled to ${encoder.height}p — the scale is cheap, the decode is not`);
    }
    const src = fpsOf(video.frameRate);
    if (src && encoder.fps && encoder.fpsMode !== 'auto' && Math.abs(src - encoder.fps) > 0.5) {
      notes.push(`${src} fps source, ${encoder.fps} fps output`);
    }
    const a = chosen.audio ?? audio[0];
    if (a && a.codec !== 'aac') notes.push(`${up(a.codec)} audio is re-encoded to AAC`);
  } else {
    notes.push('nothing is re-encoded; the file\'s own bytes go out');
    const gop = Number(encoder.copyMaxGopSeconds) > 0 ? Number(encoder.copyMaxGopSeconds) : 4;
    notes.push(`keyframe spacing is measured when it first plays; wider than ${gop}s falls back to a transcode`);
  }
  const will = passthrough
    ? `Passthrough — ${up(video.codec)} ships untouched`
    : `Transcode → ${up(codec)} ${encoder.width ?? '?'}×${encoder.height ?? '?'}`;
  return { passthrough, will, reasons, notes };
}

/** One line that says what a file is: "HEVC 10-bit 1080p HDR · JPN 5.1 · 2 subs". */
export function summaryOf(sheet) {
  const v = sheet.video;
  if (!v) return 'no video';
  const depth = bitDepthOf(v.pixFmt);
  const parts = [`${up(v.codec)}${depth && depth > 8 ? ` ${depth}-bit` : ''} ${v.height ? `${v.height}p` : ''}${v.hdr ? ' HDR' : ''}`.trim()];
  const a = sheet.audio?.[0];
  if (a) parts.push(`${up(a.language ?? '?')} ${a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels === 2 ? 'stereo' : `${a.channels ?? '?'}ch`}${sheet.audio.length > 1 ? ` +${sheet.audio.length - 1}` : ''}`);
  const n = sheet.subtitles?.length ?? 0;
  parts.push(n ? `${n} sub${n > 1 ? 's' : ''}` : 'no subs');
  return parts.join(' · ');
}
