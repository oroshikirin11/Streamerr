/**
 * Userspace SMB library — no mount, no privileges, works in any container.
 *
 * The service speaks SMB2 itself (v9u-smb2) for directory listing, and
 * serves file bytes to ffmpeg through a localhost-only HTTP bridge with
 * Range support — ffmpeg handles HTTP ranges natively, so probing,
 * seeking, subtitle extraction and the chunk encoders all work unchanged
 * against a URL. The kernel-mount provider remains for setups that prefer
 * it, but this one is the default answer: it asks nothing of the host.
 *
 * The scanner mirrors the filesystem provider's layout rules — collection
 * roots (movies/tv), series folders, Season subfolders, episode filename
 * parsing — via the same parseEpisode.
 */

import crypto, { createHash } from 'crypto';
import md4 from 'js-md4';
import SMB2 from 'v9u-smb2';

// OpenSSL 3 removed MD4, which NTLM authentication is built on — the SMB
// library THREW mid-handshake ('digital envelope routines::unsupported')
// and its callback never fired: the Test button sat in limbo forever.
// Shim the one algorithm in pure JS, only when the native one is gone.
try {
  createHash('md4');
} catch {
  const native = crypto.createHash.bind(crypto);
  crypto.createHash = (alg, ...rest) => {
    if (String(alg).toLowerCase() !== 'md4') return native(alg, ...rest);
    const h = md4.create();
    return {
      update(data, enc) {
        h.update(typeof data === 'string' ? Buffer.from(data, enc ?? 'utf8') : data);
        return this;
      },
      digest(enc) {
        const buf = Buffer.from(h.arrayBuffer());
        return enc ? buf.toString(enc) : buf;
      },
    };
  };
}
import { parseEpisode } from './filesystem.js';
import { parseSmbTarget } from './smb.js';

const id = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const SEASON_DIR = /^(season|staffel|saison|temporada|s)[\s._-]*\d+$|^(specials|extras|ova|ovas)$/i;
const VIDEO_EXTS = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'ts', 'm2ts', 'webm', 'wmv', 'flv', 'ogm']);
const isVideo = (name) => VIDEO_EXTS.has(name.split('.').pop().toLowerCase());
const COLLECTION = /^(movies?|films?|tv|shows?|series|anime)$/i;

// ── SMB2 interim-response fix ─────────────────────────────────────────
// The library treats EVERY response as final: an interim STATUS_PENDING
// ("working on it, real answer follows" — normal for reads that need the
// server's disk) consumed the request callback and the real data arrived
// orphaned. Every read past the server's hot cache failed. The dispatch
// below is the library's own, with the one correct addition: a PENDING
// interim leaves the request waiting for its real reply, which reuses
// the same message id.
import { createRequire } from 'module';
const _req = createRequire(import.meta.url);
const _forge = _req('v9u-smb2/lib/tools/smb2-forge');
const _SMB2Message = _req('v9u-smb2/lib/tools/smb2-message');
const STATUS_PENDING = 0x00000103;

_forge.response = function(c) {
  c.responses = {};
  c.responsesCB = {};
  c.responseBuffer = Buffer.allocUnsafe(0);
  return function(response) {
    c.responseBuffer = Buffer.concat([c.responseBuffer, response]);
    let extract = true;
    while (extract) {
      extract = false;
      if (c.responseBuffer.length >= 4) {
        const msgLength = (c.responseBuffer.readUInt8(1) << 16) + c.responseBuffer.readUInt16BE(2);
        if (c.responseBuffer.length >= msgLength + 4) {
          extract = true;
          const r = c.responseBuffer.slice(4, msgLength + 4);
          const message = new _SMB2Message();
          message.parseBuffer(r);
          const h = message.getHeaders();
          const status = Buffer.isBuffer(h.Status) ? h.Status.readUInt32LE(0) : h.Status;
          if (status === STATUS_PENDING) {
            // Interim only — the real response is still coming.
            c.responseBuffer = c.responseBuffer.slice(msgLength + 4);
            continue;
          }
          const mId = h.MessageId.toString('hex');
          if (c.responsesCB[mId]) {
            c.responsesCB[mId](message);
            delete c.responsesCB[mId];
          } else {
            c.responses[mId] = message;
          }
          c.responseBuffer = c.responseBuffer.slice(msgLength + 4);
        }
      }
    }
  };
};

