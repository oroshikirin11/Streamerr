# Screen capture — design and what was built

Brainstormed and built 2026-09-07. Supersedes the "viability" note and
narrows `roadmap-live-sources.md` to the first deliverable: **pick a
screen, and it airs.** Camera, mixing and webhook triggers stay on the
roadmap; the pieces here are shaped so they slot in later.

Two rules set by Alex during the build, and they shape everything:

- **A screen share is its own broadcast.** It is never queued behind media,
  never scheduled, and never runs beside it. Going live with a screen starts
  a broadcast whose only item is the screen; the broadcast ends when the
  share does. While media is on air, the Capture page says so and offers
  Stop.
- **Nothing held back is the default.** The publisher connects on the
  first bytes. Holding 2/5/15 s at the box (never deeper than the bank) is a
  setting for anyone who wants slack against hiccups. The UI never says "no
  delay": viewers always wait about a second on the box plus the receiver's
  segments.

---

## 1. What a share is to the engine

A queue item of a third source kind, `live`, next to `clip` and `hold`:

```
{ id: 'capture:<session>', live: true, title, duration: null, delaySeconds, onEnd, holdMinutes }
  + a non-enumerable `feed` (the bytes) and `session`
```

`_play` hands it to `_playLive` (pipeline.js). Everything downstream —
publisher, bank, splice mechanics, Studio overlays, hold card, receiver
metadata, preview — is the code every clip uses. What differs:

| a file | a screen |
|---|---|
| has a duration; the seek bar works | open-ended; the bar shows elapsed time, seek and ±30 s are disabled, `seek()` is a no-op |
| the encoder runs ahead of air and fills the cushion | frames exist only at 1×; the bank holds whatever `delaySeconds` says, filled once at the start (the publisher is gated until then, `_pubGate`, opened in `_bankPush`) |
| a respawn re-reads the file from an offset | a respawn re-attaches the feed: an Apply continues from the oldest unsent keyframe (≤ 2 s lost, nothing torn); a resume after Pause starts **fresh** (what happened behind the card never airs) |
| `tooslow` at < 0.95× | `< 0.9×` sustained, with wording for a live source; the watchdog gives a silent live source 10 s, not 5 |
| a clip end advances the queue | EOF on stdin is the share ending: the queue is empty, so the broadcast ends — or, with `onEnd: 'hold'`, a "Back in a moment" card holds for `holdMinutes` and then ends |

The roadmap called live sources "a second operating mode". For a share
alone it is not. The mode question only returns with **mixing** (camera over
media), which the two rules above put out of scope.

## 2. From the browser to ffmpeg

```
browser tab                                   box (Node)                      ffmpeg source
getDisplayMedia ─► MediaRecorder ─► ws /ws/capture ─► CaptureFeed ─► stdin ─► copy | decode/composite/encode ─► bank ─► publisher
  H.264+Opus in WebM where Chrome        (webm.js scans it: init segment,
  offers it, keyframe every 2 s          clusters, keyframes; ring buffer;
                                          re-heads clusters for a new reader)
```

- **Transport**: MediaRecorder over the panel's own WebSocket. WebRTC was
  rejected (a media server for latency nobody asked for). The recorder asks
  for `video/webm;codecs=h264,opus` first, then Matroska/avc1, then VP9, VP8.
- **`src/ffmpeg/webm.js`** — a streaming EBML scanner: keeps the EBML header,
  Info and Tracks as an init segment, reports clusters and blocks with their
  timecodes and keyframe flags. Unknown-size Segment/Cluster handled (Chrome
  and Firefox write them).
- **`src/ffmpeg/capture-feed.js`** — the ring between socket and ffmpeg.
  `attach(w, {fresh, maxBacklogSeconds})` starts a reader on a keyframe (the
  oldest unsent, or the newest when fresh or when the backlog is stale) and
  re-heads every cluster with a rebased timecode, patching block offsets, so
  a reader always sees a stream that starts at zero and stays continuous
  across anything the feed dropped. Over budget (80 MB), the oldest unsent
  clusters go; the next write starts on a keyframe and the seam closes.
  Backpressure never reaches the sender.
