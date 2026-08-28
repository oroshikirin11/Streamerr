/**
 * Render subtitles into a bottom band instead of a whole-frame canvas.
 *
 * Burning subtitles costs a transparent 1920x1080 RGBA canvas per frame:
 * libass has to make it writable (a full-frame copy), rasterise into it, and
 * then the whole thing is uploaded to the GPU and blended. Measured on the
 * real pipeline that is 1.251 ms/frame of CPU on top of a 0.364 ms/frame
 * floor -- the single most expensive thing the streaming path does.
 *
 * Almost all of that canvas is empty. Dialogue lives in the bottom fifth of
 * the frame, so nearly every one of those pixels is copied, uploaded and
 * blended purely to carry transparency.
 *
 * Cropping the canvas after libass does not help much, because `crop` is
 * zero-copy and sits downstream: libass still pays for the full frame.
 * Measured, that saves 12.5%. What actually works is never making the big
 * canvas at all -- render onto a short one and put it back at the bottom:
 *
 *     color=...:s=1920x270 -> subtitles -> hwupload -> overlay_vaapi=y=810
 *
 * The catch is that libass lays out relative to the frame it is given, so a
 * 270-row canvas would shrink the text to fit. The fix is to scale PlayResY
 * by exactly the same factor as the frame height. libass derives its font
 * scale from frame_height / PlayResY, so keeping that ratio fixed keeps every
 * glyph the same pixel size, and MarginV for a bottom alignment is measured
 * from the bottom edge -- which is the one edge the band shares with the
 * frame. Nothing else in the script has to change. Measured 31% off the
 * whole pipeline's CPU, and bit-identical output (PSNR inf on every channel,
 * alpha included).
 *
 * That identity only holds for scripts that are anchored to the bottom.
 * Anything positioned -- \pos, \move, a top or middle alignment, a drawing,
 * a rotation -- is placed relative to an edge the band does not share, and
 * would land somewhere wrong or be clipped away entirely. Typeset releases
 * are full of exactly that. So the analysis here is a whitelist, not a
 * blacklist: a script gets a band only if every construct in it is
 * understood and provably bottom-anchored, and anything unrecognised sends
 * the whole track back to the full-frame canvas. A missed optimisation costs
 * some CPU; a wrong one silently cuts a sign off the top of a broadcast.
 */

/** Vertical alignments that measure from the bottom edge: \an1, \an2, \an3. */
const BOTTOM_ALIGN = new Set([1, 2, 3]);
/**
 * Legacy SSA \a numbering -> ASS \an numbering. They are NOT the same: SSA
 * 5/6/7 are the top row and 9/10/11 the middle, so reading \a5 as \an5
 * turns a top-of-frame sign into a centred one and the band would be
 * computed for the wrong edge. Anything not in this table is unknown, and
 * unknown means refuse.
 */
const SSA_ALIGN = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 };

/**
 * Override tags that are safe inside a bottom-anchored line.
 *
 * Everything here changes how a glyph looks, not where the line is anchored.
 * Size-changing tags (\fs, \fscy, \bord, \shad) are allowed because the band
 * height is computed from their worst case below; position-changing tags are
 * not allowed at all.
 */
const SAFE_TAG = /^(?:i|b|u|s|c|fn|fsp|fs|fe|fade?|k[fo]?|K|alpha|[1-4][ac]|be|blur|bord|[xy]bord|shad|[xy]shad|fsc[xy]|q|r|h|N|n)/;

/** Tags that move or reshape a line relative to an edge the band lacks. */
/**
 * `fad`/`fade` are NOT here: they animate alpha and nothing else.
 *
 * A fade cannot move a glyph, resize one, or put ink anywhere the same cue
 * would not have put it fully opaque — so it cannot affect where the band
 * has to be. Refusing it was over-cautious rather than wrong, and it cost a
 * whole script the band for a tag that only changes opacity over time.
 * Everything still listed here can move ink, which is the actual test.
 */
