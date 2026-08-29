# Roadmap

Short list. Detail lives in the linked docs.

## 1. Live sources — OBS, step by step (NEXT)

`roadmap-live-sources.md`, `screen-capture-viability.md`

- [ ] **HTTPS on the LAN address** — camera and screen capture do not work without it. Blocks everything below.
- [ ] **Overlay changes without restarting ffmpeg** — hardest item. Also kills the DTS glitches we already have. Do it early.
- [ ] Webcam capture
- [ ] Desktop / window capture
- [ ] Mixing camera + media + overlays
- [ ] Webhook triggers for GIFs — needs revocable tokens, rate limits, fixed GIF list (never a URL)

Delay is fine. Live mode is desktop-class only; the N100 cannot run it.

## 2. Codec — the biggest single win

`roadmap-hdr-output-and-quality-controls.md` Part 7

- [ ] **AV1 output** — about half the bitrate of H.264. Browsers already decode it.
- [ ] New service (replacing Owncast) should ingest **SRT/mpegts, not RTMP** — carries AV1/HEVC with no tag games
- [ ] Studio preview uses mpegts.js and goes blind on AV1 — needs replacing
- [ ] Release build of SVT-AV1 in the Dockerfile — free 18%

Measured live-capable at 1080p on both hosts. 4K only on the desktop, and barely.

## 3. Quality settings

`roadmap-hdr-output-and-quality-controls.md` Parts 1-2, 4-5

- [ ] **Fix the half-rate subtitle canvas** — judders karaoke today. Most visible item.
- [ ] Expose: encoder preset, scaler quality, B-frames, rate control
- [ ] Fast / Balanced / Best picture selector, with individual overrides
- [ ] Grey out what the hardware physically cannot do
- [ ] Deinterlacing — does not exist at all right now

B-frames and rate control need a splice tested first.

## 4. Low value, recorded for completeness

- [ ] HDR output — only useful for SRT to a real player; browsers barely render HDR
- [ ] Drop 12 Mbps to ~6 at 1080p — identical picture, half the upload

## Facts that decide the above

- 1080p at 12 Mbps is already transparent. **No flag improves it.**
- 4K needs ~40 Mbps in H.264. Upload is 52.75 Mbps. **Not reachable.**
- Flag tuning buys 5-11%. AV1 buys ~50%.
