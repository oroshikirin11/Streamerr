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
  constructor(smb = {}, { bridgeBase = '' } = {}) {
    this._cfg = parseSmbTarget(smb);
    this._bridgeBase = bridgeBase;   // e.g. http://127.0.0.1:8099/smbmedia
    this._client = null;
    this._paths = new Map();         // id -> share-relative path ('' = root)
  }

  get configured() {
    return Boolean(this._cfg.host && this._cfg.share);
  }

  _smb() {
    if (this._client) return this._client;
    const { host, share, username, password, guest } = this._cfg;
    this._client = new SMB2({
      share: `\\\\${host}\\${share}`,
      domain: 'WORKGROUP',
      username: guest || !username ? 'guest' : username,
      password: guest ? '' : password,
      autoCloseTimeout: 0,           // long broadcasts must not lose the session
    });
    return this._client;
  }

  /** share-relative path with backslashes, as the protocol wants. */
  _p(rel) {
    const base = this._cfg.path ? this._cfg.path.replace(/\//g, '\\') : '';
    const tail = rel ? rel.replace(/\//g, '\\') : '';
    return [base, tail].filter(Boolean).join('\\');
  }

  _readdir(rel) {
    return new Promise((resolve, reject) => {
      this._smb().readdir(this._p(rel), { stats: true }, (err, list) => {
        if (err) reject(this._friendly(err));
        else resolve(list);
      });
    });
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
    return new Promise((resolve, reject) => {
      this._smb().getSize(this._p(rel), (err, n) => err ? reject(this._friendly(err)) : resolve(n));
    });
  }

  _rawStream(rel, opts) {
    return new Promise((resolve, reject) => {
      this._smb().createReadStream(this._p(rel), opts, (err, s) =>
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
    if (total <= STRIPE) return this._rawStream(rel, { start: s0, end: e0 });

    const { Readable } = await import('stream');
    const self = this;
    let next = s0;              // next stripe to LAUNCH
    let emit = s0;              // next stripe to EMIT
    const done = new Map();     // stripeStart -> Buffer
    const inflight = new Map(); // stripeStart -> Promise
    let failed = null;

    const launch = () => {
      while (inflight.size < LANES && next <= e0 && !failed) {
        const from = next;
        const to = Math.min(from + STRIPE - 1, e0);
        next = to + 1;
        inflight.set(from, (async () => {
          const st = await self._rawStream(rel, { start: from, end: to });
          const parts = [];
          await new Promise((res, rej) => {
            st.on('data', (d) => parts.push(d));
            st.on('end', res);
            st.on('error', rej);
          });
          done.set(from, Buffer.concat(parts));
          inflight.delete(from);
        })().catch((err) => { failed = err; inflight.delete(from); }));
      }
    };

    const out = new Readable({
      async read() {
        for (;;) {
          if (failed) { this.destroy(failed); return; }
          if (emit > e0) { this.push(null); return; }
          launch();
          if (done.has(emit)) {
            const buf = done.get(emit);
            done.delete(emit);
            emit += buf.length;
            if (!this.push(buf)) return;   // backpressure — resume on next read()
            continue;
          }
          // wait for any lane to land, then re-check
          await Promise.race([...inflight.values()]).catch(() => {});
        }
      },
    });
    return out;
  }
}
