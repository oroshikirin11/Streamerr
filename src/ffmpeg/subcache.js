/**
 * Extract embedded subtitle tracks to small files, once.
 *
 * `subtitles=filename=episode.mkv:si=0` makes libavfilter open and demux the
 * WHOLE media file a second time, in parallel with the main decode. On a
 * local 200 MB file that is barely measurable; on a multi-gigabyte episode
 * over a network mount it is a second full read of the same data, and it
 * dominates everything else.
 *
 * A subtitle track is a few hundred kilobytes. Pulling it out once and
 * pointing the filter at that instead removes the duplicate read.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { join } from 'path';

/** Subtitle codec → the container to extract it into. */
const EXT_FOR = {
  ass: 'ass', ssa: 'ass',
  subrip: 'srt', srt: 'srt', text: 'srt',
  mov_text: 'srt', webvtt: 'vtt',
};

/** File extension → the ffmpeg muxer name, which is not always the same. */
const MUXER_FOR = { ass: 'ass', srt: 'srt', vtt: 'webvtt' };

/** Bitmap formats cannot be extracted to a text file and must stay in place. */
export function isExtractable(sub) {
  return Boolean(sub && !sub.external && !sub.bitmap && EXT_FOR[sub.codec]);
}

function keyFor(srcPath, typeIndex) {
  const st = statSync(srcPath);
  return createHash('sha1')
    .update(`${srcPath}:${st.size}:${Math.floor(st.mtimeMs)}:${typeIndex}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Extract one embedded subtitle track, or return the cached copy.
 * Returns null when the track cannot be extracted — the caller should then
 * fall back to reading it from the media file.
 *
 * @returns {Promise<string|null>} path to the extracted subtitle file
 */
export async function extractSubtitle(srcPath, sub, cacheDir) {
  if (!isExtractable(sub)) return null;
  if (!existsSync(srcPath)) return null;

  const ext = EXT_FOR[sub.codec];
  mkdirSync(cacheDir, { recursive: true });

  let out;
  try {
    out = join(cacheDir, `${keyFor(srcPath, sub.typeIndex)}.${ext}`);
  } catch {
    return null;
  }
  if (existsSync(out)) return out;

  const tmp = `${out}.partial`;
  // Extraction demuxes the whole container, so the kill-switch must scale
  // with the file: a fixed 120s cap silently killed every extraction of a
  // large remux, which then fell back to the far worse in-band read. Budget
  // a pessimistic 30 MB/s plus slack, capped at an hour.
  let timeout = 600_000;
  try {
    timeout = Math.min(3_600_000,
      Math.max(600_000, (statSync(srcPath).size / 30e6) * 1000 + 120_000));
  } catch { /* keep the default */ }
  const ok = await run([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', srcPath,
    '-map', `0:s:${sub.typeIndex}`,
    // Copy where possible; ffmpeg converts when the target format differs.
    '-c:s', ext === 'srt' ? 'srt' : 'copy',
    // The format must be explicit: the temp name ends in .partial, so ffmpeg
    // cannot infer it from the extension and refuses to write anything.
    '-f', MUXER_FOR[ext],
    tmp,
  ], undefined, timeout);

  if (!ok || !existsSync(tmp)) {
    safeUnlink(tmp);
    return null;
  }
  try {
    renameSync(tmp, out);
  } catch {
    safeUnlink(tmp);
    return null;
  }
  return out;
}

/**
 * Fonts live inside the MKV for most anime releases, and libass needs them or
 * the typesetting falls back to a default face. Extracted once alongside the
 * subtitles; the filter is pointed at the directory via `fontsdir`.
 *
 * @returns {Promise<string|null>} directory containing the fonts
 */
export async function extractFonts(srcPath, cacheDir) {
  if (!existsSync(srcPath)) return null;

  let dir;
  try {
    dir = join(cacheDir, `fonts-${keyFor(srcPath, 'fonts')}`);
  } catch {
    return null;
  }
  const marker = join(dir, '.done');
  if (existsSync(marker)) return dir;

  mkdirSync(dir, { recursive: true });
  // dump_attachment writes every attached font into the working directory.
  await run([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-dump_attachment:t', '',
    '-i', srcPath,
    '-f', 'null', '-',
  ], dir);

  // A file with no attachments is not a failure — there is simply nothing to
  // extract, and libass falls back to system fonts. Mark it done either way so
  // we don't retry on every clip.
  try {
    writeFileSync(marker, '');
  } catch { /* best effort */ }
  return dir;
}

function safeUnlink(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

function run(args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd,
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