const UNSAFE_TAG = /^(?:move|org|i?clip|p\d|fr[xyz]?|t\()/;

function splitCsv(line, count) {
  // ASS's last field is free text and may itself contain commas.
  const out = [];
  let rest = line;
  for (let i = 0; i < count - 1; i += 1) {
    const c = rest.indexOf(',');
    if (c < 0) return null;
    out.push(rest.slice(0, c).trim());
    rest = rest.slice(c + 1);
  }
  out.push(rest);
  return out;
}

function num(v, fallback) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Width of a character in em units, for estimating how many lines a long
 * line wraps into. Deliberately generous: overestimating the wrap only makes
 * the band taller, underestimating it clips text.
 */
function emWidth(ch) {
  const c = ch.codePointAt(0);
  // CJK, Hangul and fullwidth forms are one em wide; Latin averages ~0.5.
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf)
    || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)) return 1.0;
  return 0.62;
}

/**
 * Scan the override tags in one event's text.
 *
 * @returns {{ ok: boolean, reason: string|null, fs: number, scaleY: number,
 *             bord: number, shad: number, lines: number, plain: string }}
 */
function scanText(text, style) {
  let fs = style.fontSize;
  let scaleY = style.scaleY;
  let bord = style.outline;
  let shad = style.shadow;
  // Kept per hard line: wrapping has to be estimated against each line's own
  // width. Measuring the whole cue as one run costs a two-line caption a
  // third line it never has, and that slack lands directly in the band.
  const segs = [''];
  const posYs = [];
  const aligns = new Set();
  let i = 0;

  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i);
      if (end < 0) { segs[segs.length - 1] += text.slice(i); break; }
      const block = text.slice(i + 1, end);
      // A block holds several backslash-introduced tags run together.
      for (const raw of block.split('\\').slice(1)) {
        const tag = raw.trim();
        if (!tag) continue;
        /**
         * Positioning is measured, not refused.
         *
         * \pos puts the cue's anchor at an absolute PlayRes coordinate, and
         * which part of the text that anchor names depends on the alignment
         * in force. Both are collected here and resolved by the caller,
         * which knows the line count. Every y is kept, not just the last:
         * one cue can reposition mid-line, and the band has to cover all of
         * them.
         */
        const mp = /^pos\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(tag);
        if (mp) { posYs.push(num(mp[2], 0)); continue; }
        // \an takes ASS numbering directly.
        const ma = /^an\s*([1-9])\b/.exec(tag);
        if (ma) { aligns.add(Number(ma[1])); continue; }
        // \a is the legacy SSA form on a different numbering entirely, and
        // reading it as \an silently turns "bottom" into "top". Digits only,
        // so \alpha is not caught by it.
        const ml = /^a\s*(\d+)$/.exec(tag);
        if (ml) {
          const ssa = SSA_ALIGN[Number(ml[1])];
          if (!ssa) return { ok: false, reason: `\\a${ml[1]}` };
          aligns.add(ssa);
          continue;
        }
        if (UNSAFE_TAG.test(tag)) {
          return { ok: false, reason: `\\${tag.slice(0, 12)}` };
        }
        if (!SAFE_TAG.test(tag)) {
          // Unknown tag: refuse rather than assume it is harmless.
          return { ok: false, reason: `unknown \\${tag.slice(0, 12)}` };
        }
        const m = /^(fscy|fs|bord|shad)\s*([\d.]+)/.exec(tag);
        if (m) {
          const v = num(m[2], null);
          if (v == null) continue;
          if (m[1] === 'fs') fs = Math.max(fs, v);
          else if (m[1] === 'fscy') scaleY = Math.max(scaleY, v);
          else if (m[1] === 'bord') bord = Math.max(bord, v);
          else shad = Math.max(shad, v);
        }
      }
      i = end + 1;
      continue;
    }
    if (text[i] === '\\' && (text[i + 1] === 'N' || text[i + 1] === 'n')) {
      segs.push(''); i += 2; continue;
    }
    if (text[i] === '\\' && text[i + 1] === 'h') {
      segs[segs.length - 1] += ' '; i += 2; continue;
    }
    segs[segs.length - 1] += text[i];
    i += 1;
  }
  return { ok: true, reason: null, fs, scaleY, bord, shad, segs, posYs, aligns };
}

