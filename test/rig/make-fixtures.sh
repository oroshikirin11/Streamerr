#!/bin/bash
# Synthetic media for the splice rig. Generated, not committed: a few tens of
# MB that any box with ffmpeg can rebuild in a minute.
#
#   hevcsub-e1/e2  HEVC + B-pyramid (real reorder depth), 2s GOP so the copy
#                  gate lets it ship untouched; AAC 48k stereo; an embedded
#                  ASS track so subtitle applies have something to extract.
#   fixture        H.264, the transcode-path default.
#   longgop        HEVC with a 10s GOP -- fails the copy gate, like Death Note.
set -e
cd "$(dirname "$0")/fixtures"
FPS=24000/1001
ass() {  # $1 = out.ass   a few cues so the band analysis has real geometry
cat > "$1" <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,First line of dialogue
Dialogue: 0,0:00:05.00,0:00:09.00,Default,,0,0,0,,Second line, a little longer than the first
Dialogue: 0,0:00:12.00,0:00:15.00,Default,,0,0,0,,Third
Dialogue: 0,0:00:20.00,0:00:40.00,Default,,0,0,0,,A long one that stays up for twenty seconds
Dialogue: 0,0:00:45.00,0:01:30.00,Default,,0,0,0,,And one that covers most of the rest
ASS
}
ass subs.ass

gen() {  # $1 name  $2 seconds  $3 tone Hz  $4 extra video args   $5 codec args
  local name=$1 secs=$2 hz=$3 vsrc=$4; shift 4
  [ -s "$name.mkv" ] && { echo "  $name.mkv exists"; return; }
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=$FPS$vsrc" \
    -f lavfi -i "sine=frequency=$hz:sample_rate=48000" \
    -i subs.ass \
    -t "$secs" -map 0:v -map 1:a -map 2:s \
    "$@" \
    -c:a aac -b:a 128k -ac 2 -c:s ass \
    -metadata:s:s:0 language=eng \
    "$name.mkv"
  echo "  $name.mkv $(du -h "$name.mkv" | cut -f1)"
}
# x265: bframes=4 with a pyramid gives the real reorder depth (pts-dts to
# ~0.25s) that produced the two-frame overlap on air.
X265="-c:v libx265 -preset veryfast -x265-params bframes=4:b-pyramid=1:keyint=48:min-keyint=48:scenecut=0:log-level=error -pix_fmt yuv420p"
gen hevcsub-e1 100 440  "" $X265
gen hevcsub-e2 100 660  ":s=1280x720" $X265
gen fixture     90 523  "" -c:v libx264 -preset veryfast -g 48 -keyint_min 48 -sc_threshold 0 -pix_fmt yuv420p
gen longgop    120 330  "" -c:v libx265 -preset veryfast -x265-params bframes=4:b-pyramid=1:keyint=240:min-keyint=240:scenecut=0:log-level=error -pix_fmt yuv420p
echo "keyframe intervals:"
for f in hevcsub-e1 longgop; do
  printf "  %-12s " "$f"
  ffprobe -v error -select_streams v -show_entries packet=pts_time,flags -of csv=p=0 "$f.mkv" \
    | awk -F, '$2 ~ /K/ {print $1}' | sort -n | awk 'NR>1{printf "%.2f ", $1-p} {p=$1}' | cut -c1-60; echo
done

# fixture-pgs: the HEVC fixture with a synthetic PGS track (make-pgs.py) as
# its only subtitle. -itsoffset keeps the first cue at 1 s: ffmpeg rebases a
# secondary input to start at 0, and a cue at exactly 0 races sub2video's
# initial blank frame — a pathology no real disc has.
python3 ../make-pgs.py synth.sup 1280 720 >/dev/null
ffmpeg -hide_banner -loglevel error -y -i hevcsub-e1.mkv -itsoffset 1 -i synth.sup \
  -map 0:v -map 0:a -map 1:s -c copy -metadata:s:s:0 language=eng fixture-pgs.mkv
echo "  fixture-pgs.mkv $(du -h fixture-pgs.mkv | cut -f1)"
