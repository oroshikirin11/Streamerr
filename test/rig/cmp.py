"""Does every spawn USE the splice point computed for it?

The frontier used to move between the two -- progress from the outgoing source
after the splice was decided -- and the spawn baked in a number nobody chose:
computed 240.261, spawned 243.141. Needs ALLLOG=1 (the spawn argv is long).
"""
import re, sys
sp = None; bad = 0; n = 0
for l in open(sys.argv[1]):
    m = re.search(r"-> splice=([0-9.]+)", l)
    if m:
        sp = float(m.group(1))
    m2 = re.search(r"output_ts_offset ([0-9.]+)", l)
    if m2 and sp is not None:
        off = float(m2.group(1)); d = off - sp; n += 1
        flag = "  <== MISMATCH" if abs(d) > 0.15 else ""
        if abs(d) > 0.15:
            bad += 1
        print(f"  splice={sp:.3f} spawn={off:.3f} delta={d:+.3f}{flag}")
        sp = None
print(f"  -> {bad} mismatch(es) of {n} splices")
