#!/bin/bash
# Bitmap subtitles from the sidecar: the rig with the synthetic PGS fixture.
# Judged like pics.sh, plus a look at the pixels: the block a cue draws has
# to be in the captured output where the stream put it, and gone between
# cues. Waits for pics.sh to finish (one port, one capture.ts).
cd "$(dirname "$0")"
true
row() {
  local envs="$1" label="$2" tag="$3"
  rm -f capture.ts
  env ALLLOG=1 $envs node run.mjs > last.log 2>&1
  cp last.log "pgs-$tag.log"
  local r; r=$(python3 analyze.py capture.ts 2>/dev/null)
  local vb; vb=$(echo "$r" | grep -c "backward: none")
  local vh; vh=$(echo "$r" | grep -c "holes>150ms: none")
  local de; de=$(echo "$r" | sed -n 's/^    decode errors: //p')
  local mism; mism=$(python3 cmp.py last.log | sed -n 's/.*-> \([0-9]*\) mismatch.*/\1/p')
  local sidecar; sidecar=$(grep -c "\.mks" last.log)
  local extracted; extracted=$(grep -c "\[subs\] extracted" last.log)
  local warns; warns=$(grep -c "warn:" last.log)
  local fatal; fatal=$(grep -c "FATAL" last.log)
  printf "  %-30s video:%-4s dec-err:%-3s splice!=spawn:%-3s sidecar-spawns:%s extracted:%s warns:%s fatal:%s\n" \
    "$label" "$([ "$vb$vh" = "11" ] && echo OK || echo BAD)" "$de" "$mism" "$sidecar" "$extracted" "$warns" "$fatal"
}
echo "== PGS from the sidecar =="
rm -f cache/*.mks
row "MODE=pgs SUBS=1 SEQ=stop@30"                          "cold: extract then play" cold
# pixels: cue 1 (1.0-3.5s) bottom-left block, cue 2 (5.0-7.5s) top, gap at 4s
python3 pgs-check.py capture.ts
row "MODE=pgs SUBS=1 SEQ=seek:60@18,skip@21,stop@45"       "warm: seek then skip" seekskip
row "MODE=pgs SUBS=1 PICS=2 SEQ=pause@18,resume@24,stop@45" "PGS + 2 movers: pause/resume" movers
row "MODE=pgs SEQ=subs-on@18,seek:30@26,stop@45"           "subs on mid-play, then seek" switch
row "MODE=pgs SUBS=1 TITLE=1 SEQ=skip@18,stop@42"           "PGS + caption (canvas, media-fed): skip" caption
echo "done"
