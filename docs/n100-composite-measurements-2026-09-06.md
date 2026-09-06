# Where the frame time goes on the N100 — measured 6 Sep 2026

Seek-pinned runs (position 600 s, 90 s window, speed = engine position over
wall time) against the deployed build, Studio with the four bouncing pictures
of the cinema config, HEVC VDENC 16000k, HDR output on.

| case | speed | source ffmpeg CPU (of one core) |
|---|---|---|
| Backrooms (4K DV HDR 25 Mbps) bare SDR: decode, scale, tone map, encode | **1.27x** | 20% |
| Backrooms hdrPass (no tone map, main10) | 1.30x | 8% |
| Backrooms + one still picture (overlay_vaapi, no canvas) | **1.32x** | 16% |
| Backrooms + English SRT (half-rate RGBA canvas) | 0.99x | 20% |
| Backrooms + one bouncing picture (full-rate canvas) | 0.83x | 36% |
| Backrooms + four bouncing pictures | **0.77x** | 33% |
| Backrooms + four bouncers + SRT | 0.78x | 44% |
| Ghost in the Shell (4K HDR 40 Mbps, TrueHD) bare SDR | 1.23x | 22% |
| Ghost in the Shell + English PGS (half-rate canvas) | **0.70x** | 48% |
| Ghost in the Shell + PGS + four bouncers | 0.52x | 59% |

## After the first deploy (same day, same method)

| case | before | after | note |
|---|---|---|---|
| Backrooms + one still at size 1.0 (full-frame overlay surface) | — | 1.165x | composite area costs ~3 ms/frame, not the 20 ms a canvas frame costs |
| Backrooms + English SRT, canvas gated by exact duplicate drop | 0.99x | 0.957x | the gate bought nothing: the cost is producing the canvas, not uploading it |
| Backrooms + four bouncers (driver refused the move probe → canvas) | 0.77x | 0.76x | unchanged, as expected |
| Ghost in the Shell + PGS from the sidecar (gated canvas) | 0.70x | 0.83x | source ffmpeg at 80% of a core; steps 0.66-1.11 |
| Ghost in the Shell + PGS + four bouncers (gated canvas) | 0.52x | 0.28x, stalled | a sparse canvas stalls the video: frame sync holds the main until the next canvas frame's pts is known |
| Mr. Robot S1E1 + subs (series control, band applied) | ~1.03x | 1.39x | no regression |
| Backrooms + four bouncers, CPU composite (opt-in) | 0.77x | 0.547x | the frame down and up costs more than the canvas on iHD |
| Backrooms + English SRT, CPU composite (opt-in) | 0.99x | 0.533x | same |

## What the numbers say

- The GPU composite pass is cheap and scales only mildly with the overlay's
  area: a small still is free, a full-frame surface costs ~3 ms/frame.
- Producing a canvas frame is the cost — filling it, drawing onto it,
  handing it over — roughly 10 ms per canvas frame on the graph thread,
  whatever is on it. The exact duplicate gate did not help, because
  frames are still produced (frame sync pulls the canvas ahead until the
  next kept frame) and, worse, the gap between kept frames stalls the
  video for its whole length. The gate and the 4:4:4 canvas were removed
  again the same evening.
- PGS pays for the 4K `sub2video` frame as well: ffmpeg re-sends it on every
  packet read from the file, the gate lets twelve a second through, and each
  is scaled from 3840x2160 before the canvas can be uploaded.

## The rules that stand (second commit; N100 numbers pending)

1. **Bitmap subtitles come from a sidecar and go up directly.** PGS/DVD
   tracks are extracted, like text tracks, into a Matroska file holding only
   the track and a 16x16 heartbeat video (4 fps for PGS, 12 for DVD subs);
   the GPU graphs open it as their own input, and when nothing else is drawn
   the scaled subtitle frame IS the composite's overlay — no generated canvas,
   no CPU blend, frames at the heartbeat rate. Cue timing measured 1.084 s
   for a 1.000 s cue against 1.251 s from the media file.
2. **One or two moving pictures never touch the canvas** on a driver that
   passes the move probe (upload once, crop per frame, VAAPI window pass,
   composite like a still). Three or more stay on the canvas: each moved
   picture is two full-frame passes, and eight passes cost more than the one
   canvas they replace. The N100's iHD refused the first form of the window
   pass; the probe now tries four forms and logs what each one did.
3. The CPU composite (frame down, draw, frame up) is opt-in only:
   `encoder.subComposite: 'cpu'`.
## What to expect

Ghost in the Shell with PGS: the 4K scale and upload four times a second
plus a ~3 ms composite, so near 1.1x. Backrooms with SRT: unchanged (its
cues are top-aligned, so the band does not apply and the canvas is
full-height). Backrooms with four bouncers on this driver: unchanged at
~0.77x — the full-rate canvas is the floor of this graph on this box until
the window pass is accepted, and even then only for one or two pictures.
