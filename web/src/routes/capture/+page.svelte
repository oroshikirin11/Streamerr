<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, connectStatus, fmtTime } from '$lib/api.js';
  import { cap, pick, goLive, stop, setTitle, supported, secure } from '$lib/capture.svelte.js';

  /**
   * Capture: put a screen on the broadcast.
   *
   * One card, always in the same place; only its state changes. A share is
   * its own broadcast — it never joins the queue and never runs beside
   * media — so the page has exactly one way in ("Go live") and refuses it,
   * with the reason, while anything else is on air.
   */

  let cfg = $state(null);
  let stream = $state({ status: 'stopped', playing: null, capture: null });
  let stopFeed = null;
  let tlsBusy = $state(false);
  let tlsErr = $state('');
  let tls = $state(null);
  let saving = $state('');
  let video = $state(null);
  let titleDraft = $state('');
  let position = $state(0);

  const isSecure = $derived(secure());
  const canShare = $derived(isSecure && supported());
  const onAir = $derived(stream.status === 'running' || stream.status === 'paused' || stream.status === 'starting' || stream.status === 'preparing');
  const paused = $derived(stream.status === 'paused');
  const serverSession = $derived(stream.capture?.session ?? null);
  /** A share held by a browser other than this one. */
  const foreign = $derived(Boolean(serverSession) && cap.phase === 'idle');
  const liveHere = $derived(cap.phase === 'live' || (cap.phase === 'armed' && serverSession?.state === 'live' && serverSession?.id === cap.sessionId));
  const blocked = $derived(stream.capture?.blocked ?? null);
  const settings = $derived(stream.capture?.settings ?? cfg?.capture ?? {});
  const delay = $derived(Number(settings.delaySeconds) || 0);
  const health = $derived(serverSession?.health ?? null);
  const feedInfo = $derived(serverSession?.feed ?? null);
  const speed = $derived(stream.speed ?? null);
  const platform = $derived(/Windows/.test(navigator.userAgent) ? 'windows' : /Mac OS/.test(navigator.userAgent) ? 'mac' : 'linux');
  const mobile = $derived(/Android|iPhone|iPad/.test(navigator.userAgent));

  const surfaceName = (s) => (s === 'monitor' ? 'Monitor' : s === 'window' ? 'Window' : s === 'browser' ? 'Tab' : 'Screen');
  const codecName = (m) => (/h264|avc1/i.test(m) ? 'H.264' : /vp9/i.test(m) ? 'VP9' : /vp8/i.test(m) ? 'VP8' : m ? m.replace(/^video\//, '') : '');
  const tlsUrl = $derived.by(() => {
    const port = tls?.port ?? cfg?.server?.tls?.port ?? 8443;
    return `https://${location.hostname}:${port}${location.pathname}`;
  });

  onMount(async () => {
    try { cfg = await api.config(); } catch { /* the page still shows */ }
    try { tls = await api.get('/api/tls'); } catch { /* not fatal */ }
    stopFeed = connectStatus((msg) => {
      if (msg.type === 'stream') {
        stream = { ...msg.payload, speed: stream.speed };
        if (msg.payload.position != null) position = msg.payload.position;
      } else if (msg.type === 'capture') {
        stream.capture = msg.payload;
      } else if (msg.type === 'progress') {
        stream.speed = msg.payload.speed;
        if (msg.payload.position != null) position = msg.payload.position;
      }
    });
    const tick = setInterval(() => { if (stream.status === 'running' && stream.playing?.live) position += 1; }, 1000);
    // For the end-to-end test (test/e2e-capture.mjs), which drives this
    // page through a headless browser: the same functions the buttons call.
    window.__jsrCapture = { pick: share, goLive, stop, get cap() { return cap; } };
    return () => { clearInterval(tick); delete window.__jsrCapture; };
  });
  onDestroy(() => { stopFeed?.(); });

  // The local preview follows the store's stream wherever the page is.
  $effect(() => {
    if (video && cap.stream) {
      if (video.srcObject !== cap.stream) video.srcObject = cap.stream;
      video.play?.().catch(() => {});
    } else if (video && !cap.stream) {
      video.srcObject = null;
    }
  });
  $effect(() => { if (cap.phase === 'armed') titleDraft = cap.title; });

  async function share() {
    await pick({ settings, encoder: cfg?.encoder ?? {} });
  }

  async function enableTls() {
    tlsBusy = true; tlsErr = '';
    try {
      tls = await api.post('/api/tls', { enabled: true });
    } catch (err) {
      tlsErr = err.message;
    } finally {
      tlsBusy = false;
    }
  }

  async function saveSetting(patch) {
    saving = Object.keys(patch)[0];
    try {
      await api.saveConfig({ capture: patch });
      cfg = { ...cfg, capture: { ...(cfg?.capture ?? {}), ...patch } };
    } catch (err) {
      cap.error = err.message;
    } finally {
      saving = '';
    }
  }

  async function stopForeign() {
    try { await api.post('/api/capture/stop'); } catch (err) { cap.error = err.message; }
  }
  async function stopBroadcast() {
    try { await api.stop(); } catch (err) { cap.error = err.message; }
  }
  async function togglePause() {
    try { await (paused ? api.resume() : api.pause()); } catch (err) { cap.error = err.message; }
  }
  const fmtKbps = (k) => (k >= 1000 ? `${(k / 1000).toFixed(1)} Mb/s` : `${Math.round(k)} kb/s`);
</script>

<div class="head">
  <h1>Capture</h1>
  {#if liveHere}
    <span class="pill live"><span class="dot"></span>LIVE · {fmtTime(position)}</span>
  {:else if cap.phase === 'armed'}
    <span class="pill">Screen picked — not on air yet</span>
  {/if}
</div>

{#if cap.error}
  <p class="err" role="alert">{cap.error} <button class="inline" onclick={() => (cap.error = '')}>Dismiss</button></p>
{/if}

{#if !isSecure}
  <!-- 1 · the address is not secure: no dead button, the fix instead -->
  <section class="card lock">
    <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <div class="body">
      <h2>Screen sharing needs a secure address</h2>
      <p class="muted">
        Browsers only allow screen sharing on an <strong>https</strong> page. You are on
        <code>{location.origin}</code>. Streamerr can serve a secure address itself — no proxy,
        nothing to buy; your browser asks once whether to trust its certificate.
      </p>
      {#if tls?.listening}
        <p>The secure address is on: <a class="primary-link" href={tlsUrl}>{tlsUrl}</a></p>
        <p class="muted small">Accept the certificate when the browser asks. To skip that warning for good, <a href="/api/tls/cert">download the certificate</a> and add it to your browser's trusted authorities.</p>
        <p class="muted small">Can't connect? Under Docker the port must be published like the panel's own — <code>"{tls.port}:{tls.port}"</code> under <code>ports</code> in docker-compose.yml, then <code>docker compose up -d</code>.</p>
      {:else}
        <div class="row">
          <button class="primary" onclick={enableTls} disabled={tlsBusy}>{tlsBusy ? 'Starting…' : 'Turn on secure address'}</button>
          <span class="muted small">Then open <code>{tlsUrl}</code> and accept the certificate once.</span>
        </div>
        {#if tlsErr}<p class="err">{tlsErr}</p>{/if}
      {/if}
      <p class="muted small">Already behind a proxy with a certificate? Open the panel through it and this page works as is.</p>
    </div>
  </section>

{:else if !canShare}
  <section class="card lock">
    <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></div>
    <div class="body">
      <h2>This browser cannot share a screen</h2>
      <p class="muted">{mobile ? 'Phones do not offer screen sharing to web pages. Open this page in a desktop browser to pick a screen — this panel can still stop a share.' : 'It has no screen-capture support. Chrome, Edge or Firefox on a desktop will.'}</p>
      {#if serverSession}
        <div class="row"><button class="danger" onclick={stopForeign}>Stop sharing</button><span class="muted small">{serverSession.sender?.ua} is sharing {surfaceName(serverSession.surface).toLowerCase()} "{serverSession.title}".</span></div>
      {/if}
    </div>
  </section>

{:else if foreign}
  <!-- 5 · a share held by another browser -->
  <section class="card lock">
    <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></div>
    <div class="body">
      <h2>{serverSession.state === 'live' ? `"${serverSession.title}" is on air from another browser` : `Another browser has picked a screen`}</h2>
      <p class="muted">
        {serverSession.sender?.ua ?? 'A browser'} is sharing {surfaceName(serverSession.surface).toLowerCase()}
        {#if serverSession.width}· {serverSession.width}×{serverSession.height}{/if}
        {#if serverSession.fps}· {serverSession.fps} fps{/if}.
        The picture itself is only available there; this panel can pause or stop it.
      </p>
      <div class="row">
        {#if serverSession.state === 'live'}<button onclick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>{/if}
        <button class="danger" onclick={stopForeign}>Stop sharing</button>
      </div>
    </div>
  </section>

{:else if cap.phase === 'idle' || cap.phase === 'picking'}
  <!-- 2 · idle -->
  <p class="lede">Put a screen or window on the broadcast. It is its own broadcast: nothing else plays while it is on, and Pause puts up a card. Overlays from the Studio are drawn on it.</p>
  <section class="card idle">
    <button class="primary big" onclick={share} disabled={cap.phase === 'picking' || Boolean(blocked)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
      {cap.phase === 'picking' ? 'Waiting for the picker…' : 'Share screen'}
    </button>
    {#if blocked}
      <p class="muted small">{blocked} <button class="inline" onclick={stopBroadcast}>Stop the broadcast</button></p>
    {:else}
      <p class="muted small">
        Your browser will ask which screen or window.
        {#if delay > 0}Viewers see it about <strong>{delay} seconds</strong> after you do — that delay is what keeps the stream smooth.{:else}Viewers see it as soon as it reaches them — there is <strong>no delay</strong> and no slack for a hiccup; add a few seconds under Timing below if the stream stutters.{/if}
      </p>
    {/if}
  </section>
  <div class="settings">
    <div class="field">
      <label for="c-audio">Audio</label>
      <select id="c-audio" value={settings.audio ?? 'auto'} onchange={(e) => saveSetting({ audio: e.currentTarget.value })}>
        <option value="auto">What the picker gives</option>
        <option value="mic">Microphone</option>
        <option value="both">Both</option>
        <option value="none">None</option>
      </select>
      {#if platform !== 'windows'}<span class="hint">{platform === 'mac' ? 'macOS' : 'Linux'} shares audio for a tab, not for a window or monitor. Pick <em>Microphone</em>{platform === 'linux' ? ' and choose the “Monitor of …” device' : ''} to send what you hear.</span>{/if}
    </div>
    <div class="field">
      <label for="c-quality">Quality</label>
      <select id="c-quality" value={settings.quality ?? 'balanced'} onchange={(e) => saveSetting({ quality: e.currentTarget.value })}>
        <option value="balanced">Balanced · 8 Mb/s</option>
        <option value="sharp">Sharp · 12 Mb/s (text, code)</option>
        <option value="light">Light · 4 Mb/s (remote)</option>
      </select>
    </div>
    <div class="field">
      <label for="c-fps">Frame rate</label>
      <select id="c-fps" value={String(settings.fps ?? 30)} onchange={(e) => saveSetting({ fps: Number(e.currentTarget.value) })}>
        <option value="30">30</option>
        <option value="60">60 · costs the box more</option>
      </select>
    </div>
    <div class="field">
      <label for="c-delay">Timing</label>
      <select id="c-delay" value={String(delay)} onchange={(e) => saveSetting({ delaySeconds: Number(e.currentTarget.value) })}>
        <option value="0">No delay</option>
        <option value="2">2 s of slack</option>
        <option value="5">5 s of slack</option>
        <option value="15">15 s — smoothest</option>
      </select>
      <span class="hint">How much is banked before viewers get it. Zero means nothing absorbs a hiccup.</span>
    </div>
    <div class="field">
      <label for="c-end">When sharing ends</label>
      <select id="c-end" value={settings.onEnd ?? 'end'} onchange={(e) => saveSetting({ onEnd: e.currentTarget.value })}>
        <option value="end">End the broadcast</option>
        <option value="hold">Hold with a card for {settings.holdMinutes ?? 5} min, then end</option>
      </select>
    </div>
    <div class="field">
      <label for="c-pass">Encoding</label>
      <select id="c-pass" value={settings.passthrough === false ? 'encode' : 'copy'} onchange={(e) => saveSetting({ passthrough: e.currentTarget.value === 'copy' })}>
        <option value="copy">Send the browser's H.264 as is</option>
        <option value="encode">Always re-encode on the box</option>
      </select>
      <span class="hint">As-is costs the box nothing; anything drawn in the Studio re-encodes anyway.</span>
    </div>
  </div>
  {#if saving}<p class="muted small">Saved.</p>{/if}

{:else}
  <!-- 3 · armed, 4 · live -->
  <div class="two">
    <div>
      <div class="preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} autoplay muted playsinline></video>
        {#if liveHere}<span class="pill live float"><span class="dot"></span>LIVE</span>{/if}
      </div>
      <div class="cap">
        <strong>{surfaceName(cap.surface)}</strong>
        {#if cap.width}<span>{cap.width}×{cap.height}{#if serverSession?.width && (serverSession.width !== cap.width)} → {serverSession.width}×{serverSession.height}{/if}</span>{/if}
        {#if cap.fps}<span>{cap.fps} fps</span>{/if}
        <span>{cap.audio ? cap.audioFrom || 'audio' : 'no audio'}</span>
        {#if cap.mime}<span>{codecName(cap.mime)}</span>{/if}
      </div>
      {#if !cap.audio && (settings.audio ?? 'auto') === 'auto' && platform !== 'windows'}
        <p class="hint">{platform === 'mac' ? 'macOS' : 'Linux'} doesn't share system audio for a {surfaceName(cap.surface).toLowerCase()}. Choose <strong>Microphone</strong> in the audio setting{platform === 'linux' ? ' and pick the “Monitor of …” device' : ''} to send what you hear.</p>
      {/if}
      {#if liveHere}
        <p class="hint">This is your screen as the browser sends it. The floating preview shows what viewers get, overlays included{#if delay > 0}, about {delay} s later{/if}.</p>
        <div class="stat">
          <div><b>{fmtKbps(cap.sending.kbps)}</b><span>sending</span></div>
          <div><b>{(cap.sending.backlog / 1_000_000).toFixed(1)} MB</b><span>waiting to send</span></div>
          <div><b>{speed ? `${speed}×` : '—'}</b><span>box keeps up</span></div>
          <div><b>{feedInfo?.backlogSeconds != null ? `${feedInfo.backlogSeconds.toFixed(1)} s` : '—'}</b><span>held at the box</span></div>
        </div>
      {:else}
        <p class="hint">Nothing is on air yet. The screen stays picked until you go live or cancel — you can place overlays in the Studio meanwhile.</p>
      {/if}
    </div>

    <section class="card side">
      <div class="field">
        <label for="c-title">{liveHere ? 'Title' : 'What are you showing?'}</label>
        <input id="c-title" bind:value={titleDraft} maxlength="80" placeholder="Screen"
               onchange={() => setTitle(titleDraft)} onblur={() => setTitle(titleDraft)} />
        <span class="hint">Shown in the transport bar, to viewers, and as <code>{'{title}'}</code> in Studio captions.</span>
      </div>
      {#if liveHere}
        <div class="row">
          <button onclick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
          <span class="muted small">{paused ? 'Viewers see “Paused”. Resume picks up live — what happened meanwhile is not shown.' : 'Puts a card up. Use it when you need a moment off screen.'}</span>
        </div>
        <div class="row">
          <button class="danger" onclick={stop}>Stop sharing</button>
          <span class="muted small">{settings.onEnd === 'hold' ? `Holds the stream on a card for ${settings.holdMinutes ?? 5} min, then ends it.` : 'Ends the broadcast.'}</span>
        </div>
        <p class="muted small">Stopping from your browser's own “Stop sharing” bar does the same thing.</p>
      {:else}
        <div class="go">
          <button class="primary" onclick={goLive} disabled={Boolean(blocked) || cap.busy === 'go'}>
            {cap.busy === 'go' ? 'Going live…' : 'Go live'}
            <small>{blocked ? blocked : delay > 0 ? `Viewers see it in about ${delay} s` : 'Viewers see it right away'}</small>
          </button>
          {#if blocked}<button onclick={stopBroadcast}>Stop the broadcast</button>{/if}
        </div>
        <div class="row" style="justify-content: space-between; margin-top: 8px;">
          <button onclick={stop}>Cancel</button>
          <span class="muted small">Releases the screen.</span>
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .head h1 { margin: 0; }
  .lede { max-width: 62ch; color: var(--muted); margin: 0 0 16px; }
  .err { color: var(--danger); margin: 0 0 12px; }
  .pill { font-size: 11px; padding: 2px 9px; border-radius: 99px; background: var(--surface-2); color: var(--muted); font-weight: 500; }
  .pill.live { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); display: inline-flex; align-items: center; gap: 6px; letter-spacing: .04em; font-variant-numeric: tabular-nums; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .pill .dot { animation: none; } }
  .inline { padding: 2px 8px; font-size: 12px; margin-left: 6px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .lock { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: start; max-width: 640px; }
  .lock .ico { width: 44px; height: 44px; border-radius: 12px; background: var(--surface-2); display: grid; place-items: center; color: var(--muted); }
  .lock .ico svg { width: 22px; height: 22px; }
  .lock .body { display: grid; gap: 10px; }
  .lock h2 { margin: 0; font-size: 18px; font-weight: 600; }
  .lock p { margin: 0; }
  .primary-link { color: var(--accent); font-weight: 600; }
  code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--surface-2); padding: 1px 6px; border-radius: 5px; }
  .idle { max-width: 560px; display: grid; gap: 12px; justify-items: start; }
  .idle p { margin: 0; }
  .big { padding: 12px 22px; font-size: 16px; font-weight: 600; display: inline-flex; align-items: center; gap: 10px; }
  .big svg { width: 20px; height: 20px; }
  .settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-top: 18px; max-width: 980px; }
  .field { display: grid; gap: 5px; align-content: start; }
  .field label { font-size: 12px; color: var(--muted); letter-spacing: .02em; }
  .field select, .field input { font: inherit; font-size: 14px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 7px 10px; width: 100%; }
  .hint { font-size: 13px; color: var(--muted); max-width: 60ch; margin: 6px 0 0; display: block; }
  .two { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr); gap: 18px; align-items: start; }
  .preview { position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; border: 1px solid var(--border); background: #000; }
  .preview video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .pill.float { position: absolute; top: 10px; left: 10px; }
  .cap { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; margin-top: 8px; font-size: 13px; color: var(--muted); }
  .cap strong { color: var(--text); font-weight: 500; }
  .stat { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
  .stat div { background: var(--surface-2); border-radius: var(--radius); padding: 8px 10px; }
  .stat b { display: block; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 12px; color: var(--muted); }
  .side { display: grid; gap: 12px; }
  .go { display: grid; gap: 8px; margin-top: 4px; }
  .go button { text-align: left; padding: 10px 14px; }
  .go button small { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
  .go button.primary small { color: rgb(255 255 255 / .8); }
  @media (max-width: 860px) {
    .two { grid-template-columns: 1fr; }
    .stat { grid-template-columns: repeat(2, 1fr); }
  }
</style>
