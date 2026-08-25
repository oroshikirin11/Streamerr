<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, fmtTime } from '$lib/api.js';

  let status = $state({ status: 'stopped', playing: null, queue: [] });
  let error = $state('');
  let tracks = $state(null);
  let switching = $state(false);
  let note = $state('');
  let editing = $state(false);
  let skipping = $state(false);
  let timer;

  // Dev-only (`npm run dev` + ?mock): these controls only exist during a
  // broadcast, which would otherwise make them impossible to style or click
  // through without one. Stripped from production builds.
  const mock = import.meta.env.DEV
    && typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('mock');

  async function refresh() {
    if (mock) {
      status = {
        status: 'running',
        position: 201,
        playing: { title: "Frieren: Beyond Journey's End — S1E1", duration: 1563 },
        queue: [
          { id: 'a', title: "Frieren — S1E2", duration: 1420 },
          { id: 'b', title: "Frieren — S1E3", duration: 1435 },
          { id: 'c', title: "Frieren — S1E4", duration: 1418 },
        ],
      };
      return;
    }
    try { status = await api.streamStatus(); }
    catch (err) { error = err.message; }
  }

  onMount(() => { refresh(); if (!mock) timer = setInterval(refresh, 4000); });
  onDestroy(() => clearInterval(timer));

  /** Every edit is a full replacement of the upcoming list, keyed by id. */
  async function editQueue(fn) {
    editing = true; error = '';
    try {
      const ids = (status.queue ?? []).map((q) => q.id);
      await api.setQueue(fn(ids));
      await refresh();
    } catch (err) { error = err.message; }
    finally { editing = false; }
  }

  const removeAt = (i) => editQueue((ids) => ids.filter((_, j) => j !== i));
  const move = (i, d) => editQueue((ids) => {
    const next = [...ids];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    return next;
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

  async function skipCurrent() {
    skipping = true; error = ''; note = '';
    try {
      status = await api.next();
      tracks = null;   // they describe the clip that just left the air
    } catch (err) { error = err.message; }
    finally { skipping = false; }
  }
</script>


<div class="wrap">
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
      <button onclick={skipCurrent} disabled={skipping || !status.queue?.length}
              title={status.queue?.length
                ? `Skip to ${status.queue[0].title}`
                : 'Nothing queued to skip to'}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"
             style="vertical-align:-2px; margin-right:6px;"><path d="M6 5v14l9-7zM16 5h3v14h-3z"/></svg>
        {skipping ? 'Skipping…' : 'Skip episode'}
      </button>
      <button onclick={loadTracks} disabled={switching}>Change audio or subtitles</button>
      <div style="flex:1"></div>
      <button class="danger" onclick={stop}>Stop broadcast</button>
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
    <p class="muted">
      Nothing queued — the broadcast ends when this finishes.
      Add more from the library at any time.
    </p>
  {:else}
    <ul class="q">
      {#each status.queue as item, i (item.id ?? i)}
        <li>
          <span class="pos muted small">{i + 1}</span>
          <span class="qt">{item.title}</span>
          {#if item.duration}<span class="muted small">{fmtTime(item.duration)}</span>{/if}
          <span class="qctl">
            <button class="ic" disabled={editing || i === 0} onclick={() => move(i, -1)}
                    title="Move up" aria-label="Move up">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
            <button class="ic" disabled={editing || i === status.queue.length - 1} onclick={() => move(i, 1)}
                    title="Move down" aria-label="Move down">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            </button>
            <button class="ic rm" disabled={editing} onclick={() => removeAt(i)}
                    title="Remove from queue" aria-label="Remove from queue">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
</div>

<style>
  .wrap { max-width: 680px; margin: 0 auto; }
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
  .q { list-style: none; padding: 0; margin: 0; }
  .q li {
    display: flex; align-items: center; gap: 12px;
    padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 14px;
    border-radius: var(--radius);
    transition: background .12s ease;
  }
  .q li:hover { background: var(--surface-2); }
  .pos { min-width: 18px; text-align: right; font-variant-numeric: tabular-nums; }
  .qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qctl { display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; }
  .q li:hover .qctl, .q li:focus-within .qctl { opacity: 1; }
  .qctl .ic {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0; border-radius: 6px;
    background: transparent; border-color: transparent; color: var(--muted);
  }
  .qctl .ic:hover:not(:disabled) { background: var(--surface); color: var(--text); }
  .qctl .rm:hover:not(:disabled) { color: var(--danger); }
</style>
