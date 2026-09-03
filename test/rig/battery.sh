#!/bin/bash
# The splice batteries, one place. `./battery.sh [section ...]`; no args = all.
# Every row is one engine run against the TCP sink, judged by analyze.py on
# the bytes the sink received and by cmp.py on the engine's own log.
#
# NEVER run two rows at once: one port, one capture.ts. Concurrent runs
# produce phantom BAD rows (seen).
cd "$(dirname "$0")"
row() {
  local envs="$1" label="$2"
  rm -f capture.ts
  env ALLLOG=1 $envs node run.mjs > last.log 2>&1
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
  local skips; skips=$(grep -c "cushion cut" last.log)
  local refused; refused=$(grep -c "SKIP REFUSED" last.log)
  local guard; guard=$(grep -c "distrusting" last.log)
  local empty; empty=$(grep -c "bank=-1.00s" last.log)
  # Seams the audio close reported closing, and any it gave up on.
  local closed; closed=$(grep -cE "\[splice\] audio (hole|overlap)" last.log)
  local unclosed; unclosed=$(grep -cE "no successor audio|produced no audio" last.log)
  printf "  %-28s video:%-4s torn:%-3s dup:%-3s dec-err:%-3s seam:%-8s drift:%-8s closed:%s%s splice!=spawn:%-3s skips:%s%s guard:%s empty-bank:%s\n" \
    "$label" "$([ "$vb$vh" = "11" ] && echo OK || echo BAD)" "$torn" "$dup" "$de" "${worst}ms" "$drift" \
    "$closed" "$([ "$unclosed" != 0 ] && echo "(-$unclosed)")" "$mism" \
    "$skips" "$([ "$refused" != 0 ] && echo "(+$refused refused)")" "$guard" "$empty"
}
want() { [ $# -eq 0 ] || [[ " $* " == *" $1 "* ]]; }
sections=("$@")
sec() { [ ${#sections[@]} -eq 0 ] || [[ " ${sections[*]} " == *" $1 "* ]]; }

sec pass && {
echo "== PASSTHROUGH (run-ahead on) =="
row "MODE=pass RUNAHEAD=1 SEQ=stop@40"                                  "idle"
row "MODE=pass RUNAHEAD=1 SEQ=skip@20,stop@45"                          "skip"
row "MODE=pass RUNAHEAD=1 SEQ=seek:60@20,stop@45"                       "seek"
row "MODE=pass RUNAHEAD=1 SEQ=pause@20,resume@26,stop@48"               "pause/resume"
row "MODE=pass RUNAHEAD=1 SUBS=0 SEQ=subs-on@20,stop@45"                "subs None->on"
row "MODE=pass RUNAHEAD=1 SUBS=1 SEQ=skip@20,stop@45"                   "subs-on THEN skip"
}
sec edges && {
echo "== EDGE CASES (provoked) =="
row "MODE=pass RUNAHEAD=1 SEQ=seek:95@20,stop@50"                       "natural advance (seek to end)"
row "MODE=pass RUNAHEAD=1 SEQ=skip@20,skip@24,skip@28,stop@52"          "rapid triple skip"
row "MODE=pass RUNAHEAD=1 SEQ=subs-on@20,subs-off@26,subs-on@32,stop@56" "subtitle thrash"
row "MODE=pass RUNAHEAD=1 SEQ=pause@20,pause@22,resume@28,resume@30,stop@50" "double pause/resume"
row "MODE=pass RUNAHEAD=1 SEQ=seek:60@18,seek:20@21,seek:75@24,seek:30@27,stop@52" "seek storm"
}
sec nohead && {
echo "== NO RUN-AHEAD (source paced by the encoder, as on the N100) =="
row "MODE=hevc SEQ=skip@18,stop@42"                                     "transcode: one skip"
row "MODE=hevc SEQ=skip@18,skip@21,stop@45"                             "transcode: two skips 3s"
row "MODE=hevc SEQ=skip@18,skip@20,skip@22,stop@48"                     "transcode: three skips 2s"
row "MODE=hevc SEQ=seek:60@18,skip@21,stop@45"                          "transcode: seek then skip"
row "MODE=pass SEQ=skip@18,skip@21,skip@24,stop@48"                     "passthrough: three skips 3s"
}
sec doubletap && {
echo "== DOUBLE-TAP SKIPS (inside the spawn window) =="
row "MODE=hevc QLEN=8 SEQ=skip@20,skip@20.15,stop@46"                   "2x @150ms"
row "MODE=hevc QLEN=8 SEQ=skip@20,skip@20.3,stop@46"                    "2x @300ms"
row "MODE=hevc QLEN=8 SEQ=skip@20,skip@20.15,skip@20.3,stop@48"         "3x @150ms"
row "MODE=pass QLEN=8 SEQ=skip@20,skip@20.15,stop@46"                   "2x @150ms passthrough"
}
sec chaos && {
echo "== EVERYTHING AT ONCE (what an operator actually does) =="
row "MODE=hevc QLEN=8 SEQ=skip@16,seek:200@17,pause@18,skip@19,resume@20,stop@48" "skip/seek/pause/skip/resume"
row "MODE=hevc QLEN=8 SEQ=pause@16,skip@16.2,skip@16.4,resume@17,stop@45"        "skips while paused"
row "MODE=hevc QLEN=8 SEQ=seek:300@16,seek:100@16.3,seek:500@16.6,skip@17,stop@46" "scrub then skip"
row "MODE=hevc QLEN=8 SEQ=skip@16,pause@16.2,resume@16.4,skip@16.6,seek:250@17,stop@47" "the lot, 200ms apart"
row "MODE=pass QLEN=8 SEQ=skip@16,seek:60@17,pause@18,skip@19,resume@20,stop@48"  "same, passthrough"
}
sec sweep && {
echo "== CONSECUTIVE SKIPS, interval swept (passthrough) =="
for d in 1 2 3 4 6 8; do
  row "MODE=pass RUNAHEAD=1 SEQ=skip@18,skip@$((18 + d)),skip@$((18 + d * 2)),stop@55" "gap ${d}s x3"
done
row "MODE=pass RUNAHEAD=1 THINBUF=6 SEQ=skip@18,skip@20,skip@22,stop@55"  "thin bank, 2s gaps"
row "MODE=pass RUNAHEAD=1 THINBUF=4 SEQ=skip@18,skip@20,skip@22,stop@55"  "thinner bank, 2s gaps"
}
sec drift && {
echo "== ACCUMULATED A/V DRIFT (what a session of skips leaves behind) =="
row "MODE=pass QLEN=8 SEQ=skip@16,skip@20,skip@24,skip@28,skip@32,skip@36,stop@62" "6 passthrough skips"
row "MODE=hevc QLEN=8 SEQ=skip@16,skip@20,skip@24,skip@28,skip@32,skip@36,stop@62" "6 transcode skips"
row "MODE=pass QLEN=8 SEQ=skip@16,subs-on@20,skip@26,subs-off@30,skip@36,stop@62"   "skips + subtitle applies"
}
