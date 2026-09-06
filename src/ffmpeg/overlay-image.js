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

/** Fraction of the frame width a bouncing picture travels each second. */
const DEFAULT_SPEED = 0.06;

/**
 * The old screensaver bounce, as a closed form rather than a simulation.
 *
 * A bounce between two edges is a triangle wave, and a triangle wave has an
 * exact expression: `abs(mod(u, 2R) - R)` sweeps 0..R..0 for ever. So the
 * position is a pure function of `t`, which is what makes this affordable —
 * ffmpeg evaluates it per frame inside the already-running encoder, and
 * nothing has to re-apply, re-spawn or keep state to move a picture.
 *
 * Being stateless is not just tidy, it is REQUIRED here. The engine encodes a
 * cushion ahead of air and replays those packets later, so the same media
 * timestamp must always produce the same frame. Anything driven by a
 * wall-clock or an accumulator would put the picture in one place in the
 * cushion and somewhere else on a re-encode of the same moment.
 *
 * `t` restarts at zero on every spawn — and a spawn happens on every Apply,
 * every track change and every seek — so the caller passes the clip's media
 * offset as `phase`. Position then follows the MEDIA timeline, and a splice
 * leaves the picture exactly where it was instead of teleporting it home.
 *
 * The two axes share one speed, so travel is diagonal like the original. They
 * do not share a period: the ranges W-w and H-h differ, so the path keeps
 * finding new corners instead of retracing one diagonal.
 */
const bouncePlace = (img, width, phase, index) => {
  const v = Math.max(1, frac(img.speed, DEFAULT_SPEED) * width);   // px/second
  // A per-picture stagger, so two bouncing logos do not travel welded
  // together. Deterministic, because the cushion has to be reproducible.
  const p = (Number(phase) || 0) + index * 3.1;
  const u = `(${v.toFixed(3)}*(t+${p.toFixed(3)}))`;
  // Commas inside an option value would end the filter, exactly as in
  // enableExpr. mod() is the only place here that needs it.
  const wave = (range) => `abs(mod(${u}\\,2*${range})-${range})`;
  return `x=${wave('(W-w)')}:y=${wave('(H-h)')}`;
};

