# Roadmap: a modular quality pipeline

Not built. Recorded 2026-08-29 while the measurements are fresh, because most
of the cost here is re-learning what a driver will and will not do.

## The intent, in the author's words

> RN it streamlines for the most efficient SDR output, skipping HDR output
> outright. With a lot of performance flags hardcoded bc of the n100.
>
> On one side its good, since I now have the information on how to process and
> efficient SDR output.
>
> On the other side I really want the users to have the option to choose ...
> So I will spent some major time expanding upon the engine.
>
> Imo users should have the choice if they want to have certain performance
> flags set that potentially impact image quality or what tone mapping they use
> (if they have a choice).

> We want this engine to be as modular as possible for the most important
> settings but at the same time have a great user experience.

## What is being asked for

1. Gather every flag that can affect the picture.
2. A setting for each.
3. A single preset selector over all of them — three tiers, roughly
   efficient -> balanced -> best picture.
4. Individual override of anything the preset set.
5. A separate switch for **HDR output**, which opens the pipeline to HDR
   end-to-end when the source has it.
6. A separate choice of **tone mapping**, used when output is SDR. (Shipped
   2026-08-29 as `encoder.tonemap`.)
7. Bulletproof. Every combination tested against a real library, not synthetic
   clips.

Plus: grey out anything the host **physically cannot do**, and only that —
"unsupported by this hardware", never "we would rather you didn't".

---

## Part 1 — the audit

Everything below is currently hardcoded and can change the picture.

### Encoder flags (`src/ffmpeg/encoders.js`)

| flag | where | effect | risk if exposed |
|---|---|---|---|
| `-preset veryfast` | 160 (libx264) | **largest single lever on a CPU-only host.** `veryfast` -> `medium` is ~20-30% bitrate efficiency | none; software, always available |
| `-bf 0` | 79, 99, 119, 134, 149, 170 (all five backends) | 10-20% efficiency thrown away | **high.** B-frames reorder timestamps and the splice path already fights non-monotonic DTS. Likely why it is off |
| `-rc_mode CBR` | 71 (VAAPI) | spends as many bits on a black frame as on a complex one | moderate. CBR suits fixed-bandwidth RTMP; VBR may also upset the bank's pacing assumptions |
| `-x264-params nal-hrd=cbr` | 164 | same, software path | moderate |
| `-preset p4 -tune ll` | 111-112 (NVENC) | `ll` = low latency, explicitly trades quality. `p4` is mid-ladder of p1..p7 | low |
| `-quality balanced` | 131 (AMF) | mid of speed/balanced/quality | low |
| (no quality flag at all) | QSV | runs driver defaults | low |
| `bufsize` = 2x bitrate | 49 | VBV window; affects how hard peaks are clamped | moderate |
| 8-bit only, no profile/level control | all | locks out 10-bit even for SDR banding | tied to HDR work below |

### Filter-graph decisions (`src/ffmpeg/pipeline.js` and friends)

| decision | where | effect |
|---|---|---|
| `mode=fast` VPP scaler at >=1.5x downscale | 3631, 3710 | every 4K->1080p path takes the fast scaler. Small but real on grain |
| CPU tone curve `hable`, `desat=0` | `probe.js` `CPU_TONEMAP` | `desat=0` suits animation more than dark live action |
| **half-rate subtitle/overlay canvas** | 2475, 3931 | the RGBA canvas renders at half the frame rate unless something is bouncing. **Known to judder karaoke and `\t` animations.** Probably the most visible item in this table |
| `BAKE_MAX_WIDTH = 800` | `overlay-image.js:475` | GIF overlays wider than 800px skip pre-baking and take the per-frame path |
| `-fps_mode cfr` + `-r` | 3675, 3991, 4093, 4198 | any output rate that is not the source rate duplicates or drops frames. `fpsMode: 'auto'` is exposed; the interaction is not explained |
| subtitle canvas rendered at content rect | throughout | subtitle rendering resolution follows the video rect, not the output frame |
| pillarbox colour hardcoded black | 3768 | cosmetic |

Already exposed: `videoBitrate`, `width`/`height`, `fps`, `fpsMode`, `gopSeconds`,
`frameSize`, `hwDecode`, `chunkSeconds`, `tonemap`.

### Not image quality, but the same complaint

Audio is fixed at 160k AAC, 48kHz, **always downmixed to stereo**. A 5.1 source
loses its mix with no way to keep it.

### A gap, not a hidden decision

There is **no deinterlacing anywhere in the codebase** — no `yadif`, `bwdif`,
or `deinterlace_vaapi`. Any interlaced source (DVD rips, broadcast captures,
older TV anime) will comb, with no way to fix it.

---

## Part 2 — the preset selector

Three tiers. Wording should describe the *outcome*, not the ffmpeg concept:

- **Efficient** — for weak hosts. Today's behaviour exactly.
- **Balanced** — default.
- **Best picture** — for hosts with headroom.

Proposed mapping. Every cell is a starting point, not a promise; individual
overrides win, and anything the hardware cannot do falls back (below).

