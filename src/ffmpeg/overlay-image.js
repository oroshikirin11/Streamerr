/**
 * Picture overlays — PNGs and animated GIFs composited into the broadcast.
 *
 * Text rides the subtitle renderer, because libass already draws text and
 * ASS describes placement, colour and timing natively. Pictures cannot:
 * libass ignores the ASS format's embedded-graphics section, so there is no
 * way to smuggle a raster image through the text path. They need what OBS
 * uses internally — their own input and an `overlay` filter — which is what
 * this builds.
 *
 * Coordinates are FRACTIONS of the output frame, matching the text overlays,
 * and resolved against ffmpeg's own W/H/w/h so a frame-size change moves a
 * logo with the picture instead of leaving it behind.
 */

/**
 * A fraction of the frame, defaulting only when the value is absent.
 *
 * NOT `Number(v) || fallback`: 0 is falsy, so the left and top edges — both
 * reachable by dragging, since the editor clamps to exactly 0 — would have
 * silently become 0.5 and jumped a logo to the middle of the broadcast
 * while the editor still showed it in the corner.
 */
const frac = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

/** Frame-fraction placement, centred on the point like the text's \an5. */
const place = (x, y) => `x=(W*${x.toFixed(4)})-w/2:y=(H*${y.toFixed(4)})-h/2`;

/**
 * Commas inside an option value would end the filter. `enable` is the only
 * place here that needs it, and getting it wrong turns `between(t,0,15)`
 * into three broken filters rather than an error worth reading.
 */
const enableExpr = (s, e) => `:enable=between(t\\,${s.toFixed(3)}\\,${e.toFixed(3)})`;

/**
 * @param {object[]} images resolved descriptors: { path, x, y, size, rotation,
 *   opacity, animated, start, end } — start/end already shifted into this
 *   source's timeline, or null for "the whole clip"
 * @param {object} o
 * @param {number} o.width   output frame width, used to size the picture
 * @param {number} [o.firstInput] ffmpeg input index of the first picture
 * @returns {{ inputs: string[], filters: string[], looping: boolean }}
 *   `filters` composite from label `[in]` to `[out]`; empty when there is
 *   nothing to draw, so callers can keep their existing graph untouched.
 */
export function imageOverlayChain(images, {
  width = 1920, firstInput = 1, inLabel = 'in', outLabel = 'out',
} = {}) {
  const list = (images ?? []).filter((i) => i?.path);
  if (!list.length) return { inputs: [], filters: [], looping: false };

  const inputs = [];
  const filters = [];
  let looping = false;
  let cur = inLabel;

  list.forEach((img, i) => {
    const idx = firstInput + i;
    if (img.animated) {
      // Loop the animation for as long as the clip runs. This makes the
      // input infinite, which is why callers bound the output — an
      // unbounded secondary input keeps ffmpeg alive after the episode
      // ends, and the clip never advances.
      inputs.push('-ignore_loop', '0');
      looping = true;
    }
    inputs.push('-i', img.path);

    // A still PNG is a single frame. overlay's repeatlast (on by default)
    // holds it for the rest of the clip, so it needs no -loop and stays a
    // finite input — one less way for the process to hang.
    const steps = ['format=rgba'];
    const w = Math.max(2, Math.round((Number(img.size) || 0.2) * width));
    steps.push(`scale=${w}:-1`);
    const rot = Number(img.rotation) || 0;
    if (rot) {
      // Radians, and the canvas has to grow or the corners are clipped.
      // c=none keeps the new corners transparent rather than black.
      //
      // NOT negated. The text path negates because ASS's \frz turns
      // anticlockwise, but ffmpeg's rotate turns CLOCKWISE for a positive
      // angle — same as the editor's CSS transform. Copying the ASS
      // convention here spun pictures the wrong way, so a picture and a
      // caption set to the same angle leaned in opposite directions.
      // Measured: rotate=+PI/2 moves the left edge to the top.
      const rad = (rot * Math.PI / 180).toFixed(6);
      steps.push(`rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})`);
    }
    const op = img.opacity;
    if (op != null && Number(op) < 1) {
      steps.push(`colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(op))).toFixed(3)}`);
    }
    filters.push(`[${idx}:v]${steps.join(',')}[img${i}]`);

    const next = i === list.length - 1 ? outLabel : `ov${i}`;
    const timed = img.start != null && img.end != null
      ? enableExpr(img.start, img.end) : '';
    // eof_action=repeat holds the last overlay frame for the rest of the
    // clip. This is what makes a still PNG work without -loop: it is one
    // frame, and every frame after it reuses that one. `pass` reads like
    // the safe choice and is the opposite — it passes the main picture
    // through WITHOUT the overlay, so a logo appeared for exactly one frame
    // and then disappeared. Verified by encoding a frame and looking at it.
    filters.push(
      `[${cur}][img${i}]overlay=${place(frac(img.x, 0.5), frac(img.y, 0.5))}`
      + `:eof_action=repeat${timed}[${next}]`,
    );
    cur = next;
  });

  return { inputs, filters, looping };
}

