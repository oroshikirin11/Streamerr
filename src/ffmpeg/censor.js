/**
 * Censor boxes — a rectangle of the picture blurred out on the encoder's
 * own scaler.
 *
 * The blur is a shrink and a blow-up: the region is cropped, scaled down to
 * a few dozen pixels and scaled back to size, then laid over its own origin.
 * The scaler's interpolation does the smearing, so the result is a soft
 * mosaic that hides detail and cannot be undone by a viewer.
 *
 * Why not boxblur: it has no VAAPI form, and a CPU round trip would cost a
 * download and an upload of the whole frame per box, which is the entire
 * budget. This form costs one crop (metadata only on hardware frames) and
 * two tiny scales per box on frames that are already on the GPU — the same
 * class as a text caption, and unlike a caption it needs no canvas upload
 * and no CPU raster at all. The CPU chains get the same shape with the
 * software scaler, where the crop is cheap for the same reason.
 *
 * Coordinates are the panel's: centre x/y and width/height as fractions of
 * the OUTPUT frame. A graph that has not padded yet is still looking at the
 * bare content rect, so it passes that rect as `stage` and the boxes are
 * shifted by its origin and clipped to it.
 */
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
// Chroma is subsampled, so every crop edge and overlay origin must be even.
const even = (v) => Math.round(v / 2) * 2;

/** The enabled censor boxes of an overlay list, fields clamped and typed. */
export function censorBoxes(items) {
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.type === 'censor' && i.enabled !== false)
    .map((i) => ({
      x: clamp01(i.x), y: clamp01(i.y), w: clamp01(i.w), h: clamp01(i.h),
      strength: Math.min(10, Math.max(1, Math.round(Number(i.strength) || 5))),
    }))
    .filter((b) => b.w > 0 && b.h > 0);
}

/**
 * Hardware scalers have limits a software one does not: a smallest surface
 * they will produce (16x16 on Intel's video processor) and a largest ratio
 * per pass. A 500px box shrunk to 7 pixels in one step was answered with
 * -22 on the N100. So the shrink is a ladder — no pass steeper than 4x,
 * nothing smaller than 16 a side — and the blow-up walks the same rungs
 * back. That also averages properly at each rung where a single steep
 * pass would point-sample, so the mosaic is cleaner as well as legal.
 */
const MIN_SIDE = 16;
const MAX_STEP = 4;

/** The output sizes of every scale pass, from the crop down and back up. */
export function scaleLadder(w, h, cw, ch) {
  const steps = (from, to) => Math.ceil(Math.log(from / to) / Math.log(MAX_STEP) - 1e-9);
  const n = Math.max(1, steps(w, cw), steps(h, ch));
  const down = [];
  for (let k = 1; k <= n; k++) {
    down.push([
      Math.max(cw, even(w * Math.pow(cw / w, k / n))),
      Math.max(ch, even(h * Math.pow(ch / h, k / n))),
    ]);
  }
  return [...down, ...down.slice(0, -1).reverse(), [w, h]];
}

/**
 * A filter_complex fragment taking `inLabel` to `outLabel`, one blurred
 * box after another. Boxes that fall entirely off the stage are dropped;
 * with none left the fragment is a bare `null` so the labels still join.
 */
export function censorStage(boxes, {
  width, height, stage = null, inLabel, outLabel, gpu = true, tag = 'cz',
}) {
  const ox = stage?.x ?? 0;
  const oy = stage?.y ?? 0;
  const sw = stage?.w ?? width;
  const sh = stage?.h ?? height;
  const placed = [];
  for (const b of boxes) {
    const x0 = even(Math.max(0, (b.x - b.w / 2) * width - ox));
    const y0 = even(Math.max(0, (b.y - b.h / 2) * height - oy));
    const x1 = even(Math.min(sw, (b.x + b.w / 2) * width - ox));
    const y1 = even(Math.min(sh, (b.y + b.h / 2) * height - oy));
    const w = x1 - x0;
    const h = y1 - y0;
    // Smaller than the smallest surface: nothing a scaler can do, and
    // nothing worth hiding.
    if (w < MIN_SIDE || h < MIN_SIDE) continue;
    // Cell size follows the frame height so the look survives a resolution
    // change: strength 5 is 40px cells at 1080p, 27px at 720p. Small boxes
    // get coarser cells than asked rather than a surface under 16 a side.
    const cell = Math.max(4, Math.round(b.strength * height / 135));
    const cw = Math.min(w, Math.max(MIN_SIDE, even(w / cell)));
    const ch = Math.min(h, Math.max(MIN_SIDE, even(h / cell)));
    if (cw >= w && ch >= h) continue;
    placed.push({ x0, y0, w, h, ladder: scaleLadder(w, h, cw, ch) });
  }
  if (!placed.length) return `[${inLabel}]null[${outLabel}]`;

  const parts = [];
  let cur = inLabel;
  placed.forEach((p, n) => {
    const id = `${tag}${n}`;
    const out = n === placed.length - 1 ? outLabel : `${id}o`;
    const scales = p.ladder.map(([sw2, sh2]) => (gpu
      ? `scale_vaapi=w=${sw2}:h=${sh2}` : `scale=${sw2}:${sh2}`)).join(',');
    const over = gpu ? `overlay_vaapi=x=${p.x0}:y=${p.y0}` : `overlay=${p.x0}:${p.y0}`;
    parts.push(
      `[${cur}]split=2[${id}a][${id}b]`,
      `[${id}b]crop=${p.w}:${p.h}:${p.x0}:${p.y0},${scales}[${id}z]`,
      `[${id}a][${id}z]${over}[${out}]`,
    );
    cur = out;
  });
  return parts.join(';');
}
