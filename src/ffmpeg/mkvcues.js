/**
 * Read a Matroska file's subtitle blocks through its cue index.
 *
 * A PGS track's windows (pgsband.js) live in its display sets, and the
 * obvious way to reach them — demuxing the file — reads every byte of a
 * 25 GB disc. But an mkvmerge-muxed file, which is what every remux is,
 * carries a cue point for every subtitle block: CueClusterPosition plus
 * CueRelativePosition is the byte offset of the block. So the track can
 * be read in a few thousand small reads at known offsets, seconds even on
 * a USB disk, without touching the video.
 *
 * Only what is needed: EBML element headers, the Tracks list (to map the
 * Nth subtitle stream to its track number the way ffmpeg orders them),
 * the Cues, and the blocks the cues point at. Anything unexpected — no
 * cues for the track, lacing, an unknown-size cluster in the way — makes
 * the reader answer null and the caller falls back to a demux.
 */
import { open } from 'fs/promises';

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Seek: 0x4DBB,
  SeekID: 0x53AB, SeekPosition: 0x53AC, Tracks: 0x1654AE6B, TrackEntry: 0xAE,
  TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, Cluster: 0x1F43B675,
  SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, Cues: 0x1C53BB6B,
  CuePoint: 0xBB, CueTrackPositions: 0xB7, CueTrack: 0xF7,
  CueClusterPosition: 0xF1, CueRelativePosition: 0xF0,
};
const TRACK_SUBTITLE = 0x11;
const MAX_CUES = 50_000;

/** A vint: returns { value, length }; `marker` keeps the length bits (ids). */
function vint(buf, pos, marker = false) {
  if (pos >= buf.length) return null;
  const b0 = buf[pos];
  if (b0 === 0) return null;
  let len = 1;
  while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len += 1;
  if (pos + len > buf.length) return null;
  let value = marker ? b0 : (b0 & (0xFF >> len));
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  const unknown = !marker && value === 2 ** (7 * len) - 1;
  return { value, length: len, unknown };
}

function header(buf, pos) {
  const id = vint(buf, pos, true);
  if (!id) return null;
  const size = vint(buf, pos + id.length);
  if (!size) return null;
  return { id: id.value, size: size.value, unknown: size.unknown, dataAt: pos + id.length + size.length, headerLen: id.length + size.length };
}

function uintOf(buf, at, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[at + i];
  return v;
}

/** Walk the children of an element held in `buf` (dataAt..end). */
function* children(buf, start, end) {
  let pos = start;
  while (pos < end) {
    const h = header(buf, pos);
    if (!h || h.unknown) return;
    const next = h.dataAt + h.size;
    if (next > end) return;
    yield { ...h, end: next };
    pos = next;
  }
}

/**
 * The windows of the Nth subtitle stream, read through the cues.
 * Resolves to the scan geometry pgsband.js expects, or null.
 */
