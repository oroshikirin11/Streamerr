#!/bin/bash
# Rows with bouncing pictures on the GPU-moved chain (and its canvas
# fallback), judged exactly as battery.sh judges: analyze.py on the bytes
# the sink received, cmp.py on the engine's log. One row at a time.
cd "$(dirname "$0")"
row() {
  local envs="$1" label="$2" tag="$3"
  rm -f capture.ts
  env ALLLOG=1 $envs node run.mjs > last.log 2>&1
  cp last.log "pics-$tag.log"
  local r; r=$(python3 analyze.py capture.ts 2>/dev/null)
  local vb; vb=$(echo "$r" | grep -c "backward: none")
  local vh; vh=$(echo "$r" | grep -c "holes>150ms: none")
  local seams; seams=$(echo "$r" | sed -n 's/.*audio seams>5ms: //p')
  local worst=0
  [ "$seams" != "none" ] && worst=$(echo "$seams" | grep -o '\-\?[0-9]\+\.[0-9]' | tr -d - | sort -n | tail -1)
  local drift; drift=$(echo "$r" | sed -n 's/.*audio drift: \([-+0-9]*ms\).*/\1/p')
  local torn; torn=$(echo "$r" | sed -n 's/.*torn packet junctions: \([0-9]*\).*/\1/p')
  local dup; dup=$(echo "$r" | sed -n 's/.*duplicate video PTS: .*(n=\([0-9]*\)).*/\1/p')
  local de; de=$(echo "$r" | sed -n 's/^    decode errors: //p')
  local mism; mism=$(python3 cmp.py last.log | sed -n 's/.*-> \([0-9]*\) mismatch.*/\1/p')
  local refused; refused=$(grep -c "SKIP REFUSED" last.log)
  local moved; moved=$(grep -c "crop=w=1280:h=720:x=floor" last.log)
  local gated; gated=$(grep -c "mpdecimate=hi=0" last.log)
  local warns; warns=$(grep -c "warn:" last.log)
  local fatal; fatal=$(grep -c "FATAL" last.log)
  printf "  %-34s video:%-4s torn:%-3s dup:%-3s dec-err:%-3s seam:%-8s drift:%-8s splice!=spawn:%-3s refused:%s gpu-moved-spawns:%s gated-spawns:%s warns:%s fatal:%s\n" \
    "$label" "$([ "$vb$vh" = "11" ] && echo OK || echo BAD)" "$torn" "$dup" "$de" "${worst}ms" "$drift" \
    "$mism" "$refused" "$moved" "$gated" "$warns" "$fatal"
}
echo "== BOUNCING PICTURES on the GPU (transcode) =="
row "MODE=hevc SUBS=1 PICS=2 SEQ=seek:60@18,skip@21,stop@45"                 "subs+2 movers: seek then skip" seekskip
row "MODE=hevc SUBS=1 PICS=2 SEQ=pause@18,resume@24,stop@45"                 "subs+2 movers: pause/resume" pause
row "MODE=hevc PICS=2 SEQ=subs-on@18,subs-off@26,stop@45"                    "2 movers: subs on then off" subs
row "MODE=hevc QLEN=8 SUBS=1 PICS=2 SEQ=skip@16,seek:200@17,pause@18,skip@19,resume@20,stop@48" "subs+2 movers: chaos" chaos
row "MODE=pass PICS=2 SEQ=skip@18,skip@21,stop@45"                           "hevc source + 2 movers: two skips" passskips
echo "== canvas fallback (GPUMOVE=0) =="
row "MODE=hevc SUBS=1 PICS=2 GPUMOVE=0 SEQ=skip@18,stop@42"                  "subs+2 movers on canvas: skip" fallback
echo "== subtitles alone (gated canvas) =="
row "MODE=hevc SUBS=1 SEQ=seek:60@18,skip@21,stop@45"                        "subs: seek then skip" subsonly
echo "done"
