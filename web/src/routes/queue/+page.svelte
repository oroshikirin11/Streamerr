<script>
  import { onMount } from 'svelte';
  import { api, fmtTime } from '$lib/api.js';

  let status = $state({ status: 'stopped', playing: null, queue: [] });
  let error = $state('');

  onMount(async () => {
    try { status = await api.streamStatus(); }
    catch (err) { error = err.message; }
  });

  async function stop() {
    try { await api.stop(); status = await api.streamStatus(); }
    catch (err) { error = err.message; }
  }
</script>

<svelte:head><title>Queue — Jellystreamerr</title></svelte:head>

<h1>Queue</h1>
{#if error}<p class="err">{error}</p>{/if}

{#if status.status === 'stopped'}
  <p class="muted">Nothing is streaming. Pick something from the library.</p>
{:else}
  <div class="card">
    <p class="muted small">On air</p>
    <p><strong>{status.playing?.title ?? '—'}</strong></p>
    <p class="muted small">
      {fmtTime(status.position ?? 0)}{#if status.playing?.duration} / {fmtTime(status.playing.duration)}{/if}
    </p>
    <button class="danger" onclick={stop}>Stop broadcast</button>
  </div>

  <h2 style="margin-top:22px">Up next</h2>
  {#if !status.queue?.length}
    <p class="muted">Nothing queued — the broadcast ends when this finishes.</p>
  {:else}
    <ol class="q">
      {#each status.queue as item}<li>{item.title}</li>{/each}
    </ol>
  {/if}
{/if}

<style>
  .q { padding-left: 20px; }
  .q li { padding: 5px 0; border-bottom: 1px solid var(--border); }
</style>
