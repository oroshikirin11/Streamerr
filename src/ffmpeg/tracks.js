/**
 * Audio and subtitle track discovery and selection.
 *
 * Owncast receives a single flat H.264+AAC stream over RTMP — there is no
 * mechanism for selectable audio tracks or soft subtitles anywhere in the
 * chain. So "choose the German dub with English subs" has to be resolved
 * before encoding: the chosen audio track is mapped, and subtitles are
 * BURNED INTO the video.
 *
 * That happens during normalization, which is also the only place it can:
 * playout runs `-c copy` and cannot add or alter anything.
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

/**
 * The languages the panel offers by name.
 *
 * ISO 639-2/B and /T both appear in the wild, sometimes alongside 639-1, so
 * each entry lists every spelling seen on a real file — a file tagged `deu`
 * and a preference of `ger` have to match. This table is also what the
 * settings picker is built from, so the codes on offer and the codes that
 * actually resolve can never drift apart.
 *
 * Not a closed set: normLang passes an unrecognised code through unchanged,
 * so a share full of Swedish still works by typing `swe`.
 */
export const LANGUAGES = [
  { code: 'eng', name: 'English', aliases: ['en', 'english'] },
  { code: 'jpn', name: 'Japanese', aliases: ['ja', 'japanese'] },
  { code: 'ger', name: 'German', aliases: ['de', 'deu', 'german'] },
  { code: 'fre', name: 'French', aliases: ['fr', 'fra', 'french'] },
  { code: 'spa', name: 'Spanish', aliases: ['es', 'spanish'] },
  { code: 'ita', name: 'Italian', aliases: ['it', 'italian'] },
  { code: 'dut', name: 'Dutch', aliases: ['nl', 'nld', 'dutch'] },
  { code: 'por', name: 'Portuguese', aliases: ['pt', 'portuguese'] },
  { code: 'rus', name: 'Russian', aliases: ['ru', 'russian'] },
  { code: 'chi', name: 'Chinese', aliases: ['zh', 'zho', 'chinese'] },
  { code: 'kor', name: 'Korean', aliases: ['ko', 'korean'] },
  { code: 'pol', name: 'Polish', aliases: ['pl', 'polish'] },
];

const LANG_ALIASES = Object.fromEntries(
  LANGUAGES.flatMap((l) => [l.code, ...l.aliases].map((a) => [a, l.code])),
);

export function normLang(code) {
  if (!code) return null;
  const k = String(code).trim().toLowerCase();
  return LANG_ALIASES[k] ?? k;
}

/** Text-based subtitles can go through the `subtitles` filter. */
const TEXT_SUB_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd',
]);
/** Bitmap subtitles must be composited with `overlay` instead. */
const BITMAP_SUB_CODECS = new Set([
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub',
]);

const SIDECAR_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub'];

/**
 * Inspect a media file's streams.
 * @returns {Promise<{video: object[], audio: object[], subtitle: object[]}>}
 */
