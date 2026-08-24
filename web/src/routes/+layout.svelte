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

  const live = $derived(
    stream.status === 'running' || stream.status === 'starting'
    || stream.status === 'paused');
  const paused = $derived(stream.status === 'paused');

  onMount(async () => {
    await refreshAuth();
    ready = true;
    if (authed) startFeed();
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
      <h1>Jellystreamerr</h1>
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
        <span class="dot" class:live></span>
        <strong>Jellystreamerr</strong>
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
      <div class="status">
        {live ? 'on air' : 'offline'}
        {#if speed}<br />speed {speed}×{/if}
      </div>
    </aside>

    <main>
      {@render children()}
    </main>

    {#if stream.playing}
      <footer>
        {#if stream.playing.image}
          <img class="cover" src={stream.playing.image} alt="" />
        {/if}
        <div class="np">
          <p class="title">{stream.playing.title}{paused ? ' — paused' : ''}</p>
          <p class="muted small">
            {fmtTime(position)}
            {#if stream.playing.duration} / {fmtTime(stream.playing.duration)}{/if}
            {#if stream.queue?.length} · next: {stream.queue[0].title}{/if}
          </p>
        </div>

        <div class="bar" class:seekable={stream.playing.duration}
             role="slider" tabindex="0" aria-label="Seek"
             aria-valuenow={Math.round(position)}
             onclick={(e) => {
               if (!stream.playing.duration || busyCtl) return;
               const r = e.currentTarget.getBoundingClientRect();
               const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
               ctl(() => api.seek({ position: frac * stream.playing.duration }));
             }}
             onkeydown={(e) => {
               if (e.key === 'ArrowRight') skip(30);
               if (e.key === 'ArrowLeft') skip(-30);
             }}>
          <div class="fill" style:width="{stream.playing.duration
            ? Math.min(100, (position / stream.playing.duration) * 100)
            : 0}%"></div>
        </div>

        <div class="ctl">
          <button class="ic" onclick={() => skip(-30)} disabled={busyCtl} title="Back 30 seconds" aria-label="Back 30 seconds">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 19a7 7 0 1 0-6.9-8.5M4 4v6h6"/></svg><span class="tiny">30</span>
          </button>
          <button class="ic" onclick={togglePause} disabled={busyCtl} title={paused ? 'Resume' : 'Pause'} aria-label={paused ? 'Resume' : 'Pause'}>
            {#if paused}
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
            {/if}
          </button>
          <button class="ic" onclick={() => skip(30)} disabled={busyCtl} title="Forward 30 seconds" aria-label="Forward 30 seconds">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M13 19a7 7 0 1 1 6.9-8.5M20 4v6h-6"/></svg><span class="tiny">30</span>
          </button>
          <button onclick={openTracks} disabled={busyCtl}>Audio &amp; subs</button>
          <button class="danger" onclick={stopStream} disabled={busyCtl}>Stop</button>
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
  :global(button) { cursor: pointer; background: var(--surface-2); }
  :global(button:hover:not(:disabled)) { border-color: var(--muted); }
  :global(button:disabled) { opacity: .5; cursor: not-allowed; }
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
  .brand { display: flex; align-items: center; gap: 8px; padding: 4px 8px 14px; font-size: 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .dot.live { background: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 25%, transparent); }
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
  .status { padding: 10px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }

  main { padding: 22px 26px; min-width: 0; }

  footer {
    grid-column: 2; border-top: 1px solid var(--border);
    background: var(--surface); padding: 10px 20px;
    display: flex; align-items: center; gap: 16px;
  }
  .cover {
    width: 38px; height: 54px; object-fit: cover; border-radius: 4px;
    border: 1px solid var(--border); flex-shrink: 0;
  }
  .np { min-width: 0; flex: 0 1 300px; }
  .np .title { margin: 0; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .np p { margin: 2px 0 0; }
  .bar { flex: 3; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width .4s linear; }

  .ctl { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }
  .ctl button { padding: 6px 10px; font-size: 13px; }
  .ctl .ic { display: inline-flex; align-items: center; gap: 3px; padding: 6px 9px; }
  .tiny { font-size: 10px; }
  .bar.seekable { cursor: pointer; }
  .bar.seekable:hover { height: 7px; }
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
  }
  .toast.error { border-left-color: var(--danger); }
</style>
