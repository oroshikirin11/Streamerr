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
 * When an item is on screen, as [start, end] seconds within the clip.
 *
 * 'always'  the whole clip
 * 'intro'   the opening `seconds`
 * 'outro'   the closing `seconds` — what "show it before the episode ends"
 *           means, and it needs the duration to be known
 */
function windowFor(item, duration) {
  const secs = Math.max(1, Number(item.seconds) || 15);
  if (item.when === 'intro') return [0, secs];
  if (item.when === 'outro') {
    if (!duration || duration <= secs) return null;   // unknown or too short
    return [duration - secs, duration];
  }
  return [0, duration && duration > 0 ? duration : 86_400];
}

/**
 * @param {object[]} items      overlay items (text or image)
 * @param {object} o
 * @param {number} o.width      output frame size, for PlayRes
 * @param {number} o.height
 * @param {number} [o.duration] clip length, needed for 'outro' timing
 * @param {number} [o.startOffset] where this source was seeked to; event
 *   times are shifted back by it because -ss rebases timestamps to zero
 * @param {string} [o.title]    substituted for {title} in text
 * @returns {string|null} an ASS script, or null if nothing is visible
 */
export function overlayAss(items, {
  width = 1920, height = 1080, duration = null, startOffset = 0, title = '',
} = {}) {
  const events = [];
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

    if (item.type === 'image') {
      // Placeholder: images are composited by their own overlay_vaapi input
      // rather than drawn by libass, so they are not events here.
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

    const text = assText(String(item.text ?? '').replace(/\{title\}/g, title));
    if (!text) continue;
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