export function probeTracks(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_streams',
      '-show_entries',
      'stream=index,codec_name,codec_type,channels,channel_layout,width,height,sample_aspect_ratio,display_aspect_ratio,r_frame_rate,color_transfer,pix_fmt,profile,field_order:'
      + 'stream_tags=language,title:stream_disposition=default,forced,hearing_impaired,original',
      '-of', 'json',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed for ${path}: ${err.trim() || `exit ${code}`}`));
      }
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        return reject(new Error(`ffprobe returned unparseable JSON for ${path}`));
      }
      resolve(groupStreams(parsed.streams ?? []));
    });
  });
}

function groupStreams(streams) {
  const result = { video: [], audio: [], subtitle: [] };

  // ffmpeg's -map uses per-type ordinals (0:a:1), not absolute stream indices,
  // so both are tracked: `index` for display, `typeIndex` for mapping.
  const counters = { video: 0, audio: 0, subtitle: 0 };

  for (const s of streams) {
    const type = s.codec_type;
    if (!(type in counters)) continue;

    const tags = s.tags ?? {};
    const disp = s.disposition ?? {};
    const entry = {
      index: s.index,
      typeIndex: counters[type]++,
      codec: s.codec_name ?? null,
      language: normLang(tags.language),
      title: tags.title ?? null,
      default: disp.default === 1,
      forced: disp.forced === 1,
      hearingImpaired: disp.hearing_impaired === 1,
      original: disp.original === 1,
    };

    if (type === 'audio') {
      entry.channels = s.channels ?? null;
      entry.channelLayout = s.channel_layout ?? null;
    }
    if (type === 'subtitle') {
      entry.text = TEXT_SUB_CODECS.has(entry.codec);
      entry.bitmap = BITMAP_SUB_CODECS.has(entry.codec);
      entry.external = false;
    }
    if (type === 'video') {
      entry.width = s.width ?? null;
      entry.height = s.height ?? null;
      // Anamorphic sources store one geometry and display another; subtitle
      // placement must use the DISPLAY shape or 4:3 math lands wrong.
      entry.sar = s.sample_aspect_ratio ?? null;
      entry.dar = s.display_aspect_ratio ?? null;
      // Exact fraction ("24000/1001") so output framerate can match the
      // source without drift; hdr flags whether tone mapping is required.
      entry.frameRate = s.r_frame_rate ?? null;
      entry.hdr = ['smpte2084', 'arib-std-b67'].includes(s.color_transfer);
      entry.colorTransfer = s.color_transfer ?? null;
      // Needed to know whether the GPU can decode this at all — see
      // gpuDecodable(). 10-bit H.264 is the common case that cannot.
      entry.pixFmt = s.pix_fmt ?? null;
      entry.profile = s.profile ?? null;
      // tt/bb/tb/bt = interlaced and combs without a deinterlacer;
      // progressive/unknown/absent are all treated as progressive, which
      // is why the deinterlace setting also has a manual 'on' for the
      // mislabeled files every DVD-era library has.
      entry.interlaced = ['tt', 'bb', 'tb', 'bt'].includes(s.field_order);
    }
    result[type].push(entry);
  }
  return result;
}

/**
 * Find sidecar subtitle files sitting next to the media file.
 *
 * Conventional naming is `Episode.eng.srt`, `Episode.en.forced.srt`, or just
 * `Episode.srt`. The language and forced/SDH markers live in the filename
 * because the formats themselves carry no metadata.
 */
export function findSidecarSubtitles(mediaPath) {
  const dir = dirname(mediaPath);
  const stem = basename(mediaPath, extname(mediaPath));
  if (!existsSync(dir)) return [];

  const found = [];
  for (const name of readdirSync(dir)) {
    const ext = extname(name).toLowerCase();
    if (!SIDECAR_EXTS.includes(ext)) continue;
    if (!name.startsWith(stem)) continue;

    // Whatever sits between the stem and the extension describes the track.
    const rest = basename(name, ext).slice(stem.length);
    const middle = rest.replace(/^[.\-_]+/, '');
    const parts = middle.split(/[.\-_]+/).filter(Boolean);
    // A prefix match is not a match: "Episode 1" must not claim
    // "Episode 10.eng.srt". The stem has to be the whole name, be followed
    // by a dot, or by a dash/underscore run of nothing but language and
    // flag markers ("Episode 1-eng-forced.srt") — "Episode 1-2.srt" is a
    // different title.
    if (rest && !rest.startsWith('.')) {
      if (!/^[\-_]/.test(rest)) continue;
      const known = (p) => p === 'forced' || p === 'sdh' || p === 'cc' || p === 'hi'
        || Boolean(LANG_ALIASES[p]);
      if (!parts.length || !parts.every((p) => known(p.toLowerCase()))) continue;
    }

    let language = null;
    let forced = false;
    let hearingImpaired = false;
    for (const part of parts) {
      const p = part.toLowerCase();
      if (p === 'forced') forced = true;
      else if (p === 'sdh' || p === 'cc' || p === 'hi') hearingImpaired = true;
      else if (!language && LANG_ALIASES[p]) language = normLang(p);
    }

    found.push({
      index: null,
      typeIndex: null,
      codec: ext.slice(1),
      language,
      title: middle || null,
      default: false,
      forced,
      hearingImpaired,
      text: true,
      bitmap: false,
      external: true,
      path: join(dir, name),
    });
  }
  return found;
}

/** All subtitle options for a file: embedded plus sidecar. */
export async function listSubtitles(mediaPath, probed = null) {
  const tracks = probed ?? await probeTracks(mediaPath);
  return [...tracks.subtitle, ...findSidecarSubtitles(mediaPath)];
}

/**
 * @typedef {object} TrackPrefs
 * @property {string[]} audioLanguages     ordered preference, e.g. ["jpn","eng"]
 * @property {string[]} subtitleLanguages  ordered preference, e.g. ["ger","eng"]
 * @property {'auto'|'always'|'off'|'forced'} subtitleMode
 * @property {number|null} [audioIndex]     explicit override (typeIndex)
 * @property {number|string|null} [subtitleId] explicit override: typeIndex, or a sidecar path
 */

/**
 * Resolve preferences against what a file actually contains.
 *
 * Explicit choices win. Otherwise language order decides, and only then the
 * file's own default flag — a file's default is frequently not what the
 * viewer wants, which is the entire reason this exists.
 */
export function selectTracks(tracks, subtitles, prefs = {}) {
  const {
    audioLanguages = [],
    subtitleLanguages = [],
    subtitleMode = 'auto',
    audioIndex = null,
    subtitleId = null,
    // What a live switch actually picked, so the next episode of the same
    // series can find the counterpart track rather than the first one that
    // happens to share a language. A release with two English subtitle
    // tracks — a full one and a signs-only one — is the common case, and
    // language alone cannot tell them apart.
    subtitleLike = null,
  } = prefs;

  // ── audio ──
  let audio = null;
  if (audioIndex != null) {
    audio = tracks.audio.find((a) => a.typeIndex === audioIndex) ?? null;
  }
  if (!audio) {
    for (const lang of audioLanguages.map(normLang)) {
      audio = tracks.audio.find((a) => a.language === lang);
      if (audio) break;
    }
  }
  // "Original audio" arrives here as an empty language list. The file's
  // default track is NOT a safe proxy for the original — WEBDL anime
  // routinely ships with the dub as track 1/default — so believe the
  // container's own `original` disposition first, where it exists.
  audio ??= tracks.audio.find((a) => a.original)
    ?? tracks.audio.find((a) => a.default) ?? tracks.audio[0] ?? null;

  // ── subtitles ──
  let subtitle = null;
  // Why no subtitle was chosen, when none was. "None available" and
  // "none needed" are very different outcomes and must not read the same.
  let skipped = null;

  if (subtitleMode !== 'off') {
    if (subtitleId != null) {
      subtitle = typeof subtitleId === 'string'
        ? subtitles.find((s) => s.external && s.path === subtitleId) ?? null
        : subtitles.find((s) => !s.external && s.typeIndex === subtitleId) ?? null;
    } else if (subtitleMode === 'always') {
      // Subtitles regardless of what the audio is — for people who simply
      // prefer reading along.
      subtitle = pickByLanguage(
        subtitles.filter((s) => !s.hearingImpaired),
        subtitleLanguages.map(normLang), subtitleLike,
      ) ?? subtitles.find((s) => !s.hearingImpaired) ?? subtitles[0] ?? null;
      if (!subtitle) skipped = 'this file has none';
    } else if (subtitleMode === 'forced') {
      // Forced subs only translate foreign dialogue — the usual choice when
      // you understand the spoken language.
      subtitle = pickByLanguage(subtitles.filter((s) => s.forced), subtitleLanguages.map(normLang));
    } else {
      const audioLang = audio?.language ?? null;
      const wanted = subtitleLanguages.map(normLang);

      if (!wanted.length) {
        // No stated preference. Behave like an ordinary player: use the
        // track the file marks as default, else the first non-SDH one.
        // Matching nothing here would silently disable subtitles on a file
        // that plainly has them, which is never what someone means by "auto".
        subtitle = subtitles.find((s) => s.default && !s.hearingImpaired)
          ?? subtitles.find((s) => !s.hearingImpaired)
          ?? subtitles[0]
          ?? null;
      } else if (audioLang && wanted.includes(audioLang)) {
        // The audio is already in a language they read, so full subtitles are
        // redundant — forced-only covers signs and foreign dialogue.
        subtitle = pickByLanguage(subtitles.filter((s) => s.forced), [audioLang]);
        if (!subtitle) skipped = 'not needed — audio is already in a language you read';
      } else {
        subtitle = pickByLanguage(
          subtitles.filter((s) => !s.hearingImpaired),
          wanted, subtitleLike,
        ) ?? pickByLanguage(subtitles, wanted, subtitleLike);
      }
    }
  }

  if (!subtitle && !skipped && subtitleMode !== 'off') {
    skipped = subtitles.length
      ? 'none matched your languages'
      : 'this file has none';
  }

  return {
    audio,
    subtitle,
    skipped,
    // Surfaced so the UI can explain a choice rather than appearing arbitrary.
    reason: describeChoice(audio, subtitle, subtitleMode, skipped),
  };
}

/** Shared-word similarity between two track names, 0..1 (Dice). */
function nameSimilarity(a, b) {
  const words = (t) => String(t ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return 0;
  const inB = new Set(B);
  const shared = A.filter((w) => inB.has(w)).length;
  return (2 * shared) / (A.length + B.length);
}

/**
 * How well a track matches the one the viewer actually chose.
 *
 * Deliberately not an exact-name match and never an index. Within one
 * series a release names its tracks the same way every episode, so the
 * name carries most of the weight. Across series the names share nothing,
 * and matching on them would be worse than useless — but forced-ness
 * still means the same thing everywhere, so it keeps a vote of its own.
 * When nothing distinguishes the candidates the caller falls back to the
 * ordinary default rather than picking arbitrarily.
 */
function matchScore(s, like) {
  let score = nameSimilarity(s.title, like.title) * 3;
  if (Boolean(s.forced) === Boolean(like.forced)) score += 1;
  if (Boolean(s.hearingImpaired) === Boolean(like.hearingImpaired)) score += 0.25;
  if (like.codec && s.codec === like.codec) score += 0.25;
  return score;
}

function pickByLanguage(list, languages, like = null) {
  for (const lang of languages) {
    const sameLang = list.filter((s) => s.language === lang);
    if (!sameLang.length) continue;

    if (like) {
      const scored = sameLang
        .map((s) => ({ s, score: matchScore(s, like) }))
        .sort((a, b) => b.score - a.score);
      // Only honour the memory when it actually discriminates; equal
      // scores mean it told us nothing about these particular tracks.
      if (scored.length === 1 || scored[0].score > scored[1].score) {
        return scored[0].s;
      }
    }

    // Otherwise prefer a full track over a signs-only one.
    return sameLang.find((s) => !s.forced) ?? sameLang[0];
  }
  return null;
}

function describeChoice(audio, subtitle, mode, skipped) {
  const a = audio
    ? `audio ${audio.language ?? '?'}${audio.channels ? ` ${audio.channels}ch` : ''}`
    : 'no audio';
  if (mode === 'off') return `${a}, subtitles off`;
  if (!subtitle) return `${a}, no subtitles (${skipped ?? 'none selected'})`;
  const kind = subtitle.external ? 'sidecar' : 'embedded';
  const flags = [subtitle.forced && 'forced', subtitle.bitmap && 'bitmap']
    .filter(Boolean).join(', ');
  return `${a}, ${kind} ${subtitle.language ?? '?'} subs${flags ? ` (${flags})` : ''}`;
}

/**
 * Escape a path for use inside a filtergraph value.
 *
 * Filter arguments are parsed twice — once splitting on `:` and `,`, once for
 * the option value — so a path with a colon or apostrophe silently produces a
 * broken graph. Windows drive letters and anime filenames both hit this.
 */
export function escapeFilterPath(p) {
  // Returns a FULLY QUOTED token. Inside ffmpeg filter single-quotes,
  // everything is literal until the next quote — backslash escapes are NOT
  // interpreted there, so the old approach of writing \' inside the quotes
  // terminated the string early and broke the whole graph on any filename
  // containing an apostrophe ("A Shinigami's Work"). The working idiom is
  // close-quote, escaped literal quote, reopen: '  ->  '\''
  // Filtergraphs are parsed TWICE. The graph parser strips one level of
  // quotes and escapes before the option parser runs, so single-level
  // quoting leaves a bare apostrophe that the option parser treats as an
  // opening quote — it then swallows the following options into the
  // filename. So: level 1 quotes for the option parser, level 2
  // backslash-escapes that result for the graph parser.
  const level1 = "'" + String(p).split("'").join("'\\''") + "'";
  return level1.replace(/([\\'\[\],;])/g, '\\$1');
}

/**
 * Build the video-filter fragment that renders subtitles.
 *
 * Returns null when there is nothing to burn in. Text and bitmap subtitles
 * take different paths: text goes through the `subtitles` filter, which
 * rasterises via libass; bitmap subtitles are already images and must be
 * composited with `overlay`, which needs a second input rather than a filter.
 *
 * @returns {{ filter: string|null, overlayInput: string|null, needsComplex: boolean }}
 */
export function buildSubtitleFilter(subtitle, mediaPath, opts = {}) {
  const { extractedPath = null, fontsDir = null, overlayPath = null } = opts;
  const fonts = fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '';

  // A Studio overlay on a clip with no subtitles. Returned in exactly the
  // shape a text subtitle has, so every decision downstream — which graph
  // to build, whether to composite on the GPU, whether to chunk — is made
  // by the code that already handles subtitles, unchanged. An overlay does
  // require compositing, so such a clip moves off the cheap fixed-function
  // path; that is inherent, not a policy choice made here.
  if (!subtitle) {
    return overlayPath
      ? {
        filter: `subtitles=filename=${escapeFilterPath(overlayPath)}${fonts}`,
        canvasFilter: `subtitles=filename=${escapeFilterPath(overlayPath)}${fonts}:alpha=1`,
        overlayInput: null,
        needsComplex: false,
      }
      : { filter: null, canvasFilter: null, overlayInput: null, needsComplex: false };
  }
  // Studio overlays ride the subtitle chain: libass is already rendering
  // into this canvas, so a second pass costs one CPU pass and no GPU work
  // at all — measured at ~3000fps for a typeset script, against 24 needed.
  const withOverlay = (f) => (f && overlayPath
    ? `${f},subtitles=filename=${escapeFilterPath(overlayPath)}`
    : f);
  /**
   * The same chain for a TRANSPARENT canvas: `:alpha=1` on EVERY subtitles
   * filter, not appended once at the tail. A subtitles filter without it
   * leaves the canvas's alpha channel untouched, and on an all-transparent
   * canvas that is glyphs with alpha zero — drawn, and invisible once
   * composited. Exactly that shipped: the canvas builders decorated the
   * COMBINED string, so the moment a Studio text overlay chained a second
   * filter on, only the overlay got alpha and the actual subtitles
   * vanished from the stream. Pixel-measured: srt-then-overlay with tail
   * alpha renders 0 visible subtitle pixels; with alpha on each, 1776.
   */
  const forCanvas = (f) => (f && overlayPath
    ? `${f}:alpha=1,subtitles=filename=${escapeFilterPath(overlayPath)}:alpha=1`
    : (f ? `${f}:alpha=1` : f));

  if (subtitle.bitmap) {
    // Bitmap subs cannot be handled by a simple -vf chain; the caller must
    // build a filter_complex that overlays [0:s:N] onto the video.
    //
    // A Studio overlay cannot ride that chain, so it comes back separately
    // for the caller to append AFTER the scale — at output coordinates,
    // exactly where the text path puts it. Without this, switching to a
    // PGS track silently took the overlay off screen.
    //
    // On a GPU box the same decoded bitmaps ride the alpha canvas the
    // text path already uploads (canvasInput), so the video never leaves
    // the GPU; the caption goes onto that canvas as a libass pass.
    return {
      filter: null,
      overlayInput: `0:s:${subtitle.typeIndex}`,
      canvasInput: `0:s:${subtitle.typeIndex}`,
      canvasOverlay: overlayPath
        ? `subtitles=filename=${escapeFilterPath(overlayPath)}${fonts}:alpha=1`
        : null,
      needsComplex: true,
      postFilter: overlayPath
        ? `,subtitles=filename=${escapeFilterPath(overlayPath)}${fonts}`
        : '',
    };
  }

  if (subtitle.external) {
    return {
      filter: withOverlay(`subtitles=filename=${escapeFilterPath(subtitle.path)}${fonts}`),
      canvasFilter: forCanvas(`subtitles=filename=${escapeFilterPath(subtitle.path)}${fonts}`),
      overlayInput: null,
      needsComplex: false,
    };
  }

  // Prefer a pre-extracted copy. Pointing the filter at the media file makes
  // libavfilter demux the whole thing a second time alongside the main
  // decode — barely visible locally, ruinous over a network mount.
  if (extractedPath) {
    return {
      filter: withOverlay(`subtitles=filename=${escapeFilterPath(extractedPath)}${fonts}`),
      canvasFilter: forCanvas(`subtitles=filename=${escapeFilterPath(extractedPath)}${fonts}`),
      overlayInput: null,
      needsComplex: false,
    };
  }

  // `si` selects among the file's subtitle streams and is a subtitle-relative
  // index, not the absolute stream index.
  return {
    filter: withOverlay(`subtitles=filename=${escapeFilterPath(mediaPath)}:si=${subtitle.typeIndex}${fonts}`),
    canvasFilter: forCanvas(`subtitles=filename=${escapeFilterPath(mediaPath)}:si=${subtitle.typeIndex}${fonts}`),
    overlayInput: null,
    needsComplex: false,
  };
}

/**
 * Which WORK a queued item belongs to, for scoping a live track switch.
 *
 * A choice made during one show is about that show: switching Death Note
 * to English subtitles must not decide anything for the film queued
 * after it, which has its own languages, its own releases, and — since
 * drawing subtitles rules out HDR passthrough — possibly its own picture
 * quality. Episodes of one series share a work and carry the choice
 * between them; every film is its own work, so one film never speaks for
 * the next.
 *
 * The series NAME is the key, not an id, because the same show can be
 * queued from different sources in one broadcast. A film has no series,
 * so it falls back to its own item id, which no other item shares.
 */
export function workKeyOf(item) {
  const series = String(item?.series ?? '').trim();
  if (series) return `series:${series.toLowerCase()}`;
  const id = String(item?.id ?? '').trim();
  return id ? `item:${id}` : '';
}
