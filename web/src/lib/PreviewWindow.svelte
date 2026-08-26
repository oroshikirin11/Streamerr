<script>
  /**
   * Floating live preview — a picture-in-picture window playing the exact
   * MPEG-TS the publisher is sending to Owncast, via /ws/preview.
   *
   * It hovers above everything, drags freely, and snaps to one of four
   * docks on release (remembered across sessions). Bottom docks clear the
   * transport bar; left docks clear the sidebar. There is no second encode
   * behind this: closing the window costs the server nothing, and opening
   * it costs only the stream's own bitrate.
   */
  import { onMount } from 'svelte';
  import mpegts from 'mpegts.js';

  let { bottomInset = 90, onclose } = $props();

  const MARGIN = 14;
  const SIZES = { s: 300, l: 460 };

  let corner = $state(localStorage.getItem('jsr-preview-corner') ?? 'br');
  let size = $state(localStorage.getItem('jsr-preview-size') ?? 's');
  let muted = $state(localStorage.getItem('jsr-preview-muted') !== '0');

  let vw = $state(window.innerWidth);
  let vh = $state(window.innerHeight);
  const width = $derived(SIZES[size] ?? SIZES.s);
  const height = $derived(Math.round(width * 9 / 16));

  let pos = $state({ x: -9999, y: -9999 });
  let dragging = $state(false);
  let nearest = $state(null);
  let connected = $state(false);
  let unsupported = $state(false);
  /** Autoplay was vetoed — waiting for a click anywhere on the window. */
  let needsGesture = $state(false);

  let video;
  let player = null;
  let retryTimer = null;
  let watchdog = null;
  let gone = false;

  function sidebarW() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--sidebar');
    return parseInt(v, 10) || 0;
  }

  function dockPos(c, w = width, h = height) {
    return {
      x: c.endsWith('l') ? sidebarW() + MARGIN : vw - w - MARGIN,
      y: c.startsWith('t') ? MARGIN : vh - h - bottomInset,
    };
  }

  // Docked placement follows the viewport, the pinned corner, the window
  // size and the transport bar's height; a drag in progress owns `pos`.
  $effect(() => {
    if (!dragging) pos = dockPos(corner);
  });

  function nearestDock() {
    const cx = pos.x + width / 2;
    const cy = pos.y + height / 2;
    let best = 'br';
    let bestD = Infinity;
    for (const c of ['tl', 'tr', 'bl', 'br']) {
      const p = dockPos(c);
      const d = Math.hypot(p.x + width / 2 - cx, p.y + height / 2 - cy);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  let drag = null;
  function onDown(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    // A few px of slack so a plain click never nudges the window.
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    dragging = true;
    pos = {
      x: Math.min(Math.max(drag.ox + dx, 4), vw - width - 4),
      y: Math.min(Math.max(drag.oy + dy, 4), vh - height - 4),
    };
    nearest = nearestDock();
  }
  function onUp() {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    corner = nearestDock();
    localStorage.setItem('jsr-preview-corner', corner);
    nearest = null;
    // Leaving drag mode re-enables the CSS transition, so this reads as the
    // window gliding into its dock rather than teleporting.
    dragging = false;
  }

  function toggleSize() {
    size = size === 's' ? 'l' : 's';
    localStorage.setItem('jsr-preview-size', size);
  }
  function toggleMute() {
    muted = !muted;
    localStorage.setItem('jsr-preview-muted', muted ? '1' : '0');
  }

  function teardown() {
    clearTimeout(retryTimer);
    retryTimer = null;
    clearInterval(watchdog);
    watchdog = null;
    if (player) {
      try { player.destroy(); } catch { /* already dead */ }
      player = null;
    }
  }

  /**
   * Backstop for a wedged decoder. currentTime is a lie here: on an MSE
   * decode stall it keeps advancing over a frozen picture, so the honest
   * signal is the decoded-frame counter. Frames advancing → healthy. Frames
   * stuck while bytes still arrive → decoder wedged, rebuild the player.
   * Frames stuck and nothing arriving → the broadcast is paused, and
   * holding the last frame is exactly right.
   *
   * The server already resyncs us at every splice it knows about; this
   * catches whatever slips through.
   */
  let wdFrames = 0;
  let wdBuf = 0;
  let wdStuck = 0;
  function checkStall() {
    if (!video || !player) return;
    // A paused element is NOT a reason to stand down. After a splice
    // tears the player down and rebuilds it, the browser can leave the
    // fresh element paused — and a watchdog that bails on paused then
    // never runs again, which is a permanent stillframe that only
    // toggling the window off and on cleared. Unless we are genuinely
    // waiting on a user gesture, a paused live monitor IS the stall:
    // nudge it, and rebuild if it stays down.
    if (video.paused) {
      if (needsGesture) return;
      tryPlay();
      if (++wdStuck >= 2) { wdStuck = 0; retry(300); }
      return;
    }
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames
      ?? Math.round(video.currentTime * 30);
    const buf = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    const framesMoved = frames > wdFrames;
    const bufMoved = buf - wdBuf > 0.2;
    wdFrames = frames;
    wdBuf = buf;
    if (framesMoved || !bufMoved) { wdStuck = 0; return; }
    if (++wdStuck >= 2) { wdStuck = 0; retry(300); }
  }

  /** Consecutive failed attempts, for the reconnect backoff. */
  let attempts = 0;

  function retry(delay = 2000) {
    if (gone) return;
    connected = false;
    teardown();
    // A feed that cannot be played — server down, a proxy in the way, a
    // browser without Media Source — used to be retried every two seconds
    // indefinitely, each attempt logging a demuxer error. Back off to a
    // slow poll so a broken preview stays quiet instead of flooding the
    // console and the network.
    const wait = Math.min(delay * 2 ** Math.min(attempts, 4), 30_000);
    attempts += 1;
    retryTimer = setTimeout(connect, wait);
  }

  function connect() {
    if (gone) return;
    if (!mpegts.isSupported()) { unsupported = true; return; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    player = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: `${proto}//${location.host}/ws/preview` },
      {
        isLive: true,
        // Demuxing ~5 Mbps is nothing; the worker build is the fragile part.
        enableWorker: false,
        autoCleanupSourceBuffer: true,
        // Chase the head so the window stays a confidence monitor, not a
        // delayed replay: never more than ~3s behind the encoder.
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.8,
      },
    );
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, () => retry(2000));
    // The stream parsed — this connection reached real data, so the next
    // resync is not a failure to back off from. onplaying alone cannot be
    // the reset: autoplay policy can hold playback while data flows, and a
    // splice storm (pause spam, seeks) then ratchets the backoff to 30s
    // with no successful play to clear it — the preview lagging the actual
    // Owncast stream by an entire minute was this counter, stuck high.
    player.on(mpegts.Events.MEDIA_INFO, () => { attempts = 0; });
    // A clean close is the server resyncing us across a stream splice
    // (seek, track change, episode boundary) — come back quickly.
    player.on(mpegts.Events.LOADING_COMPLETE, () => retry(300));
    player.load();
    tryPlay();
    wdFrames = 0;
    wdBuf = 0;
    wdStuck = 0;
    watchdog = setInterval(checkStall, 3000);
  }

  /**
   * play() can reject for two very different reasons: called before the
   * MSE pipeline has media (fixed by retrying on canplay), or an autoplay
   * veto (fixed only by a user gesture, so surface a click-to-play state
   * instead of a frozen first frame).
   */
  function tryPlay() {
    video?.play()?.then(
      () => { needsGesture = false; },
      () => { needsGesture = true; },
    );
  }

  // A seam splice appended fresh content behind whatever this player had
  // buffered. Hop to it at once — waiting for the latency chaser to work
  // that out is the visible pause-and-stutter after a cache seek.
  function onSeam() {
    setTimeout(() => {
      if (!video || video.paused) return;
      const b = video.buffered;
      if (!b?.length) return;
      const end = b.end(b.length - 1);
      if (end - video.currentTime > 1.2) video.currentTime = Math.max(0, end - 0.8);
    }, 300);
  }

  onMount(() => {
    window.addEventListener('jsr-seam', onSeam);
    connect();
    return () => {
      window.removeEventListener('jsr-seam', onSeam); gone = true; teardown(); };
  });
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if dragging}
  <!-- The four docks it can snap to, with the one it will pick lit up. -->
  {#each ['tl', 'tr', 'bl', 'br'] as c}
    {@const p = dockPos(c)}
    <div class="dock" class:near={nearest === c}
         style:left="{p.x}px" style:top="{p.y}px"
         style:width="{width}px" style:height="{height}px"></div>
  {/each}
{/if}

<div class="pv" class:dragging role="dialog" aria-label="Live preview"
     style:left="{pos.x}px" style:top="{pos.y}px" style:width="{width}px"
     onpointerdown={onDown} onpointermove={onMove}
     onpointerup={onUp} onpointercancel={onUp}
     ondblclick={toggleSize}>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} {muted} autoplay playsinline
         style:height="{height}px"
         onplaying={() => { connected = true; needsGesture = false; attempts = 0; }}
         oncanplay={() => { if (video.paused) tryPlay(); }}></video>

  {#if needsGesture}
    <button class="gesture" onclick={tryPlay} aria-label="Play preview">
      <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
    </button>
  {:else if !connected}
    <div class="state">
      {#if unsupported}
        <p>This browser can't play the preview<br />(no Media Source support).</p>
      {:else}
        <span class="spin" aria-hidden="true"></span>
        <p>Connecting to the feed…</p>
      {/if}
    </div>
  {/if}

  <div class="bar">
    <span class="lv" title="The exact stream Owncast is receiving — a few seconds ahead of what viewers see">
      <span class="lvdot" class:on={connected}></span>Preview
    </span>
    <div class="grow"></div>
    <button class="b" onclick={toggleMute}
            title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}>
      {#if muted}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>
      {/if}
    </button>
    <button class="b" onclick={toggleSize}
            title={size === 's' ? 'Larger' : 'Smaller'} aria-label={size === 's' ? 'Larger' : 'Smaller'}>
      {#if size === 's'}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/></svg>
      {/if}
    </button>
    <button class="b" onclick={onclose} title="Hide preview" aria-label="Hide preview">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
  </div>
</div>

<style>
  .pv {
    position: fixed; z-index: 28;
    border-radius: 10px; overflow: hidden;
    background: #000;
    border: 1px solid var(--border);
    box-shadow: 0 10px 34px rgba(0, 0, 0, .4);
    cursor: grab; touch-action: none;
    user-select: none; -webkit-user-select: none;
    transition: left .25s cubic-bezier(.2, .8, .25, 1),
                top .25s cubic-bezier(.2, .8, .25, 1),
                width .18s ease, box-shadow .18s ease;
  }
  .pv.dragging {
    transition: width .18s ease;
    cursor: grabbing;
    box-shadow: 0 18px 50px rgba(0, 0, 0, .55);
  }
  video {
    display: block; width: 100%; background: #000;
    transition: height .18s ease;
    pointer-events: none;   /* the window handles the pointer, not the video */
  }

  .bar {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; align-items: center; gap: 4px;
    padding: 6px 6px 14px 10px;
    background: linear-gradient(rgba(0, 0, 0, .78), transparent);
    color: #eee;
    opacity: 0; transition: opacity .15s ease;
  }
  .pv:hover .bar, .pv:focus-within .bar, .pv.dragging .bar { opacity: 1; }
  .grow { flex: 1; }
  .lv {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; text-shadow: 0 1px 3px rgba(0, 0, 0, .6);
  }
  .lvdot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #777; transition: background .3s ease;
  }
  .lvdot.on { background: #e8493c; box-shadow: 0 0 6px rgba(232, 73, 60, .8); }
  .b {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0;
    background: rgba(255, 255, 255, .12); border: none; border-radius: 6px;
    color: #eee; cursor: pointer;
  }
  .b:hover { background: rgba(255, 255, 255, .25); }

  .state {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 8px;
    background: #000; color: var(--muted);
    font-size: 12px; text-align: center; line-height: 1.5;
  }
  .state p { margin: 0; }
  .spin {
    width: 18px; height: 18px; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, .15);
    border-top-color: rgba(255, 255, 255, .6);
    animation: pvspin .8s linear infinite;
  }
  @keyframes pvspin { to { transform: rotate(360deg); } }

  .gesture {
    position: absolute; inset: 0; width: 100%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, .45); border: none; color: #fff;
    cursor: pointer;
  }
  .gesture:hover { background: rgba(0, 0, 0, .3); }

  .dock {
    position: fixed; z-index: 27;
    border: 2px dashed var(--border); border-radius: 10px;
    opacity: .5; transition: opacity .12s ease, border-color .12s ease;
    pointer-events: none;
  }
  .dock.near { border-color: var(--accent); opacity: 1; }
</style>