/** True when the picture's POSITION is a function of time. */
export const isMoving = (img) => img?.motion === 'bounce';

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
  width = 1920, firstInput = 1, inLabel = 'in', outLabel = 'out', phase = 0,
} = {}) {
  const list = (images ?? []).filter((i) => i?.path);
  if (!list.length) return { inputs: [], filters: [], looping: false };

  const inputs = [];
  const filters = [];
  let looping = false;
  let cur = inLabel;

  list.forEach((img, i) => {
    const idx = firstInput + i;
    // A pre-baked animation is already at its final size, angle and opacity,
    // so it needs none of the per-frame filters below — only looping.
    const baked = img.animated ? (img.baked ?? null) : null;
    if (img.animated) {
      // Loop the animation for as long as the clip runs. This makes the
      // input infinite, which is why callers bound the output — an
      // unbounded secondary input keeps ffmpeg alive after the episode
      // ends, and the clip never advances.
      // `-ignore_loop 0` is the GIF demuxer's own loop flag; a baked clip is
      // an ordinary video and loops with -stream_loop instead.
      if (baked) inputs.push('-stream_loop', '-1');
      else inputs.push('-ignore_loop', '0');
      looping = true;
    }
    inputs.push('-i', baked ?? img.path);

    // A still PNG is a single frame. overlay's repeatlast (on by default)
    // holds it for the rest of the clip, so it needs no -loop and stays a
    // finite input — one less way for the process to hang.
    const steps = ['format=rgba'];
    if (baked) {
      // Nothing to recompute: the bake already applied all of it.
      filters.push(`[${idx}:v]format=rgba[img${i}]`);
    } else {
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
    }

    const next = i === list.length - 1 ? outLabel : `ov${i}`;
    const timed = img.start != null && img.end != null
      ? enableExpr(img.start, img.end) : '';
    // eof_action=repeat holds the last overlay frame for the rest of the
    // clip. This is what makes a still PNG work without -loop: it is one
    // frame, and every frame after it reuses that one. `pass` reads like
    // the safe choice and is the opposite — it passes the main picture
    // through WITHOUT the overlay, so a logo appeared for exactly one frame
    // and then disappeared. Verified by encoding a frame and looking at it.
    /**
     * format=auto, because overlay's DEFAULT is yuv420.
     *
     * On the canvas path the main input is RGBA, so the default converts
     * the whole 1920x1080 canvas to YUV to blend and the trailing
     * format=rgba converts it back — two full-frame colourspace passes per
     * frame, for a logo that might be 300px wide. That is why the cost was
     * the same for a full-frame picture and a corner one: none of it was
     * the blend. Measured over 480 frames: 0.43s on the default against
     * 0.16s with auto, on a 0.03s baseline — 3x the overlay's own cost.
     *
     * auto rather than rgb so the CPU burn-in path, where the main input
     * really is YUV, keeps picking yuv420 exactly as before.
     */
    const at = isMoving(img)
      ? bouncePlace(img, width, phase, i)
      : place(frac(img.x, 0.5), frac(img.y, 0.5));
    filters.push(
      `[${cur}][img${i}]overlay=${at}`
      + `:eof_action=repeat:format=auto${timed}[${next}]`,
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
    /**
     * Opacity baked into the alpha channel, NOT overlay_vaapi's `alpha=`.
     *
     * `alpha=` sets VA_BLEND_GLOBAL_ALPHA, and vf_overlay_vaapi ALSO sets
     * VA_BLEND_PREMULTIPLIED_ALPHA for any overlay carrying an alpha
     * channel. An opacity below 1 was therefore the only thing in this
     * product that ever handed the driver BOTH flags at once — the single
     * difference between this graph and the two overlay_vaapi graphs the
     * iHD deployment has already proven, and what drew a magenta box around
     * a rotated picture there whenever subtitles were off.
     *
     * Scaling alpha here is also exactly what the software builder does, so
     * the two paths now agree on what opacity means.
     */
    const op = img.opacity;
    if (op != null && Number(op) < 1) {
      steps.push(`colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(op))).toFixed(3)}`);
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
    /**
     * PREMULTIPLIED, because that is what the filter promises the driver.
     *
     * vf_overlay_vaapi sets VA_BLEND_PREMULTIPLIED_ALPHA whenever the
     * overlay surface carries an alpha channel — unconditionally, and
     * without premultiplying anything itself. Uploading straight alpha
     * under that flag is a lie the driver acts on, and it acts on it by
     * unpremultiplying: every partly transparent pixel comes out too
     * bright, and `rgb/a` at a==0 is a divide by zero. A driver that
     * saturates that divide instead of clamping to nothing lands on
     * (255, ~125, 255) — which is the magenta, and which is why it appeared
     * in exactly the region a rotation leaves fully transparent.
     *
     * Measured on radeonsi against a CPU-composited reference: mean channel
     * error over the alpha 96..159 band falls from 15.0 to 3.0.
     *
     * format=rgba after it because premultiply only accepts planar input —
     * without it the uploaded surface silently becomes ARGB, not RGBA.
     *
     * This and the opacity change above must ship TOGETHER. Baking opacity
     * into alpha on its own lowers alpha and makes the unpremultiply
     * inflation worse; together they are correct.
     */
    steps.push('premultiply=inplace=1', 'format=rgba');
    steps.push('hwupload');
    filters.push(`[${idx}:v]${steps.join(',')}[img${i}]`);

    const next = i === list.length - 1 ? outLabel : `ov${i}`;
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
      + `:eof_action=repeat[${next}]`,
    );
    cur = next;
  });

  return { inputs, filters, looping };
}

/**
 * Split pictures into the ones that can be baked into a still layer and the
 * ones that cannot.
 *
 * A picture is bakeable when it looks the same on every frame of the clip:
 * no intro/outro window, not an animated GIF, and not moving. Those three
 * are the only things that make a picture's contribution a function of time
 * — the first two because its pixels change, the third because its position
 * does, which a single flattened still cannot express either.
 */
export function splitStaticImages(images) {
  const baked = [];
  const live = [];
  for (const img of (images ?? []).filter((i) => i?.path)) {
    if (img.start == null && img.end == null && !img.animated && !isMoving(img)) {
      baked.push(img);
    } else live.push(img);
  }
  return { baked, live };
}

/**
 * ffmpeg arguments that render still pictures ONCE into a transparent
 * full-canvas PNG, so the streaming graph can start from that instead of
 * compositing them 24 times a second.
 *
 * This is the whole point: a still picture's contribution to the canvas is
 * identical on every frame, so computing it per frame is pure waste.
 * Measured over 720 frames of the real canvas chain — canvas alone 1.164
 * ms/frame, canvas plus a per-frame overlay 1.434, canvas seeded with a
 * pre-rendered layer 1.169. The picture stops costing anything at all
 * rather than merely costing less, and the graph loses an input and a
 * filter with it.
 *
 * format=rgba on the colour source is load-bearing and NOT decoration:
 * lavfi's `color` defaults to an opaque format, so `black@0.0` without it
 * yields alpha 255 — a fully OPAQUE black layer that hides the entire
 * video behind the subtitles. Caught by measuring the layer's alpha plane
 * (255 against the 9.3 a correct layer gives) before this ever ran live.
 */
export function staticLayerArgs(images, { width, height, out }) {
  const chain = imageOverlayChain(images, {
    width, firstInput: 1, inLabel: 'base', outLabel: 'lay',
  });
  if (!chain.filters.length) return null;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${width}x${height},format=rgba`,
    ...chain.inputs,
    '-filter_complex',
    `[0:v]format=rgba[base];${chain.filters.join(';')};[lay]format=rgba[o]`,
    // -frames:v 1 also bounds the infinite colour source.
    '-map', '[o]', '-frames:v', '1', '-pix_fmt', 'rgba', '-update', '1', out,
  ];
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
/**
 * ffmpeg arguments that render an animated picture ONCE at its final size,
 * angle and opacity, into a lossless RGBA clip the live graph can just loop.
 *
 * A GIF's scale, rotate and opacity produce identical output on every pass of
 * the animation, and the live graph used to recompute all three on every GIF
 * frame for as long as the episode ran. Measured over a 60s window against a
 * heavily typeset subtitle track: 2.71s live, 2.01s pre-baked — a 26% saving
 * that lands exactly on what a moving STILL costs, i.e. those three filters
 * were the entire remaining GIF penalty.
 *
 * Lossless on purpose. The point is that the pixels are identical to what the
 * live path would have produced; a lossy intermediate would trade quality for
 * a saving that is already free.
 *
 * NOT `-ignore_loop 0` here: the bake wants exactly one pass of the
 * animation. The live graph loops the result instead.
 */
export function animBakeArgs(img, { width, out, maxSeconds = 20 }) {
  const steps = ['format=rgba'];
  const w = Math.max(2, Math.round((Number(img.size) || 0.2) * width));
  steps.push(`scale=${w}:-2`);
  const rot = Number(img.rotation) || 0;
  if (rot) {
    const rad = (rot * Math.PI / 180).toFixed(6);
    steps.push(`rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})`);
  }
  const op = img.opacity;
  if (op != null && Number(op) < 1) {
    steps.push(`colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(op))).toFixed(3)}`);
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-t', String(maxSeconds), '-i', img.path,
    '-vf', steps.join(','),
    // qtrle is lossless and carries alpha. The transparent corners a rotation
    // creates have to survive, or the picture composites as a black box.
    '-c:v', 'qtrle', '-pix_fmt', 'argb', '-an', '-sn', out,
  ];
}

/** Widest a picture may be before pre-baking costs more disk than it saves. */
export const BAKE_MAX_WIDTH = 800;

export function canvasImageChain(images, opts = {}) {
  const r = imageOverlayChain(images, opts);
  if (!r.filters.length) return r;
  const last = r.filters.length - 1;
  const fmt = opts.format ?? 'rgba';
  r.filters[last] = r.filters[last].replace(/\[(\w+)\]$/, `,format=${fmt}[$1]`);
  return r;
}

/**
 * A moving picture composited by the GPU from a surface uploaded ONCE.
 *
 * The bounce used to be drawn on the CPU canvas, and the canvas was the
 * cost: a 1920x1038 RGBA frame is 8 MB, and on the N100 every canvas
 * frame handed to the driver measured ~17-20 ms of the graph thread —
 * whatever was drawn on it. One bouncing logo took a 4K HDR title from
 * 1.27x to 0.83x; four of them to 0.77x. A still through overlay_vaapi
 * cost nothing measurable (1.32x), because its surface goes up once and
 * the composite pass itself is cheap. So a moving picture must become a
 * still that the GPU merely reads from a different place each frame.
 *
 * overlay_vaapi resolves its x/y once, so the motion cannot be expressed
 * there. It CAN be expressed as cropping: `crop` on a hardware frame
 * writes crop offsets into the frame's metadata (no pixels touched, no
 * copy), and the next VAAPI filter reads its input region from exactly
 * those fields. So the picture is padded, on the CPU, into a transparent
 * stage twice the frame less the picture, uploaded once and looped as
 * references; per frame a crop of frame size slides over it with the
 * bounce expression, a VAAPI scale pass renders that window into a fresh
 * frame-sized surface (a pass, never a copy through the CPU), and the
 * result composites onto the video like any still.
 *
 * The trajectory is the software builder's, term for term: with the stage
 * `iw` wide and the picture `pw`, the crop's `iw-W` IS `W-pw`, the range
 * the bounce runs over, so `x = R - abs(mod(v(t+p), 2R) - R)` places the
 * picture exactly where `overlay` would have. Two frames a second apart
 * differ; pixels match the CPU composite (measured, both drivers).
 *
 * out_range=pc on the scale is load-bearing: without any colour option
 * scale_vaapi at an identity size passes frames through untouched — crop
 * metadata included — and overlay_vaapi ignores the overlay's crop. For an
 * RGBA surface the range is a no-op, so nothing changes but the bypass.
 *
 * The pad expressions clamp so a picture wider than the frame (a large
 * rotated one) yields a stage no narrower than the frame; crop then
 * clamps its own offsets. Such a picture sits still rather than breaking
 * the graph.
 */
export function vaapiMovedImageChain(images, {
  width = 1920, height = 1080, firstInput = 1, inLabel = 'in', outLabel = 'out',
  rate = '30', phase = 0, end = null, scale = 'out_range=pc',
} = {}) {
  const list = (images ?? []).filter((i) => i?.path);
  if (!list.length) return { inputs: [], filters: [], looping: false };
  const inputs = [];
  const filters = [];
  let cur = inLabel;
  const esc = (s) => s.replace(/,/g, '\\,');
  list.forEach((img, i) => {
    const idx = firstInput + i;
    // -r gives the single frame a duration of one output frame, which is
    // what the loop below repeats it at — the layer input does the same.
    inputs.push('-r', String(rate), '-i', img.path);
    const steps = ['format=rgba'];
    const w = Math.max(2, Math.round((Number(img.size) || 0.2) * width / 2) * 2);
    steps.push(`scale=w=${w}:h=-2`);
    const rot = Number(img.rotation) || 0;
    if (rot) {
      const rad = (rot * Math.PI / 180).toFixed(6);
      steps.push(`rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})`);
    }
    const op = img.opacity;
    if (op != null && Number(op) < 1) {
      steps.push(`colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(op))).toFixed(3)}`);
    }
    // Premultiplied, for the reason vaapiImageOverlayChain gives.
    steps.push('premultiply=inplace=1', 'format=rgba');
    steps.push(esc(`pad=w=max(2*${width}-iw,${width}):h=max(2*${height}-ih,${height})`
      + `:x=max(0,${width}-iw):y=max(0,${height}-ih):color=black@0.0`));
    steps.push('hwupload', 'loop=loop=-1:size=1:start=0', `setpts=N/(${rate})/TB`);
    if (end != null && end > 0) steps.push(`trim=end=${Number(end).toFixed(3)}`);
    const v = Math.max(1, frac(img.speed, DEFAULT_SPEED) * width);   // px/second
    const p = (Number(phase) || 0) + i * 3.1;
    const u = `(${v.toFixed(3)}*(t+${p.toFixed(3)}))`;
    const rx = `max(1,iw-${width})`;
    const ry = `max(1,ih-${height})`;
    const cx = `floor(${rx}-abs(mod(${u},2*${rx})-${rx}))`;
    const cy = `floor(${ry}-abs(mod(${u},2*${ry})-${ry}))`;
    steps.push(esc(`crop=w=${width}:h=${height}:x=${cx}:y=${cy}`));
    // The colour option the device's probe found it accepts on RGBA.
    steps.push(`scale_vaapi=w=${width}:h=${height}:${scale || 'out_range=pc'}`);
    filters.push(`[${idx}:v]${steps.join(',')}[mv${i}]`);
    const next = i === list.length - 1 ? outLabel : `mo${i}`;
    filters.push(`[${cur}][mv${i}]overlay_vaapi=x=0:y=0:eof_action=repeat[${next}]`);
    cur = next;
  });
  // The loop is unbounded: the caller ends the output with the clip.
  return { inputs, filters, looping: true };
}

/** Can this picture ride the GPU-moved chain? Moving, not animated, untimed. */
export const gpuMovable = (img) => isMoving(img) && !img?.animated
  && img?.start == null && img?.end == null;
