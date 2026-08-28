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
    // -2 keeps the height even. This is the software path, which does not
    // care, but it keeps both builders producing the same size.
    steps.push(`scale=${w}:-2`);
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
 * Timing is handled at the input (see below), so this covers intro/outro
 * pictures too — nothing here needs the software path.
 */
export function vaapiImageOverlayChain(images, {
  width = 1920, height = 1080, firstInput = 1, inLabel = 'in', outLabel = 'out',
} = {}) {
  const list = (images ?? []).filter((i) => i?.path);
  if (!list.length) return { inputs: [], filters: [], looping: false };

  const inputs = [];
  const filters = [];
  let looping = false;
  let cur = inLabel;

  list.forEach((img, i) => {
    const idx = firstInput + i;
    /**
     * Timing without `enable`, done at the INPUT instead of the filter.
     *
     * overlay_vaapi has no timeline support, which is why timed pictures
     * used to send the whole clip to the software path. They do not need
     * one: the filter draws whatever frames the secondary input currently
     * has, so bounding WHEN that input has frames is the same thing.
     * `-itsoffset` withholds it until the window opens, `-t` ends it, and
     * repeatlast=0 stops the last frame being held forever afterwards.
     * Measured on a 10s clip with a 4-7s window: off at 1s, on at 5s, off
     * at 9s.
     */
    const timed = img.start != null && img.end != null;
    const span = timed ? Math.max(0.04, img.end - img.start) : 0;
    if (timed && img.start > 0) inputs.push('-itsoffset', img.start.toFixed(3));
    if (img.animated) {
      inputs.push('-ignore_loop', '0');
      if (!timed) looping = true;        // unbounded only when it never ends
    } else if (timed) {
      inputs.push('-loop', '1');         // a still needs looping to have a span
    }
    if (timed) inputs.push('-t', span.toFixed(3));
    inputs.push('-i', img.path);

    // All of this runs once, on a single frame, before the picture is ever
    // handed to the GPU — which is why a logo can be free.
    const steps = ['format=rgba'];
    // Even, because hardware surfaces want even dimensions and -2 only
    // makes the HEIGHT even.
    const w = Math.max(2, Math.round((Number(img.size) || 0.2) * width / 2) * 2);
    // Scaled to the requested fraction of the frame width and NOT clamped to
    // the frame. Overflow is handled by the crop below, which is both the
    // correct thing for a picture dragged half off the edge and what the
    // editor already shows — its stage clips rather than shrinking.
    steps.push(`scale=w=${w}:h=-2`);
    const rot = Number(img.rotation) || 0;
    if (rot) {
      const rad = (rot * Math.PI / 180).toFixed(6);
      steps.push(`rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})`);
    }
    const fx = frac(img.x, 0.5).toFixed(4);
    const fy = frac(img.y, 0.5).toFixed(4);
    /**
     * Crop to the part of the picture that actually lands on the frame.
     *
     * This is the fix for a hard `h264_vaapi -22 (Invalid argument)` that
     * KILLED a live broadcast, and the constraint is narrower than it first
     * looked: it is not that the overlay SURFACE must fit inside the main
     * frame, it is that the PLACED RECTANGLE must. Measured on the
     * deployment's iHD driver — a 384-wide logo centred at x=0.8 sits at
     * 1344..1728 and composites fine; the same logo at size 0.8 is 1536
     * wide, sits at 768..2304, overhangs the 1920 edge by 384, and the
     * encoder dies. Same story vertically, which is why a 1536x1536 picture
     * failed while 1056x1056 in the same position was accepted.
     *
     * Cropping first means the surface handed to the GPU is always inside
     * the frame, so the overhang can never reach the driver — and a picture
     * dragged half off the edge shows its visible half instead of taking
     * the broadcast down.
     *
     * Positions are fractions and clamped to 0..1, so the picture's centre
     * is always on the frame and at least half of it always survives the
     * crop; the width and height below cannot reach zero.
     *
     * Commas inside an option value would end the filter, hence esc().
     */
    const esc = (s) => s.replace(/,/g, '\\,');
    const ox = `(${width}*${fx}-iw/2)`;       // desired left edge, may be < 0
    const oy = `(${height}*${fy}-ih/2)`;
    const even = (s) => `floor((${s})/2)*2`;
    const cropX = `max(0,-${ox})`;
    const cropY = `max(0,-${oy})`;
    const cropW = even(`min(iw-${cropX},${width}-max(0,${ox}))`);
    const cropH = even(`min(ih-${cropY},${height}-max(0,${oy}))`);
    steps.push(esc(`crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY}`));
    steps.push('hwupload');
    filters.push(`[${idx}:v]${steps.join(',')}[img${i}]`);

    const next = i === list.length - 1 ? outLabel : `ov${i}`;
    const op = img.opacity != null && Number(img.opacity) < 1
      ? `:alpha=${Math.max(0, Math.min(1, Number(img.opacity))).toFixed(3)}` : '';
    /**
     * Placement clamped to the frame, which is the same arithmetic seen from
     * the other side: `w`/`h` here are the CROPPED size, so when nothing was
     * cropped this is exactly the old centred expression, and when the
     * picture overhung an edge it lands flush against that edge — which is
     * where the visible part belongs.
     */
    filters.push(
      `[${cur}][img${i}]overlay_vaapi=`
      + `x=${esc(`max(0,min(main_w-w,main_w*${fx}-w/2))`)}`
      + `:y=${esc(`max(0,min(main_h-h,main_h*${fy}-h/2))`)}`
      + `${op}:eof_action=repeat[${next}]`,
    );
    cur = next;
  });

  return { inputs, filters, looping };
}

/**
 * Pictures drawn onto the RGBA overlay canvas, on the CPU, before it is
 * uploaded and composited by the single overlay_vaapi the driver has
 * already proven it can do.
 *
 * The alternative — a second overlay_vaapi chained after the first — is
 * what took a live broadcast down: it ran on the development GPU and
 * returned -22 from h264_vaapi on the deployment's iHD driver. One graph
 * shape, probed once, is the rule here for a reason.
 *
 * The trailing format=rgba is load-bearing: overlay may hand back a format
 * without an alpha channel, and the canvas has to stay transparent
 * everywhere nothing was drawn or the composite becomes an opaque box over
 * the picture.
 */
export function canvasImageChain(images, opts = {}) {
  const r = imageOverlayChain(images, opts);
  if (!r.filters.length) return r;
  const last = r.filters.length - 1;
  r.filters[last] = r.filters[last].replace(/\[(\w+)\]$/, ',format=rgba[$1]');
  return r;
}
