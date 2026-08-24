<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  let cfg = $state(null);
  let saved = $state(false);
  let error = $state('');

  onMount(async () => {
    try { cfg = await api.config(); }
    catch (err) { error = err.message; }
  });

  async function save() {
    error = ''; saved = false;
    try {
      await api.saveConfig({
        owncast: { rtmpUrl: cfg.owncast.rtmpUrl },
        encoder: {
          backend: cfg.encoder.backend,
          width: +cfg.encoder.width, height: +cfg.encoder.height,
          fps: +cfg.encoder.fps, videoBitrate: cfg.encoder.videoBitrate,
          gopSeconds: +cfg.encoder.gopSeconds,
        },
        tracks: cfg.tracks,
      });
      saved = true;
      setTimeout(() => (saved = false), 3000);
    } catch (err) { error = err.message; }
  }

  async function logout() { await api.logout(); location.reload(); }
</script>

<svelte:head><title>Settings — Jellystreamerr</title></svelte:head>

<h1>Settings</h1>

{#if !cfg}
  <p class="muted">Loading…</p>
{:else}
  <div class="card">
    <h3>Output</h3>
    <div class="g">
      <div><label>Width</label><input type="number" bind:value={cfg.encoder.width} /></div>
      <div><label>Height</label><input type="number" bind:value={cfg.encoder.height} /></div>
      <div><label>FPS</label><input type="number" bind:value={cfg.encoder.fps} /></div>
      <div><label>Bitrate</label><input bind:value={cfg.encoder.videoBitrate} /></div>
      <div><label>Keyframes (s)</label><input type="number" bind:value={cfg.encoder.gopSeconds} /></div>
      <div><label>Encoder</label><input bind:value={cfg.encoder.backend} /></div>
    </div>
    <p class="muted small">
      Keyframe interval must divide Owncast's segment length — 2 seconds is what its docs recommend.
    </p>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Owncast</h3>
    <label>Server address</label>
    <input bind:value={cfg.owncast.rtmpUrl} spellcheck="false" />
    <p class="muted small">
      The stream key is stored but never sent back to the browser. Change it in setup.
    </p>
  </div>

  <div class="row" style="margin-top:16px">
    <button class="primary" onclick={save}>Save</button>
    <a href="/setup"><button>Re-run setup</button></a>
    <div style="flex:1"></div>
    <button onclick={logout}>Sign out</button>
  </div>
  {#if saved}<p class="muted small">Saved.</p>{/if}
  {#if error}<p class="err">{error}</p>{/if}
{/if}

<style>
  .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
  input { width: 100%; font: inherit; color: inherit; border-radius: var(--radius);
          border: 1px solid var(--border); background: var(--surface); padding: 8px 11px; }
  .row { display: flex; gap: 8px; align-items: center; }
  a { text-decoration: none; }
</style>
