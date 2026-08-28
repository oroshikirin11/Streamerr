<script>
  import { onMount } from 'svelte';
  import mpegts from 'mpegts.js';
  import { api } from '$lib/api.js';

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

  function stopFeed() {
    clearTimeout(retryTimer); retryTimer = null;
    try { player?.destroy(); } catch { /* already gone */ }
    player = null;
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
    player.on(mpegts.Events.ERROR, () => {
      stopFeed();
      retryTimer = setTimeout(startFeed, 2000);
    });
    try { player.load(); player.play?.().catch(() => {}); feed = 'live'; } catch { stopFeed(); }
  }

  function toggleFeed() {
    if (player) { stopFeed(); feed = 'off'; } else { startFeed(); }
  }
  const sel = $derived(items.find((i) => i.id === selected) ?? null);

  onMount(async () => {
    try {
      cfg = await api.config();
      items = (cfg.overlay?.items ?? []).map((i) => ({ ...i, id: i.id ?? uid() }));
    } catch (err) { error = err.message; }
    startFeed();
    return stopFeed;
  });

  function add(kind) {
    const item = kind === 'text'
      ? { id: uid(), type: 'text', text: 'New text', x: 0.5, y: 0.5, size: 0.06,
          colour: '#ffffff', rotation: 0, outline: true, when: 'always', seconds: 15, enabled: true }
      : { id: uid(), type: 'text', text: '{title}', x: 0.5, y: 0.86, size: 0.05,
          colour: '#ffcc66', rotation: 0, outline: true, when: 'outro', seconds: 15, enabled: true };
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
    const move = (ev) => {
      const now = Math.abs(ev.clientY - cy) || 1;
      patch(item.id, { size: Math.min(0.4, Math.max(0.015, base * (now / start))) });
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

  async function apply() {
    busy = 'apply'; error = '';
    try {
      await api.saveConfig({ overlay: { items: items.map(({ id, ...rest }) => ({ id, ...rest })) } });
      dirty = false;
    } catch (err) { error = err.message; }
    busy = '';
  }

  async function clearAll() {
    if (items.length && !confirm('Remove every overlay from the broadcast?')) return;
    busy = 'clear'; error = '';
    try {
      await api.saveConfig({ overlay: { items: [] } });
      items = []; selected = null; dirty = false;
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
    <div class="spacer"></div>
    <button onclick={toggleFeed} title="Show the picture that is going out behind your overlays">
      {feed === 'live' ? 'Hide the picture' : 'Show the picture'}
    </button>
    <button onclick={() => add('text')}>Add text</button>
    <button onclick={() => add('nowplaying')} title="A caption bound to whatever is playing">Add now-playing</button>
    <button class="danger" onclick={clearAll} disabled={busy === 'clear' || !items.length}>Remove all</button>
    <button class="primary" onclick={apply} disabled={!dirty || busy === 'apply'}>
      {busy === 'apply' ? 'Applying…' : 'Apply to broadcast'}
    </button>
  </div>
  {#if error}<p class="err">{error}</p>{/if}

  <div class="cols">
    <!-- The frame. 16:9 because that is the configured output; items are
         positioned as percentages so this scales to any window width. -->
    <div class="stagewrap">
      <div class="stage" bind:this={stage} onpointerdown={(e) => { if (e.target === stage) selected = null; }}>
        <!-- Behind everything, and never a drag target: clicking the picture
             should deselect, exactly as clicking bare stage does. -->
        <video bind:this={video} class="feed" class:on={feed === 'live'}
               muted playsinline disablepictureinpicture></video>
        <div class="grid" aria-hidden="true"></div>
        {#each items as item (item.id)}
          <div class="item" class:on={selected === item.id} class:off={item.enabled === false}
               style={`left:${item.x * 100}%; top:${item.y * 100}%;
                       transform: translate(-50%,-50%) rotate(${item.rotation}deg);
                       font-size:${item.size * 100}cqh; color:${item.colour};`}
               onpointerdown={(e) => startDrag(e, item)}
               role="button" tabindex="0"
               aria-label={`${item.text} — drag to move`}>
            <span class="txt" class:outline={item.outline !== false}>
              {item.text.replace('{title}', 'Episode title')}
            </span>
            {#if selected === item.id}
              <span class="handle rot" onpointerdown={(e) => startRotate(e, item)}
                    role="button" tabindex="-1" aria-label="Rotate"></span>
              <span class="handle size" onpointerdown={(e) => startResize(e, item)}
                    role="button" tabindex="-1" aria-label="Resize"></span>
            {/if}
          </div>
        {/each}
        {#if !items.length}
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

    <div class="side">
      {#if sel}
        <div class="card">
          <h3>Selected</h3>
          <label>Text</label>
          <textarea rows="2" value={sel.text}
                    oninput={(e) => patch(sel.id, { text: e.currentTarget.value })}></textarea>
          <p class="muted small">
            <code>{'{title}'}</code> is replaced with whatever is playing.
          </p>

          <div class="row2">
            <div><label>Colour</label>
              <input type="color" value={sel.colour}
                     oninput={(e) => patch(sel.id, { colour: e.currentTarget.value })} /></div>
            <div><label>Size</label>
              <input type="range" min="1.5" max="30" step="0.5" value={sel.size * 100}
                     oninput={(e) => patch(sel.id, { size: +e.currentTarget.value / 100 })} /></div>
          </div>

          <label>Rotation <span class="muted small">{sel.rotation}°</span></label>
          <input type="range" min="-180" max="180" step="1" value={sel.rotation}
                 oninput={(e) => patch(sel.id, { rotation: +e.currentTarget.value })} />

          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" checked={sel.outline !== false} style="width:auto"
                   onchange={(e) => patch(sel.id, { outline: e.currentTarget.checked })} />
            Outline — keeps it readable on any picture
          </label>

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

      {#if items.length}
        <div class="card">
          <h3>On screen</h3>
          <ul class="list">
            {#each items as i (i.id)}
              <li class:on={selected === i.id}>
                <button class="pick" onclick={() => (selected = i.id)}>
                  <span class="dot" style={`background:${i.colour}`}></span>
                  <span class="nm">{i.text.slice(0, 24) || '(empty)'}</span>
                  <span class="muted small">{whenLabel(i)}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .wrap { max-width: 1240px; margin: 0 auto; }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .head h1 { margin: 0; }
  .spacer { flex: 1; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }

  .stage {
    position: relative; aspect-ratio: 16 / 9; container-type: size;
    background: #0b0d10; border: 1px solid var(--border); border-radius: 12px;
    overflow: hidden; user-select: none; touch-action: none;
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
    object-fit: contain; background: #000;
    opacity: 0; transition: opacity .25s ease; pointer-events: none;
  }
  .feed.on { opacity: 1; }
  .empty {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 13px; pointer-events: none;
  }

  .item {
    position: absolute; cursor: grab; white-space: pre; line-height: 1.15;
    padding: 2px 4px; border-radius: 4px;
  }
  .item:active { cursor: grabbing; }
  .item.off { opacity: .35; }
  .item.on { outline: 1px dashed var(--accent); outline-offset: 3px; }
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
</style>
