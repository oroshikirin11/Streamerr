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

The cushion depth is already a setting (`BANK_SECONDS`, default 15, exposed in
Settings). Live mode is close to "cushion = minimum, compose every frame" —
which suggests the modes are less far apart than they look, PROVIDED the
compositing moves before the encoder for both.

Consequences worth knowing before starting:

- **Overlay motion must stay closed-form.** Bounce is computed from media
  timestamps precisely so a replayed packet always produces the same frame. In
  live mode there is no replay, so the constraint relaxes — but the same code
  has to serve both, so do not break it.
- **Splices lose their cover.** Today a source restart hides behind the
  cushion. At 1-2s it will be visible. Live mode probably wants to avoid
  restarts entirely, which means overlay changes must be applied to a running
  graph rather than by respawning — a genuinely different design.
- **Two decodes plus a composite plus an encode.** The N100 will not do this;
  it is already at 0.83x on Apocalypto alone. Live mode is desktop-class
  hardware only, and should say so rather than fail.

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
5. Live mode with a shrunk cushion.
6. Webhook triggers last — they are cheap once (5) exists, and pointless
   before it.
