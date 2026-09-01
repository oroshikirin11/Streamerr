# Agent prompt — finish the TCP destination passphrase (sender side)

Copy everything below the line into the agent working on Streamerr.

---

## Mission

The receiver's raw-TCP ingest now supports an **optional preamble
passphrase** (Streamingestarr `16b90aa`), and the operator has set one on
the public VPS listener. The sender's transport half is already committed
(`abbf3fc`) — your job is to verify the plumbing end to end, close any gap
in the settings UI, and prove it live. Repo: `~/IdeaProjects/Streamerr`.

## The wire contract (receiver is authoritative, do not change unilaterally)

- Plain TCP to `<host>:9711`. First line, within 5s and 1KB:
  `SGR-TS/1 <streamkey> <passphrase>\n` — passphrase is the OPTIONAL second
  token. A receiver with no passphrase configured ignores it; a receiver
  with one configured rejects missing/wrong (connection closed right after
  the preamble, error logged with the remote address). Then raw container
  bytes (mpegts; matroska for AV1).
- Passphrase rules: 10-79 chars, NO spaces or newlines (it rides a
  space-delimited line). Empty string = disabled.

## Already done in `abbf3fc` — verify, don't redo

- `src/ffmpeg/tcp-bridge.js`: `TCP_PREAMBLE(key, passphrase)` emits the
  two-token form when a passphrase is present; `_bridge` reads
  `{url, key, passphrase}` from `this._creds()`.
- `src/publish.js` (tcp branch): key and passphrase both refuse
  spaces/newlines at validation time.

## What to verify / likely finish

1. **Creds plumbing:** the bridge is constructed at `pipeline.js:1392` as
   `new TcpBridge(() => d.creds, …)`. Confirm `d.creds` actually carries
   `passphrase` for tcp-protocol destinations — primary slot AND extras.
   The destination config model already has a `passphrase` field (SRT uses
   it); make sure the tcp path doesn't strip it.
2. **Settings UI:** does the publish-destination form show the passphrase
   input when protocol is TCP? If it's SRT-only today, expose it for TCP
   too. It is a secret: masked as `__SET__` on GET and restored via
   `restorePublishSecrets` on PUT, like the SRT one — verify the round
   trip doesn't blank it when saving unrelated settings.
3. **Log hygiene:** the passphrase must never appear in logs or the
   console. Check `redactUrl` and every bridge log line (`abbf3fc` writes
   it only to the socket — keep it that way).
4. **Failure shape:** a wrong passphrase looks like "server closed the
   connection right after connect" — the bridge drops the local socket,
   the publisher exits, supervision retries with backoff. Verify that
   doesn't become a tight crash loop, and that the bridge's failure log
   makes the cause guessable (it cannot know WHY the receiver closed —
   saying "closed immediately after the preamble — wrong key or
   passphrase?" is honest and enough).

## Live verification (the receiver is ready)

- Target: `tcp://stream.livinginasimulation.de:9711` — public, passphrase
  SET by the operator (get the value from them; never log it).
- **One broadcast slot**: stop any running SRT broadcast first, or the
  receiver answers the preamble with "stream already running" and closes —
  indistinguishable from wrong-passphrase at the sender.
- Ladder: H.264 transcode → HEVC transcode → 4K HDR HEVC passthrough
  (flagship: receiver must probe `TCP/mpegts`, `HEVC Main 10 · HDR (PQ)`,
  and the theater must play with the HDR badge). Success log:
  `[tcp-bridge] connected to <host>:9711 — authenticated, splicing`.
- Negative test: temporarily misconfigure the passphrase → expect
  immediate close + supervision backoff, no crash loop.
- Reconnect test: operator restarts the receiver container mid-broadcast →
  sender must reconnect and re-authenticate on its own within ~10-20s.
- Deploy note: the desktop sender runs as the docker container
  `streamerr` (compose in the repo root) — code changes need
  `docker compose up -d --build`, a plain restart reuses the stale image.
  The N100 box (192.168.178.186:8099, API open) is the other sender.

## Why TCP at all (context, not a task)

The home uplink drops UDP in bursts no SRT latency window survives
(measured: 9k unrecoverable packets in 2 minutes at 32 Mbps; upload
congested to 24 of 52 Mbps on Sunday evenings). TCP retransmits forever —
loss becomes delay, the deep player buffer hides it, and RTMP proved the
approach flawless on this exact line. TCP ingest = that reliability with
HEVC/AV1/HDR. The Receive health line on the receiver's Status page should
read zero drops forever on TCP; if it doesn't, something is deeply wrong.
