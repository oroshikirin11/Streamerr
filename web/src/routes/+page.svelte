<script>
  import { onMount } from 'svelte';
  import { api, fmtTime , maskClock, parseClock } from '$lib/api.js';

  let libraries = $state([]);
  // Null = showing the folder cards. The grid only exists inside a library.
  let libraryId = $state(null);
  let items = $state([]);
  let total = $state(0);
  let search = $state('');
  let loading = $state(true);
  let error = $state('');
  /** Whether a broadcast is running — decides "Stream" vs "Add to queue". */
  let live = $state(false);

  const currentLibrary = $derived(libraries.find((l) => l.id === libraryId));

  async function refreshLive() {
    try { live = (await api.streamStatus()).status !== 'stopped'; }
    catch { live = false; }
  }

  // Drill-down state. Null series = showing the grid.
  let series = $state(null);
  let seasons = $state([]);
  let seasonId = $state(null);
  let episodes = $state([]);
  let selected = $state(new Set());
  // Episode ids whose still failed to load, so the row shows its tile instead.
  let brokenArt = $state(new Set());
  let starting = $state(false);
  /** How many were just appended to a running broadcast, for the hint. */
  let queued = $state(0);
  let tracksFor = $state(null);
  // Per-broadcast track choice, picked before starting.
  let trackOverride = $state(null);

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      refreshLive();
      libraries = await api.libraries();
      if (!libraries.length) {
        error = 'No libraries configured. Set one up in Settings.';
        return;
      }
      // A single library has no choice to offer — skip straight to its grid.
      if (libraries.length === 1) await enterLibrary(libraries[0]);
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function enterLibrary(l) {
    libraryId = l.id;
    search = '';
    items = [];
    await loadItems();
  }

  async function loadItems() {
    const res = await api.items(libraryId, search ? { search } : {});
    items = res.items;
    total = res.total;
  }

  async function openSeries(item) {
    refreshLive();
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

  /** All / none for the episodes currently listed (one season, or all). */
  const allSelected = $derived(
    episodes.length > 0 && episodes.every((e) => selected.has(e.id)));
  function toggleAll() {
    selected = allSelected ? new Set() : new Set(episodes.map((e) => e.id));
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

  const chosenAudio = (t) =>
    trackOverride?.audioIndex ?? t.data.chosen.audioIndex;
  const chosenSub = (t) =>
    trackOverride && 'subtitleId' in trackOverride
      ? trackOverride.subtitleId
      : t.data.chosen.subtitleKey;

  function pickAudio(i) {
    trackOverride = { ...(trackOverride ?? {}), audioIndex: i };
  }
  function pickSub(key) {
    trackOverride = {
      ...(trackOverride ?? {}),
      subtitleId: key,
      subtitleMode: key === null ? 'off' : 'always',
    };
  }

  /** Scheduled start: "HH:MM" today, or tomorrow when that is already past. */
  let scheduling = $state(false);
  let startTime = $state('');
  function toggleSchedule() {
    scheduling = !scheduling;
    if (scheduling && !startTime) {
      // Suggest the next half-hour — movie night starts on a round time.
      const d = new Date(Date.now() + 5 * 60_000);
      d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
      startTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
  }
  function startAtEpoch() {
    if (!scheduling || !startTime) return null;
    const t = parseClock(startTime);
    if (!t) return null;
    const d = new Date();
    d.setHours(t.h, t.m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  async function stream() {
    if (!selected.size) return;
    starting = true;
    error = '';
    try {
      const ordered = episodes.filter((e) => selected.has(e.id)).map((e) => e.id);
      if (live) {
        // Append behind whatever is already queued — the broadcast is not
        // interrupted, the selection just plays when its turn comes.
        const st = await api.streamStatus();
        if (st.status === 'stopped') {
          live = false;
          await api.start(ordered, trackOverride, startAtEpoch());
        } else {
          // Entries, not bare ids: sending ids alone silently discarded
          // every programmed air time and off-air break already set on the
          // schedule, so adding one episode from the library wiped an
          // evening's planning.
          await api.setQueue([
            ...(st.queue ?? []).map((q) => ({
              id: q.id,
              startAt: q.startAt ?? null,
              breakOffline: q.breakOffline ?? false,
            })),
            ...ordered.map((id) => ({ id })),
          ]);
        }
      } else {
        await api.start(ordered, trackOverride, startAtEpoch());
      }
      // Queued behind a running broadcast: say where the air times live,
      // because nothing else on this page points at them.
      queued = live ? ordered.length : 0;
      selected = new Set();
      trackOverride = null;
      scheduling = false;
      // Back to the grid: once it is playing, the transport bar is where you
      // control it, and the season list has served its purpose.
      series = null;
    } catch (err) {
      error = err.detail ? `${err.message}: ${err.detail}` : err.message;
    } finally {
      starting = false;
    }
  }
</script>


{#if loading}
  <p class="muted">Loading library…</p>

{:else if error && !items.length}
  <div class="card"><p class="err">{error}</p></div>

{:else if !libraryId}
  <header class="row">
    <h1>Library</h1>
  </header>
  <div class="folders">
    {#each libraries as l}
      <button class="folder" onclick={() => enterLibrary(l)} aria-label={l.name}>
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
             stroke-width="1.5" aria-hidden="true">
          {#if l.type === 'movies'}
            <path d="M4 5h16v14H4zM4 9h16M8 5v4M16 5v4M4 15h16M8 15v4M16 15v4"/>
          {:else if l.type === 'tvshows'}
            <path d="M3 8h18v11H3zM8 21h8M12 8L8 3M12 8l4-5"/>
          {:else}
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          {/if}
        </svg>
        <span class="fname">{l.name}</span>
        <span class="muted small">
          {l.type === 'movies' ? 'Movies' : l.type === 'tvshows' ? 'Shows' : 'Media'}
        </span>
      </button>
    {/each}
  </div>

{:else if !series}
  <header class="row">
    {#if libraries.length > 1}
      <button onclick={() => { libraryId = null; items = []; error = ''; }}>← Library</button>
    {/if}
    <h1 style="margin:0">{currentLibrary?.name ?? 'Library'}</h1>
    <div class="spacer"></div>
    <div class="search">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
           stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input placeholder="Search" bind:value={search}
             oninput={() => { clearTimeout(globalThis._t); globalThis._t = setTimeout(loadItems, 250); }} />
    </div>
  </header>

  {#if !items.length}
    {#if search}
      <!-- An empty grid after a search reads as a broken library unless it
           says which search emptied it. -->
      <p class="muted">
        Nothing matches “{search}”.
        <button class="lnk inline" onclick={() => { search = ''; load(); }}>Clear the search</button>
      </p>
    {:else}
      <p class="muted">Nothing here.</p>
    {/if}
  {:else}
    <div class="grid">
      {#each items as item}
        <button class="poster" onclick={() => openSeries(item)} aria-label={item.title}>
          <div class="art">
            {#if item.image}
              <img src={item.image} alt="" loading="lazy" />
            {:else}
              <span class="initial">{item.title.slice(0, 1)}</span>
            {/if}
            <span class="playbadge" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </span>
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
    <button onclick={() => { series = null; error = ''; }}>← {currentLibrary?.name ?? 'Library'}</button>
    <h1 style="margin:0">{series.title}</h1>
    <div class="spacer"></div>
    {#if selected.size}
      {#if !live}
        {#if scheduling}
          <input class="schedtime" type="text" inputmode="numeric" maxlength="5"
                 placeholder="HH:MM" bind:value={startTime}
                 oninput={(e) => { startTime = maskClock(e.currentTarget.value); }}
                 aria-label="Go live at (24-hour, HH:MM)"
                 title="The stream opens with a countdown card until this time" />
        {/if}
        <button class="sched" class:on={scheduling} onclick={toggleSchedule}
                title={scheduling ? 'Start immediately instead' : 'Schedule the start — a countdown card runs until then'}
                aria-pressed={scheduling} aria-label="Schedule the start">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>
          </svg>
        </button>
      {/if}
      <button class="primary" disabled={starting} onclick={stream}>
        {#if starting}{live ? 'Queueing…' : 'Starting…'}
        {:else if scheduling && startTime && !live}Go live at {startTime}
        {:else}{live ? 'Add' : 'Stream'} {selected.size} episode{selected.size > 1 ? 's' : ''}{live ? ' to queue' : ''}{/if}
      </button>
    {/if}
  </header>

  {#if error}<p class="err">{error}</p>{/if}
  {#if queued}
    <p class="queued">
      Added {queued} to the queue.
      <a href="/queue">Open Schedule</a> to see when each one airs, or to
      program a time.
      <button class="lnk" onclick={() => (queued = 0)} aria-label="Dismiss">×</button>
    </p>
  {/if}

  {#if seasons.length > 1}
    <div class="seasons">
      <button class:on={seasonId === null} onclick={() => pickSeason(null)}>All</button>
      {#each seasons as s}
        <button class:on={seasonId === s.id} onclick={() => pickSeason(s.id)}>{s.name}</button>
      {/each}
    </div>
  {/if}

  {#if episodes.length}
    <div class="selbar">
      <input type="checkbox" id="ep-all" checked={allSelected}
             indeterminate={selected.size > 0 && !allSelected}
             onchange={toggleAll} />
      <label for="ep-all" class="selall">
        {allSelected ? 'Select none' : 'Select all'}
        <span class="muted small">({episodes.length})</span>
      </label>
      {#if selected.size}
        <span class="muted small selcount">{selected.size} selected</span>
        <button class="ghost small" onclick={() => (selected = new Set())}>Clear</button>
      {/if}
    </div>
  {/if}

  <ul class="eps">
    {#each episodes as ep}
      <li class:sel={selected.has(ep.id)}>
        <input type="checkbox" id={`ep-${ep.id}`}
               checked={selected.has(ep.id)} onchange={() => toggle(ep.id)} />
        <!-- A label makes the whole row toggle the checkbox natively, so it
             works from the keyboard too — a click handler on the <li> did
             not. -->
        <label class="rowlabel" for={`ep-${ep.id}`}>
          <!-- Every row gets a still frame of the same size, art or not: a
               grid that only sometimes indents reads as broken. Without art
               the tile carries the episode number, so the column still means
               something. -->
          <span class="still">
            {#if ep.image && !brokenArt.has(ep.id)}
              <!-- Jellyfin serves stills from its own host, which the browser
                   may not be able to reach. Falling back to the tile keeps a
                   broken-image icon off the row. -->
              <img src={ep.image} alt="" loading="lazy" decoding="async"
                   onerror={() => (brokenArt = new Set([...brokenArt, ep.id]))} />
            {:else}
              <span class="stub">{ep.episode != null ? ep.episode : '·'}</span>
            {/if}
          </span>
          <span class="meta">
            <span class="t">{ep.title}</span>
            <span class="sub">
              {ep.season != null && ep.episode != null ? `S${String(ep.season).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')}` : '—'}
              {#if ep.duration}<span class="dot">·</span>{fmtTime(ep.duration)}{/if}
            </span>
          </span>
        </label>
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
            <li>
              <button class="tr" class:pick={a.typeIndex === chosenAudio(tracksFor)}
                      onclick={() => pickAudio(a.typeIndex)}>
                {a.language ?? '?'} · {a.codec} · {a.channels ?? '?'}ch{a.title ? ` — ${a.title}` : ''}
              </button>
            </li>
          {/each}
        </ul>
        <p class="muted small">Subtitles</p>
        <ul class="tracks">
          <li>
            <button class="tr" class:pick={chosenSub(tracksFor) === null}
                    onclick={() => pickSub(null)}>None</button>
          </li>
          {#each tracksFor.data.subtitles as s}
            <li>
              <button class="tr" class:pick={String(s.key) === String(chosenSub(tracksFor))}
                      onclick={() => pickSub(s.key)}>
                {s.language ?? '?'} · {s.codec}{s.forced ? ' · forced' : ''}{s.external ? ' · sidecar' : ''}
              </button>
            </li>
          {/each}
        </ul>
        <p class="small">→ {tracksFor.data.chosen.reason}</p>
        <p class="muted small">
          Click a track to use it for this broadcast instead.
        </p>
      {/if}
      <button onclick={() => (tracksFor = null)}>Close</button>
    </div>
  </div>
{/if}

<style>
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .spacer { flex: 1; }

  .folders {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    max-width: 800px;
  }
  .folder {
    display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
    padding: 18px 16px 14px; text-align: left;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; color: var(--muted);
    transition: transform .15s ease, box-shadow .15s ease, border-color .15s;
  }
  .folder:hover {
    transform: translateY(-3px); border-color: var(--accent);
    box-shadow: 0 10px 24px rgba(0,0,0,.25); color: var(--accent);
  }
  .fname { font-size: 15px; font-weight: 500; color: var(--text); }

  .search { position: relative; }
  .search svg {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--muted); pointer-events: none;
  }
  .search input { padding-left: 32px; width: 220px; transition: width .15s ease; }
  .search input:focus { width: 280px; }

  .grid {
    display: grid; gap: 18px 14px;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
  .poster { background: none; border: none; padding: 0; text-align: left; }
  .art {
    aspect-ratio: 2/3; border-radius: 8px; overflow: hidden;
    background: var(--surface-2); border: 1px solid var(--border);
    display: grid; place-items: center; position: relative;
    transition: transform .18s ease, box-shadow .18s ease;
  }
  .poster:hover .art, .poster:focus-visible .art {
    transform: translateY(-4px);
    box-shadow: 0 12px 28px rgba(0,0,0,.3);
  }
  .art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .initial { font-size: 32px; color: var(--muted); }
  .playbadge {
    position: absolute; inset: 0; display: grid; place-items: center;
    background: rgba(0,0,0,.35); color: #fff;
    opacity: 0; transition: opacity .15s ease;
  }
  .playbadge svg {
    width: 40px; height: 40px; padding: 10px; box-sizing: content-box;
    background: color-mix(in srgb, var(--accent) 90%, #000);
    border-radius: 50%; transform: scale(.85);
    transition: transform .15s ease;
  }
  .poster:hover .playbadge, .poster:focus-visible .playbadge { opacity: 1; }
  .poster:hover .playbadge svg { transform: scale(1); }
  .name { margin: 7px 0 0; font-size: 13px; line-height: 1.35; }
  .poster:hover .name { color: var(--accent); }
  .poster p { margin: 1px 0 0; }

  .seasons { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
  .seasons button.on { border-color: var(--accent); color: var(--accent); }

  .eps { list-style: none; padding: 0; margin: 0; }
  .eps li {
    display: flex; align-items: center; gap: 12px;
    padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 14px;
    border-radius: var(--radius); cursor: pointer;
    transition: background .12s ease;
  }
  .eps li:hover { background: var(--surface-2); }
  .eps li.sel { background: color-mix(in srgb, var(--accent) 9%, transparent); }
  .rowlabel {
    display: flex; align-items: center; gap: 12px;
    flex: 1; min-width: 0; cursor: pointer;
  }
  .eps li:focus-within { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* 16:9, because an episode still is a frame of the video — unlike the
     2:3 posters on the series grid. Fixed size so every row aligns. */
  .still {
    flex: none; width: 96px; height: 54px; border-radius: 6px;
    overflow: hidden; background: var(--surface-2);
    border: 1px solid var(--border);
    display: grid; place-items: center;
  }
  .still img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .stub {
    font-variant-numeric: tabular-nums; color: var(--muted);
    font-size: 15px; opacity: .5;
  }
  .meta { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .dot { margin: 0 5px; }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted); padding: 4px 8px; }
  button.ghost:hover { border-color: var(--border); }

  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: grid; place-items: center; padding: 20px;
  }
  .modal { width: min(460px, 100%); max-height: 80vh; overflow: auto; }
  .tracks { list-style: none; padding: 0; margin: 4px 0 14px; font-size: 13px; }
  .tracks li { padding: 0; }
  .tr {
    display: block; width: 100%; text-align: left; margin: 3px 0;
    background: transparent; border-color: var(--border); font-size: 13px;
  }
  .tr.pick { border-color: var(--accent); color: var(--accent); }
  .queued {
    display: flex; align-items: center; gap: 8px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius);
    padding: 8px 12px; font-size: 13px; margin: 0 0 12px;
  }
  .queued a { color: var(--accent); }
  .lnk {
    margin-left: auto; background: none; border: none; color: var(--muted);
    cursor: pointer; padding: 0 4px; font-size: 15px; line-height: 1;
  }
  .lnk.inline {
    margin-left: 4px; padding: 0; font-size: inherit;
    color: var(--accent); text-decoration: underline;
  }

  .selbar {
    display: flex; align-items: center; gap: 9px;
    padding: 6px 10px; margin-bottom: 2px;
    border-bottom: 1px solid var(--border);
  }
  .selbar input { width: auto; }
  .selall { font-size: 13px; cursor: pointer; user-select: none; }
  .selcount { margin-left: auto; }

  .sched {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; padding: 7px 0; color: var(--muted);
  }
  .sched:hover { color: var(--text); }
  .sched.on { color: var(--accent); border-color: var(--accent); }
  .schedtime { width: auto; padding: 6px 8px; font-size: 13px; }
</style>
