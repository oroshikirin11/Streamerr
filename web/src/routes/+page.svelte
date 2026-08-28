<script>
  import { onMount } from 'svelte';
  import { api, fmtTime , maskClock, parseClock } from '$lib/api.js';

  let libraries = $state([]);
  // Null = showing the folder cards. The grid only exists inside a library.
  /** Which shelf a series was opened from, so the back button names it. */
  let fromLibrary = $state(null);
  let loading = $state(true);
  let error = $state('');
  /** Whether a broadcast is running — decides "Stream" vs "Add to queue". */
  let live = $state(false);


  /** Landing view: every library as its own shelf, so the first screen shows
   *  media instead of two folders to click through. */
  let shelves = $state([]);
  /** How many of each shelf are rendered. Grown by the scroll sentinel
   *  rather than rendering thousands of posters up front. */
  let shown = $state({});
  const SHELF_STEP = 24;
  /** The items endpoint caps a response at 200, so a shelf holds a window
   *  onto its library rather than the whole thing. Reaching the end of what
   *  is loaded fetches the next window. */
  const PAGE = 60;
  /** Which library is shown alone; null means all of them. */
  let onlyLibrary = $state(null);
  /** Searches every shelf at once. Server-side, because a shelf only ever
   *  holds a page of its library — filtering what happens to be loaded would
   *  quietly miss most of a big one. */
  let shelfSearch = $state('');
  let searchTimer = null;
  let searching = $state(false);

  /**
   * A shelf heading should read as a category, not as a folder on disk.
   * "movies" and "tv" become "Movies" and "Shows", while a library someone
   * deliberately named — "Anime", "Documentaries 4K" — keeps its own name.
   */
  const GENERIC_NAME = /^(movies?|films?|tv|shows?|tvshows|series|media|video)$/i;
  const shelfTitle = (l) => {
    if (!GENERIC_NAME.test((l.name ?? '').trim())) return l.name;
    if (l.type === 'movies') return 'Movies';
    if (l.type === 'tvshows') return 'Shows';
    return (l.name ?? '').replace(/^./, (c) => c.toUpperCase());
  };
  /** Honours the Library display setting; see config.ui.lazyImages. */
  let lazyImages = $state(false);
  let refreshing = $state(false);

  /**
   * Nothing on this side caches listings, so this is mostly for Jellyfin:
   * the server asks it to rescan, and media that was missing is media
   * Jellyfin had not indexed. Its scan runs in the background, hence the
   * wording of the confirmation rather than a claim that it is done.
   */
  async function refreshLibrary() {
    refreshing = true;
    try {
      const r = await api.refreshLibrary();
      // Re-fetch the libraries too, not just their contents: the server
      // rebuilt its providers, and a source added or removed since this page
      // loaded would otherwise be missing from the shelves.
      libraries = await api.libraries();
      await loadShelves();
      window.dispatchEvent(new CustomEvent('jsr-toast', { detail: {
        kind: 'info',
        message: r?.note ?? 'Library refreshed.',
      } }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('jsr-toast', { detail: { kind: 'error', message: err.message } }));
    } finally {
      refreshing = false;
    }
  }

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
  // Measured against a real Jellyfin library: stills come back 356x200 in
  // about 9ms, so a long series costs a couple of hundred milliseconds and a
  // couple of megabytes to fetch in full. The cap only exists to stop a
  // thousand-episode series firing a thousand requests at once; every
  // ordinary show sits well inside it. Set below 89 it would have left the
  // longest series in that library still popping in.
  const EAGER_STILLS = 120;
  let starting = $state(false);
  let tracksFor = $state(null);
  // Per-broadcast track choice, picked before starting.
  let trackOverride = $state(null);

  /**
   * Background still generation, polled only while it is running — and once
   * a minute otherwise, since a refresh or a settings change can start one.
   */
  let stills = $state({ running: false, done: 0, total: 0, failed: 0 });
  onMount(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try { stills = await api.get('/api/library/stills'); } catch { /* not fatal */ }
      setTimeout(tick, stills.running ? 2000 : 60_000);
    };
    tick();
    return () => { stop = true; };
  });

  onMount(load);

  async function load() {
    loading = true;
    error = '';
    try {
      refreshLive();
      api.config().then((c) => { lazyImages = Boolean(c.ui?.lazyImages); }).catch(() => {});
      libraries = await api.libraries();
      if (!libraries.length) {
        error = 'No libraries configured. Set one up in Settings.';
        return;
      }
      await loadShelves();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  /**
   * One shelf per library, fetched in parallel. A library that fails to load
   * is dropped rather than taking the whole page down with it — a broken
   * Jellyfin should not hide a working folder library.
   */
  async function loadShelves() {
    const q = shelfSearch.trim();
    const next = await Promise.all(libraries.map(async (l) => {
      try {
        const res = await api.items(l.id, { limit: PAGE, ...(q ? { search: q } : {}) });
        return { library: l, items: res.items ?? [], total: res.total ?? 0 };
      } catch {
        // One broken provider should not blank the page for the others.
        return null;
      }
    }));
    shelves = next.filter(Boolean).filter((sh) => sh.items.length);
    shown = Object.fromEntries(shelves.map((sh) => [sh.library.id, SHELF_STEP]));
  }

  /** Debounced so typing does not fire a request per keystroke. */
  function onSearchInput() {
    clearTimeout(searchTimer);
    searching = true;
    searchTimer = setTimeout(async () => {
      try { await loadShelves(); } finally { searching = false; }
    }, 250);
  }

  let fetchingMore = false;
  /**
   * Reveal more, and fetch more when revealing runs out. Without the fetch
   * this stopped dead at the first page and looked like the library simply
   * ended there.
   */
  async function revealMore() {
    const next = { ...shown };
    let changed = false;
    for (const sh of shelves) {
      if (onlyLibrary && sh.library.id !== onlyLibrary) continue;
      const have = next[sh.library.id] ?? SHELF_STEP;
      if (have < sh.items.length) { next[sh.library.id] = have + SHELF_STEP; changed = true; }
    }
    if (changed) { shown = next; return; }

    if (fetchingMore) return;
    const hungry = shelves.find((sh) => (!onlyLibrary || sh.library.id === onlyLibrary)
      && sh.items.length < sh.total);
    if (!hungry) return;
    fetchingMore = true;
    try {
      const q = shelfSearch.trim();
      const res = await api.items(hungry.library.id, {
        startIndex: hungry.items.length, limit: PAGE, ...(q ? { search: q } : {}),
      });
      const more = res.items ?? [];
      if (more.length) {
        // Replace the entry so the keyed each block sees a new array.
        shelves = shelves.map((sh) => (sh.library.id === hungry.library.id
          ? { ...sh, items: [...sh.items, ...more] } : sh));
        shown = { ...shown, [hungry.library.id]: (shown[hungry.library.id] ?? SHELF_STEP) + SHELF_STEP };
      } else {
        // Guard against a provider that reports a total it will not serve.
        shelves = shelves.map((sh) => (sh.library.id === hungry.library.id
          ? { ...sh, total: sh.items.length } : sh));
      }
    } catch {
      /* leave what is already rendered alone */
    } finally {
      fetchingMore = false;
    }
  }

  /** The sentinel sits below the last shelf; seeing it means the reader has
   *  reached the end of what is rendered, so render more. */
  function sentinel(node) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) revealMore();
    }, { rootMargin: '600px' });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  /**
   * A film is one file. Opening a list of exactly one row to tick it and then
   * press a button is three clicks to do the obvious thing, so clicking the
   * poster does it: queued behind the broadcast if one is running, started if
   * not. Nothing is lost by skipping the detail view — audio and subtitles
   * can be changed live from the transport bar, and air times are programmed
   * on the Schedule page after queueing.
   */
  async function playMovie(item) {
    if (starting) return;
    await refreshLive();
    episodes = [{ ...item, season: null, episode: null }];
    selected = new Set([item.id]);
    trackOverride = null;
    scheduling = false;
    startTime = '';
    await stream();
  }

  async function openSeries(item, from = null) {
    refreshLive();
    fromLibrary = from;
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
      // A folder holding one film reads as a series until something looks
      // inside it, and a list of one entry is a worse answer than just
      // playing the thing. Decided here rather than while listing, because
      // over SMB looking inside every folder to label the grid cost a
      // network round trip per row and stalled browsing.
      if (!seasons.length && episodes.length === 1 && episodes[0].type === 'Movie') {
        await playMovie(episodes[0]);
      }
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
      // because nothing else points at them. Raised through the layout so it
      // lands in the corner you are already watching rather than at the
      // bottom of whatever page you happen to be on.
      if (live) {
        const n = ordered.length;
        window.dispatchEvent(new CustomEvent('jsr-toast', { detail: {
          kind: 'info',
          message: `Added ${n} ${n === 1 ? 'title' : 'titles'} to the queue.`,
          href: '/queue', hrefLabel: 'Open Schedule',
        } }));
      }
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

{:else if error && !shelves.length}
  <div class="card"><p class="err">{error}</p></div>

{:else if !series}
  <header class="row">
    <h1>Library</h1>
  </header>
  <div class="shelfbar">
    <div class="chips">
      <button class="chip" class:on={!onlyLibrary} onclick={() => (onlyLibrary = null)}>All</button>
      {#each shelves as sh (sh.library.id)}
        <!-- Clicking the active chip clears it, so the same button both
             narrows to one shelf and returns to everything. -->
        <button class="chip" class:on={onlyLibrary === sh.library.id}
                aria-pressed={onlyLibrary === sh.library.id}
                onclick={() => (onlyLibrary = onlyLibrary === sh.library.id ? null : sh.library.id)}>
          {shelfTitle(sh.library)}
        </button>
      {/each}
    </div>
    <div class="spacer"></div>
    {#if stills.running && stills.total}
      <!-- Quiet on purpose: this is background work nobody is waiting on,
           so it reports itself without asking for attention. -->
      <span class="stills" title={`Making the missing episode pictures — ${stills.done} of ${stills.total} done${stills.failed ? `, ${stills.failed} could not be made` : ''}. They are made a couple at a time and paused while you are on air, so browsing stays fast.`}>
        <span class="spin" aria-hidden="true"></span>
        {stills.done}/{stills.total}
      </span>
    {/if}
    <button class="ghost small" onclick={refreshLibrary} disabled={refreshing}
            title="Look for media added since this page was opened">
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
    <input class="find" type="search" bind:value={shelfSearch} oninput={onSearchInput}
           placeholder="Search the library" aria-label="Search the library" />
  </div>

  {#if searching}
    <p class="muted small">Searching…</p>
  {:else if shelfSearch.trim() && !shelves.length}
    <p class="muted">Nothing matches “{shelfSearch.trim()}”.</p>
  {/if}

  <!-- One shelf per library. The old screen was two folder buttons, which
       made the first thing you saw a filing cabinet rather than a library. -->
  {#each shelves.filter((sh) => !onlyLibrary || sh.library.id === onlyLibrary) as sh (sh.library.id)}
    <section class="shelf">
      <header class="shead">
        <h2>{shelfTitle(sh.library)}</h2>
        <span class="count">{sh.total || sh.items.length}</span>
      </header>
      <div class="grid">
        {#each sh.items.slice(0, shown[sh.library.id] ?? SHELF_STEP) as item, i (item.id)}
          <button class="poster" disabled={starting}
                  onclick={() => (item.type === 'Movie'
                    ? playMovie(item)
                    : openSeries(item, shelfTitle(sh.library)))}
                  aria-label={item.type === 'Movie'
                    ? `${live ? 'Queue' : 'Stream'} ${item.title}`
                    : item.title}>
            <div class="art">
              {#if item.image}
                <img src={item.image} alt="" decoding="async"
                     loading={lazyImages ? 'lazy' : 'eager'}
                     fetchpriority={i < 12 ? 'auto' : 'low'} />
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
    </section>
  {/each}
  <!-- Grows every shelf that still has items left, so the page keeps
       extending as you scroll instead of ending at an arbitrary cut. -->
  <div use:sentinel class="sentinel" aria-hidden="true"></div>


{:else}
  <header class="row">
    <button onclick={() => { series = null; error = ''; }}>← {fromLibrary ?? 'Library'}</button>
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
    {#each episodes as ep, i}
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
              <!-- Deferring these was the wrong default. A season is a few
                   dozen small images, and lazy loading only starts the
                   request once a row is nearly on screen — so any flick of
                   the wheel outruns it and rows arrive visibly blank. Fetch
                   a normal season up front instead, at low priority below
                   the fold so it never competes with the page itself, and
                   only fall back to lazy past the point where a list is
                   long enough for that to matter. -->
              <img src={ep.image} alt="" decoding="async"
                   loading={!lazyImages && i < EAGER_STILLS ? 'eager' : 'lazy'}
                   fetchpriority={i < 12 ? 'auto' : 'low'}
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
  .stills {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--muted); white-space: nowrap;
  }
  .stills .spin {
    width: 11px; height: 11px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--accent);
    animation: stillspin 0.9s linear infinite;
  }
  @keyframes stillspin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .stills .spin { animation: none; } }

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

  /* Shelves. The header is sticky so you always know which library you are
     looking at once a long one runs past the top of the screen. */
  .shelfbar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    margin: 0 0 18px;
  }
  .shelfbar .spacer { flex: 1; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    padding: 5px 13px; border-radius: 999px; font-size: 13px;
    background: var(--surface-2); border: 1px solid transparent; color: var(--muted);
    cursor: pointer; transition: color .12s ease, border-color .12s ease, background .12s ease;
  }
  .chip:hover { color: var(--text); }
  .chip.on { color: var(--accent); border-color: var(--accent); background: transparent; }
  .find { width: min(260px, 100%); }

  .shelf { margin: 0 0 26px; }
  /* Fixed track width, not 1fr: with a 1fr grid a three-film shelf stretched
     its posters to the width of the page and one category filled the screen.
     Posters should be the same size on every shelf regardless of how full
     it is, and the row should simply stop when it runs out. */
  .shelf .grid {
    grid-template-columns: repeat(auto-fill, 150px);
    justify-content: start; gap: 16px 16px;
  }
  .shead {
    display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px;
    position: sticky; top: 0; z-index: 2;
    background: linear-gradient(var(--bg) 72%, transparent);
    padding: 10px 0 12px;
  }
  .shead h2 { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: .1px; }
  .shead .count {
    font-size: 12px; color: var(--muted);
    background: var(--surface-2); border-radius: 999px; padding: 2px 9px;
  }
  .shead .spacer { flex: 1; }
  .shead button { opacity: 0; transition: opacity .14s ease; }
  .shelf:hover .shead button,
  .shead button:focus-visible { opacity: 1; }
  .sentinel { height: 1px; }
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