export class SmbStreamLibrary {
  // Eight sessions, three concurrent commands each — see _acquireLane.
  static POOL = 8;
  static DEPTH = 3;

  constructor(smb = {}, { bridgeBase = '' } = {}) {
    this._cfg = parseSmbTarget(smb);
    this._bridgeBase = bridgeBase;   // e.g. http://127.0.0.1:8099/smbmedia
    this._client = null;
    this._paths = new Map();         // id -> share-relative path ('' = root)
  }

  get configured() {
    return Boolean(this._cfg.host && this._cfg.share);
  }

  /**
   * A POOL of connections, not one. The chunk encoders are many ffmpeg
   * processes range-reading the bridge at once; over a single SMB session
   * their requests serialized and a fresh episode took minutes to first
   * air. Stripes round-robin across the pool, and a global lane budget
   * keeps one consumer at full wire speed while many share fairly.
   */
  _smb(lane = 0) {
    this._pool ??= [];
    const i = Math.abs(lane) % SmbStreamLibrary.POOL;
    if (!this._pool[i]) {
      const { host, share, username, password, guest } = this._cfg;
      this._pool[i] = new SMB2({
        share: `\\\\${host}\\${share}`,
        domain: 'WORKGROUP',
        username: guest || !username ? 'guest' : username,
        password: guest ? '' : password,
        autoCloseTimeout: 0,         // long broadcasts must not lose the session
      });
    }
    return this._pool[i];
  }

  /**
   * Per-connection op budget. The depth is THE load-bearing number: this
   * client wedges a session outright somewhere past ~3 concurrent
   * commands (a 16-encoder storm through 3-deep connections passed clean;
   * raising the global budget so one connection carried 8 hung every op
   * on it forever — used=32 waiting=32 with zero bytes moving). Width
   * therefore comes from MORE CONNECTIONS, never deeper queues: eight
   * sessions, three ops each. Acquisition picks the least-loaded session
   * so a burst spreads instead of convoying.
   */
  _acquireLane(avoid = -1) {
    this._busy ??= new Array(SmbStreamLibrary.POOL).fill(0);
    this._waiters ??= [];
    if (process.env.JSR_SMB_TRACE && !this._laneMon) {
      this._laneMon = setInterval(() => {
        console.log(`[smb-lanes] busy=${this._busy.join(',')} waiting=${this._waiters.length}`);
      }, 3000);
      this._laneMon.unref?.();
    }
    const pick = () => {
      let best = -1;
      for (let i = 0; i < this._busy.length; i++) {
        if (i === avoid && this._busy.length > 1) continue;
        if (this._busy[i] < SmbStreamLibrary.DEPTH
            && (best < 0 || this._busy[i] < this._busy[best])) best = i;
      }
      return best;
    };
    const c = pick();
    if (c >= 0) {
      this._busy[c] += 1;
      return Promise.resolve(c);
    }
    return new Promise((res) => this._waiters.push({ res, avoid }));
  }

  _releaseLane(c) {
    this._busy[c] -= 1;
    // Wake waiters that can now be placed (their avoid may skip this slot).
    for (let i = 0; i < this._waiters.length; ) {
      const w = this._waiters[i];
      const free = this._busy.findIndex((n, j) =>
        n < SmbStreamLibrary.DEPTH && (j !== w.avoid || this._busy.length === 1));
      if (free < 0) break;
      this._waiters.splice(i, 1);
      this._busy[free] += 1;
      w.res(free);
    }
  }

