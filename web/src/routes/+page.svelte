<script>
  import { onMount } from 'svelte';
  import { api, fmtTime } from '$lib/api.js';

  let libraries = $state([]);
  let libraryId = $state(null);
  let items = $state([]);
  let total = $state(0);
  let search = $state('');
  let loading = $state(true);
  let error = $state('');

  // Drill-down state. Null series = showing the grid.
  let series = $state(null);
  let seasons = $state([]);
  let seasonId = $state(null);
  let episodes = $state([]);
  let selected = $state(new Set());
  let starting = $state(false);
  let tracksFor = $state(null);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      libraries = await api.libraries();
      if (!libraries.length) {
        error = 'No libraries configured. Set one up in Settings.';
        return;
      }
      libraryId = libraries[0].id;
      await loadItems();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function loadItems() {
    const res = await api.items(libraryId, search ? { search } : {});
    items = res.items;
    total = res.total;
  }

  async function openSeries(item) {
    series = item;
    selected = new Set();
    seasonId = null;
    seasons = [];
    episodes = [];
    error = '';

    // A movie is a single playable file — it has no seasons to list, and
    // asking Jellyfin for its episodes returns nothing.
    if (item.type === 'Movie') {
      episodes = [{ ...item, season: null, episode: null }];
      selected = new Set([item.id]);
      return;
    }

    try {
      seasons = await api.seasons(item.id);
      episodes = await api.episodes(item.id);
    } catch (err) {
      error = err.message;
    }
  }

  async function pickSeason(id) {
    seasonId = id;
    episodes = await api.episodes(series.id, id ?? undefined);
    selected = new Set();
  }

  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected = next;
  }

  /** Everything from this episode to the end — the usual "watch on" case. */
  function selectFrom(id) {
    const i = episodes.findIndex((e) => e.id === id);
    selected = new Set(episodes.slice(i).map((e) => e.id));
  }

  async function showTracks(ep) {
    tracksFor = { episode: ep, data: null, error: null };
    try {
      tracksFor = { episode: ep, data: await api.tracks(ep.id), error: null };
    } catch (err) {
      tracksFor = { episode: ep, data: null, error: err.message };
    }
  }

  async function stream() {
    if (!selected.size) return;
    starting = true;
    error = '';
    try {
      const ordered = episodes.filter((e) => selected.has(e.id)).map((e) => e.id);
      await api.start(ordered);
      selected = new Set();
    } catch (err) {
      error = err.detail ? `${err.message}: ${err.detail}` : err.message;
    } finally {
      starting = false;
    }
  }
</script>

<svelte:head><title>Library — Jellystreamerr</title></svelte:head>

