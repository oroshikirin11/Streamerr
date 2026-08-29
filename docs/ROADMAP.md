# Roadmap

Ordered. Detail in the linked docs. Items marked **+** were not in the original
plan — added where they seemed to belong; move or drop them freely.

---

## Phase 1 — Overlay changes without restarting the source

The foundation. Ships value immediately and becomes the model for mixing later.

`roadmap-live-sources.md`

- [ ] Apply overlay changes to a **running** filter graph instead of respawning ffmpeg
- [ ] No more stream aborts on apply
- [ ] Studio gets smooth — no splice, no re-buffer

Why first: it fixes what we already have. Every apply today restarts ffmpeg and
produces corrupt-packet, out-of-order and non-monotonic DTS errors in real
logs. A graph that never restarts needs none of that, nor the partial-packet
trimming or `_srcGen` realignment machinery.

- [ ] **+** Retire that machinery once nothing restarts mid-stream
- [ ] **+** Keep overlay motion closed-form — it must still serve both modes

---

## Phase 2 — AV1 output, and H.264 tuning

`roadmap-hdr-output-and-quality-controls.md` Parts 1-2, 7

**AV1**
- [ ] AV1 as an output codec — about half of H.264's bitrate
- [ ] **+** Replace the Studio preview: it uses mpegts.js and goes blind on AV1
- [ ] **+** Release build of SVT-AV1 in the Dockerfile — free 18%

**H.264 tuning** (the settings we discussed)
- [ ] Expose: encoder preset, B-frames, rate control, scaler quality
- [ ] Fast / Balanced / Best picture selector, with individual overrides
- [ ] Grey out only what the hardware physically cannot do
- [ ] B-frames and rate control: test a splice before shipping

---

## Phase 3 — HDR output, and the rest of the visual-quality settings

`roadmap-hdr-output-and-quality-controls.md` Parts 3-5

- [ ] HDR output as its own switch
- [ ] **Fix the half-rate subtitle canvas** — judders karaoke today. Most visible item we have.
- [ ] `mode=fast` scaler — expose it
- [ ] `fps_mode cfr` frame duplication — expose or explain it
- [ ] Deinterlacing — does not exist at all
- [ ] **+** Audio: 160k AAC and a forced stereo downmix. 5.1 sources lose their mix.

---

## Phase 4 — Close the gaps, then polish

Everything that stops this being "done".

- [ ] **+** Subtitle extraction reads the whole file — 56 GB for a 65 KB subtitle on Apocalypto. Fetch subtitles from Jellyfin instead.
- [ ] **+** Bitrate guidance: warn when the encoder cannot hold the target (the N100 silently drops to 2.5 Mbps at 4K)
- [ ] **+** Test matrix against a real library, every combination
- [ ] UI deep polish
- [ ] General bug fixing

Goal: the media streaming service is **complete**.

**+** "Complete" needs a definition written down now, while not in the middle
of it. "Polish and bug fixing in general" has no end condition, and the
realistic failure mode is that Phase 4 never finishes and Phase 6 never starts.
Three or four concrete items, then stop.

---

## Phase 5 — Branch off a new project

Not a fork kept in sync. A **new project that uses this one as its basis** and
then goes its own way.

- [ ] Copy once Phase 4 is done

This side stays **slim**: stream media libraries to people, nothing more. No
bloat.

**+** What that implies, and it changes what Phase 4 should prioritise:

- Whatever state the engine is in at copy time is inherited **permanently** by
  the new project. Engine bugs left behind get copied and then found twice.
- The UI is **not** inherited in any meaningful sense — the creator service
  needs scenes, source lists and audio mixers, none of which exist here, so
  most of this UI gets rewritten there anyway.
- Therefore: in Phase 4, **engine and pipeline correctness first**. Polish the
  UI only as far as THIS product needs it, not as preparation for the next one.
- No syncing obligation afterwards. If a bad engine bug turns up later it can
  be ported by hand, but neither side owes the other anything.

---

## Phase 6 — Creator service (the new project)

The powerful one. Personal use and content creators.

`roadmap-live-sources.md`, `screen-capture-viability.md`

- [ ] **+** HTTPS on the LAN address — camera and screen capture do not work without a secure context. Blocks everything here.
- [ ] Webcam capture
- [ ] Desktop / window capture
- [ ] Mixing: camera + desktop + media + overlays
- [ ] **Audio source mixing** — multiple sources, levels, muting
- [ ] Webhook triggers for GIFs — revocable tokens, rate limits, a fixed GIF list, never a caller-supplied URL
- [ ] Go crazy with overlays and audio, while the stream stays smooth
- [ ] More inspiration from OBS

**+** Worth stealing from OBS specifically:
- [ ] **Scenes** — named layouts, switched live. The single biggest OBS concept and the one that makes the rest usable.
- [ ] Transitions between scenes
- [ ] Hotkeys
- [ ] Per-source audio monitoring

Notes: delay is fine, this is a broadcast. Desktop-class hardware only — the
N100 cannot run it.

---

## In limbo

- [ ] Our own ingest, built on Owncast

If it happens, it should take **SRT/mpegts, not RTMP** — mpegts carries AV1 and
HEVC natively, so the Enhanced-RTMP tagging problem never arises. Decide at
design time; it is free then and awkward later.

---

## Facts that shape all of the above

- 1080p at 12 Mbps is already transparent. **No flag improves it.**
- 4K needs ~40 Mbps in H.264. Upload is 52.75 Mbps. **Not reachable.**
- Flag tuning buys 5-11%. **AV1 buys ~50%.**
- Delay is acceptable everywhere. This is a broadcast.
