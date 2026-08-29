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
8. **AV1 output support.** Worth more than items 1-4 combined — see Part 7.

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

---

## Part 6 — what bitrate is actually available, and what it buys

Measured 2026-08-29. This section exists because it reframes everything above:
most of the quality levers have nothing left to win at the bitrate in use.

### The encoder is already over-provisioned at 1080p

Bitrate needed to reach CRF 20 (visually near-transparent), 10s clips:

| source | today's flags | best flags | gain |
|---|---|---|---|
| Jujutsu Kaisen (clean Bluray anime) | 2.06 Mbps | 1.96 Mbps | 5% |
| Berserk (grainy HDTV) | 4.27 Mbps | 3.78 Mbps | 11% |

The stream sends **12 Mbps**. So 1080p runs at 3-6x the bitrate it needs and is
already past transparency — the output is bounded by the SOURCE FILE, not by
the encoder. **No flag, and no extra bitrate, can improve 1080p picture
quality.** The realistic win is the other direction: 12 Mbps could drop to
about 6 with no visible loss, halving upload.

### 4K is out of reach, and not for a compute reason

What the source files themselves spend, in HEVC 10-bit:

| file | bitrate |
|---|---|
| Backrooms (WEB-DL) | 25.3 Mbps |
| Apocalypto (UHD Bluray remux) | 54.1 Mbps |

H.264 needs roughly 1.5-2x what HEVC does, so Backrooms-grade 4K over H.264
wants **~40-50 Mbps**. Against that:

- the stream sends 12 Mbps — about a quarter of it
- **the home upload is 52.75 Mbps** (916.87 down), so 40 Mbps would consume
  ~76% of the line, and it is shared with the whole household
- preset and B-frame tuning buys 5-11%, against a shortfall of ~300%

So better flags do NOT unlock 4K, and a stronger host does not either — a
stronger host merely encodes 4K without collapsing, which is not the same as
making it look right. **1080p at 12 Mbps is transparent; 4K at 12 Mbps is
starved. Same bandwidth, and the 1080p one looks better.**

### The scale of every lever, for perspective

| lever | efficiency vs H.264 today |
|---|---|
| preset + B-frames | 5-11% |
| HEVC | 30-50% |
| AV1 | ~50% |

The entire settings project is worth about a fifth of simply changing codec —
which browsers will not allow. Note AV1 has BETTER browser support than HEVC
(Chrome, Firefox, Edge all decode it), but neither host can encode it: RDNA2
and Alder Lake-N are both AV1 decode-only, and software AV1 is too slow for
live 4K.

### What this leaves worth building

1. **Bandwidth** — 1080p at ~6 Mbps instead of 12, identical picture.
2. **The bitrate-independent image faults** — half-rate subtitle canvas,
   `mode=fast` scaler, `fps_mode cfr` frame duplication, absent deinterlacing.
   These change what viewers see at ANY bitrate, and the canvas one is visible
   on the anime library today.
3. **Tone-mapping choice** — a genuine difference in look.

Not 4K, and not "better picture at 1080p", because there is none to be had.

### Measurement note

VMAF was attempted first and abandoned after five harness faults (frame
misalignment inflating 240 frames to 292, an "identical files" ceiling of
98.24 rather than 100, and the score line being logged at info level while the
harness ran at error level). Fixed-CRF bitrate comparison replaced it: it
cannot desync, though it measures efficiency rather than perceptual score. A
4K CRF spot-check was discarded as untrustworthy — it landed on dark, static
footage and reported `medium` needing MORE bitrate than `veryfast`, which is
backwards. The source-bitrate figures above are arithmetic on real file sizes
and durations, and are the numbers to trust.

---

## Part 7 — AV1, the one path that beats every flag here

Measured 2026-08-29. Neither host can encode AV1 in hardware (RDNA2 and
Alder Lake-N are both decode-only), so this is software SVT-AV1.

| | 1080p, preset 12 | 4K, preset 12 |
|---|---|---|
| desktop (7800X3D), system ffmpeg | 17.1x | — |
| desktop, container image | 14.1x | 1.49x |
| **N100 (cinema), container image** | **3.2x** | ~0.34x (extrapolated) |

Measured on `testsrc2`, which is HARDER to encode than anime, so real content
runs faster. Speed figures are wall-clock and trustworthy; bitrate figures
from the 4K clip are NOT — that sample landed on dark, static footage.

**1080p AV1 is live-capable on BOTH hosts.** 3.2x on the N100 leaves real
margin even after scaling, subtitle rendering and tone mapping take their
share. 4K AV1 is desktop-only and has no margin.

At roughly half of H.264's bitrate, this is worth more than every flag in Part
1 combined: a good 1080p stream at ~5-6 Mbps instead of 12. Against that,
preset and B-frame tuning buys 5-11%.

**Unlike HDR, the clients are ready** — Chrome, Firefox, Edge and Safari 17+
all decode AV1, which is the opposite of the HEVC situation.

### The gate

Owncast must accept AV1 over Enhanced RTMP and package it into HLS. Same gate
as HDR, and still unverified. Test that before any other work here.

### Free performance, separately

The container's SVT-AV1 is an instrumented build — it prints `SvtMalloc[info]`
lines and runs ~18% slower than the host's release build (14.1x vs 17.1x on
identical input). Worth fixing in the Dockerfile regardless of whether AV1 is
ever adopted.

---

## Part 8 — how H.264-shaped is the engine?

Only at its two ends. Checked 2026-08-29.

### Tied to H.264

| where | what |
|---|---|
| `encoders.js` | all five backends hardcode `h264_vaapi` / `h264_qsv` / `h264_nvenc` / `h264_amf` / `libx264`. The codec is part of the backend's identity, so another codec means new entries or a codec parameter |
| `publish.js:173`, `playout.js:576` | `-tag:v 7` is the FLV tag for AVC specifically. HEVC and AV1 need Enhanced RTMP fourCC tags |
| `probe.js` | the encoder probe tests H.264 encoders |
| `pipeline.js` | `format=nv12` throughout — 8 bit assumed |
| **`web/.../studio` preview** | **`mpegts.js`, which is H.264/AAC oriented.** An AV1 or HEVC broadcast would not decode in our OWN preview pane. Easy to miss until the editor goes blind |

### Codec-agnostic

The mpegts pipe between clip and publisher, the bank and chunker (they work on
packets), splice and timestamp handling, pacing, overlay compositing (it works
on frames, before the encoder), and the entire library and scheduling layer.

### What this means

The engine is not H.264-shaped — its two ENDS are. The middle, which is the
part that was expensive to get right, carries over to any codec untouched.
Adding AV1 is: new backend entries, delivery tagging, a preview that can
decode it, and the test matrix. Not a re-architecture.
