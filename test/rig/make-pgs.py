#!/usr/bin/env python3
"""A synthetic PGS (Blu-ray bitmap subtitle) stream, for the rig.

ffmpeg decodes PGS but has no encoder, so the stream is written by hand:
each cue is a PCS/WDS/PDS/ODS/END display set showing a solid block with a
hole in it (unmistakable in a frame), followed by an empty display set that
clears it, exactly as discs are authored. Coordinates are in the VIDEO's
space (here 1280x720), so the live scale to the content rect is exercised.

    make-pgs.py out.sup [width height]
"""
import struct, sys

W = int(sys.argv[2]) if len(sys.argv) > 2 else 1280
H = int(sys.argv[3]) if len(sys.argv) > 3 else 720
out = sys.argv[1]

def seg(pts_ms, kind, body):
    return b'PG' + struct.pack('>IIBH', pts_ms * 90, 0, kind, len(body)) + body

def rle_line(runs):
    # runs: list of (colour, length); PGS RLE, colour 0 = transparent
    o = bytearray()
    for c, n in runs:
        while n > 0:
            k = min(n, 16383)
            if c == 0:
                if k < 64: o += bytes([0, k])
                else: o += bytes([0, 0x40 | (k >> 8), k & 0xff])
            else:
                if k < 64: o += bytes([0, 0x80 | k, c])
                else: o += bytes([0, 0xC0 | (k >> 8), k & 0xff, c])
            n -= k
    o += bytes([0, 0])   # end of line
    return bytes(o)

def bitmap(w, h):
    # a white block with a transparent square hole in the middle
    lines = []
    for y in range(h):
        if h // 3 <= y < 2 * h // 3:
            lines.append(rle_line([(1, w // 3), (0, w // 3), (1, w - 2 * (w // 3))]))
        else:
            lines.append(rle_line([(1, w)]))
    return b''.join(lines)

def cue(pts_ms, end_ms, x, y, w, h, obj_id):
    comp = 0
    body = struct.pack('>HHBHBBBB', W, H, 0x10, comp, 0x80, 0, 0, 1)   # PCS: epoch start, 1 object
    body += struct.pack('>HBBHH', obj_id, 0, 0, x, y)
    pcs = seg(pts_ms, 0x16, body)
    wds = seg(pts_ms, 0x17, struct.pack('>BBHHHH', 1, 0, x, y, w, h))
    # palette 0: entry 0 transparent, entry 1 white opaque (Y 235, Cr/Cb 128)
    pds = seg(pts_ms, 0x14, struct.pack('>BB', 0, 0) + bytes([0, 16, 128, 128, 0]) + bytes([1, 235, 128, 128, 255]))
    data = bitmap(w, h)
    ods_body = struct.pack('>HBB', obj_id, 0, 0xC0) + struct.pack('>I', len(data) + 4)[1:] + struct.pack('>HH', w, h) + data
    ods = seg(pts_ms, 0x15, ods_body)
    end = seg(pts_ms, 0x80, b'')
    # the clearing display set: a PCS with no objects
    clear_pcs = seg(end_ms, 0x16, struct.pack('>HHBHBBBB', W, H, 0x10, comp + 1, 0x00, 0, 0, 0))
    clear_wds = seg(end_ms, 0x17, struct.pack('>B', 0))
    clear_end = seg(end_ms, 0x80, b'')
    return pcs + wds + pds + ods + end + clear_pcs + clear_wds + clear_end

with open(out, 'wb') as f:
    # cues every 4 s for 90 s, alternating positions; the block is 300x120
    for i in range(22):
        start = 1000 + i * 4000
        x = 100 + (i % 3) * 300
        y = H - 200 if i % 2 == 0 else 80
        f.write(cue(start, start + 2500, x, y, 300, 120, i % 4))
print(out)
