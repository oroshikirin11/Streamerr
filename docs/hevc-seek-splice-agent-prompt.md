# Agent prompt — fix the HEVC seek-splice corruption

> **STATUS 2026-08-31: FIXED sender-side, verified on the local rig; N100
> re-verification after the next rebuild.** Two causes, two fixes:
> (1) FATAL mode — a copy-mode `-ss` starts VIDEO at whatever keyframe the
> matroska cue table picks (measured up to a full GOP early, with an
> arbitrary per-file threshold; exact-keyframe requests are pathological)
> while AUDIO is trimmed to the request. The per-stream discontinuity
> handlers then split by that gap and flip-flop per packet (reproduced:
> 350+ rebase lines/seek). No single-input flag fixes it (-noaccurate_seek,
> first_pts, exact-kf requests, output -ss all measured failing). Fix: the
> engine probes the true landing with the real `-ss` (one ~150ms ffmpeg
> run, `_probeCopyLanding`) and opens the file twice — video with the
> original -ss plus `-itsoffset` folding the gap, audio seeking straight
> to the landing. Measured: A/V skew 26-62ms across four seeks (was: the
> whole seek delta), discontinuity lines 380+/seek -> 0-1.
> (2) TRANSIENT mode — every HEVC respawn seam cut the old PES mid-frame
> with fresh continuity counters; "Packet corrupt ... dropping it" at each
> splice. Fix: `+initial_discontinuity` on every HEVC source spawn (the
> chunk files' proven remedy). Corrupt drops now zero; applies to
> transcode seams too (the JJK/H265 sighting). H.264 argv byte-identical
> (goldens). Residual: brief RASL artifacts at seek landings on open-GOP
> files, bounded by one GOP — normal random-access behaviour.
> The `_box`/0.27x secondary observation was the 3x bitrate ceiling, since
> replaced by the absolute `copyLimitKbps` (commit 6092b70).
>
> **Round 2 (same night):** the operator verified sender-side clean but
> viewers still saw heavy banding — the panel preview (software decode,
> concealing) was fine while Chrome's HARDWARE decoder behind the
> receiver was not. Cause: a copy->copy splice opens the new stream on a
> CRA, and a CRA mid-stream does not reset a decoder — stale DPB + POC
> collisions smear until an IDR the file may never contain. Fix: mid-clip
> copy respawns now RECONNECT the session (the _reshape machinery), so
> the receiver re-inits and hardware decoders start from scratch; an
> IDR-led transcode respawn never needs this. Plus reshape robustness
> learned live: receivers hold the dying session until their idle timeout
> and refuse the replacement — a fast publisher death inside a 30s
> reconnect window now knocks again every 3s at the ORIGINAL offset
> instead of tripping the hard-fail heuristic. Verified: seek -> one
> reshape cycle, lands on target, repeatable, broadcast never dies.
>
> **Round 3 — the actual ending (loopback experiment, operator was right
> that it was not the network):** reconnect-on-seek was WRONG twice over.
> The real receiver holds its dying session and refused every knock for
> 30s+ (broadcast death), and — measured on the receiver's own segments —
> every fresh session's FIRST segment enters mid-GOP at the receiver (RPS/
> POC errors; its transmuxer misses the stream head), so each reconnect
> painted garbage exactly when viewers were watching. That is why HDR-on
> (passthrough, reconnecting seeks) artifacted while HDR-off (transcode,
> no reconnect) was clean. Fix: NO reconnect — the decoder reset travels
> in-band as an injected end-of-sequence NAL at every HEVC seam
> (hevcEosPacket: hand-built 188-byte TS packet, PES stamped with the
> seam's timeline pts — a pts-less PES kills the muxer, measured). The
> next stream's CRA then legally begins a new coded sequence and every
> decoder flushes. Verified through the local receiver: two seeks, one
> session, sender running, ZERO decode errors in every post-seek segment.
> Remaining (receiver-side, Streamingestarr): session-start segment 0
> enters mid-GOP — cosmetic for true starts, gone from seeks entirely.

Copy everything below the line into the agent working on Streamerr.

---

## Mission

Every **seek on an HEVC broadcast** corrupts the stream at the splice seam.
Find and fix the splice damage so that seeking on HEVC (passthrough *and*
transcode) is as clean as it is on H.264. Repo: `~/IdeaProjects/Streamerr`.

## Evidence (measured 2026-08-31, live N100 → VPS Streamingestarr)

Reproduced on demand, twice. On every HEVC seek the **publisher** logs, at the
exact seam:

```
[in#0/mpegts @ …] Packet corrupt (stream = 0, dts = 16873110), dropping it.
[vist#0:0/hevc @ …] timestamp discontinuity (stream id=256): -1985700, new offset= 1985700
```

Two observed failure modes downstream:

1. **Transient** — a horizontal rainbow-macroblock band at the viewer for a
   few seconds (the dropped packet's slice data, propagating through P/B
   frames until the next IDR), then recovery.
2. **Fatal** — the receiving ingest ffmpeg (Streamingestarr, VPS) ends up with
   audio/video DTS baselines split by **exactly the seek delta** (seek jumped
   +361 s → video +360.97 s vs audio, in µs in the logs). Its discontinuity
   handler then flip-flops the global offset on *every* packet
   (`timestamp discontinuity (stream id=256): +360977266 …` / `(id=257):
   -360977267 …`, alternating, hundreds/min) and every emitted HLS segment is
   scrambled green garbage until the **broadcast** is restarted. A receiver
   restart alone does not help; a clean broadcast restart fixes it instantly.

Control: clean starts are 100% stable — 4K HDR HEVC passthrough at ~23 Mbps
ran at 1.01x with zero errors end to end (verified in Chrome via MSE). So the
damage is introduced **only at the seek splice**, sender-side.

Secondary observation, seen once: a seek respawn printed `[passthrough]` but
then measurably ran a 4K→1080p tonemap **transcode at 0.27x** (stream stalled).
That smells like the known `_box` shallow-copy bug (ROADMAP.md, "Engine —
known outstanding": profile rebuilt from a stale copy on later clips). Check
whether the seek respawn can lose `hdrOut`/passthrough eligibility this way;
fix or file it separately if it's out of scope.

## Where to look

The bank's splice / GOP-trim machinery (`src/ffmpeg/pipeline.js`) cuts the
old stream and joins the new spawn's TS at 188-byte packet boundaries and
trims to a GOP head. That machinery was built and tuned on **H.264**. Likely
suspect: NAL parsing at the trim —

- H.264 NAL header is 1 byte, `type = byte & 0x1F`, IDR = 5, AUD = 9.
- HEVC NAL header is **2 bytes**, `type = (byte >> 1) & 0x3F`, IDR = 19/20
  (IDR_W_RADL/IDR_N_LP), CRA = 21, AUD = 35, and parameter sets are
  VPS/SPS/PPS = 32/33/34.

An H.264-shaped trim on HEVC cuts mid-access-unit → the corrupt packet the
publisher drops → the timestamp rebase → mode (b) when audio and video get
rebased differently. Note the AV1 path just moved to NUT syncpoint splicing
(commit `cc0953a`) — that transport rework is adjacent code; do not regress
it, and it may be a useful reference for how a codec-aware splice was done.

## Repro / verification loop (all self-drivable)

The N100 test box runs with auth disabled — drive it directly, no password:

- Start: `POST http://192.168.1.20:8099/api/stream/start`
  `{"itemIds":["bfd24e0f~534f7ac264c62476907b865073c69b71"]}` = Backrooms,
  4K DV/HDR10+ HEVC WEB-DL ~25 Mbps, no subtitles → HEVC passthrough.
  (Ensure `encoder.codec=hevc`; `encoder.hdrOutput=true` for the HDR path.)
- Seek: `POST /api/stream/seek {"position":600}` — this is the trigger.
- Sender log: `GET /api/debug/log?after=<id>` — the bug is the
  `Packet corrupt … dropping it` line at the seam. **The fix is proven when
  repeated seeks produce zero corrupt-packet drops and zero discontinuity
  rebases in the publisher.**
- On-air proof: capture `ws://192.168.1.20:8099/ws/preview` (binary frames
  → concat → .ts) across a seek, then `ffmpeg -v error -i cap.ts -f null -`
  must be silent after the join point, and audio/video first/last DTS must
  stay aligned (`ffprobe -show_packets`).
- Receiver proof (needs the user or an authed session): Streamingestarr admin
  logs at ingest.example.com must show no
  `timestamp discontinuity` spam after seeks.
- Also cover: HEVC *transcode* seeks (enable a subtitle so the clip encodes),
  seek during passthrough→transcode transitions (Apply), and confirm H.264
  seek behaviour is byte-for-byte unchanged — H.264 is the tuned default path
  and must not be touched behaviourally.

Measurement discipline from earlier sessions: never compare speeds across
different positions — pin A/B tests with `/api/stream/seek` to the same
window. Deploy loop: the user pushes to Gitea and rebuilds the container;
for quick iterations rsync the working tree into the box's checkout
(exclude `.git node_modules config config.json cache overlays Streamerr`)
and `docker compose up -d --build streamerr` from the compose dir.

## Constraints

- Keep the engine invariants: the 15 s cushion promise, splice-at-packet
  discipline, publisher pacing, and the demotion ladder.
- No H.264 behaviour change. No AV1/NUT regression.
- Add a regression test at the level the repo already tests (argv-golden /
  splice fixtures) so this can't silently return.