/**
 * The same pictures, composited on the GPU with overlay_vaapi.
 *
 * Worth having a second builder for: forcing a clip onto the CPU because it
 * carries a logo turns a comfortable GPU episode into an unwatchable one,
 * and there is no reason to. A still picture costs the CPU nothing per
 * frame — scale and rotate run ONCE, on one frame — and the per-frame
 * composite is what the GPU is for.
 *
 * Measured on this driver: overlay_vaapi honours alpha (transparent corners
 * stayed transparent), takes x/y as EXPRESSIONS so nothing has to know the
 * picture's pixel size, and has its own `alpha` for opacity. Scaling is
 * done on the CPU beforehand rather than with the filter's `w`, so the
 * scale-then-rotate order matches the software path exactly and a rotated
 * picture is the same size on both.
 *
 * The one thing it cannot do is timing: overlay_vaapi has no `enable`
 * option, so an intro/outro picture still needs the software path. Callers
 * check for that before choosing this.
 */
export function vaapiImageOverlayChain(images, {
  width = 1920, firstInput = 1, inLabel = 'in', outLabel = 'out',
} = {}) {
  const list = (images ?? []).filter((i) => i?.path);
  if (!list.length) return { inputs: [], filters: [], looping: false };

  const inputs = [];
  const filters = [];
  let looping = false;
  let cur = inLabel;

  list.forEach((img, i) => {
    const idx = firstInput + i;
    if (img.animated) { inputs.push('-ignore_loop', '0'); looping = true; }
    inputs.push('-i', img.path);

    // All of this runs once, on a single frame, before the picture is ever
    // handed to the GPU — which is why a logo can be free.
    const steps = ['format=rgba'];
    steps.push(`scale=${Math.max(2, Math.round((Number(img.size) || 0.2) * width))}:-1`);
    const rot = Number(img.rotation) || 0;
    if (rot) {
      const rad = (rot * Math.PI / 180).toFixed(6);
      steps.push(`rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})`);
    }
    steps.push('hwupload');
    filters.push(`[${idx}:v]${steps.join(',')}[img${i}]`);

    const next = i === list.length - 1 ? outLabel : `ov${i}`;
    const op = img.opacity != null && Number(img.opacity) < 1
      ? `:alpha=${Math.max(0, Math.min(1, Number(img.opacity))).toFixed(3)}` : '';
    filters.push(
      `[${cur}][img${i}]overlay_vaapi=`
      + `x=(main_w*${frac(img.x, 0.5).toFixed(4)})-(w/2)`
      + `:y=(main_h*${frac(img.y, 0.5).toFixed(4)})-(h/2)`
      + `${op}:eof_action=repeat[${next}]`,
    );
    cur = next;
  });

  return { inputs, filters, looping };
}

/** Pictures the GPU compositor can take: everything except timed ones. */
export const gpuCanDraw = (images) => (images ?? []).every((i) => i?.start == null);
