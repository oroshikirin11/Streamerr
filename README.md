# Jellystreamerr

Web-controlled playout for [Owncast](https://owncast.online). Browse your media
library in the browser, click an episode, and it streams — with the rest of the
season following automatically.

Runs headless in a container or LXC. No OBS, no desktop, no capture.

## Status

Engine works; the web UI is not built yet. Current surface is the CLI.

| | |
|---|---|
| Encoder probing | ✅ |
| Normalization + cache | ✅ |
| Gapless chained playout | ✅ verified |
| Owncast streaming | ⏳ untested against a live server |
| Jellyfin library | ⏳ not started |
| Web UI | ⏳ not started |

## How it works

Every clip is transcoded once into a single house profile and cached. Playout
then runs `-c copy`, so **no encoding happens while streaming** — the encode
work sits on a background queue that runs faster than realtime.

Playback is one ffmpeg process that never restarts. It reads a chain of nested
`.ffconcat` scripts, each pointing at the next:

```
p000000.ffconcat          <- playing now
  ffconcat version 1.0
  file 3f2a....ts
  file p000001.ffconcat   <- written later, while ffmpeg is already running
```

The concat demuxer opens a nested reference *lazily*, at the moment playback
reaches it. So the process runs for days while everything past the playhead
stays editable — which is how the queue can change mid-stream.

This matters because Owncast accepts one publisher and drops the stream after
10 seconds of socket silence. Restarting ffmpeg per episode would end the
broadcast at every boundary.

## Quick start

```bash
cp config.example.json config.json   # then fill it in — it is gitignored
npm install

node src/cli.js probe                # which encoders actually work here
node src/cli.js selftest             # prove gapless chaining locally
node src/cli.js stream a.mkv b.mkv   # stream to the configured Owncast
```

`probe` runs a real 15-frame encode per backend, because `ffmpeg -encoders`
reports what the binary was *compiled* with, not what the hardware can do —
a machine can advertise five H.264 encoders and successfully run two.

`selftest` needs no Owncast and no network. It builds four deliberately
mismatched clips, chains them, and checks the output duration is exact.

## Existing compose stack

If your `docker-compose.yml` sits next to the checkout rather than inside it:

```
/srv/
├── docker-compose.yml        <- your stack
├── Jellystreamerr/           <- this repo
└── jellystreamerr/           <- runtime state (created below)
    ├── config/
    └── cache/
```

Relative paths in compose resolve from the **compose file's** directory, so
the build context and volumes differ from the standalone file:

```yaml
  jellystreamerr:
    build: ./Jellystreamerr
    image: jellystreamerr:latest
    container_name: jellystreamerr
    restart: unless-stopped
    ports:
      - "8099:8099"
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    group_add:
      - "989"                       # stat -c '%g' /dev/dri/renderD128
    environment:
      - JELLYSTREAMERR_CONFIG=/config/config.json
    volumes:
      - ./jellystreamerr/config:/config
      - ./jellystreamerr/cache:/app/cache
      - /extHdd:/extHdd:ro
```

Keeping state in `./jellystreamerr/` rather than inside the checkout means
`git pull` never touches your config or cache, and the repo stays clean.

```bash
cd /srv
mkdir -p jellystreamerr/config jellystreamerr/cache
cp Jellystreamerr/config.example.json jellystreamerr/config/config.json
$EDITOR jellystreamerr/config/config.json      # rtmpUrl + streamKey

docker compose build jellystreamerr
docker compose run --rm jellystreamerr node src/cli.js probe
```

The cache holds normalized clips and grows to `normalizer.cacheLimitGB` —
put it on fast local storage, not the media array.

## Requirements

- Node 20+
- ffmpeg **7.0+** with your platform's hardware encoder, and ffprobe

> Static ffmpeg builds cannot do VAAPI or QuickSync. They need a runtime
> `dlopen` of `libva`, which a static PIE cannot do — so they list the encoder
> and fail when you use it. Use `linuxserver/ffmpeg`, `jellyfin-ffmpeg`, or a
> distro build.

## Configuration

All secrets live in `config.json`, which is gitignored — stream key, Jellyfin
API key, and server addresses. Nothing sensitive is committed.

Point `owncast.rtmpUrl` at a tailnet or LAN address if you can. RTMP is
plaintext and carries the stream key in its handshake.

Encoder settings *are* the cache profile, so changing resolution, framerate or
bitrate re-keys the cache and clips are re-normalized on next use.

## Licence

MIT