{#if loading}
  <p class="muted">Loading library…</p>

{:else if error && !items.length}
  <div class="card"><p class="err">{error}</p></div>

{:else if !series}
  <header class="row">
    <h1>Library</h1>
    <div class="spacer"></div>
    {#if libraries.length > 1}
      <select bind:value={libraryId} onchange={loadItems}>
        {#each libraries as l}<option value={l.id}>{l.name}</option>{/each}
      </select>
    {/if}
    <input placeholder="Search" bind:value={search}
           oninput={() => { clearTimeout(globalThis._t); globalThis._t = setTimeout(loadItems, 250); }} />
  </header>

  {#if !items.length}
    <p class="muted">Nothing here.</p>
  {:else}
    <div class="grid">
      {#each items as item}
        <button class="poster" onclick={() => openSeries(item)}>
          <div class="art">
            {#if item.image}
              <img src={item.image} alt="" loading="lazy" />
            {:else}
              <span class="initial">{item.title.slice(0, 1)}</span>
            {/if}
          </div>
          <p class="name">{item.title}</p>
          {#if item.childCount}<p class="muted small">{item.childCount} episodes</p>{/if}
        </button>
      {/each}
    </div>
    {#if total > items.length}
      <p class="muted small">Showing {items.length} of {total}</p>
    {/if}
  {/if}

{:else}
  <header class="row">
    <button onclick={() => { series = null; error = ''; }}>← Library</button>
    <h1 style="margin:0">{series.title}</h1>
    <div class="spacer"></div>
    {#if selected.size}
      <button class="primary" disabled={starting} onclick={stream}>
        {starting ? 'Starting…' : `Stream ${selected.size} episode${selected.size > 1 ? 's' : ''}`}
      </button>
    {/if}
  </header>

  {#if error}<p class="err">{error}</p>{/if}

  {#if seasons.length > 1}
    <div class="seasons">
      <button class:on={seasonId === null} onclick={() => pickSeason(null)}>All</button>
      {#each seasons as s}
        <button class:on={seasonId === s.id} onclick={() => pickSeason(s.id)}>{s.name}</button>
      {/each}
    </div>
  {/if}

  <ul class="eps">
    {#each episodes as ep}
      <li class:sel={selected.has(ep.id)}>
        <input type="checkbox" checked={selected.has(ep.id)} onchange={() => toggle(ep.id)} />
        <span class="num">
          {ep.season != null && ep.episode != null ? `S${String(ep.season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')}` : '—'}
        </span>
        <span class="t">{ep.title}</span>
        {#if ep.duration}<span class="muted small">{fmtTime(ep.duration)}</span>{/if}
        <button class="ghost small" onclick={() => showTracks(ep)}>Tracks</button>
        <button class="ghost small" onclick={() => selectFrom(ep.id)}>From here</button>
      </li>
    {/each}
  </ul>
{/if}

{#if tracksFor}
  <div class="overlay" onclick={() => (tracksFor = null)} role="presentation">
    <div class="card modal" onclick={(e) => e.stopPropagation()} role="presentation">
      <h3>{tracksFor.episode.title}</h3>
      {#if tracksFor.error}
        <p class="err">{tracksFor.error}</p>
      {:else if !tracksFor.data}
        <p class="muted">Reading tracks…</p>
      {:else}
        <p class="muted small">Audio</p>
        <ul class="tracks">
          {#each tracksFor.data.audio as a}
            <li class:pick={a.typeIndex === tracksFor.data.chosen.audioIndex}>
              {a.language ?? '?'} · {a.codec} · {a.channels ?? '?'}ch
              {#if a.title}<span class="muted"> — {a.title}</span>{/if}
            </li>
          {/each}
        </ul>
        <p class="muted small">Subtitles</p>
        <ul class="tracks">
          {#each tracksFor.data.subtitles as s}
            <li class:pick={String(s.key) === String(tracksFor.data.chosen.subtitleKey)}>
              {s.language ?? '?'} · {s.codec}
              {#if s.forced} · forced{/if}{#if s.external} · sidecar{/if}
            </li>
          {:else}
            <li class="muted">none</li>
          {/each}
        </ul>
        <p class="small">→ {tracksFor.data.chosen.reason}</p>
      {/if}
      <button onclick={() => (tracksFor = null)}>Close</button>
    </div>
  </div>
{/if}

<style>
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .spacer { flex: 1; }

  .grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
  .poster { background: none; border: none; padding: 0; text-align: left; }
  .art {
    aspect-ratio: 2/3; border-radius: 8px; overflow: hidden;
    background: var(--surface-2); border: 1px solid var(--border);
    display: grid; place-items: center;
  }
  .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .initial { font-size: 32px; color: var(--muted); }
  .name { margin: 6px 0 0; font-size: 13px; line-height: 1.35; }
  .poster p { margin: 1px 0 0; }

  .seasons { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .seasons button.on { border-color: var(--accent); color: var(--accent); }

  .eps { list-style: none; padding: 0; margin: 0; }
  .eps li {
    display: flex; align-items: center; gap: 12px;
    padding: 9px 10px; border-bottom: 1px solid var(--border); font-size: 14px;
  }
  .eps li.sel { background: color-mix(in srgb, var(--accent) 9%, transparent); }
  .num { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; min-width: 62px; }
  .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted); padding: 4px 8px; }
  button.ghost:hover { border-color: var(--border); }

  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: grid; place-items: center; padding: 20px;
  }
  .modal { width: min(460px, 100%); max-height: 80vh; overflow: auto; }
  .tracks { list-style: none; padding: 0; margin: 4px 0 14px; font-size: 13px; }
  .tracks li { padding: 4px 8px; border-radius: 6px; }
  .tracks li.pick { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
</style>
