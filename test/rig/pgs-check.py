#!/usr/bin/env python3
"""When the synthetic PGS blocks switch on and off in capture.ts.

The fixture's cues (make-pgs.py, muxed with -itsoffset 1): bottom-left block
1.0-3.5 s, top block 5.0-7.5 s. Frames are decoded sequentially with their
own timestamps (seeking into a TS lands frames off by up to a GOP) and the
solid top band of each block is sampled; a cue edge may land up to one
canvas interval (83 ms at 12 fps) after the cue, never before it.
"""
import subprocess, sys, os
cap = sys.argv[1] if len(sys.argv) > 1 else 'capture.ts'
W, H = 1280, 720
errf = cap + '.edges.err'
p = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'info', '-nostdin', '-t', '9', '-i', cap,
                      '-vf', 'showinfo', '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                     stdout=subprocess.PIPE, stderr=open(errf, 'w'))
states = []
while True:
    b = p.stdout.read(W * H)
    if len(b) < W * H:
        break
    def solid(x0, y0):
        pts = [(x, y) for y in range(y0 + 4, y0 + 40, 4) for x in range(x0 + 4, x0 + 300, 4)]
        return sum(1 for x, y in pts if b[y * W + x] > 225) / len(pts) > 0.9
    states.append('top' if solid(400, 80) else 'bottom' if solid(100, 520) else 'none')
p.stdout.close(); p.wait()
pts = [float(l.split('pts_time:')[1].split()[0]) for l in open(errf, errors='replace') if 'pts_time:' in l]
os.unlink(errf)
edges = []
prev = None
for t, s in zip(pts, states):
    if s != prev:
        edges.append((t, s)); prev = s
expect = [(0.0, 'none'), (1.0, 'bottom'), (3.5, 'none'), (5.0, 'top'), (7.5, 'none')]
bad = 0
for i, (t, s) in enumerate(expect):
    got = edges[i] if i < len(edges) else None
    ok = got is not None and got[1] == s and t - 0.045 <= got[0] <= t + 0.15
    bad += 0 if ok else 1
    print(f'  edge {i}: expected {s:6s} at {t:.1f}s, got {got[1] + " at %.3fs" % got[0] if got else "nothing"}  {"OK" if ok else "MISMATCH"}')
print(f'  pixels: {"all OK" if not bad else str(bad) + " MISMATCH"} ({len(states)} frames read)')
