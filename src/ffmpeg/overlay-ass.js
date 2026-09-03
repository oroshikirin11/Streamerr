/**
 * Overlay items → an ASS script the existing burn path renders.
 *
 * No new filter is involved: subtitles are already libass rendering an RGBA
 * canvas that gets composited on the GPU, so an overlay is the same pipeline
 * with different events. ASS gives placement, size, colour, rotation,
 * outline and timing natively, which is why this is a text generator rather
 * than a compositor.
 *
 * Positions are FRACTIONS of the frame, never pixels. With frameSize modes
 * a 4:3 episode goes out at 1440x1080 and a 16:9 one at 1920x1080 in the
 * same broadcast; pixel coordinates would walk a logo off the frame at every
 * reshape, and fractions keep it where it was put.
 *
 * Timing is written into the event times. Verified: an event bounded to
 * 20-25s renders only inside that window with no scheduling anywhere. But
 * verified too that an input-side `-ss` rebases timestamps to zero and the
 * event then never fires — the same trap the subtitle path already corrects
 * with setpts — so `startOffset` shifts the times to match.
 */

/** ASS wants &HBBGGRR&, CSS gives #RRGGBB. */
function assColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return '&H00FFFFFF&';
  const [r, g, b] = [0, 2, 4].map((i) => m[1].slice(i, i + 2).toUpperCase());
  return `&H00${b}${g}${r}&`;
}

