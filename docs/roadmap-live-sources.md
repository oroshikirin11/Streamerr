# Roadmap: live sources — capture, camera, mixing, triggers

**This is the next thing to build** (stated 2026-08-29), ahead of the codec and
quality work in `roadmap-hdr-output-and-quality-controls.md`.

Scope, as asked for:

1. Desktop / window capture
2. Webcam capture
3. **Mixing** those with media and overlays
4. Webhooks that trigger a GIF onto the stream

`screen-capture-viability.md` covers the browser half of (1) — `getDisplayMedia`,
the secure-context requirement, the cost of a second encoder. That note stands.
This document is about what (3) and (4) do to the engine, which is a much
bigger question than capture itself.

## The central conflict: the cushion

The engine is a **playout** system. It seeks, encodes a cushion roughly 15s
ahead of air, banks those packets, and replays them. That cushion is what makes
splices invisible, lets an overlay change land without a re-buffer, and lets a
seek be served from cache.

**Live sources cannot be banked AHEAD, because their frames do not exist yet.**

An earlier draft of this document called that an impossibility. It is not, and
the correction matters: **delay is fine.** This is a broadcast, not a video
call — Twitch runs 10-30s behind glass and nobody notices. Once latency is
acceptable the bank simply changes job:

- today it is a LOOK-AHEAD. The engine encodes faster than realtime and stays
  ~15s in front of air.
- with a live source it becomes a DELAY LINE. Composite camera + media +
  overlays, encode at 1x, hold 15s of output, then publish.

Viewers see everything in sync, just late. A webhook GIF fires now and airs 15s
later, which for a broadcast is entirely normal.

What genuinely does change:

| | consequence |
|---|---|
| compositing must move BEFORE the encoder | you cannot composite a camera onto packets already encoded into the bank. This is real and unavoidable |
| **the cushion can no longer refill** | a camera produces frames at 1x, so the engine cannot encode faster than realtime to catch up. The bank absorbs jitter but cannot recover from a gap |
| therefore splices stop being free | today a source restart hides behind the cushion, which then refills. In live mode the cushion drains and stays drained. Overlay changes want to be applied to a RUNNING graph rather than by respawning |

So it is still a **second operating mode**, but for a narrower reason than
"live cannot be buffered": it is that the cushion becomes non-renewable.

## What that means concretely

Two modes, sharing the library, overlays, scheduling and publisher:

**Playout mode** — what exists today. Files, deep cushion, splices hidden,
cheap. Correct for an unattended channel.

**Live mode** — capture and camera composited before the encoder, output held
as a delay line. The cushion can stay deep (delay is acceptable); it just
cannot refill after a gap. Everything is per-frame, so it costs far more.
Correct for an attended stream.

Cushion depth is already a setting (`BANK_SECONDS`, default 15, exposed in
Settings) and does not need to change for live mode — only what fills it does.
That suggests the two modes are much less far apart than they look, PROVIDED
compositing moves before the encoder for both.

Consequences worth knowing before starting:

- **Overlay motion must stay closed-form.** Bounce is computed from media
  timestamps precisely so a replayed packet always produces the same frame. In
  live mode there is no replay, so the constraint relaxes — but the same code
  has to serve both, so do not break it.
- **Splices lose their cover.** Not because the cushion is shallow — it can
  stay 15s — but because once drained it cannot refill at 1x. Live mode wants
  to avoid restarts entirely, which means overlay changes must be applied to a
  running graph rather than by respawning. A genuinely different design, and
  the main piece of real work here.
- **Two decodes plus a composite plus an encode.** The N100 will not do this;
  it is already at 0.83x on Apocalypto alone. Live mode is desktop-class
  hardware only, and should say so rather than fail.

## The main piece of work pays for itself

Applying overlay changes to a **running** filter graph, instead of respawning
the source, is the hardest item here and the one live mode forces. It is worth
noticing that it is not purely a cost — **playout mode wants it too.**

Every overlay apply today restarts ffmpeg at a seek offset. That restart is
what produces, in real broadcast logs:

    Packet corrupt (stream = 0, dts = 5955368), dropping it.
    DTS 5950080 < 5951614 out of order
    Non-monotonic DTS; previous: 66133, current: 66091; changing to 66133
    timestamp discontinuity (stream id=257): 12832001, new offset= -12832001

