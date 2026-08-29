# HDR tone mapping, per driver

Measured, not inferred. 4K HDR10 (bt2020/smpte2084, 10-bit) to 1080p SDR,
5-second clip, h264 out.

## What each driver can do

| driver | `tonemap_vaapi` | note |
|---|---|---|
| Intel iHD (N100) | yes | fixed-function, needs the FILE to carry mastering-display metadata |
| Mesa radeonsi (RX 6900 XT) | no | the VPP filter is absent from Mesa's VAAPI |

Both refuse differently, and both surface as `-22` on the ENCODER, several
stages downstream of the cause:

    Mesa   VAAPI driver doesn't support HDR       (capability query)
    iHD    No mastering display data from input   (per frame)

"Mesa cannot tone map" would be wrong. Mesa's VAAPI lacks this one filter;
the same GPU tone maps through other APIs.

## Alternatives on the RX 6900 XT

| path | speed | verdict |
|---|---|---|
| no tone mapping | 6.1x | wrong colours; the last resort |
| CPU `zscale`+`hable` | 4.1x | what we use |
| `tonemap_opencl` (rusticl) | 2.8x | works, but two host transfers make it slower than the CPU |
| `libplacebo` (Vulkan) | — | broken in this ffmpeg build; fails on 8-bit SDR too, so not a driver issue |

OpenCL needs an explicit device (`opencl=ocl:0.0`) — rusticl enumerates the
dGPU and the iGPU, and ffmpeg refuses to guess.

## Why the engine does not rely on any of this

Three drivers, three refusals, at three different stages. A probe that gets
two of them right is still guessing at the third. So the graph is attempted
and a failure is believed: `vaapi -> cpu -> none`, demoted on the first clip
that cannot produce a block. See the tonemap demotion in `pipeline.js`.

The only thing still probed is whether the VAAPI filter exists at all, which
spares Mesa one dead spawn per broadcast.

## Cost

The CPU route runs after the GPU scale, so it maps at output size. At a
1080p output frame that is cheap. With `frameSize: source` a 4K HDR title
maps at 4K and costs roughly four times as much — on a weak box that is the
difference between holding 1x and not.