/**
 * Decide whether a script can be rendered into a bottom band, and how tall
 * that band has to be.
 *
 * @param {string} text  the .ass/.ssa script
 * @param {{width:number,height:number}} frame  output geometry
 * @returns {{ safe: boolean, reason: string, bandHeight: number,
 *             playResY: number, newPlayResY: number }}
 */
export function analyseAssBand(text, { width, height }) {
  const no = (reason) => ({ safe: false, reason, bandHeight: height });
  if (!text || typeof text !== 'string') return no('unreadable script');

  const lines = text.split(/\r?\n/);
  let playResX = 0;
  let playResY = 0;
  let styleFmt = null;
  let eventFmt = null;
  const styles = new Map();
  const events = [];
  let section = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();

    if (key === 'playresx') playResX = num(val, 0);
    else if (key === 'playresy') playResY = num(val, 0);
    else if (key === 'format' && section.includes('style')) {
      styleFmt = val.split(',').map((s) => s.trim().toLowerCase());
    } else if (key === 'format' && section.includes('event')) {
      eventFmt = val.split(',').map((s) => s.trim().toLowerCase());
    } else if (key === 'style' && styleFmt) {
      const f = splitCsv(val, styleFmt.length);
      if (!f) continue;
      const at = (n) => f[styleFmt.indexOf(n)];
      styles.set(String(at('name')).trim(), {
        align: num(at('alignment'), 2),
        marginV: num(at('marginv'), 0),
        marginL: num(at('marginl'), 0),
        marginR: num(at('marginr'), 0),
        fontSize: num(at('fontsize'), 0),
        scaleY: num(at('scaley'), 100),
        outline: num(at('outline'), 0),
        shadow: num(at('shadow'), 0),
      });
    } else if (key === 'dialogue' && eventFmt) {
      const f = splitCsv(val, eventFmt.length);
      if (!f) continue;
      const at = (n) => f[eventFmt.indexOf(n)];
      events.push({
        style: String(at('style') ?? '').trim(),
        marginV: num(at('marginv'), 0),
        effect: String(at('effect') ?? '').trim(),
        text: String(at('text') ?? ''),
      });
    }
  }

  if (!playResY || !playResX) return no('script declares no PlayRes');
  if (!events.length) return no('no dialogue events');
  if (!styles.size) return no('no styles');

  // libass scales the layout by frame_height / PlayResY. The band keeps that
  // ratio, so the new PlayResY must come out a whole number -- otherwise the
  // glyphs change size and the output is no longer identical.
  const step = height / gcd(height, playResY);

  let worst = 0; // topmost extent above the bottom edge, in PlayRes units
  for (const ev of events) {
    const style = styles.get(ev.style) ?? styles.values().next().value;
    if (ev.effect && /scroll|banner/i.test(ev.effect)) {
      return no(`event effect "${ev.effect.slice(0, 20)}"`);
    }
    const s = scanText(ev.text, style);
    if (!s.ok) return no(`positioning tag ${s.reason}`);

    /**
     * Which alignments this event can actually be drawn under.
     *
     * An override wins over the style, and a cue carrying more than one is
     * measured under ALL of them rather than the last: the tags may apply to
     * different runs, and the band has to hold whichever sits highest.
     * Without an override the style decides, which is the old behaviour.
     */
    const aligns = s.aligns.size ? [...s.aligns] : [style.align];
    // A style anchored anywhere but the bottom is only usable when the event
    // pins it with \pos — otherwise its distance from an edge the band does
    // not share is unknown, and that is exactly the case the whitelist exists
    // to refuse.
    if (!s.posYs.length && !aligns.every((a) => BOTTOM_ALIGN.has(a))) {
      return no(`alignment ${aligns.join('/')} without \\pos`);
    }

    const marginV = ev.marginV || style.marginV;
    const lineH = s.fs * (s.scaleY / 100) * 1.2; // libass default line spacing
    // Wrapped lines are not in the script; estimate each hard line's own
    // width and count how many rendered lines it turns into.
    const usable = Math.max(1, playResX - style.marginL - style.marginR);
    let total = 0;
    for (const seg of s.segs) {
      let w = 0;
      for (const ch of seg) w += emWidth(ch) * s.fs;
      total += Math.max(1, Math.ceil(w / usable));
    }
    const textH = total * lineH;
    // Outline is drawn on both sides of the glyph and the shadow is offset
    // away from it, so both add ink beyond the layout box.
    const ink = s.bord * 2 + s.shad;

    /**
     * How far above the bottom edge this event can put ink.
     *
     * Unpositioned, that is the old measurement: MarginV is a distance from
     * the bottom, so the extent is the margin plus the text.
     *
     * Positioned, \pos names an absolute y and the alignment says which part
     * of the text lands on it -- the bottom row (\an1-3), the middle
     * (\an4-6), or the top (\an7-9). Converting that to a top edge and then
     * to a distance from the bottom is what makes a typeset script
     * measurable instead of merely suspicious. A sign near the top of the
     * frame produces a huge extent, which is correct: the band would have to
     * be nearly the whole frame, and the caller's own cap then refuses it and
     * falls back. Nothing is clipped either way.
     */
    let extent = 0;
    for (const align of aligns) {
      if (!s.posYs.length) {
        extent = Math.max(extent, marginV + textH + ink);
        continue;
      }
      for (const y of s.posYs) {
        const top = BOTTOM_ALIGN.has(align) ? y - textH
          : align >= 7 ? y
            : y - textH / 2;
        extent = Math.max(extent, playResY - top + ink);
      }
    }
    if (extent > worst) worst = extent;
  }

  // Pad the analytic bound. Font metrics vary by face -- ascenders and
  // descenders can exceed the nominal size -- and the wrap estimate is only
  // an estimate. This is the difference between a band that is slightly too
  // big and one that shaves the top off a tall line. The margin is added in
  // real pixels: in PlayRes units it would scale with the script's own
  // coordinate system and land anywhere between 6 and 90 px.
  const bandPx = Math.ceil(
    ((worst * 1.15 * height) / playResY + 32) / step,
  ) * step;

  if (!(bandPx > 0) || bandPx >= height) return no('band would be full frame');
  // Past roughly two thirds of the frame the saving no longer justifies
  // running a second code path.
  if (bandPx > height * 0.62) return no(`band ${bandPx}px is too tall to pay off`);

  return {
    safe: true,
    reason: 'bottom-anchored',
    bandHeight: bandPx,
    playResY,
    newPlayResY: Math.round((playResY * bandPx) / height),
  };
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1;
}

