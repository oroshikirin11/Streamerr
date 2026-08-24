<script>
  import { onMount } from 'svelte';
  import { api, fmtTime } from '$lib/api.js';

  let status = $state({ status: 'stopped', playing: null, queue: [] });
  let error = $state('');
  let tracks = $state(null);
  let switching = $state(false);
  let note = $state('');

  onMount(async () => {
    try { status = await api.streamStatus(); }
    catch (err) { error = err.message; }
  });

  async function loadTracks() {
    error = '';
    try { tracks = await api.liveTracks(); }
    catch (err) { error = err.message; }
  }

  /**
   * Track choice is fixed for the life of an ffmpeg process, so this restarts
   * the encoder and resumes where it left off. Viewers see a short break.
   */
  async function applyTracks(audioIndex, subtitleKey, subtitleMode) {
    switching = true; error = ''; note = '';
    try {
      const r = await api.setTracks({ audioIndex, subtitleKey, subtitleMode });
      note = `Now: ${r.tracks}`;
      status = await api.streamStatus();
      await loadTracks();
    } catch (err) { error = err.message; }
    finally { switching = false; }
  }

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
    <div class="onair-row">
      {#if status.playing?.image}
        <img class="cover" src={status.playing.image} alt="" />
      {/if}
      <div>
        <p class="muted small" style="margin: 0 0 2px;">On air</p>
        <p style="margin: 0;"><strong>{status.playing?.title ?? '—'}</strong></p>
        <p class="muted small" style="margin: 2px 0 0;">
          {fmtTime(status.position ?? 0)}{#if status.playing?.duration} / {fmtTime(status.playing.duration)}{/if}
        </p>
      </div>
    </div>
    <div class="row">
      <button class="danger" onclick={stop}>Stop broadcast</button>
      <button onclick={loadTracks} disabled={switching}>Change audio or subtitles</button>
    </div>

    {#if tracks}
      <div class="tracks">
        <p class="muted small">
          Switching restarts the encoder and resumes at the same point, so
          viewers see a few seconds of interruption.
        </p>

        <p class="muted small">Audio</p>
        {#each tracks.audio as a}
          <button class="line" class:on={a.typeIndex === tracks.chosen.audioIndex}
                  disabled={switching}
                  onclick={() => applyTracks(a.typeIndex, tracks.chosen.subtitleKey, undefined)}>
            {a.language ?? '?'} · {a.codec} · {a.channels ?? '?'}ch{a.title ? ` — ${a.title}` : ''}
          </button>
        {/each}

        <p class="muted small">Subtitles</p>
        <button class="line" class:on={tracks.chosen.subtitleKey === null}
                disabled={switching}
                onclick={() => applyTracks(tracks.chosen.audioIndex, null, 'off')}>
          None
        </button>
        {#each tracks.subtitles as s}
          <button class="line" class:on={String(s.key) === String(tracks.chosen.subtitleKey)}
                  disabled={switching}
                  onclick={() => applyTracks(tracks.chosen.audioIndex, s.key, 'always')}>
            {s.language ?? '?'} · {s.codec}{s.forced ? ' · forced' : ''}{s.external ? ' · sidecar' : ''}
          </button>
        {/each}
      </div>
    {/if}

    {#if switching}<p class="muted small">Restarting the encoder…</p>{/if}
    {#if note}<p class="small">{note}</p>{/if}
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
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .onair-row { display: flex; gap: 14px; align-items: center; }
  .cover {
    width: 52px; height: 74px; object-fit: cover; border-radius: 6px;
    border: 1px solid var(--border); flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,.25);
  }
  .tracks { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; }
  .line {
    display: block; width: 100%; text-align: left; margin: 3px 0;
    background: transparent; border-color: var(--border); font-size: 13px;
  }
  .line.on { border-color: var(--accent); color: var(--accent); }
  .q { padding-left: 20px; }
  .q li { padding: 5px 0; border-bottom: 1px solid var(--border); }
</style>
