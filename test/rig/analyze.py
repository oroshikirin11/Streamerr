"""What the ingest received: every way a splice can be wrong, in one place.

Zero tolerance throughout. A 1ms slack on the backward test hid a DUPLICATE
timestamp for a day; counting only audio decode errors hid video ones; and
nothing looked at lattice continuity or cumulative A/V drift at all, which is
how a 70ms-per-splice audio hole passed as "tolerable" while it summed to
-436ms on air.
"""
import subprocess, sys, json
from collections import Counter

f = sys.argv[1]
j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_packets', '-of', 'json', f],
                              capture_output=True, text=True).stdout or '{"packets":[]}')
V = [p for p in j.get('packets', []) if p.get('codec_type') == 'video']
A = [p for p in j.get('packets', []) if p.get('codec_type') == 'audio']
def g(p, k):
    v = p.get(k)
    return None if v in (None, 'N/A') else float(v)
vd = [g(p, 'dts_time') for p in V if g(p, 'dts_time') is not None]
vp = [g(p, 'pts_time') for p in V if g(p, 'pts_time') is not None]
au = [(g(p, 'pts_time'), g(p, 'duration_time')) for p in A
      if g(p, 'pts_time') is not None and g(p, 'duration_time')]

back = [(round(a, 2), round((a - b) * 1000, 2)) for a, b in zip(vd, vd[1:]) if b <= a]
# Holes are measured on PRESENTATION order (sorted pts), not decode order.
# A forward DTS step with continuous pictures is what a correct splice from
# a reordered stream to an unreordered one looks like -- the cushion holds
# pictures past its last dts, and a no-B successor placed after the last
# PICTURE necessarily starts its dts the reorder depth later. That flagged
# three flawless pause rows as video:BAD. Backward stays on DTS: that is
# what makes a muxer complain.
vps = sorted(vp)
# ...excluding the truncated tail. Stopping the capture mid-GOP strands the
# reference frames decoded early: presentation runs continuously to the cut,
# then a lone picture sits one B-run later with its in-betweens missing --
# they were still in the source. Real content never shows a hole ENDING at
# the file's final picture, so the last second is not evidence of anything.
tail = vps[-1] - 1.0 if vps else 0
holes = [(round(a, 2), round((b - a) * 1000)) for a, b in zip(vps, vps[1:])
         if b - a > 0.15 and a < tail]
aseam = [(round(a, 2), round((b - (a + d)) * 1000, 1)) for (a, d), (b, _) in zip(au, au[1:])
         if abs(b - (a + d)) > 0.005]
dups = sorted(k for k, n in Counter(vp).items() if n > 1)
errs = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-f', 'null', '-'],
                      capture_output=True, text=True).stderr
aerrs = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-map', '0:a', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr

# Lattice continuity: from the first sync byte, EVERY 188th byte must be 0x47.
# A splice that leaves a partial packet at the cushion's tail breaks this once
# per skip -- "Packet corrupt (stream = 0), dropping it" at the publisher.
raw = open(f, 'rb').read()
def synced(o):
    return raw[o] == 0x47 and all(raw[o + i * 188] == 0x47
                                  for i in range(1, 6) if o + i * 188 < len(raw))
start = next((o for o in range(min(188, len(raw))) if synced(o)), -1)
breaks = []
o = start
while start >= 0 and o + 188 <= len(raw):
    if raw[o] != 0x47:
        breaks.append(o)
        nxt = next((c for c in range(o, min(o + 188 * 4, len(raw) - 188)) if synced(c)), -1)
        if nxt < 0:
            break
        o = nxt
    o += 188

# Cumulative A/V drift -- the receiver's "A/V offset per segment". Audio
# delivered minus the audio timeline span IS what the viewer eventually hears.
drift_ms = None
if au:
    a_span = au[-1][0] - au[0][0] + (au[-1][1] or 0)
    a_have = sum(d for _, d in au if d)
    drift_ms = (a_span - a_have) * 1000

print(f"    video DTS backward: {back[:4] if back else 'none'}")
print(f"    video DTS holes>150ms: {holes[:4] if holes else 'none'}")
print(f"    audio seams>5ms: {aseam[:4] if aseam else 'none'}")
if drift_ms is None:
    print("    audio drift: n/a")
else:
    print(f"    audio drift: {drift_ms:+.0f}ms ({'audio ahead' if drift_ms > 5 else 'in sync'}) "
          f"[{a_have:.2f}s delivered over {a_span:.2f}s]")
print(f"    torn packet junctions: {len(breaks)} {breaks[:4] if breaks else ''}")
print(f"    duplicate video PTS: {[round(d, 3) for d in dups[:6]] if dups else 'none'} (n={len(dups)})")
print(f"    decode errors: {len([l for l in errs.splitlines() if l.strip()])}")
print(f"    audio decode errors: {len([l for l in aerrs.splitlines() if l.strip()])}")
