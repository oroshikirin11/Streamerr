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
 * ISO 639-2/B and /T both appear in the wild, sometimes alongside 639-1.
 * Normalising to one form per language means a file tagged `deu` and a user
 * preference of `ger` still match.
 */
const LANG_ALIASES = {
  de: 'ger', deu: 'ger', ger: 'ger', german: 'ger',
  en: 'eng', eng: 'eng', english: 'eng',
  ja: 'jpn', jpn: 'jpn', japanese: 'jpn',
  fr: 'fre', fra: 'fre', fre: 'fre', french: 'fre',
  es: 'spa', spa: 'spa', spanish: 'spa',
  it: 'ita', ita: 'ita', italian: 'ita',
  nl: 'dut', nld: 'dut', dut: 'dut', dutch: 'dut',
  pt: 'por', por: 'por', portuguese: 'por',
  ru: 'rus', rus: 'rus', russian: 'rus',
  zh: 'chi', zho: 'chi', chi: 'chi', chinese: 'chi',
  ko: 'kor', kor: 'kor', korean: 'kor',
  pl: 'pol', pol: 'pol', polish: 'pol',
};

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
      'stream=index,codec_name,codec_type,channels,channel_layout,width,height,sample_aspect_ratio,display_aspect_ratio:'
      + 'stream_tags=language,title:stream_disposition=default,forced,hearing_impaired',
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
    const middle = basename(name, ext).slice(stem.length).replace(/^[.\-_]+/, '');
    const parts = middle.split(/[.\-_]+/).filter(Boolean);

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
  audio ??= tracks.audio.find((a) => a.default) ?? tracks.audio[0] ?? null;

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
        subtitleLanguages.map(normLang),
      ) ?? subtitles.find((s) => !s.hearingImpaired) ?? subtitles[0] ?? null;
      if (!subtitle) skipped = 'this file has none';
    } else if (subtitleMode === 'forced') {
      // Forced subs only translate foreign dialogue — the usual choice when
      // you understand the spoken language.
      subtitle = pickByLanguage(subtitles.filter((s) => s.forced), subtitleLanguages);
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
          wanted,
        ) ?? pickByLanguage(subtitles, wanted);
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

function pickByLanguage(list, languages) {
  for (const lang of languages) {
    // Prefer a non-forced full track, then anything in that language.
    const exact = list.find((s) => s.language === lang && !s.forced)
      ?? list.find((s) => s.language === lang);
    if (exact) return exact;
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
  if (!subtitle) return { filter: null, overlayInput: null, needsComplex: false };
  const { extractedPath = null, fontsDir = null } = opts;
  const fonts = fontsDir ? `:fontsdir=${escapeFilterPath(fontsDir)}` : '';

  if (subtitle.bitmap) {
    // Bitmap subs cannot be handled by a simple -vf chain; the caller must
    // build a filter_complex that overlays [0:s:N] onto the video.
    return {
      filter: null,
      overlayInput: `0:s:${subtitle.typeIndex}`,
      needsComplex: true,
    };
  }

  if (subtitle.external) {
    return {
      filter: `subtitles=filename=${escapeFilterPath(subtitle.path)}${fonts}`,
      overlayInput: null,
      needsComplex: false,
    };
  }

  // Prefer a pre-extracted copy. Pointing the filter at the media file makes
  // libavfilter demux the whole thing a second time alongside the main
  // decode — barely visible locally, ruinous over a network mount.
  if (extractedPath) {
    return {
      filter: `subtitles=filename=${escapeFilterPath(extractedPath)}${fonts}`,
      overlayInput: null,
      needsComplex: false,
    };
  }

  // `si` selects among the file's subtitle streams and is a subtitle-relative
  // index, not the absolute stream index.
  return {
    filter: `subtitles=filename=${escapeFilterPath(mediaPath)}:si=${subtitle.typeIndex}${fonts}`,
    overlayInput: null,
    needsComplex: false,
  };
}
