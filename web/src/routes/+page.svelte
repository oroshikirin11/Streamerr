<script>
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { api, fmtTime , maskClock, parseClock } from '$lib/api.js';
  import Inspector from '$lib/Inspector.svelte';
  import { modal } from '$lib/modal.js';

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
  /**
   * Shelves fold on their name — every library open by default, and a
   * fold is a viewing preference for THIS visit, so it lives here and not
   * in any config. Keyed by library id; absent means open.
   */
  let folded = $state({});
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
    refreshSched();
  }

  // Tonight and the saved schedules: the poster's button reads them. With
  // nothing lined up and nothing on air, a click streams at once; with a
  // draft or a broadcast, it adds to tonight, which the server plays next.
  let sched = $state({ schedules: [], tonight: { entries: [], segments: [] }, history: [] });
  async function refreshSched() {
    try { sched = await api.schedule(); } catch { /* keep what we have */ }
  }
  onMount(refreshLive);
  const adding = $derived(live || (sched.tonight?.entries?.length ?? 0) > 0);
  const epName = (t) => { const i = String(t ?? '').lastIndexOf(' — '); return i > 0 ? t.slice(i + 3) : t; };
  let schedMenu = $state(false);
  let schedName = $state('');
  async function addToSchedule(id) {
    schedMenu = false;
    const ordered = episodes.filter((e) => selected.has(e.id)).map((e) => e.id);
    if (!ordered.length) return;
    starting = true; error = '';
    try {
      let name;
      if (id === 'new') {
        name = schedName.trim() || series?.title || 'New schedule';
        await api.createSchedule({ name, itemIds: ordered });
      } else {
        const s = sched.schedules.find((x) => x.id === id);
        name = s?.name ?? '';
        await api.updateSchedule(id, { itemIds: [...(s?.items ?? []).map((i) => i.id), ...ordered] });
      }
      await refreshSched();
      window.dispatchEvent(new CustomEvent('jsr-toast', { detail: {
        kind: 'info', message: `Added ${ordered.length} to "${name}".`, href: '/queue', hrefLabel: 'Open Schedule',
      } }));
      clearSelection();
    } catch (err) { error = err.message; }
    finally { starting = false; schedName = ''; }
  }

  // Drill-down state. Null series = showing the grid.
  //
  // The open show also lives in the URL (`/?series=<id>`), so Back leaves
  // the show for the grid rather than the whole Library, Forward returns
  // to it, and a show can be linked. State follows the URL: opening pushes
  // an entry, and the effect below turns URL changes — Back, Forward, a
  // pasted link — back into state.
  let series = $state(null);
  const seriesParam = $derived(page.url.searchParams.get('series'));
  /** Whether the entry under this show is the grid, so "← Shows" can go back. */
  let pushedFromGrid = false;
  /** Shelf labels by show id, so Back/Forward keeps the "← Movies" name. */
  const fromLabels = new Map();
  const seriesUrl = (id) => `/?series=${encodeURIComponent(id)}`;
  function pushSeriesUrl(id) {
    if (seriesParam === id) return;
    pushedFromGrid = seriesParam == null;
    goto(seriesUrl(id), { keepFocus: true, noScroll: true });
  }
  /** Leave the show for the grid: pop our own entry when there is one. */
  function showGrid() {
    error = '';
    if (seriesParam == null) { series = null; return; }
    if (pushedFromGrid) history.back();
    else goto('/', { keepFocus: true });
  }
  /** Something to open from the URL when it is not on a loaded shelf. */
  async function itemFromUrl(id) {
    for (const sh of shelves) {
      const it = sh.items.find((x) => x.id === id);
      if (it) return { item: it, from: shelfTitle(sh.library) };
    }
    const r = await api.inspect(id);
    if (r.kind !== 'series') return null;
    return { item: { id: r.id, title: r.title, type: 'Series' }, from: null };
  }
  // Depends on the URL (and the initial load) ONLY: reading `series` here
  // would re-run this the moment openSeries assigns it — before goto has
  // put the id in the URL — and close the show it just opened.
  $effect(() => {
    const id = seriesParam;
    if (loading) return;
    untrack(() => syncFromUrl(id));
  });
  function syncFromUrl(id) {
    if (id == null) { pushedFromGrid = false; if (series) { series = null; clearSelection(); } return; }
    if (series?.id !== id) openFromUrl(id);
  }
  async function openFromUrl(id) {
    let found;
    try { found = await itemFromUrl(id); }
    catch (err) { found = null; error = err.message; }
    if (!found) { goto('/', { replaceState: true }); return; }
    await openSeries(found.item, found.from ?? fromLabels.get(id) ?? null, { fromUrl: true });
  }
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
  /** The media inspector: { id, title, pick } while open. */
  let inspect = $state(null);
  function openInspect(item, e = null) {
    e?.stopPropagation?.(); e?.preventDefault?.();
    inspect = { id: item.id, title: item.title, pick: null };
  }
  /** From the season list: the same sheet, with the tracks pickable for the next broadcast. */
  function openInspectPick(ep) {
    inspect = { id: ep.id, title: ep.title, pick: true };
  }
  // Per-broadcast track choice, picked before starting. It describes the
  // files of THIS selection: it goes with the selection when that is
  // cleared, and with the show when another one opens — a subtitle index
  // picked for one series is meaningless in the next.
  let trackOverride = $state(null);
  function clearSelection() {
    selected = new Set();
    trackOverride = null;
  }

  /**
   * Background still generation, polled only while it is running — and once
   * a minute otherwise, since a refresh or a settings change can start one.
   */
  let stills = $state({ running: false, done: 0, total: 0, failed: 0 });
  let meta = $state({ running: false, fetched: 0, matched: 0, missed: 0 });
  /** Bumped as background work lands, so frame images retry their URL. */
  let artVersion = $state(0);
  onMount(() => {
    let stop = false;
    let lastDone = -1;
    let lastFetched = -1;
    let lastAuto = 0;
    const tick = async () => {
      if (stop) return;
      try { stills = await api.get('/api/library/stills'); } catch { /* not fatal */ }
      try { meta = await api.get('/api/library/meta/status'); } catch { /* not fatal */ }
      // Background work landed: pull it in without asking for a refresh.
      // Shelf data re-fetches (new TMDB titles and posters), and bumping
      // artVersion re-requests episode stills whose earlier fetch 404'd —
      // throttled, so a busy sweep does not turn browsing into a reload
      // loop.
      const grew = (lastDone >= 0 && stills.done !== lastDone)
        || (lastFetched >= 0 && meta.fetched !== lastFetched);
      lastDone = stills.done;
      lastFetched = meta.fetched;
      if (grew && Date.now() - lastAuto > 15_000) {
        lastAuto = Date.now();
        artVersion = Date.now();
        loadShelves().catch(() => {});
      }
      setTimeout(tick, stills.running || meta.running ? 2000 : 60_000);
    };
    tick();
    return () => { stop = true; };
  });

  /** Frame stills get a version so a placeholder retries once work lands. */
  const art = (u) => (u && artVersion && u.includes('-frame') ? `${u}&sv=${artVersion}` : u);

  /**
   * Fix artwork: the operator browses TMDB candidates and pins the right
   * one to a title the matcher got wrong (or missed). The item carries
   * its cache key (`metaKey`), so the fix lands in exactly the slot the
   * wrong answer occupies.
   */
  let fixItem = $state(null);
  let fixQuery = $state('');
  let fixResults = $state(null);
  let fixBusy = $state(false);
  let fixError = $state('');
  function openFix(item, e) {
    e.stopPropagation();
    e.preventDefault();
    fixItem = item;
    fixQuery = item.rawTitle?.replace(/\((?:19|20)\d{2}\)/, '').trim() ?? item.title;
    fixResults = null;
    fixError = '';
    fixSearch();
  }
  async function fixSearch() {
    if (!fixItem || !fixQuery.trim()) return;
    fixBusy = true; fixError = '';
    try {
      const r = await api.get(`/api/library/meta/search?type=${fixItem.metaType}`
        + `&q=${encodeURIComponent(fixQuery.trim())}`);
      fixResults = r.results ?? [];
    } catch (err) { fixError = err.message; }
    finally { fixBusy = false; }
  }
  async function fixApply(candidate) {
    fixBusy = true; fixError = '';
    try {
      await api.post('/api/library/meta/assign',
        { metaKey: fixItem.metaKey, tmdbId: candidate.id });
      fixItem = null;
      await refreshLibrary();
    } catch (err) { fixError = err.message; }
    finally { fixBusy = false; }
  }
  /** Nothing here is right: drop the match and stay with the filename. */
  async function fixClear() {
    fixBusy = true; fixError = '';
    try {
      await api.post('/api/library/meta/clear', { metaKey: fixItem.metaKey });
      fixItem = null;
      await refreshLibrary();
    } catch (err) { fixError = err.message; }
    finally { fixBusy = false; }
  }

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

  /** Looking inside a folder before deciding what clicking it means. */
  let opening = $state(false);

  async function openSeries(item, from = null, { fromUrl = false } = {}) {
    refreshLive();

    // A movie is a single playable file — it has no seasons to list, and
    // asking Jellyfin for its episodes returns nothing.
    if (item.type === 'Movie') {
      fromLibrary = from;
      fromLabels.set(item.id, from);
      series = item;
      seasonId = null;
      seasons = [];
      error = '';
      episodes = [{ ...item, season: null, episode: null }];
      selected = new Set([item.id]);
      trackOverride = null;
      if (!fromUrl) pushSeriesUrl(item.id);
      return;
    }

    // Look inside BEFORE switching views. A folder holding one film reads
    // as a series until something looks inside it, and a list of one entry
    // is a worse answer than just playing the thing — decided on click
    // rather than while listing, because over SMB looking inside every
    // folder to label the grid cost a round trip per row. Probing first
    // also means a single film plays straight from the grid instead of
    // flashing an empty detail view for the length of an SMB round trip.
    if (opening) return;
    opening = true;
    let ss = [];
    let eps = [];
    let failed = null;
    try {
      ss = await api.seasons(item.id);
      eps = await api.episodes(item.id);
    } catch (err) { failed = err.message; }
    finally { opening = false; }

    if (!failed && !ss.length && eps.length === 1 && eps[0].type === 'Movie') {
      // Reached by link: the URL names a show that turned out to be a film.
      if (fromUrl) goto('/', { replaceState: true });
      await playMovie(eps[0]);
      return;
    }

    fromLibrary = from;
    fromLabels.set(item.id, from);
    series = item;
    seasonId = null;
    seasons = ss;
    episodes = eps;
    clearSelection();
    error = failed ?? '';
    if (!fromUrl) pushSeriesUrl(item.id);
  }

  async function pickSeason(id) {
    seasonId = id;
    episodes = await api.episodes(series.id, id ?? undefined);
    clearSelection();
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
    if (allSelected) clearSelection();
    else selected = new Set(episodes.map((e) => e.id));
  }

  /** Everything from this episode to the end — the usual "watch on" case. */
  function selectFrom(id) {
    const i = episodes.findIndex((e) => e.id === id);
    selected = new Set(episodes.slice(i).map((e) => e.id));
  }


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
      // Decide on fresh facts: the broadcast may have ended, or tonight
      // may have been lined up on another tab, since the button was drawn.
      await refreshSched();
      const st = await api.streamStatus();
      live = st.status !== 'stopped';
      const addOnly = live || (sched.tonight?.entries?.length ?? 0) > 0;
      // Everything goes through tonight, so the schedule page shows it and
      // history remembers it; with nothing lined up, tonight goes live at
      // once. Adding behind a broadcast never interrupts it — the server
      // hands the engine the new lineup and the selection plays its turn.
      // Lining up and going live are two calls, and the tray answers the
      // first one before the second has started the broadcast: for that
      // moment it offered "Go live" for a stream already on its way. Tell
      // it the start is under way for the whole sequence.
      if (!addOnly) window.dispatchEvent(new CustomEvent('jsr-going-live', { detail: { on: true } }));
      await api.tonightAdd(ordered);
      if (!addOnly) {
        await api.goLive(startAtEpoch(), trackOverride);
      } else {
        const n = ordered.length;
        // A tonight item is just an id — the lineup has nowhere to keep a
        // track choice, and only the start call takes one. Say so rather
        // than let a pick made in the Inspector vanish quietly.
        const dropped = Boolean(trackOverride && Object.keys(trackOverride).length);
        window.dispatchEvent(new CustomEvent('jsr-toast', { detail: {
          kind: dropped ? 'warn' : 'info',
          message: (live
            ? `Added ${n} ${n === 1 ? 'title' : 'titles'} — they play after what is lined up.`
            : `Added ${n} ${n === 1 ? 'title' : 'titles'} to tonight.`)
            + (dropped ? ' Track choice applies only when starting a broadcast — it was not kept for the queued items.' : ''),
          href: '/queue', hrefLabel: 'Open Schedule',
        } }));
      }
      await refreshSched();
      clearSelection();
      scheduling = false;
      // Back to the grid: once it is playing, the transport bar is where you
      // control it, and the season list has served its purpose.
      showGrid();
    } catch (err) {
      error = err.detail ? `${err.message}: ${err.detail}` : err.message;
    } finally {
      starting = false;
      window.dispatchEvent(new CustomEvent('jsr-going-live', { detail: { on: false } }));
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
      <span class="stills" title={`Making the missing episode pictures — ${stills.done} made so far${stills.failed ? `, ${stills.failed} could not be made` : ''}.${stills.current ? ` Working on ${stills.current}.` : ''} They are made a couple dozen at a time with short pauses, and paused entirely while you are on air, so browsing stays fast.`}>
        <span class="spin" aria-hidden="true"></span>
        {stills.done} made
      </span>
    {/if}
    {#if meta.running && meta.fetched}
      <!-- Same quiet register as the stills indicator: background work
           reporting itself, not asking for attention. -->
      <span class="stills" title={`Matching titles against TMDB — ${meta.matched} matched so far${meta.missed ? `, ${meta.missed} not found` : ''}. Runs in the background; the library fills in as answers land.`}>
        <span class="spin" aria-hidden="true"></span>
        matching titles
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
        <h2>
          <button class="fold" onclick={() => (folded[sh.library.id] = !folded[sh.library.id])}
                  aria-expanded={!folded[sh.library.id]}>
            <svg class="chev" class:closed={folded[sh.library.id]} viewBox="0 0 24 24"
                 width="15" height="15" fill="currentColor" aria-hidden="true">
              <path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/>
            </svg>
            {shelfTitle(sh.library)}
          </button>
        </h2>
        <span class="count">{sh.total || sh.items.length}</span>
      </header>
      {#if !folded[sh.library.id]}
      <div class="grid">
        {#each sh.items.slice(0, shown[sh.library.id] ?? SHELF_STEP) as item, i (item.id)}
          <button class="poster" disabled={starting || opening}
                  onclick={() => (item.type === 'Movie'
                    ? playMovie(item)
                    : openSeries(item, shelfTitle(sh.library)))}
                  aria-label={item.type === 'Movie'
                    ? `${adding ? 'Add' : 'Stream'} ${item.title}`
                    : item.title}>
            <div class="art">
              {#if item.image}
                <img src={art(item.image)} alt="" decoding="async"
                     loading={lazyImages ? 'lazy' : 'eager'}
                     fetchpriority={i < 12 ? 'auto' : 'low'} />
              {:else}
                <span class="initial">{item.title.slice(0, 1)}</span>
              {/if}
              <span class="playbadge" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </span>
              <!-- The corner cluster. Not <button>s: they live inside one.
                   Each stops the click so inspecting or fixing never queues
                   the title it belongs to. Info is on every tile — a film
                   has no page of its own, so this is its detail view. -->
              <span class="tileacts">
                <span class="tileact" role="button" tabindex="0"
                      title="What this file is, and what the encoder will do with it"
                      onclick={(e) => openInspect(item, e)}
                      onkeydown={(e) => { if (e.key === 'Enter') openInspect(item, e); }}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>
                </span>
                {#if item.metaKey}
                  <span class="tileact" role="button" tabindex="0"
                        title="Wrong picture or title? Pick the right one from TMDB"
                        onclick={(e) => openFix(item, e)}
                        onkeydown={(e) => { if (e.key === 'Enter') openFix(item, e); }}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                  </span>
                {/if}
              </span>
            </div>
            <p class="name">{item.title}</p>
            {#if item.childCount}<p class="muted small">{item.childCount} episodes</p>{/if}
          </button>
        {/each}
      </div>
      {/if}
    </section>
  {/each}
  <!-- Grows every shelf that still has items left, so the page keeps
       extending as you scroll instead of ending at an arbitrary cut. -->
  <div use:sentinel class="sentinel" aria-hidden="true"></div>


{:else}
  <header class="row">
    <button onclick={showGrid}>← {fromLibrary ?? 'Library'}</button>
    <h1 style="margin:0">{series.title}</h1>
    <div class="spacer"></div>
    {#if selected.size}
      <span class="menu">
        <button class="ghost" onclick={() => (schedMenu = !schedMenu)} disabled={starting}
                title="Keep these in a saved schedule instead of playing them now">Add to schedule…</button>
        {#if schedMenu}
          <div class="pop">
            {#each sched.schedules as s (s.id)}
              <button class="line" onclick={() => addToSchedule(s.id)}>{s.name} <span class="muted">· {s.items.length} items</span></button>
            {/each}
            <div class="newrow">
              <input placeholder={series?.title ?? 'New schedule'} bind:value={schedName}
                     onkeydown={(e) => { if (e.key === 'Enter') addToSchedule('new'); }} />
              <button onclick={() => addToSchedule('new')}>New</button>
            </div>
          </div>
        {/if}
      </span>
      {#if !adding}
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
        {:else if scheduling && startTime && !adding}Go live at {startTime}
        {:else}{adding ? 'Add' : 'Stream'} {selected.size} episode{selected.size > 1 ? 's' : ''}{adding ? ' to tonight' : ''}{/if}
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
        <button class="ghost small" onclick={clearSelection}>Clear</button>
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
              <img src={art(ep.image)} alt="" decoding="async"
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
        <button class="ghost small" onclick={() => openInspectPick(ep)} title="What this file is, and which tracks to use">Info</button>
        <button class="ghost small" onclick={() => selectFrom(ep.id)}>From here</button>
      </li>
    {/each}
  </ul>
{/if}

{#if inspect}
  <Inspector id={inspect.id} title={inspect.title} onclose={() => (inspect = null)}
             pick={inspect.pick ? {
               audioIndex: trackOverride?.audioIndex ?? null,
               subtitleKey: trackOverride && 'subtitleId' in trackOverride ? trackOverride.subtitleId : undefined,
               onAudio: pickAudio, onSub: pickSub,
             } : null} />
{/if}

{#if fixItem}
  <div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) fixItem = null; }} role="presentation">
    <div class="card modal fixmodal" role="dialog" aria-modal="true" tabindex="-1"
         aria-labelledby="fix-title" use:modal={{ onClose: () => (fixItem = null) }}>
      <h3 id="fix-title">Pick the right match</h3>
      <p class="muted small">For <b>{fixItem.rawTitle}</b> — the choice is
        remembered and never re-matched.</p>
      <form class="fixsearch" onsubmit={(e) => { e.preventDefault(); fixSearch(); }}>
        <input type="search" bind:value={fixQuery} aria-label="Search TMDB"
               placeholder="Search TMDB" />
        <button type="submit" disabled={fixBusy}>{fixBusy ? 'Searching…' : 'Search'}</button>
      </form>
      {#if fixError}<p class="err">{fixError}</p>{/if}
      {#if fixResults}
        {#if !fixResults.length}
          <p class="muted">Nothing found — try fewer words.</p>
        {:else}
          <div class="fixgrid">
            {#each fixResults as c (c.id)}
              <button class="fixcand" disabled={fixBusy} onclick={() => fixApply(c)}
                      title={c.overview}>
                {#if c.poster}
                  <img src={c.poster} alt="" loading="lazy" />
                {:else}
                  <span class="noart">{c.title.slice(0, 1)}</span>
                {/if}
                <span class="fixname">{c.title}{c.year ? ` (${c.year})` : ''}</span>
              </button>
            {/each}
          </div>
        {/if}
      {:else if fixBusy}
        <p class="muted">Searching…</p>
      {/if}
      <div class="fixfoot">
        <button onclick={fixClear} disabled={fixBusy}
                title="Drop whatever TMDB matched and keep the filename and local artwork">
          Remove match — keep the filename
        </button>
        <div style="flex:1"></div>
        <button onclick={() => (fixItem = null)}>Close</button>
      </div>
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
    display: grid; gap: 18px 14px; align-items: start;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }

  /* Shelves. Headers scroll with their shelf. They used to stick to the
     top of the screen, which inside the padded scroller left a band above
     them for posters to show through — and pinned a title the operator had
     already scrolled past. */
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
    padding: 10px 0 12px;
  }
  .shead h2 { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: .1px; }
  /* The name IS the fold control. Inherits the heading's look wholesale;
     opacity pinned because an old .shead button rule fades buttons out. */
  .shead .fold {
    display: inline-flex; align-items: center; gap: 7px;
    background: none; border: none; padding: 0; cursor: pointer;
    font: inherit; color: inherit; letter-spacing: inherit;
    opacity: 1 !important;
  }
  .shead .fold .chev { transition: transform .14s ease; color: var(--muted); }
  .shead .fold .chev.closed { transform: rotate(-90deg); }
  .shead .fold:hover .chev { color: inherit; }
  .shead .count {
    font-size: 12px; color: var(--muted);
    background: var(--surface-2); border-radius: 999px; padding: 2px 9px;
  }
  .shead .spacer { flex: 1; }
  .shead button { opacity: 0; transition: opacity .14s ease; }
  .shelf:hover .shead button,
  .shead button:focus-visible { opacity: 1; }
  .sentinel { height: 1px; }
  /* A tile is its grid track, never its caption: a long dotted release
     name used to widen the button (and with it the poster) and run its
     text across the neighbours. */
  .poster { background: none; border: none; padding: 0; text-align: left; display: block; width: 100%; min-width: 0; }
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
  /* Fix-artwork: a corner affordance that exists only under the cursor,
     so the grid stays a grid until someone needs it. */
  .tileacts { position: absolute; top: 6px; right: 6px; z-index: 2; display: flex; gap: 4px; }
  .tileact {
    display: grid; place-items: center; width: 26px; height: 26px; border-radius: 999px;
    background: rgba(0, 0, 0, 0.65); color: #fff; opacity: 0; transition: opacity .14s ease, background .14s ease;
  }
  .poster:hover .tileact, .tileact:focus-visible { opacity: 1; }
  .tileact:hover { background: rgba(0, 0, 0, 0.85); }
  .fixart {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    display: grid; place-items: center; width: 26px; height: 26px;
    border-radius: 6px; background: rgba(0, 0, 0, 0.65); color: #fff;
    opacity: 0; transition: opacity 0.12s ease; cursor: pointer;
  }
  .poster:hover .fixart, .fixart:focus-visible { opacity: 1; }
  .fixart:hover { background: rgba(0, 0, 0, 0.85); }
  .fixmodal { width: min(680px, 92vw); }
  .fixsearch { display: flex; gap: 8px; margin: 10px 0; }
  .fixsearch input { flex: 1; }
  .fixgrid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 10px; max-height: 55vh; overflow-y: auto; margin-bottom: 12px;
  }
  .fixcand {
    background: none; border: 1px solid transparent; border-radius: 8px;
    padding: 4px; text-align: left; cursor: pointer;
  }
  .fixcand:hover { border-color: var(--accent); }
  .fixcand img, .fixcand .noart {
    width: 100%; aspect-ratio: 2/3; object-fit: cover; border-radius: 6px;
    background: rgba(255, 255, 255, 0.06); display: grid; place-items: center;
    font-size: 22px; color: var(--muted);
  }
  .fixname { display: block; font-size: 11.5px; margin-top: 4px; line-height: 1.25; }
  .fixfoot { display: flex; gap: 8px; align-items: center; }
  .poster:hover .playbadge svg { transform: scale(1); }
  .name {
    margin: 7px 0 0; font-size: 13px; line-height: 1.35;
    overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
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
    /* Above everything on the page. */
    z-index: 30;
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
  .menu { position: relative; }
  .pop { position: absolute; top: 110%; right: 0; z-index: 5; min-width: 260px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .pop .line { display: block; width: 100%; text-align: left; margin: 2px 0; background: transparent; border-color: transparent; font-size: 13px; }
  .pop .line:hover { background: var(--surface-2); }
  .pop .newrow { display: flex; gap: 6px; margin-top: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
  .pop .newrow input { flex: 1; min-width: 0; padding: 5px 8px; font-size: 13px; }
</style>