plus the partial-packet trimming the splice path has to do, and the
`_srcGen` / packet-realignment machinery that exists solely because a source
can be replaced mid-stream. None of that is needed by a graph that never
restarts.

So the ledger is better than it looks:

| | today | with a running graph |
|---|---|---|
| overlay apply | respawn, splice, cushion covers it | filter update, no splice |
| DTS discontinuities at apply | routine | gone |
| cushion after an apply | drained, refills at >1x | untouched |
| live sources | impossible (cushion cannot refill) | works |

It is the expensive item, but it removes a class of bug that has cost real
debugging time, and it is the thing that makes live sources possible at all.
Worth doing early rather than last.

## Ingest

Browser to box, for both capture and camera:

- **WebRTC / WHIP** — the right answer for live. Low latency, handles
  congestion, browser-native. More to implement.
- **MediaRecorder over WebSocket** — simpler, but chunked WebM with the
  browser's own keyframe placement, and latency that grows under load.

Either way the box re-encodes: the browser's resolution, frame rate and
keyframe placement will not match the publisher's. That is the second encoder
`screen-capture-viability.md` warns about.

`getDisplayMedia()` and `getUserMedia()` both need a **secure context**. They
do not work on `http://192.168.178.186:8099`, which is the address normally
used. Solve that first — everything else is downstream.

## Webhook triggers

Small in itself: an authenticated endpoint that pushes an overlay onto the
active composite for N seconds. The hard parts are the cushion (above) and:

- **Authentication.** A public webhook that draws on the broadcast is an open
  door. Tokens, per-trigger, revocable.
- **Rate limiting.** Someone will hold the button down.
- **A fixed catalogue.** Triggers should select from GIFs the operator has
  already added, never accept a URL — otherwise it is arbitrary remote content
  on the stream.

## The goal, as stated

> We just want the mightyness of OBS step by step in a nice web format + our
> media streaming support we already have.

Incremental. Each piece should be usable on its own — a webcam that works
alone is worth shipping before mixing exists.

## Cheaper alternative, still true

OBS already does capture, camera, scenes and compositing well, and can push
into the box's RTMP input. If the goal is to have the feature rather than to
own it, that is days of work saved. The counter-argument is that "an OBS
replacement" is the point of the product.

## Suggested order

1. Secure context (HTTPS on the LAN address, or accept it is remote-only).
2. Webcam ingest alone, no mixing — proves the ingest path and the second
   encoder on real hardware.
3. Measure. Decide whether live mode is desktop-only.
4. Compositing before the encoder, shared by both modes.
5. Live mode: cushion as a delay line, no respawn on overlay change.
6. Webhook triggers last — they are cheap once (5) exists, and pointless
   before it.

---

## Phase 1 feasibility — settled by experiment, 2026-08-29

**It works, but NOT by sending commands to a running filter graph.** That
approach is dead:

| filter | runtime-changeable options |
|---|---|
| `overlay` (CPU) | `x`, `y` only |
| **`overlay_vaapi`** — the path we actually use | **none** |
| `subtitles` | none |
| `scale_vaapi` | none |

ffmpeg exposes runtime commands (via `zmq`, which IS built in) only for options
flagged `T`. On the GPU path there are none at all, so opacity, size, rotation,
swapping a subtitle file and adding or removing an overlay are all impossible
that way. An input cannot be added to a running graph either — the input count
is fixed when the graph is built.

### What does work: the overlay layer as a piped RGBA stream

Keep the main graph FIXED and change only the pixels flowing into it:

    [media]  ─────────────────────┐
                                  ├─ overlay_vaapi → encode → publish
    [RGBA frames on a pipe] ──────┘

The renderer that fills the pipe is ours, and it can be restarted freely.
Verified end to end:

- renderer v1 (red) ran, was killed at 3s, replaced by v2 (blue)
- sampled output: `f70000` at t=1s, `0000ff` at t=6s
- the encoder produced all 8s **in one process** and never restarted

**The load-bearing detail:** a wrapper must hold the write end of the pipe open
across renderer restarts. If it closes, ffmpeg sees EOF on that input and
`eof_action=repeat` freezes the last frame forever — a later restart's frames
are never read. In the test a subshell held the fifo across both renderer
processes, which is the pattern to copy.

