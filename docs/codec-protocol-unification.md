# Codec-aware destinations — switch-resistant by design

The rule the operator set: changing the output codec must never lose a
destination's configuration. The mechanism: configs persist per
protocol; the CODEC selects which one is active.

1. The primary already stores creds per protocol (publish.rtmp / .srt
   slots). Selection becomes codec-aware: h264 uses publish.protocol as
   the operator chose it; hevc/av1 use the SRT slot (the only transport
   deployed receivers accept for them). Nothing is written, only chosen.
2. Extras keep their single protocol each. At start, extras whose
   protocol cannot carry the codec SIT OUT with a warn line naming them
   ("skipping 'VPS - Streamingestarr' — rtmp cannot carry HEVC"), and
   rejoin automatically when the codec returns to h264. Configs never
   change.
3. The start refusal remains only for a PRIMARY that cannot carry the
   codec and has no configured SRT slot to fall back to — with the
   sentence naming the fix.
4. UI: the codec dropdown notes which destinations would sit out at the
   current selection, live, so surprises happen in Settings rather than
   at the start button.

Implementation order: destinations(publish, codec) selects/filters and
returns skipped[] for logging; engine passes profile.codec; the start
route replaces the blanket non-h264/rtmp refusal with primary-only
refusal + skip warnings; Settings shows the sit-out preview.
