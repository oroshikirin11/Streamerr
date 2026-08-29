/**
 * A catalogue paired with the media it describes.
 *
 * Jellyfin knows the posters, the season structure and the episode order. It
 * does not hand over bytes — it hands over a path as its own process sees it.
 * So a source is really two things: where the listing comes from, and where
 * the media is read from. Welding them together is what made "Jellyfin" look
 * like a place media lives, and left an operator with a beautiful catalogue
 * that would not play.
 *
 * Everything about listing is delegated to the catalogue untouched. The only
 * thing this changes is resolvePath: the reported path goes through the
 * derived rules, and the media provider turns the result into whatever
 * ffmpeg opens — a filename for a folder, a bridge URL for a share.
 */

import { makeMapper } from './pathmap.js';

export class PairedLibrary {
  /**
   * @param {object} catalogue a library providing listings (Jellyfin)
   * @param {object} media     a library providing bytes (folder or share)
   * @param {Array<{from,to}>} rules derived by deriveMapping()
   */
  constructor(catalogue, media, rules = []) {
    this.catalogue = catalogue;
    this.media = media;
    this.rules = rules ?? [];
    this.map = makeMapper(this.rules);
  }

  /**
   * Both halves must work. A catalogue with no reachable media is the exact
   * failure this pairing exists to make impossible, so it is not "configured"
   * until both sides are.
   */
  get configured() {
    return Boolean(this.catalogue?.configured && this.media?.configured);
  }

  async test() {
    const cat = await this.catalogue.test?.();
    if (cat && cat.ok === false) return { ...cat, error: `Catalogue: ${cat.error ?? 'unavailable'}` };
    const med = await this.media.test?.();
    if (med && med.ok === false) return { ...med, error: `Media: ${med.error ?? 'unavailable'}` };
    return { ok: true };
  }

  /**
   * Listing is the catalogue's job, verbatim.
   *
   * This list is not decoration — CompositeLibrary calls every one of these
   * on a source, and a missing one is not a graceful degradation but a
   * TypeError surfacing as a 400 with an empty library behind it. Anything
   * added to the library interface has to be added here too.
   */
  libraries(...a) { return this.catalogue.libraries(...a); }
  items(...a) { return this.catalogue.items(...a); }
  seasons(...a) { return this.catalogue.seasons(...a); }
  episodes(...a) { return this.catalogue.episodes(...a); }
  item(...a) { return this.catalogue.item(...a); }
  nextEpisode(...a) { return this.catalogue.nextEpisode(...a); }
  imagePath(...a) { return this.catalogue.imagePath(...a); }
  shows(...a) { return this.catalogue.shows?.(...a); }
  search(...a) { return this.catalogue.search?.(...a); }
  allPaths(...a) { return this.catalogue.allPaths?.(...a); }

  /**
   * The bridge token belongs to the MEDIA half — it authorises reads of the
   * share — so it is proxied there rather than shadowed here. Rebuilds carry
   * it across by assigning to this property, which must reach the provider
   * that actually checks it, or an ffmpeg already reading the bridge is
   * cut off mid-clip.
   */
  get bridgeToken() { return this.media?.bridgeToken; }
  set bridgeToken(v) { if (this.media) this.media.bridgeToken = v; }

  /**
   * Streaming is a MEDIA capability, and the composite probes for it with
   * `typeof s.lib?.stream === 'function'` rather than calling it. So this
   * has to be a function when the media half can stream and undefined when
   * it cannot — a share can, a folder cannot, and answering yes for a folder
   * would advertise a bridge that does not exist.
   */
  get stream() {
    return typeof this.media?.stream === 'function'
      ? (...a) => this.media.stream(...a)
      : undefined;
  }

  /**
   * Byte size, also the media half's. The bridge asks for it before serving
   * a range, so without it every read answered 502 and ffprobe reported a
   * 5XX — with a catalogue that listed perfectly, which made it look like a
   * network fault rather than a missing method.
   */
  size(...a) { return this.media.size(...a); }

  /**
   * The one method that is ours.
   *
   * The catalogue's reported path is translated by the derived rules and
   * handed to the media provider, which knows how its own bytes are reached.
   * A rule that no longer fits fails here, naming both paths, rather than
   * surfacing as an ffmpeg error minutes into a broadcast.
   */
  resolvePath(episode) {
    const reported = episode?.sourcePath ?? episode?.path;
    if (!reported) throw new Error(`No path for "${episode?.title ?? 'this item'}"`);
    const mapped = this.map(reported);
    if (typeof this.media.resolveMapped !== 'function') {
      throw new Error('This media source cannot serve a paired catalogue');
    }
    try {
      return this.media.resolveMapped(mapped);
    } catch (err) {
      throw new Error(
        `Cannot open the media. The catalogue reports ${reported}`
        + `${mapped === reported ? '' : `, which maps to ${mapped}`}`
        + ` — ${err.message}. Re-check the library match in Settings.`,
      );
    }
  }
}