export async function pgsWindowsViaCues(srcPath, subtitleIndex, { maxBlocks = MAX_CUES } = {}) {
  let fh;
  try { fh = await open(srcPath, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    const readAt = async (at, len) => {
      if (at < 0 || at >= st.size) return Buffer.alloc(0);
      const buf = Buffer.alloc(Math.min(len, st.size - at));
      const { bytesRead } = await fh.read(buf, 0, buf.length, at);
      return buf.subarray(0, bytesRead);
    };

    // EBML header, then the Segment.
    let head = await readAt(0, 64 * 1024);
    const ebml = header(head, 0);
    if (!ebml || ebml.id !== ID.EBML) return null;
    const seg = header(head, ebml.dataAt + ebml.size);
    if (!seg || seg.id !== ID.Segment) return null;
    const segStart = seg.dataAt;

    // Top-level children: SeekHead (where the Cues are), Tracks, maybe
    // Cues up front. Stop at the first Cluster.
    let cuesAt = null;
    let tracksBuf = null;
    let cuesBuf = null;
    let pos = segStart;
    for (let guard = 0; guard < 64; guard++) {
      const buf = await readAt(pos, 64 * 1024);
      const h = header(buf, 0);
      if (!h) break;
      if (h.id === ID.Cluster) break;
      if (h.id === ID.SeekHead || h.id === ID.Tracks || h.id === ID.Cues) {
        const whole = h.size + h.headerLen <= buf.length ? buf.subarray(0, h.size + h.headerLen) : await readAt(pos, h.size + h.headerLen);
        const hh = header(whole, 0);
        if (h.id === ID.SeekHead) {
          for (const seek of children(whole, hh.dataAt, hh.dataAt + hh.size)) {
            if (seek.id !== ID.Seek) continue;
            let sid = null; let spos = null;
            for (const c of children(whole, seek.dataAt, seek.end)) {
              if (c.id === ID.SeekID) sid = uintOf(whole, c.dataAt, c.size);
              if (c.id === ID.SeekPosition) spos = uintOf(whole, c.dataAt, c.size);
            }
            if (sid === ID.Cues && spos != null) cuesAt = segStart + spos;
          }
        } else if (h.id === ID.Tracks) tracksBuf = whole;
        else cuesBuf = whole;
      }
      if (h.unknown) break;
      pos += h.headerLen + h.size;   // h was parsed at offset 0 of a buffer read at pos
    }
    if (!tracksBuf) return null;
    if (!cuesBuf && cuesAt != null) {
      const hb = await readAt(cuesAt, 64);
      const ch = header(hb, 0);
      if (!ch || ch.id !== ID.Cues || ch.unknown || ch.size > 256 * 1024 * 1024) return null;
      cuesBuf = await readAt(cuesAt, ch.size + ch.headerLen);
    }
    if (!cuesBuf) return null;

    // The Nth subtitle track, in order of appearance — ffmpeg's s:N.
    const th = header(tracksBuf, 0);
    let trackNumber = null; let seen = 0;
    for (const te of children(tracksBuf, th.dataAt, th.dataAt + th.size)) {
      if (te.id !== ID.TrackEntry) continue;
      let num = null; let type = null;
      for (const c of children(tracksBuf, te.dataAt, te.end)) {
        if (c.id === ID.TrackNumber) num = uintOf(tracksBuf, c.dataAt, c.size);
        if (c.id === ID.TrackType) type = uintOf(tracksBuf, c.dataAt, c.size);
      }
      if (type === TRACK_SUBTITLE) {
        if (seen === subtitleIndex) { trackNumber = num; break; }
        seen += 1;
      }
    }
    if (trackNumber == null) return null;

    // Every cue for that track.
    const ch = header(cuesBuf, 0);
    const blocks = [];
    for (const cp of children(cuesBuf, ch.dataAt, ch.dataAt + ch.size)) {
      if (cp.id !== ID.CuePoint) continue;
      for (const tp of children(cuesBuf, cp.dataAt, cp.end)) {
        if (tp.id !== ID.CueTrackPositions) continue;
        let track = null; let cluster = null; let rel = null;
        for (const c of children(cuesBuf, tp.dataAt, tp.end)) {
          if (c.id === ID.CueTrack) track = uintOf(cuesBuf, c.dataAt, c.size);
          if (c.id === ID.CueClusterPosition) cluster = uintOf(cuesBuf, c.dataAt, c.size);
          if (c.id === ID.CueRelativePosition) rel = uintOf(cuesBuf, c.dataAt, c.size);
        }
        if (track === trackNumber && cluster != null && rel != null) blocks.push({ cluster, rel });
      }
      if (blocks.length > maxBlocks) return null;
    }
    if (!blocks.length) return null;

    // Read each block: the cluster's header tells where its data starts,
    // the relative position points at the block element inside it.
    const acc = { width: 0, height: 0, minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, windows: 0, cues: 0, source: 'cues', blocks: blocks.length };
    const clusterData = new Map();
    for (const b of blocks) {
      let dataAt = clusterData.get(b.cluster);
      if (dataAt == null) {
        const cb = await readAt(segStart + b.cluster, 16);
        const chh = header(cb, 0);
        if (!chh || chh.id !== ID.Cluster) return null;
        dataAt = segStart + b.cluster + chh.headerLen;
        clusterData.set(b.cluster, dataAt);
      }
      const at = dataAt + b.rel;
      const bh = await readAt(at, 16);
      let eh = header(bh, 0);
      if (!eh) return null;
      let frameAt = at + eh.headerLen; let frameLen = eh.size;
      if (eh.id === ID.BlockGroup) {
        const gb = await readAt(frameAt, 16);
        const inner = header(gb, 0);
        if (!inner || inner.id !== ID.Block) return null;
        frameAt += inner.headerLen; frameLen = inner.size; eh = inner;
      } else if (eh.id !== ID.SimpleBlock) return null;
      if (frameLen > 4 * 1024 * 1024) return null;
      const blk = await readAt(frameAt, frameLen);
      const tn = vint(blk, 0);
      if (!tn) return null;
      const flags = blk[tn.length + 2];
      if (flags & 0x06) return null;           // laced: not worth guessing
      parseMkvPgsFrame(blk.subarray(tn.length + 3), acc);
    }
    return acc.windows > 0 ? acc : null;
  } catch {
    return null;
  } finally {
    try { await fh.close(); } catch { /* closed */ }
  }
}

/** PGS segments as stored in Matroska: type(1) size(2) payload, no PG header. */
export function parseMkvPgsFrame(frame, acc) {
  let i = 0;
  while (i + 3 <= frame.length) {
    const type = frame[i];
    const size = frame.readUInt16BE(i + 1);
    const p = i + 3;
    if (p + size > frame.length) break;
    if (type === 0x16 && size >= 11) {
      acc.width = frame.readUInt16BE(p); acc.height = frame.readUInt16BE(p + 2);
      if (frame[p + 10] > 0) acc.cues += 1;
    } else if (type === 0x17 && size >= 1) {
      const n = frame[p];
      for (let w = 0; w < n && p + 1 + w * 9 + 9 <= p + size; w++) {
        const o = p + 1 + w * 9;
        const x = frame.readUInt16BE(o + 1), y = frame.readUInt16BE(o + 3);
        const ww = frame.readUInt16BE(o + 5), hh = frame.readUInt16BE(o + 7);
        acc.minX = Math.min(acc.minX, x); acc.maxX = Math.max(acc.maxX, x + ww);
        acc.minY = Math.min(acc.minY, y); acc.maxY = Math.max(acc.maxY, y + hh);
        acc.windows += 1;
      }
    }
    i = p + size;
  }
  return acc;
}
