# Roadmap: HDR output, and giving quality decisions back to the user

Not built. Recorded 2026-08-29 so it can be picked up later.

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

That is the theme both halves of this document serve: the engine currently
makes quality decisions on the operator's behalf, mostly to keep an Intel N100
at 1x, and those decisions are invisible and unchangeable.

## Part 1 — HDR output

Today every broadcast is SDR. HDR sources are tone mapped down before the
encoder; see `hdr-tonemapping.md`. That is the correct default (SDR is still
the standard for live streaming — Twitch has no HDR at all; YouTube Live
requires HEVC), but it is not the only thing a user might want.

### What was measured, on an RX 6900 XT (Mesa)

| | result |
|---|---|
| HEVC 10-bit (main10) encode | works |
| AV1 encode | no entrypoint — RDNA2 decodes AV1, cannot encode it |
| **H.264 10-bit** | **no usable profile** |
| 10-bit P010 kept end to end, no tone map | works |
| `overlay_vaapi` compositing onto a P010 surface | runs without error |
| BT.2020 + PQ tagging survives a re-encode | preserved |
| Mastering-display + content-light metadata | preserved |

The H.264 row is the hard constraint: the codec we stream today cannot carry
HDR at all. HDR means HEVC (or AV1, which neither host can encode).

The metadata rows are the good news — HDR10 static metadata survives a full
re-encode, so this does not require stream copy.

### The part that is NOT solved

`overlay_vaapi` composited onto an HDR surface without erroring. That proves
nothing about how it looks. Subtitles and images are authored as SDR RGBA, and
blending SDR white into a PQ surface with no conversion gives either searing or
dim text. Making that correct means converting the overlay canvas to BT.2020/PQ
at a chosen nominal luminance (~200 nits is the usual choice for subtitles)
before upload, and then LOOKING at it.

### Rough effort, cheapest first

1. **Encoder + 10-bit path + metadata** — small. Add `hevc_vaapi` main10,
   keep P010 rather than forcing NV12, skip the tone map. Largely proven above.
2. **Overlay/subtitle luminance in HDR** — moderate and fiddly. Decides whether
   it looks professional or broken.
3. **FLV tagging for Enhanced RTMP** — small, but the tee's `-tag:v 7` logic is
   H.264-specific and needs a second path.
4. **The test matrix** — the bulk of the cost. HDR x overlays x subtitles x
   pillarbox x splices x chunked path x each driver. Every driver in this
   project's history has had its own surprise.

### The gate — do this FIRST

Does the target Owncast accept HEVC over RTMP at all? Standard RTMP does not
carry HEVC; it needs the Enhanced RTMP extension. If Owncast rejects it, the
feature has no consumer and everything above is wasted work.

Cheapest genuinely useful version: **HDR over the existing SRT output to a real
player** (VLC/mpv on an HDR TV). mpegts + HEVC already works, it skips Owncast
and browsers entirely, and it would prove the whole 10-bit path end to end.
Browsers are the weakest link — HEVC playback is Safari-mostly, and HDR
rendering weaker still.

## Part 2 — quality decisions currently taken from the user

Audited 2026-08-29. Ranked by how much picture they cost.

| what | where | note |
|---|---|---|
| `-preset veryfast` | `encoders.js:160` | biggest lever on any CPU-only host. `veryfast` -> `medium` is ~20-30% bitrate efficiency |
| `-bf 0` (no B-frames) | `encoders.js` 79, 99, 119, 134, 149, 170 | 10-20% efficiency. RISKY: B-frames reorder timestamps and the splice path already fights non-monotonic DTS. Probably why it is off |
| `-rc_mode CBR` / `nal-hrd=cbr` | `encoders.js:71` and libx264 | spends as many bits on a black frame as a complex one. CBR suits fixed-bandwidth RTMP, so a real trade rather than a free win |
| `mode=fast` VPP scaler | `pipeline.js:3631` | automatic at >=1.5x downscale, so every 4K->1080p path takes the fast scaler. Small but real on grain |
| tone curve + `desat=0` | `probe.js` `CPU_TONEMAP` | HDR-only. `desat=0` suits animation more than dark live action |

Already exposed: `encoder.tonemap` (auto/vaapi/cpu/none), added 2026-08-29.

Suggested order: **encoder preset** and **scaler quality** first — high value,
low risk. Hold **B-frames** and **rate control** until a splice can be tested
with B-frames enabled, because the DTS warnings suggest that is where it bites.

## A gap, not a hidden decision

There is **no deinterlacing anywhere in the codebase** — no `yadif`, `bwdif`,
or `deinterlace_vaapi`. Any interlaced source (DVD rips, broadcast captures,
older TV anime) will comb, with no way to fix it. Worth knowing before someone
reports it as a bug.

## Design note

Whatever gets exposed, keep the demotion ladder underneath it. A forced setting
is a starting point, not a promise: hardware that cannot honour it must fall
back and say so, because dead air is worse than a substitution. A control that
offers choices the hardware cannot run is worse than no control — that mistake
was made and fixed the same day (see `86714c7`).
