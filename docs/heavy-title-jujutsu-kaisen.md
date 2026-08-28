# Why Jujutsu Kaisen runs at the edge

Measured on S01E01 (Kaizoku 1080p v2), because it performs far worse than
other anime and it was not obvious why. Short version: **nothing in our graph
is wasteful — the file is simply heavier at the source, in two ways at once.**

## What the file is

| | |
|---|---|
| video | **AV1, 10-bit** (`yuv420p10le`), 1920x1080, 24000/1001 |
| subtitles | ASS, 1020 events, **473 of them signs** and 88 karaoke |
| fonts | 24 embedded attachments |

Every other title in the library is 8-bit h264 or h265. This is the only AV1
one, and the only one whose dialogue track also carries the full typesetting.

## The subtitle band cannot apply, and that is correct

The band shrinks the subtitle canvas to a bottom strip. It refuses here with
`alignment 8 without \pos`, and it is right to:

- inline overrides across the file: `\an5` x109, `\an7` x50, `\an8` x32,
  `\an4` x17, `\an1` x16
- rendering every frame of the episode and taking the union of all
  non-transparent pixels gives an ink bounding box of **x 0..1919, y 0..1079**

The ink covers 100% of the frame. There is no smaller canvas — not a bottom
band, not a generalised bounding box. Forcing one would clip signs off the
broadcast. **Do not revisit this.**

## Where the time actually goes

Canvas cost, 180s at half rate (2158 frames), measured on a desktop — use the
ratios, not the absolute numbers:

| | ms/frame |
|---|---|
| canvas alone, no subtitles | 0.02 |
| full Kaizoku track | **1.29** |
| dialogue only (signs and karaoke stripped) | 0.49 |
| dialogue only on a 1920x420 band | 0.23 |

So the typesetting costs 2.6x what the dialogue does. Unavoidable: it is what
the media contains.

Decode, same 60s of content, hardware decode both times:

| | |
|---|---|
| AV1 10-bit (this file) | 20.9x realtime |
| the same content as 8-bit h264 | 33.0x realtime |

**AV1 10-bit costs 1.6x more than h264 for identical pictures.** On an N100
that multiplier is the difference between comfortable and marginal.

## Things that were tried and do NOT help

Measured, all within noise of each other (~20.9x):

- `scale_vaapi=format=nv12` instead of `scale_vaapi=w=1920:h=1080:format=nv12`
  — the redundant width and height cost nothing
- `-extra_hw_frames 24` instead of 8 — no effect
- no filter at all — **21.0x**, i.e. the decode IS the ceiling and the entire
  filter chain costs about half a percent

There is no waste to remove in the graph.

## Why the chunked path is not the answer

`_chunkWorkers()` returns 1 whenever the GPU composite is available, so this
clip runs single-process. That looks like the thing to change, and it is not:
the chunked path is the CPU path, so it would software-decode 10-bit AV1 on
four N100 cores. Far worse than the GPU being merely marginal.

## What is actually left

The one lever with evidence behind it is **output resolution**. The operator
already observed that 720p made Apocalypto "work way better", and the same
applies here. It costs nothing at the source — it changes what we encode, not
the media — which is the constraint that rules out re-transcoding.

That wants to be a per-title setting rather than a global one, since it should
apply to the two or three heavy titles and nothing else.

## Known related defect

The half-rate canvas assumes a subtitle's appearance does not change between
frames. That holds for plain dialogue and is false for karaoke and `\t`
animations, of which this file has 88 lines. So the optimisation is silently
juddering animated typesetting. Fixing it means detecting animated tags and
keeping full rate for those scripts, which would make this title slower, not
faster — a correctness/performance trade to decide deliberately.
