# HEVC follow-ups (operator-raised, 30 Aug 2026 night)

1. DONE — DTS console spam: the mpegts copy path's duplicate-DTS pairs are
   corrected by ffmpeg (one 90kHz tick) and the once-a-second warning is
   now dropped from the log relay.

2. DONE — N100 HEVC cost, two levers:
   - VDENC: the start-route probe now tries hevc_vaapi with -low_power 1
     first; where the driver has the fixed-function encoder (iHD on
     Alder Lake-N should) it is used and a log line says so. Probed by
     doing — an AMD box fails the low-power probe and takes the normal
     path (verified locally). H.264 is untouched.
   - Per-codec bitrate: videoBitrate stays the H.264 anchor; HEVC derives
     2/3 of it and AV1 half (codecBitrate in encoders.js), with optional
     hevcBitrate/av1Bitrate overrides editable next to the codec choice.
     Fewer bits is also cheaper to encode.

3. DONE — UI unification: the codec choice sits in the Broadcast card;
   picking HEVC/AV1 marks the SRT slot "in use", warns if it is empty,
   lists which extras sit out, and offers the codec's bitrate override.
   Saving the card carries codec + overrides; per-key merge keeps the
   encoder card's fields intact.

4. DONE — PASSTHROUGH (HEVC): buildSourceArgs grows a copy branch —
   codec=hevc + HEVC-native file + nothing to draw (no subtitle, empty
   studio, no pipe) ships the video stream untouched. Verified live over
   SRT: source process at ~3% CPU, capture decoded pixel-identical to
   the source (200-frame framemd5), copy->copy clip seams, seek respawns
   stay copy, an Apply arms the piped transcode via the cushion-kept
   splice, removal rides the pipe (passthrough resumes at the next
   clip/seek — a restart just to regain copy would violate live mode).
   The bank re-sizes per clip from the file's measured bitrate so a
   dense file cannot silently shrink the 15s cushion. H.264 never takes
   this path (tuned default stays untouched). test/passthrough.test.mjs
   pins eligibility both ways.

5. DONE (2026-08-31) — AV1 rides a NUT internal transport. mpegts cannot
   carry AV1 (its own demuxer reads it back as bin_data), so when
   codec=av1 every feeder — sources, hold cards, countdowns — emits NUT
   and the publisher demuxes NUT. The bank splices on NUT syncpoints
   (the same 8-byte startcode the overlay feed scans for) instead of the
   188-byte TS grid; each source's 25-byte fileid magic is stripped
   (legal only at byte 0) and its header block captured so publisher
   restarts can prepend it (mid-stream duplicate headers are legal —
   measured). Torn mid-frame splices resync at the next syncpoint at the
   cost of at most one glitched frame (measured). The flv codec tags are
   scrubbed for AV1 (matroska rejects them — the tag:a 10 crash). Panel
   preview is off for AV1 broadcasts (mpegts.js cannot decode it) with a
   one-time warn. SVT forces a single chunk worker — it threads itself.
   Live-verified: broadcast, seek splice, overlay apply (logo visually
   confirmed in the SRT capture), clip seam, pause/hold card/resume,
   zero decode errors in captures. TS paths for h264/hevc byte-identical.

   Previously: AV1 through the engine is blocked by TRANSPORT, not encoders:
   the source->bank->publisher hop is MPEG-TS, and ffmpeg's mpegts
   muxer writes AV1 its own demuxer reads back as bin_data (measured).
   The publisher then maps audio only and dies on the matroska header.
   Go-live now refuses AV1 with this reason. Lifting it means moving
   the internal transport (or a TS-compatible AV1 mapping), which
   collides with the 188-byte splice/GOP-trim machinery — its own
   work package.

Old text of item 4 for reference:
4. WAS-OPEN — PASSTHROUGH when nothing needs encoding. Operator insight: an
   HEVC-native file, codec=hevc, empty studio, no subtitles selected,
   identity geometry -> the transcode is pure waste; -c:v copy ships
   the source stream untouched (audio still conforms). Zero encode cost,
   perfect quality. Needs: the copy graph branch, keyframe-aligned seek
   semantics (copy can only cut on IDR), source-GOP segment boundaries at
   the receiver, VBR spikes tolerated by pacing and by the bank's
   bitrate-based sizing, and honest ineligibility the moment anything
   must be drawn (an Apply arms a transcode via the cushion-kept respawn
   — the same arming pattern the pipe uses). Same exclusion applies to
   h264-native files under codec=h264 — it was never codec-specific.
   Sized as its own work package; do not bolt onto the encode path.
