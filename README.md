<h1 align="center">Streamerr</h1>
<p align="center">Your media library, running as a live 24/7 channel — with a web panel to drive it.</p>

![The library, with a broadcast on air](docs/screenshots/library.png)

Streamerr plays the files you already have as one continuous broadcast: queue a
season, and it encodes in real time and publishes over RTMP(S), SRT, or TCP to
any ingest. Subtitles are burned in, audio and subtitle tracks switch
mid-episode, HDR passes through untouched when nothing needs drawing, and a
buffer keeps the stream seamless across episodes, seeks, and track changes.

## Quick start — Docker

```bash
git clone https://github.com/oroshikirin11/Streamerr streamerr && cd streamerr
```

Open `docker-compose.yml` and change the media volume, `/changeMe:/Media:ro`,
so the left side is your media folder. Inside an LXC, also set the render
group id (the comment there says how). Then:

```bash
docker compose up -d
```

Open `http://<host>:8099` and let the setup wizard do the rest.

- Run it on the machine that has the media on disk. SMB works too, slower.
- GPU encoding uses the render node in the compose file; without a GPU it
  encodes in software.

## Quick start — standalone

Node 20+ and ffmpeg 9+ on the PATH.

```bash
git clone https://github.com/oroshikirin11/Streamerr streamerr && cd streamerr
npm install
cd web && npm install && npm run build && cd ..
node src/index.js
```

Open `http://localhost:8099` and run setup.

## Updating

```bash
chmod +x update.sh   # once, if you downloaded a zip rather than cloning
./update.sh
```

Works for both setups: it pulls the latest code, rebuilds the container or
the panel, and restarts. Your config, schedules, uploaded pictures and cache
are never touched — they live outside the code and, under Docker, in
volumes. It refuses to run over local edits or a live broadcast (`--yes`
overrides the latter), keeps a small backup of config, schedules and
pictures under `backups/`, and `--dry-run` shows the plan without doing it.

## Metadata

Two good options, one fallback:

- **TMDB** — drop in a free API key and Streamerr matches titles, episode
  names, and posters itself, in the background. Wrong match? Fix it from the
  poster's hover menu.
- **Jellyfin** — point a library at your Jellyfin server with an API key; it
  already knows your posters and episode order.
- Plain filenames work with no key at all; episode stills are generated
  automatically either way.

## The panel

| Schedule | Settings | Studio |
| --- | --- | --- |
| ![Schedule](docs/screenshots/schedule.png) | ![Settings](docs/screenshots/settings.png) | ![Studio](docs/screenshots/studio.png) |
| Tonight on a timeline: what's on air, what follows and when, saved schedules that remember where you left off, breaks, history | Simple mode: two levers, plus your own saved preset | Overlays positioned on the live frame |

## The receiving end

[Streamingestarr](https://github.com/oroshikirin11/Streamingestarr) is Streamerr's
hybrid ingest service — the stream-receiving counterpart with playback and
chat. Streamerr was first built to publish to
[Owncast](https://owncast.online), which remains fully supported, and any
RTMP/SRT ingest works.

The TCP destination mode is Streamingestarr's own protocol, and it can run
over TLS: one switch under Settings › Streamingestarr encrypts every TCP
destination, primary and extras, on the receiver's normal TCP port. The
receiver's certificate is always verified against the system's trusted
roots — a Let's Encrypt certificate needs nothing more; for a private or
self-signed certificate, point "Trusted certificate" at its PEM file.

With "Viewers can vote to pause and resume" on (Settings › Streamingestarr),
the room gets a Pause pill: at half the viewers watching, the broadcast
pauses, and the same vote resumes it. The panel shows "Paused by viewers ·
2 of 4", a lock next to the transport holds the votes off for the night,
and a pause you make yourself is never overruled by a vote.

## Features

- Continuous playout over one connection — episode changes, seeks, and track
  switches never drop the stream
- Hardware encoding (VAAPI, QSV, NVENC, AMF, VideoToolbox) with software
  fallback; H.264, HEVC, and AV1 output
- HDR passthrough and tone mapping
- Burned-in subtitles with GPU compositing; audio/subs switchable mid-episode
- Publish to several destinations at once — RTMP(S), SRT, or TCP
- Jellyfin, local folder, and SMB libraries; TMDB or Jellyfin metadata
- Scheduling with projected air times and interval cards for programmed starts
- Studio overlays — text and pictures, dragged into place on the live frame
- Live low-latency preview in the panel; run-ahead RAM cache for instant seeks

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free to use, run, and modify for
any **noncommercial** purpose. Forks are welcome and inherit the same terms.

If Streamerr runs your channel and you want to say thanks:

<a href="https://buymeacoffee.com/oroshikirin11"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60"></a>
