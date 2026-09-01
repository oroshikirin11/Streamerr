# Screen capture — viability note

Can Streamerr capture part of the operator's desktop (or a single
application window) in the browser and put it on the broadcast?

**Short answer: yes, and the browser half is easy. The work is the ingest path
and a second encoder.** Not started — this is a note, not a plan.

## How it would work

1. The Studio calls `navigator.mediaDevices.getDisplayMedia()`. The browser
   shows its own picker: whole screen, a window, or a tab. Capture runs on the
   operator's machine, not on the server.
2. The captured stream goes to the box, either as WebM chunks over a WebSocket
   (`MediaRecorder`) or as WebRTC/WHIP ingest.
3. The box re-encodes it to the pipeline's H.264 parameters and hands it to the
   publisher.

## Three things that decide the effort

### 1. It needs a secure context

`getDisplayMedia()` is only available on HTTPS or `localhost`. It works on
`https://stream.livinginasimulation.de`, and it does **not** work on
`http://192.168.178.186:8099` — a plain-HTTP LAN address is not a secure
context, so the button would be dead on the address the operator normally
uses. Solve this first; everything else is downstream of it.

### 2. It costs a second encoder

The browser hands over VP8, VP9 or H.264 with its own resolution, frame rate
and keyframe placement. None of that matches what the publisher sends, so the
box has to re-encode — a whole extra encode beside the one already running.
The N100 has little headroom left: Apocalypto already runs at 0.83x realtime.
Measure before promising it.

### 3. It is a different kind of source

The engine is a playout system. It seeks, encodes a cushion ahead of air, and
splices on packet boundaries. A live capture can do none of those: it cannot
be seeked and cannot be banked ahead, because the frames do not exist yet.

So it does not belong in the queue beside episodes. It wants to be a **live
source mode** that takes over the publisher directly — closer to "go live from
a camera" than to anything the pipeline does today. Trying to make it behave
like a queued episode is the expensive way to build it.

## Cheaper alternatives

- Point OBS at the box's RTMP input. No new code, and OBS already does capture,
  scenes and encoding well.
- Capture to a file and queue it, if it does not need to be live.
