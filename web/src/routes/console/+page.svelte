<script>
  import { onMount, onDestroy } from 'svelte';
  import { api } from '$lib/api.js';

  // Read-only by design: the server exposes no input path, so this page can
  // show everything without becoming a remote shell.
  let entries = $state([]);
  let after = 0;
  let follow = $state(true);
  let filter = $state('');
  let error = $state('');
  let timer;
  let box;

  async function poll() {
    try {
      const r = await api.get(`/api/debug/log?after=${after}`);
      if (r.entries?.length) {
        entries = [...entries, ...r.entries].slice(-2000);
        after = r.entries[r.entries.length - 1].id;
        if (follow) queueMicrotask(() => box?.scrollTo(0, box.scrollHeight));
      }
      error = '';
    } catch (err) { error = err.message; }
  }

  onMount(() => { poll(); timer = setInterval(poll, 2000); });
  onDestroy(() => clearInterval(timer));

  const shown = $derived(filter
    ? entries.filter((e) => e.line.toLowerCase().includes(filter.toLowerCase()))
    : entries);

  const fmt = (t) => new Date(t).toTimeString().slice(0, 8);
</script>

<svelte:head><title>Console — Jellystreamerr</title></svelte:head>

<header class="row">
  <h1>Console</h1>
  <div class="spacer"></div>
  <input placeholder="Filter (e.g. geometry, spawn, warn)" bind:value={filter} />
  <label class="chk"><input type="checkbox" bind:checked={follow} /> Follow</label>
  <button onclick={() => { entries = []; }}>Clear view</button>
</header>
<p class="muted small">
  Live server and ffmpeg activity, read-only. Stream keys are redacted before
  anything reaches this page — logs are safe to copy and paste.
</p>
{#if error}<p class="err">{error}</p>{/if}

<div class="log" bind:this={box}>
  {#each shown as e (e.id)}
    <div class="line {e.level}">
      <span class="t">{fmt(e.t)}</span>
      <span class="lv">{e.level}</span>
      <span class="tx">{e.line}</span>
    </div>
  {:else}
    <p class="muted">Nothing yet. Start a stream and activity appears here.</p>
  {/each}
</div>

<style>
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .spacer { flex: 1; }
  .row input[type="text"], .row input:not([type]) { width: 280px; }
  .chk { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
  .log {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 10px 12px;
    height: calc(100vh - 190px); overflow: auto;
    font: 12px/1.55 ui-monospace, "Cascadia Code", monospace;
  }
  .line { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-all; }
  .t { color: var(--muted); flex-shrink: 0; }
  .lv { flex-shrink: 0; width: 52px; color: var(--muted); }
  .line.warn .lv, .line.warn .tx { color: #c99a2e; }
  .line.error .lv, .line.error .tx { color: var(--danger); }
</style>
