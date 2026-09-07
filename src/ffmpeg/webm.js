/**
 * A streaming WebM/Matroska scanner for live browser captures.
 *
 * MediaRecorder hands over one endless WebM: an EBML header, a Segment of
 * unknown size, Info and Tracks once, then Clusters forever. ffmpeg reads
 * that from a pipe happily — until the process reading it is replaced (a
 * Studio apply, a watchdog respawn, resume after a pause). The successor
 * has never seen the header and cannot start mid-stream, so the bytes must
 * be understood well enough to (a) keep the header, (b) know where clusters
 * and blocks begin and (c) tell a keyframe from the rest, so a new reader
 * can be started on one.
 *
 * That is all this does. It walks elements, keeps the init segment, and
 * reports clusters and blocks with their timecodes and keyframe flags. It
 * never decodes anything and it never buffers more than one element.
 *
 * Unknown-size masters (Segment, Cluster) are descended into; a Cluster of
 * unknown size ends where the next level-1 element begins, which is how
 * both Chrome and Firefox write them.
 */

// ── EBML ids, as the full bytes on the wire ────────────────────────────
export const ID = {
  EBML: 0x1A45DFA3,
  SEGMENT: 0x18538067,
  SEEKHEAD: 0x114D9B74,
  INFO: 0x1549A966,
  TRACKS: 0x1654AE6B,
  CLUSTER: 0x1F43B675,
  CUES: 0x1C53BB6B,
  TAGS: 0x1254C367,
  CHAPTERS: 0x1043A770,
  ATTACHMENTS: 0x1941A469,
  VOID: 0xEC,
  CRC32: 0xBF,
  // Info
  TIMECODE_SCALE: 0x2AD7B1,
  // Tracks
  TRACK_ENTRY: 0xAE,
  TRACK_NUMBER: 0xD7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  VIDEO: 0xE0,
  PIXEL_WIDTH: 0xB0,
  PIXEL_HEIGHT: 0xBA,
  AUDIO: 0xE1,
  SAMPLING_FREQUENCY: 0xB5,
  CHANNELS: 0x9F,
  // Cluster
  TIMECODE: 0xE7,
  SIMPLE_BLOCK: 0xA3,
  BLOCK_GROUP: 0xA0,
  BLOCK: 0xA1,
  REFERENCE_BLOCK: 0xFB,
};

/** Level-1 children of Segment: any of these ends an unknown-size Cluster. */
const LEVEL1 = new Set([
  ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.TAGS,
  ID.CHAPTERS, ID.ATTACHMENTS,
]);

const UNKNOWN = -1;

/**
 * Read a variable-length integer at `at`. Returns { value, length } or
 * null when the buffer ends first. With `keepMarker` the length-marker bit
 * stays in (element ids are compared that way).
 */
export function readVint(buf, at, keepMarker = false) {
  if (at >= buf.length) return null;
  const first = buf[at];
  if (first === 0) return null;   // reserved / invalid
  let len = 1;
  let mask = 0x80;
  while (!(first & mask)) { len += 1; mask >>= 1; }
  if (len > 8 || at + len > buf.length) return null;
  let value = keepMarker ? first : (first & (mask - 1));
  let allOnes = !keepMarker && (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[at + i];
    value = value * 256 + b;
    if (b !== 0xFF) allOnes = false;
  }
  return { value, length: len, unknown: allOnes };
}

/** Read an unsigned big-endian integer of `len` bytes. */
export function readUint(buf, at, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[at + i];
  return v;
}

/** Encode an unsigned integer as an 8-byte EBML uint element body. */
function uint8(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.max(0, Math.round(v))));
  return b;
}

/** An element id as bytes. */
function idBytes(id) {
  const n = id > 0xFFFFFF ? 4 : id > 0xFFFF ? 3 : id > 0xFF ? 2 : 1;
  const b = Buffer.alloc(n);
  for (let i = n - 1; i >= 0; i--) { b[i] = id & 0xFF; id >>>= 8; }
  return b;
}

/** Segment header with an unknown size — what a live muxer writes. */
export const SEGMENT_UNKNOWN = Buffer.concat([
  idBytes(ID.SEGMENT), Buffer.from('01ffffffffffffff', 'hex'),
]);

/**
 * A Cluster header for a re-emitted cluster: unknown size, then the
 * Timecode element as an 8-byte uint. Blocks keep their relative
 * timecodes, so rewriting only this one number rebases the whole cluster.
 */
export function clusterHeader(timecode) {
  return Buffer.concat([
    idBytes(ID.CLUSTER), Buffer.from('01ffffffffffffff', 'hex'),
    idBytes(ID.TIMECODE), Buffer.from([0x88]), uint8(timecode),
  ]);
}