### Why this is the right shape anyway

The renderer is the thing that later takes a camera and a desktop capture as
extra inputs. Building it for Phase 1 IS the compositor Phase 6 needs — which
is exactly the sequencing intent.

### Effort

Moderate, and mostly rearrangement rather than new invention:

- the renderer is largely the EXISTING subtitle/image graph, redirected to
  `-f rawvideo -pix_fmt rgba` on a pipe instead of being fused into the main
  graph
- the main graph gets simpler, because its shape stops varying with overlays
- "apply" changes from respawning the source to respawning the renderer
- the splice machinery stays for CLIP changes and seeks — Phase 1 only removes
  restarts for OVERLAY changes, which is the complaint

### Risks to measure before committing

- **Pipe bandwidth.** Full-frame RGBA at 1080p24 is ~199 MB/s of memcpy. The
  desktop will not care; the N100 might. Mitigations already in the codebase:
  render at the content rect rather than the output frame, and the existing
  half-rate canvas.
- **Framesync stalls.** If the renderer is slower than realtime the main graph
  waits on it. Needs a policy — drop late overlay frames rather than block.
- **Renderer startup latency** becomes visible as a stale overlay for a few
  frames after each apply, instead of a splice.

---

## Phase 1 implementation notes — 2026-08-30

Shipped. What the build taught beyond the feasibility experiment:

- **The fifo must be bounded on the reader side.** The holder keeps it from
  EOFing (that is its job), but a held-open silent pipe leaves ffmpeg's input
  thread blocked in read() at end of clip and the process NEVER exits —
  measured: a 10s clip encoded 9.96s and sat until killed. The writer cannot
  signal the end either: once the reader stops consuming, the renderer blocks
  on the full fifo and never reaches its own cap. So the reader carries
  `-t duration+2`; eof_action=repeat covers the margin. This is also why the
  pipe requires a KNOWN clip duration (planOverlayPipe refuses without one).
- **The continuation clock counts delivered frames, not consumed ones.** The
  main process reads the pipe ahead of the composite, so an Apply lands a
  little past the click point on the media timeline — equivalent to the old
  "end of buffer" semantics, and alignment stays exact because the count is
  the clock.
- **Nothing Apply can change may affect pipe geometry**, so pipe mode pins:
  full content-rect canvas, full frame rate, no band, no baked layer. The
  half-rate and band optimisations are the price of never restarting.
- Pillarboxed clips WITHOUT subtitles keep the classic path: barsGraph is
  only probed when subtitles exist, and unprobed composite shapes are how
  this project earned its -22 scars.
- Chunked clips keep the classic path: many parallel encoders cannot share
  one fifo.

## Phase 1, round two — the VFR canvas (2026-08-30)

The N100 falsified the first design within minutes: full-rect rawvideo at a
pinned rate cost it 30% on plain playback (Mr. Robot 1.03x -> 0.62x). The
operator's bar: idle cost = pre-pipe exactly, applies never cut the stream,
no visual compromises, no restarts. The answer was to stop shipping frames
that didn't change:

- the canvas travels as **rawvideo-in-NUT**, timestamped and self-describing;
- the renderer runs at full rate and **mpdecimate=max=12** forwards a frame
  only when the picture changed, with one forced through every half second
  (the heartbeat that bounds framesync's pairing wait — pipeline latency the
  bank absorbs, never throughput);
- **timestamps are the continuation clock**: a replacement renderer stamps
  clip-relative pts from the encode head and the stream just continues. The
  byte-counting clock, the frame padding and the geometry pinning of rates
  all died — NUT's framing makes a SIGKILLed writer cost one 'damaged' log
  line and zero video frames (measured);
- rate is no longer format, so the stepped-motion compromise is gone too:
  a static canvas costs ~2 small uploads/s, a bouncing logo passes its real
  frames at full rate.

Measured: a static subtitle canvas keeps 19 of 240 frames; the e2e crossed
100MB where full-rate would be 884MB. A static picture overlay now costs
LESS than the inline path ever did (which paid a full-rate canvas for any
picture). The remaining standing cost is the composite pass itself on
otherwise-clean clips — the price of applies being free there.
