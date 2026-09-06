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

## What the numbers say

- The GPU composite pass is free. A still picture through `overlay_vaapi`
  runs at the bare speed. The tone map costs ~0.03x.
- Every canvas frame handed to the driver costs the graph thread about
  17-20 ms — 8 MB of RGBA per upload on iHD — whatever is drawn on it. At
  24 fps that is 21 ms per video frame on top of the ~33 ms the VDBOX needs
  for a 4K decode plus a 1080p VDENC encode, which is exactly 0.77x. The CPU
  as a whole is idle; the one thread that submits GPU work is what stalls.
- PGS pays for the 4K `sub2video` frame as well: ffmpeg re-sends it on every
  packet read from the file, the gate lets twelve a second through, and each
  is scaled from 3840x2160 before the canvas can be uploaded (~50 ms per
  canvas frame including the upload).

## The rules built on it (this commit; N100 numbers after deploy pending)

1. **Moving pictures never touch the canvas.** Each is padded once onto a
   transparent stage twice the frame, uploaded once, and looped as
   references; per frame a `crop` (metadata only on hardware frames) slides
   the bounce expression over it, `scale_vaapi=…:out_range=pc` renders that
   window (the range option defeats the identity passthrough that would
   have handed the crop to a filter that ignores it), and `overlay_vaapi`
   composites it like a still. Probed at go-live (`vaapiMoveHonored`: crop
   honoured, alpha kept, edge on the pixel), demoted by doing
   (`noGpuMove`). Local proof: positions match the canvas path within
   encoder noise (no localised difference > 1500 px against 32000 for a
   misplaced picture).
2. **A canvas that only changes with a cue uploads only then.** Built as
   `yuva444p` and gated with `mpdecimate=hi=0:lo=0:frac=1` (exact: drops a
   frame only when all four planes are identical), converted to RGBA for the
   frames that pass. Against the RGBA canvas the YUV round trip measured at
   most one code value on 5% of painted pixels. A canvas that changes every
   frame (animated caption, GIF, a mover the driver would not crop) stays
   RGBA without the gate.
3. **Bitmap subtitles come from a sidecar.** PGS/DVD tracks are extracted
   like text tracks into a Matroska file holding only the track and a
   16x16 heartbeat video at 4 fps (12 fps for DVD subs, which end by
   duration); the GPU graphs open it as their own input, ungated, so a cue
   change lands on its own frame and the 4K scale is paid a few times a
   second instead of twelve. The software chain keeps reading the media
   file.
4. The CPU composite (frame down, draw, frame up) moves 6 MB per frame and
   is opt-in only: `encoder.subComposite: 'cpu'`.

## What to expect

Per the model, Backrooms with four bouncers should land near the bare 1.27x
(four free composite passes and no uploads), Backrooms with SRT near 1.2x,
Ghost in the Shell with PGS near 1.15x. Verify with seek-pinned runs at
600 s; the sustained bank is the number that matters.
