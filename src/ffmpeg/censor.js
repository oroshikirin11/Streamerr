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
    if (w < 8 || h < 8) continue;
    // Cell size follows the frame height so the look survives a resolution
    // change: strength 5 is 40px cells at 1080p, 27px at 720p.
    const cell = Math.max(4, Math.round(b.strength * height / 135));
    placed.push({
      x0, y0, w, h,
      cw: Math.max(2, Math.round(w / cell)),
      ch: Math.max(2, Math.round(h / cell)),
    });
  }
  if (!placed.length) return `[${inLabel}]null[${outLabel}]`;

  const parts = [];
  let cur = inLabel;
  placed.forEach((p, n) => {
    const id = `${tag}${n}`;
    const out = n === placed.length - 1 ? outLabel : `${id}o`;
    const [down, up, over] = gpu
      ? [`scale_vaapi=w=${p.cw}:h=${p.ch}`, `scale_vaapi=w=${p.w}:h=${p.h}`,
        `overlay_vaapi=x=${p.x0}:y=${p.y0}`]
      : [`scale=${p.cw}:${p.ch}`, `scale=${p.w}:${p.h}`, `overlay=${p.x0}:${p.y0}`];
    parts.push(
      `[${cur}]split=2[${id}a][${id}b]`,
      `[${id}b]crop=${p.w}:${p.h}:${p.x0}:${p.y0},${down},${up}[${id}z]`,
      `[${id}a][${id}z]${over}[${out}]`,
    );
    cur = out;
  });
  return parts.join(';');
}