/** Walk the children of a master element's payload. */
function* children(buf, start, end) {
  let p = start;
  while (p < end) {
    const id = readVint(buf, p, true);
    if (!id) return;
    const size = readVint(buf, p + id.length);
    if (!size || size.unknown) return;
    const head = id.length + size.length;
    if (p + head + size.value > end) return;
    yield { id: id.value, at: p, dataAt: p + head, size: size.value, end: p + head + size.value };
    p += head + size.value;
  }
}

function parseInfo(buf, start, end) {
  let timecodeScale = 1_000_000;   // ns per tick; the WebM default
  for (const c of children(buf, start, end)) {
    if (c.id === ID.TIMECODE_SCALE) timecodeScale = readUint(buf, c.dataAt, c.size);
  }
  return { timecodeScale };
}

function parseTracks(buf, start, end) {
  const tracks = [];
  for (const entry of children(buf, start, end)) {
    if (entry.id !== ID.TRACK_ENTRY) continue;
    const t = { number: null, type: null, codec: null, width: null, height: null, sampleRate: null, channels: null };
    for (const c of children(buf, entry.dataAt, entry.end)) {
      if (c.id === ID.TRACK_NUMBER) t.number = readUint(buf, c.dataAt, c.size);
      else if (c.id === ID.TRACK_TYPE) t.type = readUint(buf, c.dataAt, c.size);
      else if (c.id === ID.CODEC_ID) t.codec = buf.toString('latin1', c.dataAt, c.end);
      else if (c.id === ID.VIDEO) {
        for (const v of children(buf, c.dataAt, c.end)) {
          if (v.id === ID.PIXEL_WIDTH) t.width = readUint(buf, v.dataAt, v.size);
          else if (v.id === ID.PIXEL_HEIGHT) t.height = readUint(buf, v.dataAt, v.size);
        }
      } else if (c.id === ID.AUDIO) {
        for (const a of children(buf, c.dataAt, c.end)) {
          if (a.id === ID.SAMPLING_FREQUENCY) t.sampleRate = buf.readDoubleBE?.(a.dataAt) && a.size === 8
            ? buf.readDoubleBE(a.dataAt) : a.size === 4 ? buf.readFloatBE(a.dataAt) : null;
          else if (a.id === ID.CHANNELS) t.channels = readUint(buf, a.dataAt, a.size);
        }
      }
    }
    tracks.push(t);
  }
  return tracks;
}

/** Matroska codec ids → the names the rest of the engine uses. */
export function codecName(codecId) {
  const c = String(codecId ?? '');
  if (c.startsWith('V_MPEG4/ISO/AVC')) return 'h264';
  if (c.startsWith('V_MPEGH/ISO/HEVC')) return 'hevc';
  if (c === 'V_VP9') return 'vp9';
  if (c === 'V_VP8') return 'vp8';
  if (c === 'V_AV1') return 'av1';
  if (c === 'A_OPUS') return 'opus';
  if (c.startsWith('A_AAC')) return 'aac';
  if (c === 'A_VORBIS') return 'vorbis';
  return c.toLowerCase();
}

/**
 * The scanner. Feed it bytes in any chunking; it calls back with:
 *
 *   onInit(buffer, meta)  once, when the first Cluster begins — the EBML
 *                         header, a Segment header of unknown size, then
 *                         the original Info and Tracks elements verbatim.
 *                         meta = { timecodeScale, tracks }
 *   onCluster(timecode)   every Cluster, when its Timecode has been read
 *   onBlock(block)        every SimpleBlock or BlockGroup:
 *                         { buf, track, keyframe, relTimecode, bytes }
 */
