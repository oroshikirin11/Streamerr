<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api, connectStatus, fmtTime } from '$lib/api.js';

  let { children } = $props();

  let ready = $state(false);
  let authed = $state(false);
  let passwordConfigured = $state(false);
  let password = $state('');
  let loginError = $state('');
  let busy = $state(false);

  let stream = $state({ status: 'stopped', playing: null, queue: [] });
  let position = $state(0);
  let speed = $state(null);
  let toast = $state(null);
  let tracks = $state(null);
  let busyCtl = $state(false);
  /** Fraction of the seek strip under the cursor, for the time bubble. */
  let hoverFrac = $state(null);

  const live = $derived(stream.status === 'running' || stream.status === 'paused');
  /** First-time subtitle extraction before going live — can take minutes. */
  const preparing = $derived(
    stream.status === 'preparing' || stream.status === 'starting');
  const paused = $derived(stream.status === 'paused');

  onMount(async () => {
    await refreshAuth();
    ready = true;
    const mock = import.meta.env.DEV && page.url.searchParams.has('mock');
    if (authed && !mock) startFeed();
    // Dev-only playbar preview (`npm run dev` + ?mock): the transport bar only
    // renders while something streams, which makes styling it require a live
    // broadcast. The real feed is skipped so it cannot overwrite the fake
    // state. Stripped from production builds.
    if (mock) {
      stream = {
        status: page.url.searchParams.get('mock') === 'prep' ? 'preparing' : 'running',
        playing: {
          title: "Frieren: Beyond Journey's End — S1E1",
          duration: 1563,
          image: 'data:image/svg+xml,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="92" height="128"><rect width="92" height="128" fill="#405a7a"/><circle cx="46" cy="50" r="24" fill="#dfe8f4"/></svg>'),
        },
        queue: [{ title: "Frieren — S1E2" }],
      };
      position = 201;
      speed = '1.37';
    }
  });

  async function refreshAuth() {
    try {
      const s = await api.authStatus();
      passwordConfigured = s.configured;
      authed = s.authenticated;
      if (authed && !s.onboarded && page.url.pathname !== '/setup') {
        goto('/setup');
      }
    } catch {
      authed = false;
    }
  }

  function startFeed() {
    connectStatus((msg) => {
      if (msg.type === 'stream') {
        if (msg.payload.status === 'preparing' && stream.status !== 'preparing') {
          toast = {
            kind: 'info',
            message: 'Preparing subtitles — the first playback of a file reads '
              + 'it once in full, then it goes live automatically.',
          };
          setTimeout(() => { toast = null; }, 12000);
        }
        stream = msg.payload;
        if (msg.payload.position != null) position = msg.payload.position;
      } else if (msg.type === 'progress') {
        position = msg.payload.position;
        speed = msg.payload.speed;
      } else if (msg.type === 'error' || msg.type === 'warn') {
        toast = { kind: msg.type, message: msg.payload.message };
        setTimeout(() => { toast = null; }, 8000);
      }
    });
  }

  async function login(e) {
    e.preventDefault();
    busy = true;
    loginError = '';
    try {
      if (passwordConfigured) await api.login(password);
      else await api.setupPassword(password);
      password = '';
      await refreshAuth();
      startFeed();
    } catch (err) {
      loginError = err.message;
    } finally {
      busy = false;
    }
  }

  async function ctl(fn) {
    busyCtl = true;
    try { await fn(); stream = await api.streamStatus(); }
    catch (err) { toast = { kind: 'error', message: err.message }; }
    finally { busyCtl = false; }
  }

  const stopStream = () => ctl(() => api.stop());
  const togglePause = () => ctl(() => (paused ? api.resume() : api.pause()));
  const skip = (delta) => ctl(() => api.seek({ delta }));
  const nextClip = () => ctl(async () => {
    await api.next();
    tracks = null;   // they describe the clip that just left the air
  });

  async function openTracks() {
    if (tracks) { tracks = null; return; }
    try { tracks = await api.liveTracks(); }
    catch (err) { toast = { kind: 'error', message: err.message }; }
  }

  async function applyTrack(audioIndex, subtitleKey, subtitleMode) {
    busyCtl = true;
    try {
      const r = await api.setTracks({ audioIndex, subtitleKey, subtitleMode });
      toast = { kind: 'info', message: r.tracks };
      setTimeout(() => { toast = null; }, 6000);
      tracks = await api.liveTracks();
      stream = await api.streamStatus();
    } catch (err) { toast = { kind: 'error', message: err.message }; }
    finally { busyCtl = false; }
  }

  // The browser tab doubles as a status light, visible even when the panel
  // is a background tab.
  const favicon = (c1, c2) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>`
    + `</linearGradient></defs>`
    + `<rect width="32" height="32" rx="8" fill="url(#g)"/>`
    + `<path d="M12 9.5v13l11-6.5z" fill="#fff"/></svg>`);
  // Green = broadcasting, red = not — the user's chosen semantics, matching
  // the on-air pill in the sidebar. Amber while preparing subtitles.
  const favIdle = favicon('#f0836b', '#d0402f');
  const favLive = favicon('#5fc493', '#1f7a50');
  const favPrep = favicon('#f0c36b', '#c98a2e');

  $effect(() => {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = live ? favLive : preparing ? favPrep : favIdle;
  });

  // The tab title is what's on air, not which page is open: the playing
  // title while broadcasting or preparing, just the service name otherwise.
  $effect(() => {
    document.title = live && stream.playing
      ? `🟢 ${stream.playing.title}`
      : preparing && stream.playing
        ? `⏳ ${stream.playing.title}`
        : 'Jellystreamerr';
  });

  let devMode = $state(false);
  $effect(() => {
    if (authed) api.config().then((c) => { devMode = Boolean(c.devMode); }).catch(() => {});
  });
  $effect(() => {
    const h = (e) => { devMode = Boolean(e.detail); };
    window.addEventListener('jsr-devmode', h);
    return () => window.removeEventListener('jsr-devmode', h);
  });

  const nav = $derived([
    { href: '/', label: 'Library', icon: 'M4 5h16v11H4zM2 19h20' },
    { href: '/queue', label: 'Queue', icon: 'M4 6h16M4 12h16M4 18h10' },
    ...(devMode ? [{ href: '/console', label: 'Console', icon: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5' }] : []),
    { href: '/settings', label: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-3-2V3h-4v3L7 8 5 7 3 11l2 1v0l-2 1 2 4 2-1 3 2v3h4v-3l3-2 2 1 2-4-2-1z' },
  ]);
</script>

{#if !ready}
  <div class="center"><p class="muted">Loading…</p></div>

{:else if !authed}
  <div class="center">
    <form class="card login" onsubmit={login}>
      <div class="brand" style="padding: 0 0 2px;">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
        <h1 style="margin: 0; font-size: 19px;">Jellystreamerr</h1>
      </div>
      <p class="muted">
        {passwordConfigured
          ? 'Enter your password to continue.'
          : 'Choose a password. The panel can start broadcasts and stores your stream key, so it should not be left open.'}
      </p>
      <input
        type="password"
        bind:value={password}
        placeholder={passwordConfigured ? 'Password' : 'At least 8 characters'}
        autocomplete={passwordConfigured ? 'current-password' : 'new-password'}
      />
      {#if loginError}<p class="err">{loginError}</p>{/if}
      <button class="primary" type="submit" disabled={busy || password.length < 1}>
        {passwordConfigured ? 'Sign in' : 'Create password'}
      </button>
    </form>
  </div>

{:else}
  <div class="app">
    <aside>
      <div class="brand">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
        <strong>Jellystreamerr</strong>
      </div>
      <div class="status">
        <span class="onair" class:live class:prep={preparing}>
          <span class="dot" class:live class:prep={preparing}></span>
          {live ? 'On air' : preparing ? 'Preparing' : 'Offline'}
        </span>
        {#if speed && live}
          <span class="speed" class:slow={parseFloat(speed) < 0.97}>{speed}×</span>
        {/if}
      </div>
      <nav>
        {#each nav as n}
          <a href={n.href} class:active={page.url.pathname === n.href}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                 stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <path d={n.icon} />
            </svg>
            {n.label}
            {#if n.href === '/queue' && stream.queue?.length}
              <span class="badge">{stream.queue.length}</span>
            {/if}
          </a>
        {/each}
      </nav>
      <div class="spacer"></div>
    </aside>

    <main>
      {@render children()}
    </main>

    {#if stream.playing}
      <footer>
        <div class="seek" class:seekable={stream.playing.duration}
             role="slider" tabindex="0" aria-label="Seek"
             aria-valuemin="0" aria-valuemax={Math.round(stream.playing.duration ?? 0)}
             aria-valuenow={Math.round(position)}
             onclick={(e) => {
               if (!stream.playing.duration || busyCtl || preparing) return;
               const r = e.currentTarget.getBoundingClientRect();
               const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
               ctl(() => api.seek({ position: frac * stream.playing.duration }));
             }}
             onmousemove={(e) => {
               if (!stream.playing.duration) return;
               const r = e.currentTarget.getBoundingClientRect();
               hoverFrac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
             }}
             onmouseleave={() => (hoverFrac = null)}
             onkeydown={(e) => {
               if (e.key === 'ArrowRight') skip(30);
               if (e.key === 'ArrowLeft') skip(-30);
             }}>
          <div class="fill" style:width="{stream.playing.duration
            ? Math.min(100, (position / stream.playing.duration) * 100)
            : 0}%"></div>
          {#if hoverFrac != null && stream.playing.duration}
            <div class="bubble" style:left="{hoverFrac * 100}%">
              {fmtTime(hoverFrac * stream.playing.duration)}
            </div>
          {/if}
        </div>

        <div class="frow">
          <div class="fleft">
            {#if stream.playing.image}
              <img class="cover" src={stream.playing.image} alt="" />
            {/if}
            <div class="np">
              <p class="title">
                {stream.playing.title}
                {#if paused}<span class="pill">Paused</span>
                {:else if preparing}<span class="pill">Preparing subtitles…</span>{/if}
              </p>
              <p class="muted small">
                {fmtTime(position)}
                {#if stream.playing.duration} / {fmtTime(stream.playing.duration)}{/if}
                {#if stream.queue?.length} · next: {stream.queue[0].title}{/if}
              </p>
            </div>
          </div>

          <div class="ctl">
            <button class="ic" onclick={() => skip(-30)} disabled={busyCtl || preparing} title="Back 30 seconds" aria-label="Back 30 seconds">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 19a7 7 0 1 0-6.9-8.5M4 4v6h6"/></svg><span class="tiny">30</span>
            </button>
            <button class="ic play" onclick={togglePause} disabled={busyCtl || preparing} title={paused ? 'Resume' : 'Pause'} aria-label={paused ? 'Resume' : 'Pause'}>
              {#if paused}
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
              {:else}
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
              {/if}
            </button>
            <button class="ic" onclick={() => skip(30)} disabled={busyCtl || preparing} title="Forward 30 seconds" aria-label="Forward 30 seconds">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M13 19a7 7 0 1 1 6.9-8.5M20 4v6h-6"/></svg><span class="tiny">30</span>
            </button>
            <button class="ic" onclick={nextClip} disabled={busyCtl || !stream.queue?.length}
                    title={stream.queue?.length ? `Skip to ${stream.queue[0].title}` : 'Nothing queued to skip to'}
                    aria-label="Skip to next episode">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M6 5v14l9-7zM16 5h3v14h-3z"/></svg>
            </button>
          </div>

          <div class="fright">
            <button onclick={openTracks} disabled={busyCtl || preparing}>Audio &amp; subs</button>
            <button class="danger" onclick={stopStream} disabled={busyCtl}>Stop</button>
          </div>
        </div>
      </footer>

      {#if tracks}
        <div class="panel">
          <div class="phead">
            <strong>{tracks.title}</strong>
            <span class="muted small">{tracks.chosen.reason}</span>
            <div style="flex:1"></div>
            <button onclick={() => (tracks = null)}>Close</button>
          </div>
          <p class="muted small">
            Switching restarts the encoder and resumes at the same point, so
            viewers see a few seconds of interruption.
          </p>

          <div class="cols">
            <div>
              <p class="muted small">Audio</p>
              {#each tracks.audio as a}
                <button class="tr" class:pick={a.typeIndex === tracks.chosen.audioIndex}
                        disabled={busyCtl}
                        onclick={() => applyTrack(a.typeIndex, tracks.chosen.subtitleKey, undefined)}>
                  {a.language ?? '?'} · {a.codec} · {a.channels ?? '?'}ch{a.title ? ` — ${a.title}` : ''}
                </button>
              {/each}
            </div>
            <div>
              <p class="muted small">Subtitles</p>
              <button class="tr" class:pick={tracks.chosen.subtitleKey === null}
                      disabled={busyCtl}
                      onclick={() => applyTrack(tracks.chosen.audioIndex, null, 'off')}>None</button>
              {#each tracks.subtitles as sub}
                <button class="tr" class:pick={String(sub.key) === String(tracks.chosen.subtitleKey)}
                        disabled={busyCtl}
                        onclick={() => applyTrack(tracks.chosen.audioIndex, sub.key, 'always')}>
                  {sub.language ?? '?'} · {sub.codec}{sub.forced ? ' · forced' : ''}{sub.external ? ' · sidecar' : ''}
                </button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/if}

{#if toast}
  <div class="toast" class:error={toast.kind === 'error'}>{toast.message}</div>
{/if}

<style>
  :global(:root) {
    --bg: #f7f7f5;
    --surface: #ffffff;
    --surface-2: #f0efec;
    --text: #1d1d1b;
    --muted: #6b6b66;
    --border: #dededa;
    --accent: #2f6fd0;
    --danger: #c0392b;
    --success: #2b8a5f;
    --radius: 8px;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #17171a;
      --surface: #202024;
      --surface-2: #2a2a2f;
      --text: #ececeb;
      --muted: #9a9a95;
      --border: #34343a;
      --accent: #6ba3f0;
      --danger: #e8705f;
      --success: #5fc493;
    }
  }
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 400 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  :global(h1, h2, h3) { font-weight: 500; margin: 0 0 .5rem; }
  :global(h1) { font-size: 22px; }
  :global(h2) { font-size: 18px; }
  :global(h3) { font-size: 16px; }
  :global(input, select, button) {
    font: inherit;
    color: inherit;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    padding: 8px 11px;
  }
  :global(input:focus, select:focus) {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  }
  :global(button) {
    cursor: pointer; background: var(--surface-2);
    transition: background .15s, border-color .15s, color .15s,
                box-shadow .15s, transform .06s;
  }
  :global(button:hover:not(:disabled)) { border-color: var(--muted); }
  :global(button:active:not(:disabled)) { transform: scale(.97); }
  :global(button:disabled) { opacity: .5; cursor: not-allowed; }
  :global(:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  :global(button.primary) { background: var(--accent); border-color: var(--accent); color: #fff; }
  :global(button.danger) { background: transparent; border-color: var(--danger); color: var(--danger); }
  :global(.muted) { color: var(--muted); }
  :global(.small) { font-size: 13px; }
  :global(.err) { color: var(--danger); font-size: 13px; }
  :global(.card) {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
  }

  .center { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
  .login { width: min(420px, 100%); display: flex; flex-direction: column; gap: 12px; }

  .app { display: grid; grid-template-columns: 190px 1fr; grid-template-rows: 1fr auto; min-height: 100vh; }
  aside {
    grid-row: 1 / 3;
    border-right: 1px solid var(--border);
    background: var(--surface);
    padding: 14px 10px;
    display: flex; flex-direction: column; gap: 4px;
  }
  .brand { display: flex; align-items: center; gap: 9px; padding: 4px 8px 16px; font-size: 14px; letter-spacing: .01em; }
  .mark {
    width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
    display: grid; place-items: center; color: #fff;
    background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #8b5cf6));
    box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .mark svg { margin-left: 1px; }
  nav { display: flex; flex-direction: column; gap: 2px; }
  nav a {
    display: flex; align-items: center; gap: 9px;
    padding: 8px 10px; border-radius: var(--radius);
    color: var(--muted); text-decoration: none; font-size: 14px;
  }
  nav a:hover { background: var(--surface-2); }
  nav a.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .badge { margin-left: auto; font-size: 11px; background: var(--surface-2); padding: 1px 7px; border-radius: 99px; }
  .spacer { flex: 1; }
  .status {
    padding: 0 8px 14px;
    display: flex; align-items: center; gap: 8px; font-size: 12px;
  }
  /* Green = broadcasting, red = not, amber = preparing subtitles. */
  .onair {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px 3px 8px; border-radius: 999px;
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
    font-weight: 500; letter-spacing: .02em;
  }
  .onair.live {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }
  .onair.prep {
    background: color-mix(in srgb, #c98a2e 16%, transparent);
    color: #c98a2e;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex-shrink: 0; }
  .dot.live { background: var(--success); animation: pulse 2s ease-in-out infinite; }
  .dot.prep { background: #c98a2e; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 40%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 0%, transparent); }
  }
  .speed { color: var(--muted); font-variant-numeric: tabular-nums; }
  .speed.slow { color: var(--danger); }

  main { padding: 22px 26px; min-width: 0; }

  footer {
    grid-column: 2; position: relative;
    border-top: 1px solid var(--border);
    background: var(--surface); padding: 12px 20px 10px;
  }

  /* The seek strip spans the entire top edge of the bar — the whole width is
     the timeline, like every video player, instead of a floating segment. */
  .seek {
    position: absolute; top: 0; left: 0; right: 0; height: 4px;
    transform: translateY(-50%);
    background: var(--surface-2);
    transition: height .12s ease;
  }
  .seek .fill {
    height: 100%; background: var(--accent);
    border-radius: 0 2px 2px 0;
    transition: width .4s linear;
    position: relative;
  }
  .seek .fill::after {
    content: ''; position: absolute; right: -5px; top: 50%;
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--accent); transform: translateY(-50%) scale(0);
    transition: transform .12s ease;
    box-shadow: 0 1px 4px rgba(0,0,0,.35);
  }
  .seek.seekable { cursor: pointer; }
  .seek.seekable:hover, .seek.seekable:focus-visible { height: 8px; }
  .seek.seekable:hover .fill::after { transform: translateY(-50%) scale(1); }
  .bubble {
    position: absolute; bottom: 14px; transform: translateX(-50%);
    background: var(--text); color: var(--bg);
    font-size: 11px; font-variant-numeric: tabular-nums;
    padding: 3px 8px; border-radius: 6px; pointer-events: none;
    white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3);
  }

  /* Three zones: now-playing | transport | actions. The transport is grid-
     centered so it cannot drift when the title or actions change width. */
  .frow {
    display: grid; grid-template-columns: 1fr auto 1fr;
    align-items: center; gap: 16px;
  }
  .fleft { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .cover {
    width: 44px; height: 62px; object-fit: cover; border-radius: 6px;
    border: 1px solid var(--border); flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  .np { min-width: 0; }
  .np .title {
    margin: 0; font-size: 14px; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .np p { margin: 2px 0 0; }
  .pill {
    display: inline-block; margin-left: 6px; padding: 1px 8px;
    font-size: 11px; font-weight: 500; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent); vertical-align: 1px;
  }

  .ctl { display: flex; gap: 8px; align-items: center; }
  .ctl .ic {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 3px; width: 40px; height: 40px; padding: 0;
    border-radius: 50%; border-color: transparent; background: transparent;
    color: var(--muted);
  }
  .ctl .ic:hover:not(:disabled) { background: var(--surface-2); color: var(--text); border-color: transparent; }
  .ctl .play {
    width: 44px; height: 44px;
    background: var(--accent); color: #fff;
  }
  .ctl .play:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, #fff);
    color: #fff;
  }
  .tiny { font-size: 9px; font-weight: 600; }

  .fright { display: flex; gap: 8px; justify-content: flex-end; }
  .fright button { padding: 6px 12px; font-size: 13px; }
  .panel {
    grid-column: 2; border-top: 1px solid var(--border);
    background: var(--surface); padding: 12px 20px 16px;
  }
  .phead { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 8px; }
  .tr {
    display: block; width: 100%; text-align: left; margin: 3px 0;
    background: transparent; border-color: var(--border); font-size: 13px;
  }
  .tr.pick { border-color: var(--accent); color: var(--accent); }
  .toast {
    position: fixed; bottom: 18px; right: 18px; max-width: 420px;
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--muted);
    border-radius: var(--radius); padding: 11px 14px; font-size: 13px;
    box-shadow: 0 6px 24px rgba(0,0,0,.25);
    animation: slidein .2s ease;
  }
  .toast.error { border-left-color: var(--danger); }
  @keyframes slidein {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*) { animation: none !important; transition: none !important; }
  }
</style>
