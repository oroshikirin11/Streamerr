/**
 * Background generation of episode stills.
 *
 * Making these on demand put ffmpeg on the browsing path: opening a
 * 37-episode season over SMB fired 37 cold network seeks while the user
 * waited. So the image route serves only what is already cached, and this
 * fills the cache behind it — slowly, two at a time, and never while a
 * broadcast is on air.
 *
 * That last rule is not caution for its own sake. Speculative ffmpeg work
 * running beside the encoder is exactly what made a marginal clip stall
 * earlier in this project's life; the sweep yields the machine the moment
 * anything goes live and picks up where it left off afterwards.
 */

import { cachedFrame, frameGrab, isVideoFile } from './thumbs.js';

/** Two, not three: this is background work competing with a NAS. */
const CONCURRENCY = 2;
/** Between finished stills, so a sweep is never a burst. */
const GAP_MS = 400;
/** While a broadcast holds the machine, or after a run finishes. */
const IDLE_MS = 20_000;
/**
 * Stills per pass, and series inspected to find them.
 *
 * Both are caps on WORK PER PASS, not on the library. Without them a
 * 600-episode library re-walked every source on every cycle — hundreds of
 * SMB directory listings — and then wrote 600 files in one go. A cache
 * living on a slow or failing disk experiences that as a sustained write
 * storm, which is exactly the load that has twice taken this deployment's
 * storage down. Little and often instead: the library still completes, a
 * few dozen at a time, with a long pause between.
 */
const BATCH = 24;
const SCAN_SERIES = 40;
/** Between batches. Long: nothing waits on this, and the point is to be
 *  invisible to the disk rather than to finish quickly. */
const BATCH_IDLE_MS = 120_000;
/** A file that will not yield a frame is usually broken, not busy. */
const MAX_ATTEMPTS = 3;
/** Backoff per attempt; a share that is down deserves a longer pause. */
const RETRY_MS = [5_000, 30_000];