  /** share-relative path with backslashes, as the protocol wants. */
  _p(rel) {
    const base = this._cfg.path ? this._cfg.path.replace(/\//g, '\\') : '';
    const tail = rel ? rel.replace(/\//g, '\\') : '';
    return [base, tail].filter(Boolean).join('\\');
  }

  /** EVERY SMB operation passes through the lane budget — not just
   *  stripe transfers. Sixteen concurrent encoders' open/stat/read storm
   *  overdrew the server's SMB2 credits and every pending request hung
   *  with the encoders at 0.1% CPU. Bounded outstanding ops keep credits
   *  healthy no matter how many consumers pile onto the bridge. */
  /**
   * The client connects lazily on the first command, and its handshake
   * cannot absorb concurrent requests: a spawn burst racing onto a fresh
   * connection produced EALREADY, double-fired callbacks and ops hung to
   * their deadline. One trivial command, alone, brings a connection up;
   * everything else on it waits for that. A failed warm-up forgets the
   * connection so the next use rebuilds it from scratch.
   */
  _ensureReady(c) {
    this._ready ??= [];
    this._ready[c] ??= new Promise((resolve, reject) => {
      this._smb(c).exists(this._p('') || '.', (err) => {
        if (err) { this._ready[c] = null; this._pool[c] = null; reject(this._friendly(err)); }
        else resolve();
      });
    });
    return this._ready[c];
  }

  async _op(fn, avoid = -1) {
    const c = await this._acquireLane(avoid);
    try {
      await this._deadline(this._ensureReady(c), 20_000);
      // A lane-holding operation may NEVER hang: a wedged op leaked its
      // lane forever, and twelve leaks meant every later request queued
      // behind a dead wall (measured: used=12, waiting=52, zero progress).
      return await this._deadline(fn(c), 20_000);
    } catch (err) {
      // The client shares one file handle per (connection, path): when a
      // concurrent read of the same file finishes, its close invalidates
      // the handle under everyone else on that connection mid-request.
      // Purely a timing race — a different connection has its own handle,
      // so one retry there resolves it every time.
      if (avoid < 0 && /FILE_CLOSED/i.test(String(err?.code ?? err?.message ?? err))) {
        return this._op(fn, c);
      }
      throw err;
    } finally { this._releaseLane(c); }
  }

  _readdir(rel) {
    return this._op((c) => new Promise((resolve, reject) => {
      this._smb(c).readdir(this._p(rel), { stats: true }, (err, list) => {
        if (err) reject(this._friendly(err));
        else resolve(list);
      });
    }));
  }

  _friendly(err) {
    const code = String(err?.code ?? err?.message ?? err);
    if (/LOGON_FAILURE|ACCESS_DENIED/i.test(code)) {
      return new Error(this._cfg.guest
        ? 'The share refused guest access — it may need a username and password.'
        : 'The share rejected these credentials.');
    }
    if (/BAD_NETWORK_NAME/i.test(code)) {
      return new Error(`No share named "${this._cfg.share}" on ${this._cfg.host}.`);
    }
    if (/OBJECT_NAME_NOT_FOUND|OBJECT_PATH_NOT_FOUND/i.test(code)) {
      return new Error(`The folder "${this._cfg.path}" does not exist in the share.`);
    }
    if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(code)) {
      return new Error(`Could not reach ${this._cfg.host} — is it on and sharing?`);
    }
    return err instanceof Error ? err : new Error(code);
  }

  _remember(rel) {
    const k = id(`smb:${rel}`);
    this._paths.set(k, rel);
    return k;
  }

  /** No SMB operation may hang the caller — modern servers can stall a
   *  bad negotiation rather than refuse it. */
  _deadline(promise, ms = 10_000) {
    return Promise.race([promise, new Promise((_, rej) =>
      setTimeout(() => rej(new Error(
        `No answer from ${this._cfg.host} after ${ms / 1000}s — wrong address, `
        + 'a firewall, or a server that does not speak SMB2.')), ms).unref?.())]);
  }

  async test() {
    const entries = await this._deadline(this._readdir(''));
    const dirs = entries.filter((e) => e.isDirectory());
    return { ok: true, roots: dirs.length, sample: dirs.slice(0, 5).map((d) => d.name) };
  }

  async libraries() {
    const entries = await this._readdir('');
    const dirs = entries.filter((e) => e.isDirectory());
    // A root holding collections (movies/tv) becomes one library each,
    // same as the filesystem provider; otherwise the root is the library.
    const collections = dirs.filter((d) => COLLECTION.test(d.name));
    if (collections.length) {
      return collections.map((d) => ({ id: this._remember(d.name), name: d.name }));
    }
    return [{ id: this._remember(''), name: this._cfg.path?.split('/').pop() || this._cfg.share }];
  }

  async items(libraryId, { startIndex = 0, limit = 100, search } = {}) {
    const root = this._paths.get(libraryId);
    if (root == null) throw new Error('Unknown library');
    const entries = await this._readdir(root);
    let dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    if (search) {
      const q = search.toLowerCase();
      dirs = dirs.filter((n) => n.toLowerCase().includes(q));
    }
    const page = dirs.slice(startIndex, startIndex + limit).map((name) => {
      const rel = root ? `${root}/${name}` : name;
      return { id: this._remember(rel), title: name, type: 'Series' };
    });
    return { items: page, total: dirs.length };
  }

  async seasons(seriesId) {
    const rel = this._paths.get(seriesId);
    if (rel == null) throw new Error('Unknown item');
    const entries = await this._readdir(rel);
    return entries
      .filter((e) => e.isDirectory() && SEASON_DIR.test(e.name))
      .map((e) => {
        const srel = `${rel}/${e.name}`;
        return { id: this._remember(srel), name: e.name };
      });
  }

  async episodes(seriesId, { seasonId } = {}) {
    const rel = this._paths.get(seasonId || seriesId);
    if (rel == null) throw new Error('Unknown item');
    const seriesRel = this._paths.get(seriesId) ?? rel;
    const seriesName = seriesRel.split('/').pop() || this._cfg.share;

    // Videos directly in the folder plus one level of Season folders —
    // the filesystem provider's exact shape.
    const out = [];
    const scan = async (dir, inSeason) => {
      const entries = await this._readdir(dir);
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!inSeason && SEASON_DIR.test(e.name)) await scan(`${dir}/${e.name}`, true);
          continue;
        }
        if (!isVideo(e.name)) continue;
        const parsed = parseEpisode(e.name, { allowBareNumber: inSeason });
        const frel = `${dir}/${e.name}`;
        out.push({
          id: this._remember(frel),
          seriesId,
          seriesName,
          title: parsed.title,
          season: parsed.season,
          episode: parsed.episode,
          size: e.size,
          rel: frel,
        });
      }
    };
    await scan(rel, false);
    out.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)
      || a.title.localeCompare(b.title));
    return out;
  }

  async item(itemId) {
    const rel = this._paths.get(itemId);
    if (rel == null) throw new Error('Unknown item');
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    const parent = parts[parts.length - 2] ?? '';
    const inSeason = SEASON_DIR.test(parent);
    const parsed = parseEpisode(name, { allowBareNumber: inSeason });
    const isEpisode = parsed.episode != null;
    return {
      id: itemId,
      type: isEpisode ? 'Episode' : 'Movie',
      title: isEpisode || !parent ? parsed.title : parent,
      seriesName: isEpisode
        ? (inSeason ? parts[parts.length - 3] : parent) ?? null
        : null,
      season: parsed.season,
      episode: parsed.episode,
      rel,
    };
  }

  async nextEpisode(seriesId, currentId) {
    const list = await this.episodes(seriesId);
    const i = list.findIndex((e) => e.id === currentId);
    return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
  }

  /** The bridge URL ffmpeg consumes. */
  resolvePath(episode) {
    const rel = episode.rel ?? this._paths.get(episode.id);
    if (rel == null) throw new Error('Unknown media path');
    return `${this._bridgeBase}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** For the HTTP bridge: size then a ranged stream of a share file. */
  size(rel) {
    return this._op((c) => new Promise((resolve, reject) => {
      this._smb(c).getSize(this._p(rel), (err, n) => err ? reject(this._friendly(err)) : resolve(n));
    }));
  }

  _rawStream(rel, opts, lane = 0) {
    return new Promise((resolve, reject) => {
      this._smb(lane).createReadStream(this._p(rel), opts, (err, s) =>
        err ? reject(this._friendly(err)) : resolve(s));
    });
  }

  /**
   * Ranged read, striped across parallel SMB streams.
   *
   * The protocol client reads sequentially with one request in flight,
   * which capped a gigabit LAN at ~6.5MB/s — three minutes to pull one
   * episode through subtitle extraction. Splitting the range into stripes
   * read concurrently and emitted in order multiplies throughput by the
   * stripe count without touching the client's internals.
   */
  async stream(rel, { start, end } = {}) {
    const size = await this._deadline(this.size(rel));
    const s0 = start ?? 0;
    const e0 = end != null ? Math.min(end, size - 1) : size - 1;
    const total = e0 - s0 + 1;
    const STRIPE = 4 * 1024 * 1024;
    const LANES = 4;
    // Small reads don't benefit — one stripe, no orchestration.
    if (total <= STRIPE) {
      // Budgeted open; the transfer itself is small.
      return this._op((c) => this._rawStream(rel, { start: s0, end: e0 }, c));
    }

    const { Readable } = await import('stream');
    const self = this;
    // Emission is by STRIPE ORDER, never by byte arithmetic: a stripe that
    // arrives short would desync a byte-based pointer and hang the stream
    // silently. Short stripes are an integrity failure and error out loud.
    // SLOW START. ffmpeg's opening moves are probes: read a few KB, seek
    // away, abandon the connection. Eagerly prefetching 16MB per request
    // meant the bridge shoveled megabytes into abandoned sockets while
    // real reads starved behind the waste — node at 54% CPU, encoders at
    // 0.1%. The first stripes are small and sequential; full parallel
    // striping engages only once the consumer has proven it is streaming.
    const sizes = [256 * 1024, 1024 * 1024, 2 * 1024 * 1024];
    const order = [];
    {
      let from = s0;
      for (let k = 0; from <= e0; k++) {
        const len = Math.min(sizes[k] ?? STRIPE, e0 - from + 1);
        order.push({ from, to: from + len - 1 });
        from += len;
      }
    }
    let launchIdx = 0;
    let emitIdx = 0;
    const done = new Map();     // stripeStart -> Buffer
    const inflight = new Map(); // stripeStart -> Promise
    let failed = null;

    const launch = () => {
      // PREFETCH EARNS ITS DEPTH. ffmpeg's opening moves probe ~1.3MB and
      // hang up; with sixteen encoders probing at once, every megabyte
      // fetched beyond what the consumer actually reads is bandwidth
      // stolen from a neighbour. Measured with eager 4-deep prefetch:
      // wire at full line rate, ~90% of it into abandoned sockets, no
      // encoder finishing its probe in two minutes. So: one stripe at a
      // time until three have been drained, two until six, and only a
      // proven long reader gets full parallel striping.
      const cap = emitIdx < 3 ? 1 : emitIdx < 6 ? 2 : LANES;
      while (inflight.size < cap && launchIdx < order.length
          && launchIdx - emitIdx < cap + 1 && !failed) {
        const { from, to } = order[launchIdx];
        launchIdx += 1;
        inflight.set(from, (async () => {
          let lastConn = -1;
          const pull = (avoid) => self._op(async (c) => {
            lastConn = c;
            const st = await self._rawStream(rel, { start: from, end: to }, c);
            const parts = [];
            await new Promise((res, rej) => {
              st.on('data', (d) => parts.push(d));
              st.on('end', res);
              st.on('error', rej);
            });
            const buf = Buffer.concat(parts);
            if (buf.length !== to - from + 1) {
              throw new Error(`short read from the share at offset ${from}: `
                + `${buf.length} of ${to - from + 1} bytes`);
            }
            return buf;
          });
          let buf;
          try {
            buf = await pull(-1);
          } catch {
            // One retry on a different connection — a single wedged or
            // reset session must not fail the whole stream.
            buf = await pull(lastConn);
          }
          done.set(from, buf);
          inflight.delete(from);
        })().catch((err) => { failed = err; inflight.delete(from); }));
      }
    };

    const out = new Readable({
      async read() {
        for (;;) {
          if (this.destroyed) return;   // consumer hung up — stop fetching
          if (failed) { this.destroy(failed); return; }
          if (emitIdx >= order.length) { this.push(null); return; }
          launch();
          const key = order[emitIdx]?.from;
          if (done.has(key)) {
            const buf = done.get(key);
            done.delete(key);
            emitIdx += 1;
            if (!this.push(buf)) return;   // backpressure — resume on next read()
            continue;
          }
          if (!inflight.size) {
            // nothing running and nothing to emit — never spin, never hang
            this.destroy(new Error('stream underrun reading the share'));
            return;
          }
          await Promise.race([...inflight.values()]).catch(() => {});
        }
      },
    });
    return out;
  }
}