| flag | Efficient | Balanced | Best picture |
|---|---|---|---|
| libx264 preset | `veryfast` | `fast` | `medium` |
| B-frames | 0 | 2 | 3 |
| rate control | CBR | CBR | VBR with maxrate |
| VPP scaler | `mode=fast` always | `fast` only above 2x | full quality |
| subtitle canvas rate | half | half | full |
| GIF bake cap | 800px | 1200px | no cap |
| NVENC | `p4 -tune ll` | `p5` | `p6 -tune hq` |
| AMF | `speed` | `balanced` | `quality` |
| tone mapping | fastest available | auto | best available |

**The selector must show what it changed.** A preset that silently rewrites
nine fields is the same opacity problem in a nicer wrapper — the point is to
give the decisions back, so the fields it set should be visible and editable
underneath it.

---

## Part 3 — HDR output

### Measured on an RX 6900 XT (Mesa), 2026-08-29

| | result |
|---|---|
| HEVC 10-bit (main10) encode | works |
| AV1 encode | no entrypoint — RDNA2 decodes AV1, cannot encode it |
| **H.264 10-bit** | **no usable profile** |
| 10-bit P010 kept end to end, no tone map | works |
| `overlay_vaapi` compositing onto a P010 surface | runs without error |
| BT.2020 + PQ tagging survives a re-encode | preserved |
| Mastering-display + content-light metadata | preserved |

The H.264 row is the hard constraint: the codec streamed today cannot carry
HDR at all. HDR means HEVC. The metadata rows are the good news — HDR10 static
metadata survives a full re-encode, so this does not require stream copy.

### The part that is NOT solved

`overlay_vaapi` composited onto an HDR surface without erroring. **That proves
nothing about how it looks.** Subtitles and images are authored as SDR RGBA,
and blending SDR white into a PQ surface with no conversion gives either
searing or dim text. Correct means converting the overlay canvas to BT.2020/PQ
at a chosen nominal luminance (~200 nits is usual for subtitles) — and then
looking at it.

### Effort, cheapest first

1. **Encoder + 10-bit path + metadata** — small; largely proven above.
2. **Overlay/subtitle luminance in HDR** — moderate, fiddly, decides whether it
   looks professional or broken.
3. **FLV tagging for Enhanced RTMP** — small, but the tee's `-tag:v 7` logic is
   H.264-specific and needs a second path.
4. **The test matrix** — the bulk of the cost.

### The gate — do this FIRST

Does the target Owncast accept HEVC over RTMP? Standard RTMP does not carry it;
it needs the Enhanced RTMP extension. **If Owncast rejects it, the feature has
no consumer** and everything above is wasted.

Cheapest useful version: HDR over the existing **SRT** output to a real player
(VLC/mpv on an HDR TV). mpegts + HEVC already works and skips Owncast and
browsers entirely. Browsers are the weakest link — HEVC playback is
Safari-mostly, HDR rendering weaker still.

---

## Part 4 — capability gating

Grey out only what the host **physically cannot do**. A control that offers an
impossible choice is worse than no control: that exact mistake shipped and was
fixed the same day (`86714c7`), after "GPU" was offered on a Mesa box that has
no VAAPI tone-map filter, and every clip died at -22.

Needs probing, cached per process, in the shape of `probe.js`:

| capability | how to probe |
|---|---|
| VAAPI tone map | `vaapiTonemapPresent()` — already exists |
| CPU tone map | `cpuTonemapAvailable()` — already exists |
| HEVC 10-bit encode (gates HDR output) | encode one main10 frame |
| AV1 encode | encode one frame; expect "no usable encoding entrypoint" |
| B-frame support per encoder | encode with `-bf 2` and check |
| VBR rate control per driver | encode with `-rc_mode VBR` |
| OpenCL tone map | needs an explicit device (`opencl=ocl:0.0`); rusticl enumerates every GPU and ffmpeg refuses to guess |

**Probe honestly.** A synthetic probe told an N100 it could not tone map,
because the lavfi source carried no mastering-display metadata while the filter
was working perfectly — see `hdr-tonemapping.md`. When a probe cannot be
trusted, attempt the real thing and believe the failure.

---

## Part 5 — testing (the author's point 7)

Every combination, against a **real library**. Today proved synthetic clips
lie: a probe passed on a driver that fails on real files, and a filter that
"worked" produced a picture nobody had looked at.

Axes that interact:

- output: SDR / HDR
- tone map: auto / vaapi / cpu / opencl / none
- preset tier: efficient / balanced / best picture, plus overrides
- overlays: none / picture / animated GIF / moving (bounce)
- subtitles: none / embedded text / external / bitmap
- geometry: 16:9 / pillarboxed 4:3 / source frame size
- source: 8-bit H.264 / 10-bit HEVC / HDR10 / AV1
- path: direct spawn / chunked bank / splice at an overlay apply

Non-negotiables, each learned the hard way this session:

- **Encoding without error is not passing.** Check the pixels.
- **A splice is part of the test.** Several bugs only appeared at an overlay
  apply, not at clip start.
- **Test on both hosts.** Intel iHD and Mesa refuse differently, at different
  stages, and both surface as `-22` on the encoder.
- **Every forced setting must survive its own failure.** The demotion ladder
  runs underneath any user choice: fall back and warn loudly, never dead air.
- Demotion triggers should match **the argv actually spawned**, not the
  intended state — `_box` is a copy and can drift (`86714c7`).

---

## Design note

Modularity and UX pull against each other here. The resolution is that the
preset selector is the UX and the individual flags are the modularity — but the
preset must *show its work*, and every control must be honest about what this
machine can actually do.
