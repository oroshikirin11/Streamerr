"""Geometry at each splice: where the cushion's audio and pictures end, where
the successor's begin, and the holes between them.

The successor is found by a continuity-counter JUMP on the video pid -- a
fresh ffmpeg starts counting at zero -- because this build sets no
discontinuity indicators at all, and guessing from timestamps mislabelled a
B-pyramid's opening frames as the cushion's. The n-th jump pairs with the
n-th "-> splice=" line of the engine log.
"""
import sys, subprocess, json, re
ts, log = sys.argv[1], sys.argv[2]
raw = open(ts, 'rb').read()
def synced(o): return raw[o] == 0x47 and all(raw[o + i*188] == 0x47 for i in range(1, 6) if o + i*188 < len(raw))
g = next(o for o in range(188) if synced(o))
jumps = []; prev = None; o = g
while o + 188 <= len(raw):
    if raw[o] != 0x47:
        nxt = next((c for c in range(o, min(o + 188*4, len(raw) - 188)) if synced(c)), -1)
        if nxt < 0: break
        o = nxt
    pid = ((raw[o+1] & 0x1f) << 8) | raw[o+2]
    if pid == 0x100 and (raw[o+3] & 0x30):          # carries payload: cc counts
        cc = raw[o+3] & 0x0f
        if prev is not None and cc != ((prev + 1) & 0x0f) and cc != prev:
            jumps.append(o)
        prev = cc
    o += 188
tls = [float(x) for x in re.findall(r"-> splice=([0-9.]+)", open(log).read())]
j = json.loads(subprocess.run(['ffprobe','-v','error','-show_packets','-of','json', ts], capture_output=True, text=True).stdout)
def f(p, k):
    v = p.get(k); return None if v in (None, 'N/A') else float(v)
rows = sorted((int(p.get('pos', 0)), p['codec_type'][0], f(p,'pts_time'), f(p,'dts_time'), f(p,'duration_time') or 0)
              for p in j['packets'] if f(p,'pts_time') is not None)
FR = 1001/24000
print(f"splices logged: {len(tls)}   cc jumps on the video pid: {len(jumps)}")
for i, so in enumerate(jumps[:len(tls)]):
    tl = tls[i]
    cush = [r for r in rows if r[0] < so]; succ = [r for r in rows if r[0] >= so]
    ca = [r for r in cush if r[1]=='a']; cv = [r for r in cush if r[1]=='v']
    sa = [r for r in succ if r[1]=='a']; sv = [r for r in succ if r[1]=='v']
    if not (ca and cv and sa and sv): continue
    a_end = ca[-1][2] + ca[-1][4]; v_end = max(r[2] for r in cv) + FR
    v_first = min(r[2] for r in sv[:8])
    print(f"#{i+1} tl={tl:.4f}  cushion audio ends {a_end:.4f}, pictures end {v_end:.4f} | "
          f"successor audio {sa[0][2]:.4f} (tl{(sa[0][2]-tl)*1000:+.1f}ms), first picture {v_first:.4f} (tl{(v_first-tl)*1000:+.1f}ms)")
    print(f"     AUDIO HOLE {(sa[0][2]-a_end)*1000:+.1f}ms   VIDEO HOLE {(v_first-v_end)*1000:+.1f}ms")