/** The image id out of a url the providers built. */
function idOf(imageUrl) {
  const m = /\/api\/library\/image\/([^/?#]+)/.exec(String(imageUrl ?? ''));
  return m ? decodeURIComponent(m[1]) : null;
}

export class StillSweeper {
  /**
   * @param {object} o
   * @param {() => object} o.library   current composite (rebuilt on config change)
   * @param {() => string} o.cacheDir
   * @param {() => boolean} o.busy     true while a broadcast is on air
   * @param {(msg: string) => void} [o.log]
   */
  constructor({
    library, cacheDir, busy, log = () => {},
    // Injected so the scheduling can be tested without running ffmpeg —
    // this class is about pacing and retry, and those are what break.
    grab = frameGrab, cached = cachedFrame, isVideo = isVideoFile,
  }) {
    this.getLibrary = library;
    this.getCacheDir = cacheDir;
    this.isBusy = busy;
    this.log = log;
    this._grab = grab;
    this._cached = cached;
    this._isVideo = isVideo;
    /** srcPath -> { attempts, nextAt }. Kept in memory only: a restart is a
     *  reasonable moment to give a previously broken file another chance. */
    this._failed = new Map();
    this._state = { running: false, done: 0, total: 0, failed: 0 };
    this._timer = null;
    this._stopped = false;
  }

  status() {
    return { ...this._state, pending: Math.max(0, this._state.total - this._state.done) };
  }

  /** Begin, or re-plan if a sweep is already running. Safe to call often. */
  start() {
    if (this._timer || this._state.running) return;
    this._timer = setTimeout(() => { this._timer = null; this._run(); }, 1500);
    this._timer.unref?.();
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** Every episode across every still-enabled source that has no cached art. */
  async _collect() {
    const lib = this.getLibrary();
    const cacheDir = this.getCacheDir();
    if (!lib?.sources || !cacheDir) return [];
    const out = [];
    let scanned = 0;
    // Where the previous pass stopped, so successive passes advance through
    // the library instead of re-walking its first pages forever.
    let skip = this._cursor ?? 0;
    let seen = 0;
    for (const src of lib.sources) {
      if (!src.lib?._stills) continue;               // source opted out
      let libraries = [];
      try { libraries = await src.lib.libraries(); } catch { continue; }
      for (const l of libraries) {
        let page;
        try { page = await src.lib.items(l.id, { startIndex: 0, limit: 500 }); } catch { continue; }
        for (const item of page?.items ?? []) {
          if (out.length >= BATCH || scanned >= SCAN_SERIES) break;
          // Resume point: cheap to skip, and it costs no directory listing.
          seen += 1;
          if (seen <= skip) continue;
          scanned += 1;
          // Films are skipped: the grid shows their poster, and since they
          // play on click there is no episode list where a still would ever
          // appear. Generating one is work nobody sees.
          if (item.type === 'Movie') continue;
          let eps = [];
          try { eps = await src.lib.episodes(item.id); } catch { continue; }
          for (const ep of eps) {
            if (ep.type === 'Movie') continue;   // a film inside a folder
            const id = idOf(ep.image);
            if (!id) continue;
            let path;
            try { path = src.lib.imagePath?.(id) ?? null; } catch { path = null; }
            // Only media needs making; real artwork is served as it is.
            if (!path || !this._isVideo(path)) continue;
            if (this._cached(path, cacheDir)) continue;
            const f = this._failed.get(path);
            if (f && (f.attempts >= MAX_ATTEMPTS || Date.now() < f.nextAt)) continue;
            out.push(path);
            if (out.length >= BATCH) break;
          }
        }
        if (out.length >= BATCH || scanned >= SCAN_SERIES) break;
      }
      if (out.length >= BATCH || scanned >= SCAN_SERIES) break;
    }
    // Wrap when the walk reaches the end, so newly added media is found on
    // the next lap rather than never.
    this._cursor = out.length || scanned ? seen : 0;
    return out;
  }

  async _run() {
    if (this._stopped || this._state.running) return;
    // A broadcast owns the machine. Come back later rather than competing.
    if (this.isBusy()) { this._later(); return; }

    let queue;
    try { queue = await this._collect(); } catch { this._later(); return; }
    if (!queue.length) { this._later(); return; }

    this._state = { running: true, done: 0, total: queue.length, failed: 0 };
    this._didWork = true;
    this.log(`[stills] ${queue.length} to make\n`);
    const cacheDir = this.getCacheDir();

    let next = 0;
    const worker = async () => {
      while (!this._stopped) {
        // Re-checked every item, not just at the start: going live mid-sweep
        // must stop it there and then.
        if (this.isBusy()) return;
        const i = next++;
        if (i >= queue.length) return;
        const src = queue[i];
        let made = null;
        try { made = await this._grab(src, cacheDir); } catch { made = null; }
        if (made) {
          this._state.done += 1;
          this._failed.delete(src);
        } else {
          this._state.failed += 1;
          const prev = this._failed.get(src)?.attempts ?? 0;
          const attempts = prev + 1;
          // Retried with backoff, then left alone: a file ffmpeg cannot
          // decode will not decode on the fourth try either, and retrying
          // it forever would keep the sweep permanently "running".
          this._failed.set(src, {
            attempts,
            nextAt: Date.now() + (RETRY_MS[Math.min(prev, RETRY_MS.length - 1)]),
          });
        }
        await new Promise((r) => { const t = setTimeout(r, GAP_MS); t.unref?.(); });
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const { done, failed } = this._state;
    this._state.running = false;
    if (done || failed) this.log(`[stills] made ${done}${failed ? `, ${failed} failed` : ''}\n`);
    this._later();
  }

  /** Idle, then look again — new media, a finished broadcast, a retry due. */
  _later() {
    this._state.running = false;
    if (this._stopped || this._timer) return;
    const wait = this._didWork ? BATCH_IDLE_MS : IDLE_MS;
    this._didWork = false;
    this._timer = setTimeout(() => { this._timer = null; this._run(); }, wait);
    this._timer.unref?.();
  }
}
