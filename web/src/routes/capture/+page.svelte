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
  {#if liveHere && paused}
    <span class="pill">Paused · {fmtTime(position)}</span>
  {:else if liveHere}
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
  <section class="card hero">
    <div class="glyph" aria-hidden="true">
      <svg viewBox="0 0 64 48" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="58" height="36" rx="4"/><path d="M22 45h20M32 39v6" stroke-linecap="round"/><path class="beam" d="M12 30l9-9 8 6 10-12 13 11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="52" cy="10" r="3" fill="var(--success)" stroke="none"/></svg>
    </div>
    <div class="herobody">
      <h2>Share a screen</h2>
      <p class="muted">Your browser asks which screen or window. It becomes the broadcast on its own — nothing else plays while it is on — and overlays from the Studio are drawn on it.</p>
      <div class="row">
        <button class="primary big" onclick={share} disabled={cap.phase === 'picking' || Boolean(blocked)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
          {cap.phase === 'picking' ? 'Waiting for the picker…' : 'Share screen'}
        </button>
        {#if blocked}
          <span class="small muted">{blocked}</span>
          <button onclick={stopBroadcast}>Stop the broadcast</button>
        {:else}
          <span class="small muted">{delay > 0 ? `${delay} s held back at the box, then the receiver's own delay.` : 'Nothing held back: about a second to the receiver, then its own delay.'}</span>
        {/if}
      </div>
    </div>
  </section>

  <div class="groups">
    <section class="card group">
      <h3>Picture</h3>
      <div class="field">
        <label for="c-quality">Quality</label>
        <select id="c-quality" value={settings.quality ?? 'balanced'} onchange={(e) => saveSetting({ quality: e.currentTarget.value })}>
          <option value="max">Max · 30 Mb/s at 1080p</option>
          <option value="sharp">Sharp · 16 Mb/s at 1080p</option>
          <option value="balanced">Balanced · 8 Mb/s at 1080p</option>
          <option value="light">Light · 4 Mb/s, for remote</option>
        </select>
        <span class="hint">Scaled up for bigger screens. Goes out untouched from Chrome or Edge.</span>
      </div>
      <div class="pair">
        <div class="field">
          <label for="c-res">Resolution</label>
          <select id="c-res" value={settings.resolution ?? 'native'} onchange={(e) => saveSetting({ resolution: e.currentTarget.value })}>
            <option value="native">Screen's own</option>
            <option value="match">Broadcast frame</option>
          </select>
        </div>
        <div class="field">
          <label for="c-fps">Frame rate</label>
          <select id="c-fps" value={String(settings.fps ?? 30)} onchange={(e) => saveSetting({ fps: Number(e.currentTarget.value) })}>
            <option value="30">30 fps</option>
            <option value="60">60 fps</option>
          </select>
        </div>
      </div>
      <span class="hint">1:1 needs the browser's H.264 copied as is; a re-encode lands in the broadcast frame. 60 fps costs the box more.</span>
    </section>

    <section class="card group">
      <h3>Sound</h3>
      <div class="field">
        <label for="c-audio">Audio</label>
        <select id="c-audio" value={settings.audio ?? 'auto'} onchange={(e) => saveSetting({ audio: e.currentTarget.value })}>
          <option value="monitor">What I hear</option>
          <option value="auto">What the picker gives</option>
          <option value="mic">Microphone</option>
          <option value="both">System + microphone</option>
          <option value="none">None</option>
        </select>
        {#if platform === 'linux'}<span class="hint"><em>What I hear</em> captures the output's “Monitor of …” device: no microphone opens, nothing local is muted.</span>
        {:else if platform === 'mac'}<span class="hint">macOS shares audio for a tab only. <em>What I hear</em> needs a virtual output device such as BlackHole.</span>
        {:else}<span class="hint">Windows shares system audio with a monitor or window.</span>{/if}
      </div>
    </section>

    <section class="card group">
      <h3>Broadcast</h3>
      <div class="field">
        <label for="c-delay">Held back at the box</label>
        <select id="c-delay" value={String(delay)} onchange={(e) => saveSetting({ delaySeconds: Number(e.currentTarget.value) })}>
          <option value="0">Nothing · fastest, no slack</option>
          <option value="2">2 s · a little slack</option>
          <option value="5">5 s · steadier</option>
          <option value="15">15 s · smoothest</option>
        </select>
        <span class="hint">What the box banks before it sends. Viewers wait this plus about a second on the box plus the receiver's own segments, so never zero.</span>
      </div>
      <div class="field">
        <label for="c-end">When sharing ends</label>
        <select id="c-end" value={settings.onEnd ?? 'end'} onchange={(e) => saveSetting({ onEnd: e.currentTarget.value })}>
          <option value="end">End the broadcast</option>
          <option value="hold">Hold a card {settings.holdMinutes ?? 5} min, then end</option>
        </select>
      </div>
      <div class="field">
        <label for="c-pass">Encoding</label>
        <select id="c-pass" value={settings.passthrough === false ? 'encode' : 'copy'} onchange={(e) => saveSetting({ passthrough: e.currentTarget.value === 'copy' })}>
          <option value="copy">Browser's H.264 as is</option>
          <option value="encode">Always re-encode on the box</option>
        </select>
        <span class="hint">As-is costs the box nothing. Anything drawn in the Studio re-encodes anyway.</span>
      </div>
    </section>
  </div>
  {#if saving}<p class="muted small saved">Saved.</p>{/if}

{:else}
  <!-- 3 · armed, 4 · live -->
  <div class="two">
    <div>
      <div class="preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} autoplay muted playsinline></video>
        {#if liveHere && paused}<span class="pill float">Paused</span>
        {:else if liveHere}<span class="pill live float"><span class="dot"></span>LIVE</span>{/if}
      </div>
      <div class="cap">
        <span class="chip strong">{surfaceName(cap.surface)}</span>
        {#if serverSession?.width}<span class="chip">{serverSession.width}×{serverSession.height}</span>
        {:else if cap.width}<span class="chip">{cap.width}×{cap.height}</span>{/if}
        {#if cap.fps}<span class="chip">{cap.fps} fps</span>{/if}
        <span class="chip" class:off={!cap.audio}>{cap.audio ? cap.audioFrom || 'audio' : 'no audio'}</span>
        {#if cap.mime}<span class="chip">{codecName(cap.mime)}{#if cap.bps}&nbsp;· {(cap.bps / 1e6).toFixed(0)} Mb/s{/if}</span>{/if}
        {#if liveHere}<span class="chip" class:off={delay === 0}>{delay > 0 ? `${delay} s held back` : 'nothing held back'}</span>{/if}
      </div>
      {#if cap.mime && !/h264|avc1/i.test(cap.mime)}
        <p class="hint">This browser records {codecName(cap.mime)}, which the box must re-encode into the broadcast frame. For a 1:1 picture use Chrome or Edge: they record H.264, which goes out untouched.</p>
      {/if}
      {#if !cap.audio && (settings.audio ?? 'auto') === 'auto' && platform !== 'windows'}
        <p class="hint">{platform === 'mac' ? 'macOS' : 'Linux'} doesn't share system audio for a {surfaceName(cap.surface).toLowerCase()}. Choose <strong>What I hear</strong> in the audio setting to send it.</p>
      {/if}
      {#if liveHere}
        <p class="hint">This is your screen as the browser sends it. The floating preview shows what viewers get, overlays included.</p>
        <div class="stat">
          <div><b>{fmtKbps(cap.sending.kbps)}</b><span>sending</span></div>
          <div><b>{(cap.sending.backlog / 1_000_000).toFixed(1)} MB</b><span>waiting to send</span></div>
          <div><b>{speed ? `${speed}×` : '—'}</b><span>box keeps up</span></div>
          <div><b>{feedInfo?.backlogSeconds != null ? `${feedInfo.backlogSeconds.toFixed(1)} s` : '—'}</b><span>held at the box</span></div>
        </div>
      {:else}
        <p class="hint">Nothing is on air yet. The screen stays picked until you go live or cancel — you can place overlays in the Studio meanwhile.</p>
        <p class="hint">Sending {fmtKbps(cap.sending.kbps)} · {Math.round(cap.sending.bytes / 1024)} KB so far · the box has {feedInfo ? `${Math.round((feedInfo.bytesIn ?? 0) / 1024)} KB${serverSession?.codec ? ` of ${serverSession.codec.toUpperCase()}` : ', no video header yet'}` : 'nothing yet'}.</p>
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
        <div class="actions">
          <button onclick={togglePause}>
            {#if paused}<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Resume
            {:else}<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>Pause{/if}
          </button>
          <button class="danger" onclick={stop}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop sharing
          </button>
        </div>
        <p class="muted small">{paused ? 'Viewers see a “Paused” card. Resume picks up live; what happened meanwhile is not shown.' : 'Pause puts a card up for a moment off screen.'} {settings.onEnd === 'hold' ? `Stopping holds a card for ${settings.holdMinutes ?? 5} min, then ends the broadcast.` : 'Stopping ends the broadcast.'} Your browser's own “Stop sharing” bar does the same.</p>
      {:else}
        <div class="go">
          <button class="primary" onclick={goLive} disabled={Boolean(blocked) || cap.busy === 'go'}>
            {cap.busy === 'go' ? 'Going live…' : 'Go live'}
            <small>{blocked ? blocked : delay > 0 ? `${delay} s held back, then the receiver's delay` : 'About a second to the receiver, then its delay'}</small>
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
  .hero { display: grid; grid-template-columns: auto 1fr; gap: 22px; align-items: center; max-width: 760px; padding: 22px 24px; }
  .glyph { width: 96px; color: var(--accent); opacity: .9; }
  .glyph svg { width: 100%; height: auto; display: block; }
  .glyph .beam { opacity: .55; }
  .herobody { display: grid; gap: 10px; }
  .herobody h2 { margin: 0; font-size: 20px; font-weight: 650; }
  .herobody p { margin: 0; max-width: 58ch; }
  .groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 16px; max-width: 980px; }
  .group { display: grid; gap: 12px; align-content: start; padding: 16px 18px; }
  .group h3 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .saved { margin: 8px 0 0; }
  .chip { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 99px; background: var(--surface-2); color: var(--text); font-size: 12px; white-space: nowrap; }
  .chip.strong { font-weight: 600; }
  .chip.off { color: var(--muted); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button { display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; }
  .actions svg { width: 14px; height: 14px; }
  .big { padding: 12px 22px; font-size: 16px; font-weight: 600; display: inline-flex; align-items: center; gap: 10px; }
  .big svg { width: 20px; height: 20px; }
  .settings { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; margin-top: 18px; max-width: 980px; }
  .field { display: grid; gap: 5px; align-content: start; }
  .field label { font-size: 12px; color: var(--muted); letter-spacing: .02em; }
  .field select, .field input { font: inherit; font-size: 14px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: 7px 10px; width: 100%; }
  .hint { font-size: 12.5px; line-height: 1.45; color: var(--muted); max-width: 60ch; margin: 4px 0 0; display: block; }
  .two { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr); gap: 18px; align-items: start; }
  .preview { position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; border: 1px solid var(--border); background: #000; }
  .preview video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .pill.float { position: absolute; top: 10px; left: 10px; }
  .cap { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px; }
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
    .hero { grid-template-columns: 1fr; }
    .glyph { width: 64px; }
    .stat { grid-template-columns: repeat(2, 1fr); }
  }
</style>
