<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, connectStatus, fmtTime, audioLabel, subtitleLabel } from '$lib/api.js';

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
        tracks: {
          audio: { language: 'jpn', title: null, codec: 'aac', channels: 2 },
          subtitle: { language: 'eng', title: null, codec: 'ass', forced: false, external: false },
        },
        queue: (() => {
          const t = Math.floor(Date.now() / 1000) + 1362;
          return [
            { id: 'a', title: "Frieren — S1E2", duration: 1420, at: t },
            { id: 'b', title: "Frieren — S1E3", duration: 1435, at: t + 1420 },
            { id: 'c', title: "Frieren — S1E4", duration: 1418,
              at: t + 4200, startAt: t + 4200 },
          ];
        })(),
      };
      return;
    }
    try { applyStatus(await api.streamStatus()); }
    catch (err) { error = err.message; }
  }

  let stopFeed;
  onMount(() => {
    refresh();
    if (mock) return;
    // Driven by the same push the transport bar uses, so the rundown moves
    // the instant the engine advances rather than up to a poll later. The
    // slow timer is only a safety net for a dropped socket.
    stopFeed = connectStatus((msg) => {
      if (msg.type === 'stream') applyStatus(msg.payload);
    });
    timer = setInterval(refresh, 10000);
  });
  onDestroy(() => { clearInterval(timer); stopFeed?.(); });

  /**
   * Adopt a status push, and abandon a time edit whose item is no longer
   * in the queue.
   *
   * Rows are identified by item id rather than position precisely because
   * of this moment: an item going on air shifts everything up, and an edit
   * keyed by row would land on whichever item took the slot.
   */
  function applyStatus(next) {
    status = next;
    if (pinId && !(next.queue ?? []).some((q) => q.id === pinId)) {
      pinId = null;
      note = 'That item went on air — its time can no longer be changed.';
      setTimeout(() => {
        if (note.startsWith('That item went on air')) note = '';
      }, 5000);
    }
  }

  /**
   * Every edit is a full replacement of the upcoming list. Entries carry
   * their pin as well as their id, so reordering or removing an item never
   * silently drops the times someone programmed.
   */
  /** Flip the break ahead of a pinned block between card and off-air. */
  const setBreakMode = (id, offline) => editQueue((es) =>
    es.map((e) => (e.id === id ? { ...e, breakOffline: offline } : e)));

  async function editQueue(fn) {
    editing = true; error = '';
    try {
      const entries = (status.queue ?? [])
        .map((q) => ({ id: q.id, startAt: q.startAt ?? null, breakOffline: q.breakOffline ?? false }));
      await api.setQueue(fn(entries));
      await refresh();
    } catch (err) { error = err.message; }
    finally { editing = false; }
  }

  const removeAt = (i) => editQueue((es) => es.filter((_, j) => j !== i));
  const move = (i, d) => editQueue((es) => {
    const next = [...es];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    return next;
  });

  // ── programmed air times ─────────────────────────────────────────────

  /** Which ITEM is having its time edited, and the value being typed. */
  let pinId = $state(null);
  let pinValue = $state('');

  const hhmm = (epoch) => new Date(epoch * 1000)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();

  /**
   * A long queue runs past midnight — 50 episodes is the best part of a
   * day — so a bare HH:MM would make tomorrow 02:14 look like today's.
   * Anything off today's date carries its weekday.
   */
  function clock(epoch) {
    if (epoch == null) return null;
    const now = Date.now() / 1000;
    if (sameDay(epoch, now)) return hhmm(epoch);
    return `${new Date(epoch * 1000).toLocaleDateString([], { weekday: 'short' })} ${hhmm(epoch)}`;
  }

  /** The day a pin is being typed against — the row's own, not today's. */
  let pinBase = $state(null);

  function openPin(q) {
    pinId = q.id;
    pinBase = q.startAt ?? q.at ?? Math.floor(Date.now() / 1000);
    // Seed with the time it would air anyway, so nudging is the easy case.
    pinValue = hhmm(pinBase);
  }

  /**
   * "HH:MM" on the day this item was already going to air, so nudging an
   * episode that falls after midnight does not yank it back to today.
   *
   * Deliberately does NOT roll an impossible time forward to the next day.
   * Doing so turned a mistyped hour into a twenty-three hour gap filled
   * with a test card — a silently absurd schedule instead of an error.
   * An unreachable time is refused by repin(); moving something to another
   * day is what the day-shift control is for.
   */
  function epochFor(hm, base) {
    const [h, m] = hm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const d = new Date((base ?? Math.floor(Date.now() / 1000)) * 1000);
    d.setHours(h, m, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  /** Shift a programmed time a whole day, for a multi-day marathon. */
  async function nudgeDay(id, days) {
    const q = status.queue.find((x) => x.id === id);
    const base = (q?.startAt ?? q?.at ?? Math.floor(Date.now() / 1000)) + days * 86400;
    if (base * 1000 <= Date.now()) return;
    await repin(id, base);
  }

  /**
   * Programme one item, carrying every later programmed time with it.
   *
   * A rundown moves as a block. Pushing episode 21 back ten minutes while
   * 22 and 23 keep their old times strands those pins in the past, where
   * they stop being programmed at all and quietly revert to whatever the
   * running order produces — the times you set simply stop meaning
   * anything. Unpinned items already cascade, so only the pins need
   * carrying.
   */
  /**
   * The earliest a row could possibly air: when everything ahead of it
   * finishes. A time before that is not a schedule, it is a wish — the
   * engine never starts a clip early, so the pin would simply be ignored
   * and the row would sit there looking programmed while meaning nothing.
   */
  function earliestFor(i) {
    const q = status.queue ?? [];
    const now = Date.now() / 1000;
    if (i <= 0) {
      const dur = status.playing?.duration;
      return dur ? now + Math.max(0, dur - (status.position ?? 0)) : now;
    }
    const prev = q[i - 1];
    if (prev?.at == null) return now;
    return prev.duration ? prev.at + prev.duration : prev.at;
  }

  async function repin(id, at) {
    const q = status.queue ?? [];
    const i = q.findIndex((x) => x.id === id);
    if (i < 0) { pinId = null; return; }

    // Refuse rather than accept a time the broadcast cannot honour. The
    // editor stays open so the time can be corrected in place.
    const earliest = earliestFor(i);
    if (at != null && at < earliest - 30) {
      const blocker = i === 0 ? (status.playing?.title ?? 'what is on air') : q[i - 1].title;
      error = at < Date.now() / 1000
        ? `That time has already passed. The earliest this can air is ${clock(earliest)}`
          + `, when ${blocker} finishes — use the arrow to move it to another day.`
        : `Cannot air before ${clock(earliest)} — ${blocker} is still running then.`;
      setTimeout(() => {
        if (error.startsWith('Cannot air before') || error.startsWith('That time has already')) error = '';
      }, 7000);
      return;
    }

    const from = q[i]?.startAt ?? q[i]?.at ?? null;
    const delta = at != null && from != null ? at - from : 0;
    const now = Date.now() / 1000;
    let carried = 0;
    pinId = null;
    // An item that aired while this was open is simply gone from the list,
    // so the edit becomes a no-op instead of hitting the wrong episode.
    await editQueue((es) => es.map((e, j) => {
      if (e.id === id) return { ...e, startAt: at };
      if (!delta || j <= i || e.startAt == null) return e;
      const moved = e.startAt + delta;
      if (moved <= now) return e;       // dragging it into the past helps nobody
      carried++;
      return { ...e, startAt: moved };
    }));
    if (carried) {
      note = `Moved ${carried} later programmed time${carried > 1 ? 's' : ''} by the same amount.`;
      setTimeout(() => { if (note.startsWith('Moved ')) note = ''; }, 6000);
    }
  }

  const savePin = (id) => repin(id, pinValue ? epochFor(pinValue, pinBase) : null);
  async function clearPin(id) {
    pinId = null;
    await editQueue((es) => es.map((e) => (e.id === id ? { ...e, startAt: null } : e)));
  }

  /** Gaps run from seconds to most of a day; h:mm:ss suits neither end. */
  function fmtGap(sec) {
    if (sec < 90) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /** Dead air before row i, in seconds — a pin pushing past the natural end. */
  function gapBefore(i) {
    const q = status.queue[i];
    if (!q?.at) return 0;
    const prev = i === 0 ? null : status.queue[i - 1];
    const prevEnd = i === 0
      ? (status.position != null && status.playing?.duration
        ? Date.now() / 1000 + (status.playing.duration - status.position) : null)
      : (prev?.at != null && prev.duration ? prev.at + prev.duration : null);
    if (prevEnd == null) return 0;
    return Math.max(0, Math.round(q.at - prevEnd));
  }

  /** A pre-show or interval card is on air, not an episode. */
  const card = $derived(Boolean(status.playing?.countdown));

  // ── programme blocks ─────────────────────────────────────────────────
  //
  // Consecutive episodes with nothing between them are one sitting; only a
  // break separates sittings. Grouping the list that way makes the breaks
  // the loudest thing on the page, which is the point of a schedule.

  const blocks = $derived.by(() => {
    const q = status.queue ?? [];
    const out = [];
    q.forEach((item, i) => {
      const gap = gapBefore(i);
      if (!out.length || gap > 30) out.push({ key: item.id, gap, rows: [] });
      out[out.length - 1].rows.push({ item, i });
    });
    for (const b of out) {
      b.first = b.rows[0].item;
      b.last = b.rows[b.rows.length - 1].item;
      b.count = b.rows.length;
      b.total = b.rows.every((r) => r.item.duration)
        ? b.rows.reduce((t, r) => t + r.item.duration, 0) : null;
      b.pinned = b.rows.some((r) => r.item.startAt != null);
      b.end = b.first.at != null && b.total != null ? b.first.at + b.total : null;
    }
    return out;
  });

  /** "Show — S4E16 – E30" when a block is one series, else first … last. */
  function blockLabel(b) {
    const cut = (t) => {
      const i = String(t).lastIndexOf(' — ');
      return i > 0 ? [t.slice(0, i), t.slice(i + 3)] : [null, t];
    };
    const [s1, e1] = cut(b.first.title);
    const [s2, e2] = cut(b.last.title);
    if (s1 && s1 === s2) return { series: s1, range: `${e1} – ${e2}` };
    return { series: null, range: `${b.first.title} … ${b.last.title}` };
  }

  let expanded = $state(new Set());
  function toggleBlock(key) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    expanded = next;
  }
  /** Editing a row inside a collapsed block must reveal it first. */
  function openBlockPin(b) {
    if (!expanded.has(b.key)) toggleBlock(b.key);
    openPin(b.first);
  }

  /** When the last queued item finishes — the end of the evening. */
  const endsAt = $derived.by(() => {
    const q = status.queue ?? [];
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].at != null && q[i].duration) return q[i].at + q[i].duration;
    }
    return null;
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
<h1>Schedule</h1>
{#if error}<p class="err">{error}</p>{/if}

{#if status.status === 'stopped'}
  <p class="muted">Nothing is streaming. Pick something from the library.</p>
{:else if status.status === 'break'}
  <div class="card">
    <p class="muted small" style="margin: 0 0 2px;">Off air</p>
    <p style="margin: 0;"><strong>Back at {clock(status.breakUntil)}</strong></p>
    <p class="muted small" style="margin: 2px 0 0;">
      {#if status.queue?.length}
        The broadcast reconnects by itself and opens with {status.queue[0].title}.
      {:else}
        The broadcast reconnects by itself.
      {/if}
    </p>
    <div class="row">
      <button onclick={skipCurrent} disabled={skipping}>
        {skipping ? 'Going live…' : 'Go live now'}
      </button>
      <div style="flex:1"></div>
      <button class="danger" onclick={stop}>Stop broadcast</button>
    </div>
  </div>

  <div class="uphead">
    <h2>Up next</h2>
  </div>
  <ul class="q">
    {#each status.queue as item (item.id)}
      <li class="ep">
        <span class="tcell" style="color:var(--muted)">{clock(item.at) ?? '—:—'}</span>
        <span class="qt">{item.title}</span>
        {#if item.duration}<span class="muted small dur">{fmtTime(item.duration)}</span>{/if}
      </li>
    {/each}
  </ul>
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
          {#if card}
            live in {fmtTime(Math.max(0, (status.playing.duration ?? 0) - (status.position ?? 0)))}
          {:else}
            {fmtTime(status.position ?? 0)}{#if status.playing?.duration} / {fmtTime(status.playing.duration)}{/if}
          {/if}
        </p>
        <!-- Burned into the picture, so it is worth seeing at a glance:
             viewers cannot switch this at their end. A pre-show or interval
             card has no tracks worth reporting. -->
        {#if !card}
        <div class="chips">
          <span class="chip" title="Audio track being broadcast">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                 stroke-width="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6"/></svg>
            {audioLabel(status.tracks?.audio)}
          </span>
          <span class="chip" class:off={!status.tracks?.subtitle}
                title="Subtitle track burned into the picture">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                 stroke-width="1.8" aria-hidden="true"><path d="M3 5h18v14H3zM7 15h4M14 15h3"/></svg>
            {subtitleLabel(status.tracks?.subtitle)}
          </span>
        </div>
        {/if}
      </div>
    </div>
    <div class="row">
      <button onclick={skipCurrent} disabled={skipping || (!card && !status.queue?.length)}
              title={card
                ? 'Start the show now instead of waiting'
                : status.queue?.length ? `Skip to ${status.queue[0].title}` : 'Nothing queued to skip to'}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"
             style="vertical-align:-2px; margin-right:6px;"><path d="M6 5v14l9-7zM16 5h3v14h-3z"/></svg>
        {skipping ? 'Skipping…' : card ? 'Start now' : 'Skip episode'}
      </button>
      {#if !card}
        <button onclick={loadTracks} disabled={switching}>Change audio or subtitles</button>
      {/if}
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

  <div class="uphead">
    <h2>Up next</h2>
    {#if endsAt}<span class="muted small">ends around {clock(endsAt)}</span>{/if}
    {#if status.queue?.length > 1}
      <span class="muted small" style="margin-left:auto">
        {status.queue.length} queued
      </span>
    {/if}
  </div>

  {#if !status.queue?.length}
    <p class="muted">
      Nothing queued — the broadcast ends when this finishes.
      Add more from the library at any time.
    </p>
  {:else}
    <ul class="q">
      {#snippet epRow(item, i)}
        <li class="ep">
          {#if pinId === item.id}
            {@const target = pinValue ? epochFor(pinValue, pinBase) : null}
            {@const floor = earliestFor(i)}
            <span class="tcell edit">
              <input class="tin" type="time" bind:value={pinValue}
                     class:bad={target != null && target < floor - 30}
                     onkeydown={(e) => { if (e.key === 'Enter') savePin(item.id); if (e.key === 'Escape') pinId = null; }}
                     aria-label="Air time"
                     title={`Not before ${clock(floor)} — what runs ahead of this is still going`} />
            </span>
            {#if target && !sameDay(target, Date.now() / 1000)}
              <span class="onday">{new Date(target * 1000)
                .toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            {/if}
          {:else}
            {@const late = item.startAt && item.at && item.at > item.startAt + 30}
            <button class="tcell t" class:pinned={item.startAt && !late} class:late disabled={editing}
                    onclick={() => openPin(item)}
                    title={late
                      ? `Programmed for ${clock(item.startAt)}, but what runs before it does not finish until then`
                      : item.startAt ? 'Programmed — click to change' : 'Click to program an air time'}>
              {#if item.startAt}
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
                     stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
              {/if}
              {clock(item.at) ?? '—:—'}
            </button>
          {/if}

          <span class="qt">{item.title}</span>
          {#if item.duration}<span class="muted small dur">{fmtTime(item.duration)}</span>{/if}

          <span class="qctl" class:open={pinId === item.id}>
            {#if pinId === item.id}
              <button class="ic ok" onclick={() => savePin(item.id)} title="Set time" aria-label="Set time">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 13l4 4L19 7"/></svg>
              </button>
              <button class="ic" onclick={() => nudgeDay(item.id, 1)}
                      title="Move a day later" aria-label="Move a day later">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              </button>
              {#if item.startAt}
                <button class="ic rm" onclick={() => clearPin(item.id)} title="Clear the programmed time" aria-label="Clear time">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
              {:else}
                <button class="ic" onclick={() => (pinId = null)} title="Cancel" aria-label="Cancel">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
              {/if}
            {:else}
              <button class="ic" disabled={editing || i === 0} onclick={() => move(i, -1)}
                      title="Move up" aria-label="Move up">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
              </button>
              <button class="ic" disabled={editing || i === status.queue.length - 1} onclick={() => move(i, 1)}
                      title="Move down" aria-label="Move down">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
              </button>
              <button class="ic rm" disabled={editing} onclick={() => removeAt(i)}
                      title="Remove from schedule" aria-label="Remove from schedule">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
              </button>
            {/if}
          </span>
        </li>
      {/snippet}

      {#each blocks as b (b.key)}
        {#if b.gap > 30}
          <!-- A break is the only thing that separates two blocks, so it
               gets the full width: amber for a programmed interval, red
               for dead air long enough to lose the audience. -->
          {@const offline = b.first.breakOffline && b.first.startAt != null}
          <li class="brk" class:bad={!offline && b.gap > 1200} class:off={offline}>
            <span class="ln"></span>
            {#if offline}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="1.7" aria-hidden="true"><path d="M18.4 5.6A9 9 0 1 1 5.6 5.6M12 2v8"/></svg>
              off air · {fmtGap(b.gap)} · back {clock(b.first.at)}
            {:else}
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>
              {b.gap > 1200 ? 'dead air' : 'break'} · {fmtGap(b.gap)} of card
            {/if}
            {#if b.first.startAt != null}
              <button class="brkmode" disabled={editing}
                      onclick={() => setBreakMode(b.first.id, !offline)}
                      title={offline
                        ? 'Keep the stream up and show a countdown card instead'
                        : 'Take the stream offline for this break — Owncast shows its offline page, and the broadcast comes back on its own'}>
                {offline ? 'air a card instead' : 'go off air instead'}
              </button>
            {/if}
            <span class="ln"></span>
          </li>
        {/if}

        {#if b.count === 1}
          {@render epRow(b.first, b.rows[0].i)}
        {:else}
          <li class="blkrow" class:pinned={b.first.startAt != null}>
            <button class="bh" onclick={() => toggleBlock(b.key)}
                    aria-expanded={expanded.has(b.key)}
                    title={expanded.has(b.key) ? 'Collapse' : 'Show the episodes'}>
              <svg class="chev" class:open={expanded.has(b.key)} viewBox="0 0 24 24" width="14" height="14"
                   fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
              <span class="tcell bt" class:pin={b.first.startAt != null}>
                {#if b.first.startAt != null}
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
                       stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
                {/if}
                {clock(b.first.at) ?? '—:—'}
              </span>
              {#if blockLabel(b).series}
                <span class="bl"><strong>{blockLabel(b).series}</strong> — {blockLabel(b).range}</span>
              {:else}
                <span class="bl">{blockLabel(b).range}</span>
              {/if}
              <span class="bm">
                {b.count} episodes{#if b.total} · {fmtGap(b.total)}{/if}{#if b.end} · to {clock(b.end)}{/if}
              </span>
            </button>
          </li>
          {#if expanded.has(b.key)}
            {#each b.rows as r (r.item.id)}
              {@render epRow(r.item, r.i)}
            {/each}
          {/if}
        {/if}
      {/each}
    </ul>
    <p class="muted small hint">
      Times are projected from each item's length. Click one to program it —
      the broadcast then waits behind an interval card rather than starting early.
    </p>
  {/if}
{/if}
</div>

<style>
  .wrap { max-width: 680px; margin: 0 auto; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .onair-row { display: flex; gap: 14px; align-items: center; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 9px 2px 7px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border);
    font-size: 12px; color: var(--text); max-width: 260px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .chip svg { color: var(--muted); flex-shrink: 0; }
  .chip.off { color: var(--muted); }
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
  .uphead {
    display: flex; align-items: baseline; gap: 10px;
    margin: 22px 0 6px;
  }
  .uphead h2 { margin: 0; }
  .q { list-style: none; padding: 0; margin: 0; }
  .q li {
    display: flex; align-items: center; gap: 12px;
    padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 14px;
    border-radius: var(--radius);
    transition: background .12s ease;
  }
  .q li:hover { background: var(--surface-2); }
  .qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dur { font-variant-numeric: tabular-nums; }

  /* The time column is the point of this view, so it leads every row and
     keeps one width whether it is projected, programmed or being edited. */
  .tcell {
    display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px;
    /* Wide enough for a weekday-qualified time ("Wed 14:26") plus the pin
       marker, so a schedule crossing midnight never wraps. */
    width: 106px; flex-shrink: 0; white-space: nowrap;
    font-variant-numeric: tabular-nums; font-size: 13px;
  }
  .onday {
    font-size: 11px; color: var(--accent);
    white-space: nowrap; flex-shrink: 0;
  }
  .t {
    padding: 3px 6px; border: 1px solid transparent; border-radius: 6px;
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .t:hover:not(:disabled) { border-color: var(--border); color: var(--text); }
  .t.pinned { color: var(--accent); font-weight: 500; }
  /* Programmed, but the material ahead of it overruns that time. */
  .t.late { color: var(--muted); text-decoration: underline dotted; }
  .tin {
    width: 74px; padding: 2px 4px; font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .tin.bad { border-color: var(--danger); color: var(--danger); }

  /* Break divider: the one thing allowed to interrupt the rundown. */
  .q li.brk {
    display: flex; align-items: center; gap: 8px;
    border: none; padding: 8px 4px; font-size: 12px;
    color: #c98a2e;
  }
  .q li.brk .ln { flex: 1; border-top: 1px dashed color-mix(in srgb, currentColor 45%, transparent); }
  .q li.brk:hover { background: transparent; }
  .q li.brk.bad { color: var(--danger); }
  .q li.brk.off { color: var(--muted); }
  .brkmode {
    padding: 1px 8px; font-size: 11.5px; border-radius: 999px;
    background: transparent; border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
    color: inherit; cursor: pointer; flex-shrink: 0;
  }
  .brkmode:hover:not(:disabled) { border-color: currentColor; }

  /* A sitting: episodes with nothing between them, one card. */
  .q li.blkrow {
    display: block; padding: 0; border: 1px solid var(--border);
    border-left: 3px solid var(--success);
    background: var(--surface); margin: 2px 0;
  }
  .q li.blkrow.pinned { border-left-color: var(--accent); }
  .q li.blkrow:hover { background: var(--surface-2); }
  .bh {
    display: flex; align-items: center; gap: 10px; width: 100%;
    padding: 8px 12px 8px 8px; background: transparent; border: none;
    font-size: 14px; color: var(--text); text-align: left; cursor: pointer;
  }
  .chev { color: var(--muted); flex-shrink: 0; transition: transform .15s ease; }
  .chev.open { transform: rotate(90deg); }
  .bt { color: var(--muted); }
  .bt.pin { color: var(--accent); font-weight: 500; }
  .bl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bl strong { font-weight: 500; }
  .bm { color: var(--muted); font-size: 12px; white-space: nowrap; flex-shrink: 0; }

  /* Episodes inside an expanded block sit slightly inset. */
  .q li.ep { border-left: 3px solid transparent; }

  .qctl { display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; }
  .q li:hover .qctl, .q li:focus-within .qctl, .qctl.open { opacity: 1; }
  .qctl .ok:hover:not(:disabled) { color: var(--success); }
  .hint { margin-top: 10px; }
  .qctl .ic {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0; border-radius: 6px;
    background: transparent; border-color: transparent; color: var(--muted);
  }
  .qctl .ic:hover:not(:disabled) { background: var(--surface); color: var(--text); }
  .qctl .rm:hover:not(:disabled) { color: var(--danger); }
</style>