export class WebmScanner {
  constructor({ onInit = null, onCluster = null, onBlock = null, onWarn = null } = {}) {
    this.onInit = onInit;
    this.onCluster = onCluster;
    this.onBlock = onBlock;
    this.onWarn = onWarn;
    this._buf = Buffer.alloc(0);
    this._pos = 0;
    this._inSegment = false;
    this._cluster = null;        // { remaining: number|null, tc: number|null }
    this._ebml = null;
    this._info = null;
    this._tracksBuf = null;
    this.meta = { timecodeScale: 1_000_000, tracks: [] };
    this.initDone = false;
    this.bytesIn = 0;
    this.damaged = 0;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.bytesIn += chunk.length;
    this._buf = this._pos === 0 && this._buf.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this._buf.subarray(this._pos), chunk]);
    this._pos = 0;
    this._scan();
  }

  _closeCluster() {
    this._cluster = null;
  }

  _scan() {
    const buf = this._buf;
    for (;;) {
      const p = this._pos;
      if (p >= buf.length) break;
      const id = readVint(buf, p, true);
      if (!id) {
        // A zero byte can never start an id, and an id that does not fit
        // in 8 more bytes is not waiting for input: the stream is torn.
        // Skip a byte and look again, counting it so a genuinely broken
        // sender is visible.
        if (buf[p] === 0 || p + 8 < buf.length) {
          this.damaged += 1;
          this._pos = p + 1;
          continue;
        }
        break;
      }
      const size = readVint(buf, p + id.length);
      if (!size) break;
      const head = id.length + size.length;
      const dataAt = p + head;
      const known = !size.unknown;

      // Inside an unknown-size cluster, a level-1 id ends it.
      if (this._cluster && this._cluster.remaining == null && LEVEL1.has(id.value)) {
        this._closeCluster();
      }

      if (id.value === ID.SEGMENT) {
        this._inSegment = true;
        this._pos = dataAt;
        continue;
      }
      if (id.value === ID.CLUSTER) {
        this._closeCluster();
        if (!this.initDone) this._emitInit();
        this._cluster = { remaining: known ? size.value : null, tc: null };
        this._pos = dataAt;
        continue;
      }
      if (!known) {
        // Only Segment and Cluster may be open-ended; anything else with an
        // unknown size is damage. Skip its header and carry on.
        this.damaged += 1;
        this._pos = dataAt;
        continue;
      }
      const end = dataAt + size.value;
      if (end > buf.length) break;   // wait for the whole element

      if (this._cluster) {
        this._clusterChild(id.value, buf, p, dataAt, end);
        if (this._cluster && this._cluster.remaining != null) {
          this._cluster.remaining -= end - p;
          if (this._cluster.remaining <= 0) this._closeCluster();
        }
      } else if (id.value === ID.EBML) {
        this._ebml = Buffer.from(buf.subarray(p, end));
      } else if (id.value === ID.INFO) {
        this._info = Buffer.from(buf.subarray(p, end));
        this.meta.timecodeScale = parseInfo(buf, dataAt, end).timecodeScale;
      } else if (id.value === ID.TRACKS) {
        this._tracksBuf = Buffer.from(buf.subarray(p, end));
        this.meta.tracks = parseTracks(buf, dataAt, end);
      }
      // SeekHead, Void, CRC, Cues, Tags, Chapters: pointers and indexes a
      // live reader neither has nor needs. Dropped.
      this._pos = end;
    }
    // Compact: keep only the unconsumed tail.
    if (this._pos > 0) {
      this._buf = this._pos >= this._buf.length ? Buffer.alloc(0) : this._buf.subarray(this._pos);
      this._pos = 0;
    }
  }

  _emitInit() {
    this.initDone = true;
    if (!this._ebml || !this._tracksBuf) {
      this.onWarn?.('stream began without an EBML header or Tracks — a reader cannot be restarted on it');
    }
    const init = Buffer.concat([
      this._ebml ?? Buffer.alloc(0),
      SEGMENT_UNKNOWN,
      this._info ?? Buffer.alloc(0),
      this._tracksBuf ?? Buffer.alloc(0),
    ]);
    this.onInit?.(init, this.meta);
  }

  _clusterChild(id, buf, at, dataAt, end) {
    const cl = this._cluster;
    if (id === ID.TIMECODE) {
      cl.tc = readUint(buf, dataAt, end - dataAt);
      this.onCluster?.(cl.tc);
      return;
    }
    if (id === ID.SIMPLE_BLOCK) {
      const track = readVint(buf, dataAt);
      if (!track) return;
      const tcAt = dataAt + track.length;
      if (tcAt + 3 > end) return;
      const relTimecode = buf.readInt16BE(tcAt);
      const flags = buf[tcAt + 2];
      this.onBlock?.({
        buf: Buffer.from(buf.subarray(at, end)),
        track: track.value,
        keyframe: Boolean(flags & 0x80),
        relTimecode,
        // Where the int16 relative timecode sits inside `buf`, so a
        // re-emitted block can be rebased in place.
        relAt: tcAt - at,
        bytes: end - at,
      });
      return;
    }
    if (id === ID.BLOCK_GROUP) {
      let track = null;
      let relTimecode = 0;
      let relAt = null;
      let hasRef = false;
      for (const c of children(buf, dataAt, end)) {
        if (c.id === ID.BLOCK) {
          const t = readVint(buf, c.dataAt);
          if (!t) continue;
          track = t.value;
          if (c.dataAt + t.length + 2 <= c.end) {
            relAt = c.dataAt + t.length - at;
            relTimecode = buf.readInt16BE(c.dataAt + t.length);
          }
        } else if (c.id === ID.REFERENCE_BLOCK) {
          hasRef = true;
        }
      }
      if (track == null) return;
      this.onBlock?.({
        buf: Buffer.from(buf.subarray(at, end)),
        track,
        keyframe: !hasRef,
        relTimecode,
        relAt,
        bytes: end - at,
      });
    }
    // Position, PrevSize, anything else: dropped.
  }
}
