# HEVC follow-ups (operator-raised, 30 Aug 2026 night)

1. N100 HEVC cost — try VDENC. hevc_vaapi on iHD supports -low_power 1
   (the fixed-function VDENC block, far cheaper than EU-based encode).
   Probe-by-doing at the codec guard; if the 1-frame probe passes with
   low_power, use it. Also: HEVC needs ~2/3 the bitrate of h264 for the
   same quality — a PER-CODEC videoBitrate (h264: 12000k, hevc: 8000k)
   belongs next to the codec setting.

2. PASSTHROUGH when nothing needs encoding. Operator insight: an
   HEVC-native file, codec=hevc, empty studio, no subtitles selected,
   identity geometry -> the transcode is pure waste; -c:v copy ships
   the source stream untouched (audio still conforms). Zero encode cost,
   perfect quality. Needs: the copy graph branch, keyframe-aligned seek
   semantics (copy can only cut on IDR), bitrate spikes tolerated by
   pacing, and honest ineligibility the moment anything must be drawn
   (an Apply arms a transcode via the cushion-kept respawn — the same
   arming pattern the pipe uses). Same exclusion applies to h264-native
   files under codec=h264 — this was never codec-specific.

3. UI unification: the codec choice moves INTO the connection settings
   card; protocol per destination becomes a display of what the codec
   selected (rtmp for h264, srt otherwise) with both slots editable.
   The backend already selects codec-aware (ad65474); this is
   presentation.
