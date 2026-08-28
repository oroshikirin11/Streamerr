<script>
  import { onMount, onDestroy } from 'svelte';
  import mpegts from 'mpegts.js';
  import { api, connectStatus } from '$lib/api.js';

  /**
   * Overlay editor.
   *
   * Everything here is laid out in FRACTIONS of the output frame, never
   * pixels: with the frame-size modes a 4:3 episode goes out at 1440x1080
   * and a widescreen one at 1920x1080 in the same broadcast, and pixel
   * coordinates would walk a caption off the frame at every change of shape.
   *
   * Nothing touches the broadcast until Apply. Editing is local, so dragging
   * costs nothing — and a change to what is on air means restarting the
   * source, which viewers see as a brief re-buffer. One splice per Apply,
   * never one per drag.
   */

  let cfg = $state(null);
  let items = $state([]);
  let selected = $state(null);
  let dirty = $state(false);
  let busy = $state('');
  let error = $state('');
  let stage;                     // the frame element; all maths is relative to it

  const uid = () => Math.random().toString(36).slice(2, 10);

  // ── the live picture behind the overlays ───────────────────────────────
  // The same feed the floating preview uses: the publisher's own bytes, so
  // what is behind the captions is genuinely what is going out. It runs
  // about a bank-depth behind air, which is why placement is done against
  // the frame rather than by eye-matching a moment.
  let video;
  let player = null;
  let feed = $state('off');            // off | live | unsupported
  let retryTimer = null;
  /**
   * The frame's shape, which is NOT fixed at 16:9.
   *
   * With the frame-size modes a 4:3 episode broadcasts at 1440x1080. A
   * stage locked to 16:9 would letterbox that picture inside itself, and an
   * overlay placed near an edge would then sit on the bar rather than on
   * the picture — while appearing correct here. So the stage takes its
   * shape from what is actually going out: the live video's intrinsic size
   * when there is one, the configured output otherwise.
   */
  let liveAspect = $state(null);
  const aspect = $derived(
    liveAspect
    ?? ((+cfg?.encoder?.width || 1920) / (+cfg?.encoder?.height || 1080)));

  function onMeta() {
    if (video?.videoWidth > 0 && video?.videoHeight > 0) {
      liveAspect = video.videoWidth / video.videoHeight;
    }
  }

  let watchdog = null;
  let wdFrames = 0;
  let wdBuf = 0;
  let wdStuck = 0;
  let attempts = 0;

  function stopFeed() {
    clearTimeout(retryTimer); retryTimer = null;
    clearInterval(watchdog); watchdog = null;
    // The shape came from the feed; without it, fall back to the config.
    liveAspect = null;
    try { player?.destroy(); } catch { /* already gone */ }
    player = null;
  }

  /**
   * Rebuild the player after the feed goes away, backing off if it keeps
   * failing so a broken preview stays quiet instead of reconnecting forever.
   * Never while off air — watchBroadcast owns that transition.
   */
  function retryFeed(delay = 2000) {
    stopFeed();
    if (!onAir) return;
    const wait = Math.min(delay * 2 ** Math.min(attempts, 4), 30_000);
    attempts += 1;
    retryTimer = setTimeout(startFeed, wait);
  }

  /**
   * Backstop for a wedged decoder, same as the floating preview's: the
   * decoded-frame counter is the honest signal, because currentTime keeps
   * advancing over a frozen picture on an MSE stall. Frames stuck while
   * bytes still arrive means rebuild; frames stuck with nothing arriving is
   * a paused broadcast, where holding the last frame is correct.
   */
  function checkStall() {
    if (!video || !player) return;
    if (video.paused) {
      video.play?.().catch(() => {});
      if (++wdStuck >= 2) { wdStuck = 0; retryFeed(300); }
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
    if (++wdStuck >= 2) { wdStuck = 0; retryFeed(300); }
  }

  function startFeed() {
    if (!video || player) return;
    if (!mpegts.isSupported()) { feed = 'unsupported'; return; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    player = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: `${proto}//${location.host}/ws/preview` },
      { enableStashBuffer: false, liveBufferLatencyChasing: true },
    );
    player.attachMediaElement(video);
    // A splice cuts the socket by design; rebuild rather than sit frozen.
    player.on(mpegts.Events.ERROR, () => retryFeed(2000));
    // The connection reached real data, so the next resync is not a failure
    // to back off from.
    player.on(mpegts.Events.MEDIA_INFO, () => { attempts = 0; });
    /**
     * The one that was missing, and the reason applying an overlay froze
     * this stage while the floating preview carried on.
     *
     * Applying is a source restart, and the server closes the preview
     * socket CLEANLY across that splice — mpegts reports LOADING_COMPLETE,
     * not ERROR. With only an ERROR handler nothing fired, the player stayed
     * attached and non-null, and the stage held its last decoded frame for
     * the rest of the broadcast. Observed directly: two player inits at
     * startup, then one per apply, because only the floating preview — which
     * has always handled this event — was coming back.
     */
    player.on(mpegts.Events.LOADING_COMPLETE, () => retryFeed(300));
    try {
      player.load(); player.play?.().catch(() => {}); feed = 'live';
      wdFrames = 0; wdBuf = 0; wdStuck = 0;
      watchdog = setInterval(checkStall, 3000);
    } catch { stopFeed(); }
  }

  function toggleFeed() {
    if (player) { stopFeed(); feed = 'off'; } else { startFeed(); }
  }

  /**
   * Follow the broadcast so the stage does not keep showing a dead frame.
   *
   * When a broadcast ends the socket simply stops delivering, and mpegts
   * leaves the last decoded frame on screen — so the editor went on showing
   * a still of a stream that is no longer running, with overlays ghosted
   * against it as though they were on air. Tearing the player down clears
   * the element and puts the stage back to its empty state; going live
   * again brings it back.
   */
  let onAir = $state(false);
  let closeStatus = null;

  function watchBroadcast() {
    closeStatus = connectStatus((msg) => {
      if (msg.type !== 'stream') return;
      const live = msg.payload?.status === 'running' || msg.payload?.status === 'preparing';
      if (live === onAir) return;
      onAir = live;
      if (live) { attempts = 0; if (!player) startFeed(); }
      else { stopFeed(); feed = 'off'; }
    });
  }
  const sel = $derived(items.find((i) => i.id === selected) ?? null);

  onMount(async () => {
    try {
      cfg = await api.config();
      items = (cfg.overlay?.items ?? []).map((i) => ({ ...i, id: i.id ?? uid() }));
      hidden = cfg.overlay?.hidden === true;
      applied = snapshot(items);
      await loadPictures();
      const s = await api.streamStatus().catch(() => null);
      onAir = s?.status === 'running' || s?.status === 'preparing';
    } catch (err) { error = err.message; }
    watchBroadcast();
    if (onAir) startFeed();
  });

  // NOT `return stopFeed` from onMount. Svelte only calls a returned cleanup
  // when the onMount callback is synchronous — an async one returns a
  // Promise, which is silently ignored. So every visit to this page built
  // another mpegts player on the same <video> and never tore the old one
  // down: four visits, four demuxers decoding the same live stream into one
  // element. That is what froze the preview and made the editor feel dead,
  // because the main thread had no time left for pointer events.
  onDestroy(() => { stopFeed(); closeStatus?.(); });

  /**
   * Hiding everything without deleting anything.
   *
   * Kept out of the items themselves so it is one switch rather than a
   * sweep that would have to remember what was already off individually —
   * un-hiding then restores exactly the arrangement that was there before.
   */
  let hidden = $state(false);

  /**
   * What each item looked like when it was last saved, by id.
   *
   * The live picture behind the stage already has the applied overlays
   * BURNT INTO IT by the encoder — it is the finished broadcast, not a
   * clean backdrop. Drawing our own copy on top of that shows everything
   * twice. So an item that is already on air, unchanged, renders its box
   * and handles but not its content: the feed is showing the real thing,
   * and that is the honest preview.
   *
   * The moment it is edited it renders fully again, which is useful rather
   * than noisy — the burnt-in copy stays where it was until Apply, so you
   * see the old position and the new one side by side.
   */
  let applied = $state({});
  const snapshot = (list) => Object.fromEntries(list.map((i) => [i.id, JSON.stringify(i)]));
  const burntIn = (i) => feed === 'live' && !hidden && i.enabled !== false
    && applied[i.id] === JSON.stringify(i);

  // ── uploaded pictures ──────────────────────────────────────────────────
  let pictures = $state([]);
  let fileInput;

  async function loadPictures() {
    try { pictures = await api.get('/api/overlay/images'); } catch { pictures = []; }
  }

  async function onPick(e) {
    const files = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';          // so the same file can be picked twice
    if (!files.length) return;
    busy = 'upload'; error = '';
    try {
      for (const f of files) {
        const { name } = await api.uploadOverlayImage(f);
        add('image', name);
      }
      await loadPictures();
    } catch (err) { error = err.message; }
    busy = '';
  }

  async function deletePicture(name) {
    const used = items.filter((i) => i.file === name).length;
    const msg = used
      ? `Delete ${name}? ${used} overlay${used > 1 ? 's' : ''} using it will stop showing.`
      : `Delete ${name}?`;
    if (!confirm(msg)) return;
    busy = 'pic'; error = '';
    try {
      await api.del(`/api/overlay/images/${encodeURIComponent(name)}`);
      await loadPictures();
    } catch (err) { error = err.message; }
    busy = '';
  }

  function add(kind, file = null) {
    const base = { id: uid(), x: 0.5, y: 0.5, rotation: 0, opacity: 1,
                   motion: 'none', speed: BOUNCE_SPEED,
                   when: 'always', seconds: 15, enabled: true };
    const item = kind === 'image'
      ? { ...base, type: 'image', file, text: '', size: 0.2 }
      : kind === 'text'
        ? { ...base, type: 'text', text: 'New text', size: 0.06,
            colour: '#ffffff', outline: true }
        : { ...base, type: 'text', text: '{title}', y: 0.86, size: 0.05,
            colour: '#ffcc66', outline: true, when: 'outro' };
    items = [...items, item];
    selected = item.id;
    dirty = true;
  }

  function remove(id) {
    items = items.filter((i) => i.id !== id);
    if (selected === id) selected = null;
    dirty = true;
  }

  function patch(id, fields) {
    items = items.map((i) => (i.id === id ? { ...i, ...fields } : i));
    dirty = true;
  }

  /**
   * Bouncing pictures — the same closed form the encoder uses.
   *
   * This MUST stay in step with bouncePlace() in src/ffmpeg/overlay-image.js.
   * The stage is a preview of what goes out, and a motion that only matched
   * approximately would be worse than none: the operator would place things
   * against a lie. The encoder works in pixels against W-w and H-h; the same
   * expression in frame fractions is what follows.
   *
   * Phase is deliberately NOT matched to air. The encoder's phase is the
   * clip's media offset, and this preview runs a bank-depth behind anyway,
   * so the picture here is in the right PATH at the right speed but not at
   * the same point on it. Matching that would mean tracking the broadcast
   * clock to no benefit — what matters for placement is the path.
   */
  const BOUNCE_SPEED = 0.06;      // fraction of frame width per second
  let clock = $state(0);
  let rafId = null;
  const moves = (i) => i?.motion === 'bounce';

  // Natural aspect per file, so the picture's HEIGHT is known — the encoder
  // scales by width and keeps aspect, and the y bounce needs the result.
  let picAspect = $state({});
  function onPicLoad(e, file) {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w > 0 && h > 0 && picAspect[file] !== w / h) {
      picAspect = { ...picAspect, [file]: w / h };
    }
  }

  function bouncePos(item, idx) {
    const size = Number(item.size) || 0.2;
    const ar = picAspect[item.file] || 1;
    // Work in units where the frame is 1 wide and 1/aspect tall, so both
    // axes share a scale and the rotation maths below is the ordinary one.
    const w = size;
    const h = size / ar;
    /**
     * The bounce is bounded by the ROTATED box, not the upright one.
     *
     * The encoder rotates the picture before it reaches overlay, with
     * ow=rotw(a):oh=roth(a) — so the w and h that overlay bounces against
     * are the rotated bounding box, which is larger for any angle that is
     * not a multiple of 180 degrees. Ignoring that here gave the preview a
     * bigger travel range than the broadcast had, so the two turned at
     * different points on the edges: not a phase difference but a different
     * path, which is what made it look wrong rather than merely late.
     */
    const a = ((Number(item.rotation) || 0) * Math.PI) / 180;
    const rw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const rh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    const rhf = Math.min(1, rh * aspect);          // as a fraction of frame HEIGHT
    const rx = Math.max(0.0001, 1 - Math.min(1, rw));
    const ry = Math.max(0.0001, 1 - rhf);
    const t = clock + idx * 3.1;
    const v = Math.min(1, Math.max(0, Number(item.speed) ?? BOUNCE_SPEED));
    const tri = (u, r) => Math.abs(((u % (2 * r)) + 2 * r) % (2 * r) - r);
    // One speed in PIXELS per second for both axes, exactly as the encoder
    // does it — which in fractions means the vertical rate is scaled by the
    // frame's aspect. Equal fractional speeds would tilt the angle.
    return {
      x: tri(v * t, rx) + rw / 2,
      y: tri(v * aspect * t, ry) + rhf / 2,
    };
  }

  /**
   * Animate the ghost only while it is OURS to animate.
   *
   * Once an item is burnt in, the feed already shows the real picture moving
   * and this box is just its marker. It cannot line up: the preview runs a
   * bank-depth behind air and the editor has no frame-accurate media clock,
   * so an animated marker chases the real picture around the frame at the
   * wrong phase and reads as a second, broken copy. Parked at its stored
   * position it claims nothing, and still selects, drags and deletes.
   */
  const ghostPos = (item, idx) => (moves(item) && !burntIn(item)
    ? bouncePos(item, idx)
    : { x: item.x, y: item.y });

  /** Only run a frame loop while something is actually moving. */
  $effect(() => {
    const any = items.some(moves);
    if (any && rafId == null) {
      const tick = () => { clock = performance.now() / 1000; rafId = requestAnimationFrame(tick); };
      rafId = requestAnimationFrame(tick);
    } else if (!any && rafId != null) {
      cancelAnimationFrame(rafId); rafId = null;
    }
    return () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };
  });

  // ── direct manipulation ────────────────────────────────────────────────
  // Pointer events rather than mouse: one code path covers a trackpad, a
  // touchscreen and a pen, and setPointerCapture keeps the gesture alive
  // when the cursor leaves the element mid-drag — which it always does at
  // speed, and which is what makes a naive implementation feel sticky.

  function startDrag(e, item) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    selected = item.id;
    const box = stage.getBoundingClientRect();
    // Grab offset, so the item does not jump to centre under the cursor.
    const dx = e.clientX - (box.left + item.x * box.width);
    const dy = e.clientY - (box.top + item.y * box.height);
    const move = (ev) => {
      const x = (ev.clientX - dx - box.left) / box.width;
      const y = (ev.clientY - dy - box.top) / box.height;
      patch(item.id, {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startRotate(e, item) {
    e.preventDefault();
    e.stopPropagation();
    selected = item.id;
    const box = stage.getBoundingClientRect();
    const cx = box.left + item.x * box.width;
    const cy = box.top + item.y * box.height;
    const move = (ev) => {
      // atan2 from the item's centre, +90 because the handle sits above it.
      let deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      if (deg > 180) deg -= 360;
      // Shift snaps to 15°, the usual escape hatch from fiddly angles.
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      patch(item.id, { rotation: Math.round(deg * 10) / 10 });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startResize(e, item) {
    e.preventDefault();
    e.stopPropagation();
    selected = item.id;
    const box = stage.getBoundingClientRect();
    const cy = box.top + item.y * box.height;
    const start = Math.abs(e.clientY - cy) || 1;
    const base = item.size;
    // A picture's size is its width across the frame, so it has to be
    // allowed to reach full width; text's is a font size, where anything
    // approaching that is already unusable.
    const max = item.type === 'image' ? 1 : 0.4;
    const move = (ev) => {
      const now = Math.abs(ev.clientY - cy) || 1;
      patch(item.id, { size: Math.min(max, Math.max(0.015, base * (now / start))) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Arrow keys nudge the selection; the fine adjustment a mouse cannot do. */
  function onKey(e) {
    if (!sel || /input|textarea|select/i.test(e.target?.tagName ?? '')) return;
    const step = e.shiftKey ? 0.05 : 0.004;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      patch(sel.id, {
        x: Math.min(1, Math.max(0, sel.x + moves[e.key][0])),
        y: Math.min(1, Math.max(0, sel.y + moves[e.key][1])),
      });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(sel.id);
    } else if (e.key === 'Escape') {
      selected = null;
    }
  }

  async function save(overlay) {
    await api.saveConfig({ overlay });
    applied = snapshot(overlay.items ?? items);
    dirty = false;
  }

  /**
   * Applying no longer takes effect the moment the request returns.
   *
   * The engine keeps its encoded cushion across an overlay change now — the
   * alternative was throwing it away, which left the publisher with nothing
   * to send and put a buffering spinner in front of every viewer. The cost
   * is that the change goes on air when that cushion drains, several seconds
   * later. The request itself still completes immediately, so without this
   * the button flashed 'Applying…' for a few milliseconds and then nothing
   * visible happened until the overlay appeared out of nowhere.
   */
  let pending = $state('');   // '' | 'apply' | 'hide'
  let pendingTimer = null;

  async function apply() {
    busy = 'apply'; error = '';
    try {
      await save({ items, hidden });
      /**
       * Applying while hidden is the one case where Apply looks broken.
       *
       * The edit saves, but `visibleOverlay()` is empty, so the engine is
       * handed the empty set it already holds, dedupes it, and never
       * respawns — no picture, and not even a line in the console. An
       * operator who missed the hidden banner has no way to tell that from a
       * broken Apply, so say it here, where they are looking.
       */
      pending = hidden ? 'apply-hidden' : 'apply';
      clearTimeout(pendingTimer);
      // Cleared on a timer rather than on a signal: the panel is not told the
      // reserve depth, so there is nothing to count down from honestly. The
      // note says "about", and the timer outlasts a full bank.
      pendingTimer = setTimeout(() => { pending = ''; }, 20000);
    } catch (err) { error = err.message; }
    busy = '';
  }

  /**
   * The step between "on air" and "deleted".
   *
   * This one writes straight through rather than waiting for Apply: it is
   * the button reached for when something is on screen that should not be,
   * and asking for a second click then would be the wrong answer.
   */
  async function toggleHidden() {
    busy = 'hide'; error = '';
    const next = !hidden;
    try {
      // Only the flag. Sending the items too would commit whatever is
      // half-edited on the frame, so reaching for Hide because something
      // wrong is on air would put the rest of that edit on air with it.
      // `dirty` is deliberately left alone: unsaved edits stay unsaved.
      await api.saveConfig({ overlay: { hidden: next } });
      hidden = next;
      // Hiding goes through setOverlay exactly like Apply does, so it lands
      // when the cushion drains too. Without this the button that is reached
      // for BECAUSE something wrong is on air was the one that looked like it
      // had done nothing.
      pending = 'hide';
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pending = ''; }, 20000);
    } catch (err) { error = err.message; }
    busy = '';
  }

  async function clearAll() {
    if (items.length && !confirm(
      'Remove every overlay? To take them off air without losing them, use Hide instead.',
    )) return;
    busy = 'clear'; error = '';
    try {
      await save({ items: [], hidden });
      items = []; selected = null;
    } catch (err) { error = err.message; }
    busy = '';
  }

  const whenLabel = (i) => (i.when === 'intro' ? `first ${i.seconds}s`
    : i.when === 'outro' ? `last ${i.seconds}s` : 'always');
</script>

<svelte:window on:keydown={onKey} />

<div class="wrap">
  <div class="head">
    <h1>Studio</h1>
    <!-- Three groups, because these buttons do three unrelated things:
         what you can SEE while editing, what you can ADD, and what reaches
         the BROADCAST. Mixed together, the only destructive buttons sat
         next to the harmless ones. -->
    <div class="group">
      <button onclick={toggleFeed} disabled={!onAir}
              title={onAir
                ? 'Show the picture that is going out behind your overlays'
                : 'Nothing is on air to show'}>
        {feed === 'live' ? 'Hide the picture' : 'Show the picture'}
      </button>
    </div>

    <div class="group">
      <button onclick={() => add('text')}>Add text</button>
      <button onclick={() => add('nowplaying')}
              title="A caption that fills in whatever episode is playing, shown before it ends">
        Add now-playing
      </button>
      <button onclick={() => fileInput.click()} disabled={busy === 'upload'}>
        {busy === 'upload' ? 'Uploading…' : 'Add picture'}
      </button>
      <input type="file" bind:this={fileInput} onchange={onPick} multiple
             accept="image/png,image/gif,image/jpeg,image/webp" style="display:none" />
    </div>

    <!-- Everything that reaches the broadcast is pushed to the far side, so
         the buttons that change what viewers see are nowhere near the ones
         that only add to the canvas. -->
    <div class="spacer"></div>

    <div class="group">
      <button class:warn={hidden} onclick={toggleHidden} disabled={busy === 'hide'}
              title="Take every overlay off air without deleting anything">
        {hidden ? 'Show on broadcast' : 'Hide from broadcast'}
      </button>
      <button class="danger" onclick={clearAll} disabled={busy === 'clear' || !items.length}>Remove all</button>
      <button class="primary" onclick={apply} disabled={!dirty || busy === 'apply'}>
        {busy === 'apply' ? 'Applying…' : 'Apply to broadcast'}
      </button>
    </div>
  </div>
  {#if hidden}
    <p class="warnbar" role={pending === 'apply-hidden' ? 'alert' : null}>
      {#if pending === 'apply-hidden'}
        Saved — but <strong>nothing went on air</strong>, because overlays are
        hidden. The edit is kept and goes out the moment you show them again.
      {:else}
        Overlays are hidden — nothing here is on air. Editing and Apply still
        work, and everything reappears when you show them again.
      {/if}
      <!-- The fix offered where the confusion happens, so noticing the
           problem and correcting it are the same click. -->
      <button class="inline" onclick={toggleHidden} disabled={busy === 'hide'}>
        Show on broadcast
      </button>
    </p>
  {/if}
  {#if pending && pending !== 'apply-hidden'}
    <p class="pending" role="status">
      <span class="spin" aria-hidden="true"></span>
      {pending === 'hide'
        ? 'Taking the overlays off air — about 15 seconds.'
        : 'Applied — going on air in about 15 seconds.'}
      The broadcast plays out what it has already encoded first, so viewers
      see no interruption.
    </p>
  {/if}
  {#if error}<p class="err">{error}</p>{/if}

  <div class="cols">
    <!-- The frame. 16:9 because that is the configured output; items are
         positioned as percentages so this scales to any window width. -->
    <div class="stagewrap">
      <div class="stage" bind:this={stage} style={`aspect-ratio:${aspect}`}
           onpointerdown={(e) => { if (e.target === stage) selected = null; }}>
        <!-- Behind everything, and never a drag target: clicking the picture
             should deselect, exactly as clicking bare stage does. -->
        <video bind:this={video} class="feed" class:on={feed === 'live'}
               onloadedmetadata={onMeta} onresize={onMeta}
               muted playsinline disablepictureinpicture></video>
        <div class="grid" aria-hidden="true"></div>
        {#each items as item, idx (item.id)}
          <!-- A picture gets no font-size: it is set inline for text, and an
               inline value would beat the class that collapses the line box.
               Left in, the box grew a whole line taller than the image and
               the resize handle sat well below the corner it belongs to. -->
          <div class="item" class:on={selected === item.id} class:off={item.enabled === false}
               class:isimg={item.type === 'image'} class:burnt={burntIn(item)}
               style={`left:${ghostPos(item, idx).x * 100}%;
                       top:${ghostPos(item, idx).y * 100}%;
                       transform: translate(-50%,-50%);
                       ${item.type === 'image' ? ''
                         : `font-size:${item.size * 100}cqh; color:${item.colour};`}
                       opacity:${item.enabled === false ? 0.35 : (item.opacity ?? 1)};`}
               onpointerdown={(e) => startDrag(e, item)}
               role="button" tabindex="0"
               aria-label={`${item.type === 'image' ? item.file : item.text} — drag to move`}>
            <!--
              The rotation lives HERE, not on .item, and the two must never be
              merged back together.

              An opacity below 1 promotes .item to its own compositor layer.
              Firefox 154 then clips that layer against the frame in the
              layer's OWN rotated space rather than the frame's, so a picture
              turned 180deg and pushed towards an edge lost the opposite side
              — it looked cut in half, while the broadcast was perfectly
              fine. Measured across nine arrangements in both engines: every
              one that carried opacity and rotate on the same element failed
              in Firefox, including will-change, translateZ(0),
              filter: opacity() and scale(-1,-1); the only two that survived
              were this one and putting the rotation on the leaf. Chrome
              renders all nine identically, so this costs nothing there.

              The handles live inside the wrapper so they still turn with the
              picture, and `transform` makes the wrapper their containing
              block. Rotating about the centre leaves the centre where it
              was, so startDrag/startRotate/startResize need no changes.
            -->
            <div class="turn" style={`transform: rotate(${item.rotation}deg)`}>
              {#if item.type === 'image'}
                <!-- Width as a fraction of the FRAME, matching how ffmpeg
                     scales it, so what is dragged here is what goes out. -->
                <img class="pic" src={`/api/overlay/images/${encodeURIComponent(item.file)}`}
                     alt={item.file} draggable="false"
                     onload={(e) => onPicLoad(e, item.file)}
                     style={`width:${item.size * 100}cqw`} />
              {:else}
                <!-- No whitespace inside the span: `white-space: pre` renders
                     the template's own newline and indentation as real space,
                     which widened the box and pushed the glyphs off centre
                     from where the encoder puts them. -->
                <span class="txt" class:outline={item.outline !== false}>{item.text.replace('{title}', 'Episode title')}</span>
              {/if}
              {#if selected === item.id}
                <span class="handle rot" onpointerdown={(e) => startRotate(e, item)}
                      role="button" tabindex="-1" aria-label="Rotate"></span>
                <span class="handle size" onpointerdown={(e) => startResize(e, item)}
                      role="button" tabindex="-1" aria-label="Resize"></span>
              {/if}
            </div>
          </div>
        {/each}
        {#if !onAir}
          <p class="empty">
            Nothing is on air. Overlays still edit and apply — they go out
            with the next broadcast.
          </p>
        {:else if !items.length}
          <p class="empty">Nothing on screen yet — add some text to place it here.</p>
        {/if}
        {#if feed === 'unsupported'}
          <p class="empty">This browser cannot show the live picture; placement still works.</p>
        {/if}
      </div>
      <p class="muted small hint">
        Drag to move, corner handle to resize, top handle to rotate.
        Arrow keys nudge, Shift for bigger steps, Delete removes.
        Positions are proportional, so they hold their place whatever shape
        the picture is.
      </p>
    </div>

    <!-- Properties on the left, inventory on the right, picture between
         them: what you are editing sits beside the thing it changes, and
         the lists stay out of the way. -->
    <div class="side left">
      {#if sel}
        <div class="card">
          <h3>Selected</h3>
          {#if sel.type === 'image'}
            <label>Picture</label>
            <select value={sel.file}
                    onchange={(e) => patch(sel.id, { file: e.currentTarget.value })}>
              {#each pictures as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
            </select>
            {#if sel.file && !pictures.some((p) => p.name === sel.file)}
              <p class="err small">This picture has been deleted, so it will not show.</p>
            {/if}
          {:else}
            <label>Text</label>
            <textarea rows="2" value={sel.text}
                      oninput={(e) => patch(sel.id, { text: e.currentTarget.value })}></textarea>
            <p class="muted small">
              <code>{'{title}'}</code> is replaced with whatever is playing.
            </p>
          {/if}

          <div class="row2">
            {#if sel.type !== 'image'}
              <div><label>Colour</label>
                <input type="color" value={sel.colour}
                       oninput={(e) => patch(sel.id, { colour: e.currentTarget.value })} /></div>
            {/if}
            <div><label>Size</label>
              <input type="range" min="1.5" max={sel.type === 'image' ? 100 : 30} step="0.5"
                     value={sel.size * 100}
                     oninput={(e) => patch(sel.id, { size: +e.currentTarget.value / 100 })} /></div>
          </div>

          <label>Rotation <span class="muted small">{sel.rotation}°</span></label>
          <input type="range" min="-180" max="180" step="1" value={sel.rotation}
                 oninput={(e) => patch(sel.id, { rotation: +e.currentTarget.value })} />

          <label>Opacity <span class="muted small">{Math.round((sel.opacity ?? 1) * 100)}%</span></label>
          <input type="range" min="5" max="100" step="1" value={(sel.opacity ?? 1) * 100}
                 oninput={(e) => patch(sel.id, { opacity: +e.currentTarget.value / 100 })} />

          <!-- Movement is described, never keyframed: the position is an
               expression the encoder evaluates per frame, so a moving
               picture is applied once like any other and costs no extra
               splices however long it runs. -->
          <label>Movement</label>
          <select value={sel.motion ?? 'none'}
                  onchange={(e) => patch(sel.id, { motion: e.currentTarget.value })}>
            <option value="none">Stay where I put it</option>
            <option value="bounce">Bounce around the frame</option>
          </select>

          {#if sel.motion === 'bounce'}
            <label>Speed <span class="muted small">{Math.round((sel.speed ?? BOUNCE_SPEED) * 100)}% of the frame per second</span></label>
            <input type="range" min="1" max="40" step="1"
                   value={(sel.speed ?? BOUNCE_SPEED) * 100}
                   oninput={(e) => patch(sel.id, { speed: +e.currentTarget.value / 100 })} />
            <p class="muted small">
              It travels corner to corner and turns at the edges, so where you
              drag it no longer matters — the frame decides. Drawn on the CPU,
              because the GPU compositor can only place a picture once.
            </p>
          {/if}

          {#if sel.type !== 'image'}
            <label style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" checked={sel.outline !== false} style="width:auto"
                     onchange={(e) => patch(sel.id, { outline: e.currentTarget.checked })} />
              Outline — keeps it readable on any picture
            </label>
          {/if}

          <label>When</label>
          <select value={sel.when} onchange={(e) => patch(sel.id, { when: e.currentTarget.value })}>
            <option value="always">The whole episode</option>
            <option value="intro">Only at the start</option>
            <option value="outro">Only before it ends</option>
          </select>
          {#if sel.when !== 'always'}
            <label class="row"><span>For</span>
              <input type="number" min="1" max="600" value={sel.seconds} style="width:80px"
                     oninput={(e) => patch(sel.id, { seconds: +e.currentTarget.value || 15 })} />
              <span>seconds</span></label>
          {/if}

          <div class="actions">
            <button onclick={() => patch(sel.id, { enabled: sel.enabled === false })}>
              {sel.enabled === false ? 'Show' : 'Hide'}
            </button>
            <div style="flex:1"></div>
            <button class="danger" onclick={() => remove(sel.id)}>Remove</button>
          </div>
        </div>
      {:else}
        <div class="card">
          <h3>Overlays</h3>
          <p class="muted small">Select something on the frame, or add a new one.</p>
        </div>
      {/if}
    </div>

    <div class="side right">
      {#if items.length}
        <div class="card">
          <h3>On screen</h3>
          <ul class="list">
            {#each items as i (i.id)}
              <li class:on={selected === i.id} class:off={i.enabled === false}>
                <button class="pick" onclick={() => (selected = i.id)}>
                  <span class="dot" style={`background:${i.type === 'image' ? '#7b8794' : i.colour}`}></span>
                  <span class="nm">
                    {i.type === 'image' ? (i.file || '(no picture)') : (i.text.slice(0, 24) || '(empty)')}
                  </span>
                  <span class="muted small">{whenLabel(i)}</span>
                </button>
                <!-- A switch, not a delete. Turning something off to see the
                     frame without it is the common move; losing the item in
                     the process is not what was meant. -->
                <button class="tog" role="switch" aria-checked={i.enabled !== false}
                        title={i.enabled === false ? 'Show this overlay' : 'Hide this overlay'}
                        onclick={() => patch(i.id, { enabled: i.enabled === false })}>
                  <span class="knob"></span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if pictures.length}
        <div class="card">
          <h3>Pictures</h3>
          <ul class="list">
            {#each pictures as p (p.name)}
              <li>
                <button class="pick" title="Place another copy on the frame"
                        onclick={() => add('image', p.name)}>
                  <img class="thumb" src={`/api/overlay/images/${encodeURIComponent(p.name)}`} alt="" />
                  <span class="nm">{p.name}</span>
                  <span class="muted small">{Math.max(1, Math.round(p.bytes / 1024))} KB</span>
                </button>
                <button class="tog del" title="Delete this picture"
                        disabled={busy === 'pic'}
                        onclick={() => deletePicture(p.name)}>×</button>
              </li>
            {/each}
          </ul>
          <p class="muted small">
            PNG, GIF, JPEG or WebP. Animated GIFs play. Click one to place
            another copy on the frame.
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Wider than the other pages on purpose: this one is a viewer, and the
     picture is the point. The side columns are fixed, so every extra pixel
     of window goes to the stage rather than to the panels. */
  .wrap { max-width: 1900px; margin: 0 auto; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  /* Each group is one segmented control: a single tray holding buttons that
     belong together. That reads as grouping on its own, without the divider
     lines a row of separate buttons would need. */
  .group {
    display: flex; align-items: center; gap: 2px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; padding: 3px;
  }
  .head button {
    height: 30px; padding: 0 11px; font-size: 13px; font-weight: 500;
    color: inherit; background: transparent; border: none;
    border-radius: 7px; cursor: pointer; white-space: nowrap;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .head button:hover:not(:disabled) { background: var(--surface-2); }
  .head button:disabled { opacity: 0.4; cursor: default; }
  /* The one button that changes what viewers see reads as the commit. */
  .head button.primary { background: var(--accent); color: #fff; }
  .head button.primary:hover:not(:disabled) { filter: brightness(1.1); }
  .head button.danger { color: var(--danger, #e5484d); }
  .head button.warn { color: var(--accent); }
  .head h1 { margin: 0; }
  .spacer { flex: 1; }
  .cols {
    display: grid; grid-template-columns: 300px minmax(0, 1fr) 320px;
    gap: 16px; align-items: start;
  }
  .side.left { grid-column: 1; grid-row: 1; }
  .stagewrap { grid-column: 2; grid-row: 1; }
  .side.right { grid-column: 3; grid-row: 1; }
  /* Two columns first — the picture keeps its width and the lists move
     under it — then one, rather than squeezing three the whole way down. */
  @media (max-width: 1240px) {
    .cols { grid-template-columns: 280px minmax(0, 1fr); }
    .side.right { grid-column: 1 / -1; grid-row: 2; }
  }
  @media (max-width: 860px) {
    .cols { grid-template-columns: 1fr; }
    .side.left { grid-column: 1; grid-row: 2; }
    .stagewrap { grid-column: 1; grid-row: 1; }
    .side.right { grid-column: 1; grid-row: 3; }
  }

  .pending {
    display: flex; align-items: center; gap: 8px;
    margin: 8px 0 0; font-size: 13px; color: var(--muted);
  }
  .spin {
    width: 12px; height: 12px; flex: none; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--accent, #6aa6ff);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }

  .stage {
    position: relative; container-type: size;
    background: #0b0d10; border: 1px solid var(--border); border-radius: 12px;
    overflow: hidden; user-select: none; touch-action: none;
    /* `overflow: hidden` alone does NOT clip an overlay whose opacity is
       below 1. Opacity promotes the item to its own compositor layer, and a
       layer is clipped by an ancestor only when that ancestor carries the
       clip itself — `container-type: size` gives layout/style/size
       containment but not paint, so the picture escaped the frame on the
       side it overhung and the operator saw it spill outside the stage.
       Broadcast output was never affected: the encoder crops geometrically
       and does not care about any of this. Paint containment puts the clip
       on the stage where the compositor can honour it. */
    contain: paint;
  }
  /* Thirds, faint: placing to a grid is most of what makes an overlay look
     deliberate rather than dropped. */
  .grid {
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(to right, transparent 33.2%, rgba(255,255,255,.07) 33.3%, transparent 33.4%,
        transparent 66.5%, rgba(255,255,255,.07) 66.6%, transparent 66.7%),
      linear-gradient(to bottom, transparent 33.2%, rgba(255,255,255,.07) 33.3%, transparent 33.4%,
        transparent 66.5%, rgba(255,255,255,.07) 66.6%, transparent 66.7%);
  }
  .feed {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: fill; background: #000;
    opacity: 0; transition: opacity .25s ease; pointer-events: none;
  }
  .feed.on { opacity: 1; }
  .empty {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 13px; pointer-events: none;
  }

  .item {
    position: absolute; cursor: grab;
    /* Both of these exist to make the editor agree with the encoder.
       The overlay is burnt by libass in DejaVu Sans (the ASS style's font),
       so rendering here in the panel's UI font put the same string at a
       different width and a different apparent size — the two copies were
       visibly out of register. `normal` leading likewise: libass lays a
       line out on the font's own metrics, and an invented 1.15 shifted the
       vertical centre, because \an5 and translate(-50%,-50%) then centre
       two different boxes. */
    font-family: 'DejaVu Sans', DejaVu, Verdana, sans-serif;
    line-height: normal;
    border-radius: 4px;
  }
  /* Already burnt into the picture behind: keep the box and the handles,
     drop the duplicate. visibility, not display, so the outline still
     traces the real extents of the text. */
  .item.burnt .txt, .item.burnt .pic { visibility: hidden; }
  .item.burnt > .turn { outline: 1px dashed color-mix(in srgb, var(--muted) 70%, transparent); }
  .item.burnt:hover > .turn, .item.burnt.on > .turn { outline: 1px dashed var(--accent); }
  /* No line box at all, so the outline hugs the picture and the resize
     handle sits on its actual corner.
     Named `isimg`, NOT `pic`: `pic` is the <img> inside, and that rule
     carries pointer-events:none so the picture never swallows the drag.
     Sharing the name applied it to the CONTAINER too, which made every
     picture overlay unclickable — no grab cursor, no drag, while text
     worked fine. */
  .item.isimg { font-size: 0; line-height: 0; padding: 0; }
  .item:active { cursor: grabbing; }
  .item.off { opacity: .35; }
  /* Selection and burnt-in outlines sit on the ROTATING wrapper, so they
     still hug the content when it is turned. On .item they would stay
     axis-aligned while the picture leaned. */
  .item.on > .turn { outline: 1px dashed var(--accent); outline-offset: 3px; }
  /* The wrapper adds no box of its own — it only carries the rotation and
     anchors the handles. NOT named .spin: that class is the pending
     indicator's spinner, and sharing the name set every overlay turning
     on a loop. */
  .turn { position: relative; }
  /* On the text itself, NOT on .item. Multi-line captions need their line
     breaks kept, but on the container it also preserved the template's own
     newlines between blocks — 12px of invisible whitespace that widened the
     box and left the glyphs sitting off-centre inside it, so the editor
     drew the caption ~14px left of where the encoder burns it. */
  .txt { white-space: pre; }
  .txt.outline {
    text-shadow: 0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000;
  }

  .handle {
    position: absolute; width: 13px; height: 13px; border-radius: 50%;
    background: var(--accent); border: 2px solid var(--bg); cursor: pointer;
  }
  .handle.rot { left: 50%; top: -26px; transform: translateX(-50%); cursor: alias; }
  .handle.size { right: -9px; bottom: -9px; border-radius: 3px; cursor: nwse-resize; }
  .hint { margin-top: 8px; }

  .side { display: flex; flex-direction: column; gap: 12px; }
  .side .card { padding: 14px; }
  .side h3 { margin: 0 0 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input, select, textarea { width: 100%; font: inherit; color: inherit;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 7px 10px; }
  input[type="color"] { padding: 2px; height: 34px; }
  input[type="range"] { padding: 0; border: none; background: none; }
  .row2 { display: grid; grid-template-columns: 84px 1fr; gap: 10px; align-items: end; }
  .row { display: flex; align-items: center; gap: 8px; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }

  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .pick { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    background: none; border: none; padding: 7px 8px; border-radius: 8px; }
  .list li.on .pick { background: var(--surface-2); }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Pictures are sized as a fraction of the frame width, exactly as ffmpeg
     scales them, so the stage stays an honest preview. */
  .pic { display: block; height: auto; pointer-events: none; }
  .thumb {
    width: 22px; height: 22px; flex: none; object-fit: contain;
    background: var(--surface-2); border-radius: 4px;
  }

  /**
   * min-width:0 is load-bearing, not tidiness.
   *
   * A flex item defaults to min-width:auto, which refuses to shrink below its
   * content. With a long upload name nothing in the row would give, so the row
   * grew past its own box and pushed the switch — which is flex:none, rightly
   * — clear outside the card. Measured at 28-38px of overhang.
   *
   * Letting the name be the item that shrinks, and truncating it, keeps every
   * fixed-size control inside the row whatever the file is called.
   */
  .list li { display: flex; align-items: center; gap: 4px; min-width: 0; }
  /* The first child is the row's label — a button here, a span there. Whatever
     it is, it is the part that may shrink; every control after it is fixed. */
  .list li > :first-child { flex: 1 1 auto; min-width: 0; }
  .list .nm {
    min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  /* Past about fifteen rows the card would push the rest of the panel off the
     page. Cap it and scroll instead; the height is in rows, not pixels, so it
     stays right if the row metrics change. */
  .list {
    max-height: calc(15 * 30px); overflow-y: auto; overscroll-behavior: contain;
  }
  .list li.off .nm { text-decoration: line-through; opacity: 0.55; }

  /* A switch that reads as a switch: the state is visible in the list
     without selecting the item, which is the whole point of having it. */
  .tog {
    flex: none; width: 34px; height: 20px; padding: 0; border-radius: 999px;
    border: 1px solid var(--border); background: var(--surface-2);
    position: relative; cursor: pointer; transition: background 0.12s;
  }
  .tog[aria-checked="true"] { background: var(--accent); border-color: var(--accent); }
  .knob {
    position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: var(--bg); transition: transform 0.12s;
  }
  .tog[aria-checked="true"] .knob { transform: translateX(14px); }
  .tog.del {
    width: 24px; border-radius: 6px; color: var(--muted);
    font-size: 16px; line-height: 1;
  }
  .tog.del:hover { color: var(--danger, #e5484d); }

  .warnbar {
    margin: 0 0 14px; padding: 8px 12px; border-radius: var(--radius);
    background: var(--surface-2); border: 1px solid var(--border);
    color: var(--muted); font-size: 13px;
  }
  /* Applying into a hidden broadcast is a dead end, not a status: it gets the
     warning colour so it reads differently from the standing notice it
     replaces, which sat there long enough to stop being read. */
  .warnbar[role='alert'] {
    color: var(--text); border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, var(--surface-2));
  }
  .warnbar .inline {
    margin-left: 8px; padding: 2px 8px; font-size: 12px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); cursor: pointer;
  }
  .warnbar .inline:disabled { opacity: 0.5; cursor: default; }
  .head button.warn { border-color: var(--accent); color: var(--accent); }
</style>