/** Braces and newlines would be read as override tags or event structure. */
function assText(s) {
  return String(s ?? '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .replace(/^\s+|\s+$/g, '');
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
const hms = (t) => {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};

/**
 * When an item is on screen, as [start, end] seconds within the clip:
 * always the whole clip. An overlay stays until the operator removes it —
 * the intro/outro windowing this once had is gone.
 */
function windowFor(item, duration) {
  return [0, duration && duration > 0 ? duration : 86_400];
}

/**
 * @param {object[]} items      overlay items (text or image)
 * @param {object} o
 * @param {number} o.width      output frame size, for PlayRes
 * @param {number} o.height
 * @param {number} [o.duration] clip length
 * @param {number} [o.startOffset] where this source was seeked to; event
 *   times are shifted back by it because -ss rebases timestamps to zero
 * @returns {string|null} an ASS script, or null if nothing is visible
 */
/**
 * Dynamic captions. A text may carry placeholders, filled per clip when the
 * script is written, so a caption follows every transition and skip without
 * the operator touching it:
 *   {name}    what is on — "Series — S1E4 — title", or the film's title
 *   {series}  the series alone (empty for a film)
 *   {title}   the episode or film title
 *   {count}   the clip's number in this broadcast, from 1
 * Filled BEFORE overlayAss strips braces, so a title that itself contains
 * braces cannot smuggle an override tag into the script.
 */
export const OVERLAY_FIELDS = /\{(name|series|title|count)\}/g;
export function fillOverlayText(items, { item = null, count = null } = {}) {
  const series = String(item?.series ?? '');
  const full = String(item?.title ?? '');
  // The queue's display title already leads with the series ("Show —
  // S1E2"); a title that does not is prefixed here. {title} is the part
  // that is not the series either way.
  const led = series && full.startsWith(`${series} — `);
  const vals = {
    series,
    title: led ? full.slice(series.length + 3) : full,
    name: led || !series || !full ? (full || series) : `${series} — ${full}`,
    count: count == null ? '' : String(count),
  };
  return (items ?? []).map((i) => (
    i?.type === 'text' && typeof i.text === 'string' && OVERLAY_FIELDS.test(i.text)
      ? { ...i, text: i.text.replace(OVERLAY_FIELDS, (_, k) => vals[k]) }
      : i));
}

/**
 * A bouncing caption, as a run of \move legs.
 *
 * The picture path gets its bounce from an ffmpeg expression evaluated per
 * frame. libass has no expression language, but it does not need one: our
 * bounce is PIECEWISE LINEAR, and \move interpolates linearly over an
 * event. So one event per leg — corner to edge — reproduces the path
 * exactly rather than approximating it, and costs libass nothing, because
 * the subtitle canvas is rasterised every frame regardless.
 *
 * Same closed form as bouncePlace() in overlay-image.js, evaluated on the
 * MEDIA timeline so a caption keeps its place across a splice exactly as a
 * picture does.
 *
 * The one inexact part is the text's extent. ffmpeg gives the picture path
 * `w` and `h`; nothing here knows how wide a string renders, so it is
 * estimated from the font size and the longest line. An estimate that is off
 * only changes how close to the edge the caption turns — it is clamped so it
 * can never leave the frame.
 */
const MAX_LEGS = 4000;

function bounceLegs(item, {
  width, height, start, end, extentW, extentH, index = 0,
}) {
  const speed = Math.min(1, Math.max(0.01, Number(item.speed) || 0.06));
  const v = Math.max(1, speed * width);              // px/second, both axes
  const rx = Math.max(1, width - extentW);
  const ry = Math.max(1, height - extentH);
  const tri = (u, r) => Math.abs(((u % (2 * r)) + 2 * r) % (2 * r) - r);
  const at = (t) => {
    const u = v * (t + index * 3.1);
    return [
      Math.round(tri(u, rx) + extentW / 2),
      Math.round(tri(u, ry) + extentH / 2),
    ];
  };
  // A leg ends whenever EITHER axis turns, which is every rx/v and ry/v.
  const turns = new Set([start, end]);
  for (const r of [rx, ry]) {
    const period = r / v;
    if (!(period > 0.01)) continue;
    for (let k = Math.ceil((start + index * 3.1) / period); turns.size < MAX_LEGS; k += 1) {
      const t = k * period - index * 3.1;
      if (t >= end) break;
      if (t > start) turns.add(t);
    }
  }
  const times = [...turns].sort((a, b) => a - b);
  const legs = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    legs.push({ from: times[i], to: times[i + 1], a: at(times[i]), b: at(times[i + 1]) });
  }
  return legs;
}

export function overlayAss(items, {
  width = 1920, height = 1080, duration = null, startOffset = 0,
} = {}) {
  const events = [];
  // Staggers bouncing captions against each other, and against bouncing
  // pictures, exactly as the picture path does.
  let idx = 0;
  for (const item of items ?? []) {
    if (!item || item.enabled === false) continue;
    const win = windowFor(item, duration);
    if (!win) continue;
    // Shifted into this source's own timeline; an event that ends before
    // the seek point is simply gone.
    const start = win[0] - startOffset;
    const end = win[1] - startOffset;
    if (end <= 0) continue;

    const x = Math.round(clamp01(item.x) * width);
    const y = Math.round(clamp01(item.y) * height);
    const rot = Number(item.rotation) || 0;
    // ASS rotates anticlockwise; every editor on earth rotates clockwise.
    const tags = [`\\pos(${x},${y})`, `\\an5`];
    if (rot) tags.push(`\\frz${(-rot).toFixed(2)}`);

    if (item.type === 'image' || item.type === 'censor') {
      // Placeholder: images are composited by their own overlay_vaapi input
      // and censor boxes are cut on the base picture, neither is drawn by
      // libass, so they are not events here.
      continue;
    }

    const size = Math.max(8, Math.round((Number(item.size) || 0.05) * height));
    tags.push(`\\fs${size}`);
    tags.push(`\\c${assColour(item.colour)}`);
    // ASS alpha runs backwards from what a slider means: &H00& is opaque and
    // &HFF& is invisible. \alpha sets fill and border together, so a
    // half-transparent caption fades its outline with it instead of leaving
    // a hard black edge around ghost text.
    if (item.opacity != null && Number(item.opacity) < 1) {
      const a = Math.round((1 - clamp01(item.opacity)) * 255)
        .toString(16).toUpperCase().padStart(2, '0');
      tags.push(`\\alpha&H${a}&`);
    }
    if (item.outline !== false) tags.push('\\bord2', '\\3c&H00000000&');
    if (item.font) tags.push(`\\fn${String(item.font).replace(/[{}\\,]/g, '')}`);

    const text = assText(String(item.text ?? ''));
    if (!text) continue;

    if (item.motion === 'bounce') {
      /**
       * The extent, estimated. See bounceLegs: nothing here can ask libass
       * how wide a string renders, so the caption's box is derived from its
       * font size and longest line, and clamped so an estimate that is off
       * can only change where it turns, never let it leave the frame.
       */
      const lines = text.split('\\N');
      const longest = Math.max(1, ...lines.map((l) => l.replace(/\{[^}]*\}/g, '').length));
      const extentW = Math.min(width * 0.9, longest * size * 0.55);
      const extentH = Math.min(height * 0.9, lines.length * size * 1.2);
      // \pos is what \move replaces; everything else about the caption is
      // unchanged, so it keeps its size, colour, outline and rotation.
      const rest = tags.filter((t) => !t.startsWith('\\pos('));
      const legs = bounceLegs(item, {
        width, height, start: win[0], end: win[1], extentW, extentH, index: idx,
      });
      for (const leg of legs) {
        const from = leg.from - startOffset;
        const to = leg.to - startOffset;
        if (to <= 0) continue;
        events.push(
          `Dialogue: 0,${hms(Math.max(0, from))},${hms(to)},Ov,,0,0,0,,`
          + `{\\move(${leg.a[0]},${leg.a[1]},${leg.b[0]},${leg.b[1]})${rest.join('')}}${text}`,
        );
      }
      idx += 1;
      continue;
    }

    events.push(
      `Dialogue: 0,${hms(Math.max(0, start))},${hms(end)},Ov,,0,0,0,,{${tags.join('')}}${text}`,
    );
  }
  if (!events.length) return null;

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,'
      + ' OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,'
      + ' ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,'
      + ' Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Ov,DejaVu Sans,48,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,'
      + '0,0,0,0,100,100,0,0,1,2,0,5,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
