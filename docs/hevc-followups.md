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

4. OPEN — PASSTHROUGH when nothing needs encoding. Operator insight: an
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