/**
 * Rewrite a script so it renders identically into a band of `bandHeight`.
 *
 * Only the PlayResY header changes. Every coordinate in the file is in
 * PlayRes units and every remaining construct is anchored to the bottom
 * edge, which the band shares with the frame, so they all keep meaning the
 * same thing.
 */
export function bandScript(text, { playResY, newPlayResY }) {
  let replaced = false;
  /**
   * How far the coordinate origin moved.
   *
   * The band is the BOTTOM slice of the original space, so a point keeps its
   * distance from the bottom edge and loses exactly the rows that were cut
   * off the top. Margins need no help with this -- they are already measured
   * from the bottom -- which is why the header rewrite alone was enough while
   * every positioned script was being refused.
   *
   * \pos is different: its y is absolute in PlayRes units. Shrinking
   * PlayResY underneath it without moving it would leave the text at the same
   * number in a much shorter space, i.e. far below the canvas and invisible.
   * Shifting by the delta puts it back exactly where it was on screen.
   */
  const delta = playResY - newPlayResY;
  const shift = (line) => line.replace(
    /(\\pos\s*\(\s*-?[\d.]+\s*,\s*)(-?[\d.]+)(\s*\))/g,
    (_, head, y, tail) => `${head}${Number((Number(y) - delta).toFixed(3))}${tail}`,
  );
  const out = text.split(/\r?\n/).map((line) => {
    if (!replaced && /^\s*PlayResY\s*:/i.test(line)) {
      replaced = true;
      return `PlayResY: ${newPlayResY}`;
    }
    // Only event lines carry override tags; styles and headers have no \pos.
    return /^\s*(?:Dialogue|Comment)\s*:/i.test(line) ? shift(line) : line;
  });
  if (!replaced) return null; // analyse() guarantees a header; refuse if not
  return out.join('\n');
}
