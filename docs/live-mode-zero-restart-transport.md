# Live mode: zero restarts, full stop

The contract: in live mode, NO studio change ever respawns the source.
Subtitles, stills, moving pictures, GIFs, later webcams — all of it
rides the canvas pipe as live renderer swaps. The only cut left in the
product is broadcast start/stop.

Why the current build still splices for motion: the fifo transport
(64KB lockstep + node hop + copies) measured a ~0.35x throughput loss
at full-rate canvas — the bank could not sustain. The fix is the
transport, not the contract.

## The shm-file transport

- Renderer stdout -> an O_APPEND fd of /dev/shm/jsr-canvas-<pid>.nut,
  passed as stdio. Node never touches the bytes. File writes are page
  cache memcpys: no pipe-size lockstep, no wakeups, and they NEVER
  block — so a swap's SIGTERM always lands on an unblocked renderer,
  which exits at a clean NUT boundary. The whole tear/guard apparatus
  becomes unnecessary.
- Successive renderers append to the same fd; the reader sees
  concatenated NUT streams exactly as it did on the fifo (joins are
  proven by the e2e).
- Reader side: -follow 1 on the file input (the file protocol retries
  at EOF, made for growing files) plus the existing -t bound so the
  process still exits at clip end.
- Space: a reaper timer punches consumed head pages with
  `fallocate -p -o 0 -l <fileSize - keep>` (util-linux is in the Arch
  image), keeping the last ~3s of canvas — the reader's demux lag is
  bounded well under that. Offsets are preserved; /dev/shm never fills.

## Then remove the motion detour

planOverlayPipe stops rejecting moving/animated pictures; the renderer
draws them again (mpdecimate stays on the chain as shipped — the green
tears came from kills, and this transport has none). setOverlay's
moving-signature respawn branch is deleted. Bouncing text returns to
the canvas too. The inline paths remain only for legacy mode.

## Prove it on the N100 with the existing harness

1. e2e acts A/B on the shm transport (joins, still, swap-under-load).
2. Seek-pinned pair, 300-480s window: shm-piped bounce vs inline
   bounce — the gate is sustain parity (bank flat at cap, 12 min).
3. Preview capture across a bounce TOGGLE: frame-accurate pts audit —
   zero gaps, zero damaged frames, zero black flashes. That is the
   contract's proof, not a feeling.

If shm full-rate still cannot sustain on the N100, the next levers in
order: renderer thread pinning/priority, canvas at readrate 1.1 with
deeper -t, and only then any talk of trade-offs — with numbers.
