# Streamingestarr mode — sender-side spec

Streamingestarr (the self-hosted receiver replacing Owncast,
`~/IdeaProjects/Streamingestarr`) exposes a structured metadata channel so
its theater page can show real now-playing/up-next/schedule information
instead of a title string. The receiver side is **built and live**; this
doc specs what Jellystreamerr's "Streamingestarr mode" needs. The
authoritative contract lives in the receiver repo:
`docs/integration-jellystreamerr.md`.

## Settings surface

A "Streamingestarr" entry on the services/settings page, exactly like the
Owncast integration: **receiver URL + access token** (created in the
receiver's admin, scope `CAN_SEND_SYSTEM_MESSAGES`). All calls are
`Authorization: Bearer <token>`.

## On enable — discovery

`GET <url>/api/integrations/capabilities` →

```json
{
  "service": "streamingestarr", "apiVersion": 1,
  "ingest": { "rtmpPort": 1935, "srtEnabled": true, "srtPort": 9710,
              "srtContainers": ["mpegts", "matroska", "mp4"] },
  "segmentFormat": "ts", "channels": ["main"],
  "metadata": { "nowPlaying": true, "schedule": true }
}
```

Use it to validate the token and pick transport per codec:
- H.264 → RTMP or SRT/mpegts.
- **AV1 → SRT with `-f matroska`** (mpegts cannot carry AV1 — measured on
  the receiver, it demuxes as bin_data). Warn if the receiver's
  `segmentFormat` is still `ts` when sending AV1.
- Stream key doubles as the SRT `streamid`.

## While streaming

1. **Now playing** — `POST /api/integrations/metadata/nowplaying` on clip
   start, seek, pause/resume and queue changes:
   `{title, subtitle, position, duration, upNext:{title,subtitle},
   announce, channel:"main"}`.
   The receiver stamps receipt time and viewers extrapolate progress — no
   periodic pushes needed. `announce:true` (clip starts only) posts a
   "Now playing — …" line in the receiver's chat.
   Everything needed already exists in the engine — this is the same data
   that drives the Owncast stream-title sync, un-flattened.
2. **Schedule** — `POST /api/integrations/metadata/schedule`
   `{items:[{title, subtitle, startsAt(ISO)}]}` whenever scheduled starts
   change, and re-push after receiver restarts (its list is in-memory;
   hooking the existing `STREAM_STARTED` webhook works). Powers the lobby
   countdown.
3. **Artwork** — `POST /api/integrations/metadata/artwork`
   `{id, type: "image/jpeg|png|webp", data: <base64, max 1 MiB>}`, then
   reference the id as `artworkId` on nowplaying / upNext / schedule
   items. Version ids (e.g. content hash) — viewers cache them immutable.
   Jellyfin poster URLs / local artwork are both fine sources; downscale
   to ~300×450 before pushing. Re-push after receiver restarts (its cache
   is in-memory, bounded to 24 entries).
4. **Pause/resume** — include `paused: true|false` in nowplaying pushes;
   viewers freeze/resume the progress ring.
5. The old `POST /api/integrations/streamtitle` still works there as a
   fallback; mode senders can skip it.

## Future phases (receiver will bump `apiVersion`)

**WebVTT subtitle upload per clip**
(replaces burn-in — the big N100 win); DVR window; receiver-side ABR.