- **`buildLiveArgs`** (pipeline.js): `-c:v copy` when `livePassthroughEligible`
  — H.264 in, H.264 out, nothing drawn, keyframes ≤ `copyMaxGopSeconds` as
  measured by the feed — otherwise `buildSourceArgs` with `srcPath: 'pipe:0'`
  and `LIVE_INPUT_ARGS` (a 0.5 s probe window, `+genpts`; never `+nobuffer`, which discards the probe window's packets). The Studio
  canvas, GPU decode and the demotion ladder are the same code paths.
- **`src/capture.js`** — `CaptureSession`: one at a time, `armed → live →
  ended`; builds the item and a synthetic track selection (geometry from
  the WebM's own Tracks element, frame rate from the sender); `parseHello`
  and `sanitizeCapture` bound every field.
- **Wire**: `hello` (JSON) then WebM bytes; `health` every second; `end`.
  The server answers `state` on every change and `error` before closing.

## 3. The secure address

`getDisplayMedia` exists only on https or localhost. **`src/tls.js`**
generates a self-signed certificate with `openssl` (SANs: hostname,
localhost, every IPv4; regenerated when the box's addresses change or the
certificate nears expiry) and the service listens on a second port (default
8443) with the same app and the same WebSocket upgrade handler.
`server.tls: { enabled, port }`; `GET/POST /api/tls`, `GET /api/tls/cert`
to download the PEM for trusting it. Never through the public VPS proxy: a
capture routed there leaves the LAN over the home upload and comes back.

The Capture page never shows a dead button: on an insecure origin it shows
one card — *Screen sharing needs a secure address* — with a one-click
*Turn on secure address* and the https link.

## 4. Server surface

| | |
|---|---|
| `GET /api/capture` | settings, the session (state, sender, geometry, codec, health, feed stats), TLS status, and `blocked` — why Go live would be refused, in words |
| `PUT /api/capture` | title |
| `POST /api/capture/go` | starts the broadcast with the armed share as its only item; 409 while anything else is on air |
| `POST /api/capture/stop` | ends the share from any panel; the sender's socket closes and the browser stops capturing |
| `WS /ws/capture` | the sender; same origin and session checks as the preview socket; one sender at a time (the second is told who holds it) |
| `GET/POST /api/tls`, `GET /api/tls/cert` | the secure address |
| `config.capture` | `delaySeconds` (0), `passthrough` (true), `quality`, `fps`, `audio`, `onEnd` ('end' \| 'hold'), `holdMinutes` — sanitised on save |
| `streamStatus()` | carries `capture` and `playing.live`; a light `capture` WS message carries the health tick |

The broadcast ending (natural, fatal, crashed) ends a live session, so the
browser stops capturing when the operator presses Stop in the transport
bar.

## 5. Browser side

`web/src/lib/capture.svelte.js` — a module store, so the picked stream,
recorder and socket survive navigation (the operator walks to the Studio
and back). Picker: monitors first, the Streamerr tab excluded, surface
switching on, at the screen's own size by default (`resolution: 'match'`
shrinks it to the broadcast frame in the browser instead). Two fallbacks learned from the end-to-end test: when the
browser cannot start the audio side, the share is retried without audio and
says so; when it cannot start a monitor capture at all, the surface hint is
dropped. Audio: what the picker gives · microphone · both (mixed in an
AudioContext) · none — with the platform truth stated on the page (Linux
and macOS share audio for tabs only; the "Monitor of …" device is the way
to send system sound). Health goes to the server every second.

Pages: `/capture` (states: insecure address · idle · picked · live · shared
from another browser · unsupported browser), the transport bar (LIVE pill,
elapsed time, health chip, seek and track switching disabled), a sidebar
chip visible from every page, and Settings › System › *Secure address* and
*Screen sharing*.

## 6. Tests

- `test/capture-feed.test.mjs` — the scanner and feed against real
  live-shaped WebM/Matroska from ffmpeg (VP9, VP8, H.264): every frame
  reproduced; a reader attached mid-stream starts on a keyframe at zero and
  loses at most one GOP; fresh attach airs only the newest GOP; over-budget
  drops keep timestamps monotonic and the stream decodable; a drop while a
  reader is attached is a cut, not a gap.
- `test/live-source.test.mjs` — `buildLiveArgs` (copy vs transcode, the
  input flags, never a seek), `livePassthroughEligible`, the engine with a
  fake feed (kind `live`, stdin pipe, the publisher gate, fresh after pause,
  seek as no-op, a dead feed advancing).
- `npm run test:capture` — `test/e2e-capture.mjs`: the real service on
  throwaway ports (TLS on, a TCP sink standing in for the ingest), a
  headless Chrome driven over DevTools (it captures a tab of its own, cut
  off from the desktop session so no real picker can pop up), and then
  ffprobe on what the ingest received. Verified on 2026-09-07: pick → armed
  → go live → H.264 copied untouched → Studio caption applied (transcode
  respawn, stream continues) → pause/resume → caption hidden (copy again)
  → stop ends the broadcast; 1138 frames of h264+aac at the ingest, zero
  decoder warnings, first bytes at the ingest **4.8 s** after Go live in
  no-delay mode.

## 7. Measured, and what it means

- **No-delay latency, Streamerr's share: 1.1 s** from Go live to the first
  bytes at the ingest (was 4.3–4.8 s). The difference was `-fflags
  +nobuffer` on the live source: it discards the packets read while
  probing, which on a copied stream is the whole first GOP, so video began
  two seconds after audio and the publisher had to probe past a second
  keyframe. With the flag gone the source probes 0.5 s and the publisher
  1 s (`JSR_LIVE_SRC_PROBE_US` / `JSR_LIVE_PUB_PROBE_US` exist for
  measuring, never for production). Everything past the ingest — the
  receiver's segmenting and the viewer's player buffer — is the receiver's
  to shorten.
- **Resolution**: the screen is sent at its own size by default
  (`capture.resolution: 'native'`); 'match' shrinks it to the broadcast
  frame in the browser. 1:1 on air needs the copy path (Chrome/Edge H.264,
  nothing drawn); a transcode still lands in the broadcast frame.
- **Bitrate**: presets are per 1080p30 and scaled by the surface's area
  (a 5120×1440 monitor gets ~3.5× the budget), capped at 80 Mb/s; `max`
  is 30 Mb/s at 1080p. Chrome honours `videoBitsPerSecond`; Firefox
  records VP8/VP9 and is transcoded regardless.
- **Passthrough**: Chrome sends `video/webm;codecs=h264,opus`; the box
  copies the video and conforms the audio to AAC. Encode cost zero.
- **Apply cost**: the feed continues from the oldest unsent keyframe; with
  the recorder's 2 s keyframes an Apply loses up to 2 s of screen and
  nothing is torn. Phase-3 WebCodecs (keyframe on demand) would make it
  zero — not built.
- **Audio on Linux**: a real microphone opened by the browser cut local
  playback on the operator's A50 (cause not found; PipeWire alone did
  not); the output's "Monitor of …" device works and carries the sound.
  The *What I hear* mode picks it automatically.
- **Frame pacing**: tab capture in Chrome delivered a steady 30 fps in the
  test. A static monitor share may deliver fewer frames; the transcode path
  duplicates to CFR, the copy path ships what arrives.
- **N100**: not yet measured. With Studio movers the canvas graph runs
  ~0.8× there on 4K titles; a 1080p30 share is lighter, but under 1.0× a
  live source drains its delay and stalls. The passthrough path costs
  nothing.

## 8. Not built (kept from the brainstorm)

Recording to disk, a preflight speed check, RTMP-in as a sibling live kind,
region crop, cursor toggle, the WebCodecs sender, webcam, mixing. Queueing
and scheduling a share were designed and then removed by rule.
