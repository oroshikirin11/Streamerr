<script>
  import { onMount, onDestroy } from 'svelte';
  import { api, connectStatus, fmtTime, clockTime, clockDay, maskClock, parseClock, audioLabel, subtitleLabel, subtitleChoice } from '$lib/api.js';
  import Inspector from '$lib/Inspector.svelte';

  /**
   * The Schedule page, timeline first.
   *
   * Two feeds drive it: the stream status (what is on air, tracks, the
   * engine's projections) and the schedule view (saved schedules, tonight
   * as segments, history, settings). Tonight is the plan; the engine's
   * queue is derived from it on the server, so this page never edits the
   * queue directly — every change goes to the schedule API and the view
   * that comes back is adopted wholesale.
   */
  let status = $state({ status: 'stopped', playing: null, queue: [] });
  let view = $state({ schedules: [], tonight: { segments: [], entries: [] }, history: [], settings: { dnd: true, breakEvery: 0, breakMinutes: 5, breakOffline: false }, live: false });
  let error = $state('');
  let note = $state('');
  let busy = $state(false);
  let now = $state(Date.now() / 1000);
  let stopFeed; let tick;

  async function refresh() {
    try {
      const [s, v] = await Promise.all([api.streamStatus(), api.schedule()]);
      status = s; view = v;
    } catch (err) { error = err.message; }
  }
  onMount(() => {
    refresh();
    stopFeed = connectStatus((msg) => {
      if (msg.type === 'stream') status = msg.payload;
      if (msg.type === 'schedule') view = msg.payload;
    });
    tick = setInterval(() => { now = Date.now() / 1000; }, 1000);
  });
  onDestroy(() => { stopFeed?.(); clearInterval(tick); });

  /** Run a schedule mutation; the API answers with the fresh view. */
  async function act(fn, okNote = '') {
    busy = true; error = '';
    try {
      const v = await fn();
      if (v?.tonight) view = v;
      if (okNote) flash(okNote);
    } catch (err) { error = err.message; }
    finally { busy = false; }
  }
  function flash(text) {
    note = text;
    setTimeout(() => { if (note === text) note = ''; }, 5000);
  }
  const confirmOnce = $state({ key: null });
  /** Two-step destructive buttons: first click arms, second fires. */
  function armed(key, fn) {
    if (confirmOnce.key === key) { confirmOnce.key = null; fn(); return; }
    confirmOnce.key = key;
    setTimeout(() => { if (confirmOnce.key === key) confirmOnce.key = null; }, 4000);
  }

  // ── derived ───────────────────────────────────────────────────────────
  const live = $derived(status.status !== 'stopped');
  const card = $derived(Boolean(status.playing?.countdown));
  const dnd = $derived(view.settings?.dnd !== false);
  const segments = $derived(view.tonight?.segments ?? []);
  const upcomingCount = $derived(view.tonight?.entries?.length ?? 0);
  const playingSeg = $derived(segments.find((s) => s.items.some((i) => i.onAir)) ?? null);
  const clock = clockDay;
  const hhmm = clockTime;
  const fmtGap = (sec) => {
    if (sec < 90) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  };
  const epName = (t) => { const i = String(t ?? '').lastIndexOf(' — '); return i > 0 ? t.slice(i + 3) : t; };
  const seriesName = (t) => { const i = String(t ?? '').lastIndexOf(' — '); return i > 0 ? t.slice(0, i) : null; };

  /** The next planned start across saved schedules. */
  const nextStart = $derived.by(() => {
    let best = null;
    for (const s of view.schedules ?? []) {
      if (s.nextRun && (!best || s.nextRun < best.at)) best = { at: s.nextRun, schedule: s };
    }
    return best;
  });

  /**
   * Every tonight item with a time. Live: the engine's projection for
   * upcoming items, the on-air item anchored at now minus its position,
   * and what already aired laid back from there by duration. Offline: a
   * projection from the first pin, the next auto-start, or now.
   */
  const placed = $derived.by(() => {
    const out = [];
    const upcoming = [];
    const before = [];
    for (const seg of segments) {
      for (const it of seg.items) {
        const dur = it.duration ?? 0;
        const row = { ...it, segKey: seg.key, segName: seg.name, scheduleId: seg.scheduleId, dur };
        if (it.state === 'upcoming') upcoming.push(row);
        else before.push(row);
      }
    }
    // What the engine plays that tonight does not know — a clip started
    // before this page existed, or tonight cleared while it played — is
    // still drawn, from the engine's own status, so the strip never
    // shows an empty night under a broadcast.
    if (live && !card && status.playing && !before.some((b) => b.onAir)) {
      const p = status.playing;
      before.push({ key: `engine:${p.seg?.item ?? p.id ?? 'onair'}`, title: p.title, image: p.image ?? null,
        state: 'onair', onAir: true, dur: p.duration ?? 0, segKey: null, engineOnly: true });
    }
    if (live) {
      for (const q of status.queue ?? []) {
        if (q.seg?.item && segments.some((sg) => sg.items.some((i) => i.key === q.seg.item))) continue;
        upcoming.push({ key: `engine:${q.seg?.item ?? q.id}:${q.at ?? ''}`, title: q.title, image: q.image ?? null,
          state: 'upcoming', dur: q.duration ?? 0, at: q.at ?? null, startAt: q.startAt ?? null,
          breakBefore: q.breakBefore ?? null, segKey: null, engineOnly: true });
      }
    }
    // Forward projection for upcoming items.
    let t;
    if (live && status.playing && !card) {
      t = now + Math.max(0, (status.playing.duration ?? 0) - (status.position ?? 0));
    } else if (live && card) {
      t = status.breakUntil ?? now;
    } else {
      const firstPin = upcoming.find((u) => u.startAt)?.startAt ?? segments.find((s) => s.startAt)?.startAt ?? null;
      const firstSeg = segments.find((s) => s.items.some((i) => i.state === 'upcoming'));
      const auto = firstSeg?.scheduleId ? view.schedules.find((s) => s.id === firstSeg.scheduleId)?.nextRun : null;
      // Rounded up to the next five minutes, so the strip does not creep
      // under the pointer with every tick of the clock.
      t = firstPin ?? auto ?? Math.ceil(now / 300) * 300;
    }
    // A length nobody has measured yet makes every later time a guess:
    // shown as "—:—" in the list and as a dashed nominal block on the strip.
    let known = true;
    let first = true;
    for (const u of upcoming) {
      if (u.at != null) { t = u.at; known = true; }
      else {
        if (u.breakBefore) t += u.breakBefore;
        if (u.startAt != null && (u.startAt > t || !known)) { t = u.startAt; known = true; }
        if (first && view.tonight.entries?.[0]?.startAt && view.tonight.entries[0].startAt > t) { t = view.tonight.entries[0].startAt; known = true; }
      }
      const nominal = u.dur || 1200;
      out.push({ ...u, at: t, end: t + nominal, dur: nominal, ghost: !u.dur, sure: known });
      if (!u.dur) known = false;
      t += nominal; first = false;
    }
    // Backwards for what already played / is on air / lies before the marker.
    let back = live && status.playing && !card ? now - (status.position ?? 0) : (out[0]?.at ?? now);
    const onAir = before.find((b) => b.onAir);
    const rest = before.filter((b) => !b.onAir);
    if (onAir) {
      const dur = status.playing?.duration ?? onAir.dur;
      out.unshift({ ...onAir, at: back, end: back + dur, dur });
    }
    for (let i = rest.length - 1; i >= 0 && i >= rest.length - 4; i--) {
      const b = rest[i];
      back -= b.dur || 1200;
      out.unshift({ ...b, at: back, end: back + (b.dur || 1200), ghost: !b.dur });
    }
    return out;
  });

  /** The strip's window: everything placed, plus margins, at least two hours. */
  const win = $derived.by(() => {
    if (!placed.length) { const a = now - 600; return { a, b: a + 7200 }; }
    let a = Math.min(...placed.map((p) => p.at), live ? now : Infinity) - 600;
    let b = Math.max(...placed.map((p) => p.end), nextStart?.at ?? 0) + 600;
    if (b - a < 7200) b = a + 7200;
    return { a, b };
  });
  const pct = (t) => `${((t - win.a) / (win.b - win.a)) * 100}%`;
  /**
   * The strip has a scale, in pixels per minute, and scrolls sideways when
   * the night is longer than the screen — a whole weekend must not be
   * squeezed into one row of slivers. Zoom is remembered per browser.
   */
  let tlEl = $state(null);
  let tlW = $state(0);
  let pxPerMin = $state((() => { try { return Number(localStorage.getItem('jsr-strip-zoom')) || 4; } catch { return 4; } })());
  const laneW = $derived(Math.max(tlW - 28, ((win.b - win.a) / 60) * pxPerMin));
  function zoom(dir) {
    const steps = [1, 1.5, 2, 3, 4, 6, 8, 12];
    const i = steps.findIndex((v) => v >= pxPerMin);
    const j = Math.min(steps.length - 1, Math.max(0, (i < 0 ? steps.length - 1 : i) + dir));
    pxPerMin = steps[j];
    try { localStorage.setItem('jsr-strip-zoom', String(pxPerMin)); } catch { /* private mode */ }
    scrolledFor = null;
  }
  const ticks = $derived.by(() => {
    // Labels need about 70px each; pick the finest step that gives it.
    const pxPerSec = laneW / (win.b - win.a);
    const step = [900, 1800, 3600, 7200, 14400, 43200].find((st) => st * pxPerSec >= 70) ?? 86400;
    const out = [];
    for (let t = Math.ceil(win.a / step) * step; t <= win.b; t += step) out.push(t);
    return out;
  });
  // Bring the moment that matters into view once per situation: now while
  // live, the start marker otherwise. Never while the operator is dragging.
  let scrolledFor = $state(null);
  $effect(() => {
    const anchor = live ? now : (startFlag?.at ?? placed[0]?.at ?? null);
    const key = `${live}:${segments.map((s) => s.key).join(',')}:${laneW}`;
    if (!tlEl || anchor == null || scrolledFor === key || drag) return;
    scrolledFor = key;
    const x = ((anchor - win.a) / (win.b - win.a)) * laneW;
    tlEl.scrollTo({ left: Math.max(0, x - tlEl.clientWidth * 0.25), behavior: 'smooth' });
  });
  const endsAt = $derived.by(() => {
    const last = placed[placed.length - 1];
    return last && last.sure !== false && !last.ghost ? last.end : null;
  });
  const startFlag = $derived.by(() => {
    const seg = segments.find((s) => s.items.some((i) => i.state === 'upcoming'));
    if (!seg) return null;
    const first = placed.find((p) => p.segKey === seg.key && p.state === 'upcoming');
    return first ? { at: first.at, seg } : null;
  });

  // ── strip drag: a block to a time, the start flag to an item ──────────
  let stripEl = $state(null);
  let drag = $state(null);   // { kind: 'block'|'flag', key, seg, x0, dx, at }
  function stripTime(clientX) {
    const r = stripEl.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return win.a + frac * (win.b - win.a);
  }
  function startBlockDrag(e, p) {
    if (!dnd || p.state !== 'upcoming' || p.engineOnly || busy || e.button !== 0) return;
    e.preventDefault();
    // Keep the grab point: the block moves with the hand, it does not jump
    // so its edge sits under the cursor.
    const grab = stripTime(e.clientX) - p.at;
    drag = { kind: 'block', key: p.key, x0: e.clientX, dx: 0, at: p.at, from: p.at, grab, earliest: floorFor(p.key) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function startFlagDrag(e) {
    if (!dnd || !startFlag || busy) return;
    e.preventDefault();
    drag = { kind: 'flag', seg: startFlag.seg, x0: e.clientX, dx: 0, at: startFlag.at };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onDragMove(e) {
    if (!drag) return;
    const at = stripTime(e.clientX) - (drag.grab ?? 0);
    drag = { ...drag, dx: e.clientX - drag.x0, at: drag.kind === 'block' ? Math.round(at / 300) * 300 : at };
  }
  function onDragCancel() { drag = null; }
  async function onDragEnd() {
    if (!drag) return;
    const d = drag; drag = null;
    if (Math.abs(d.dx) < 4) return;
    if (d.kind === 'block') {
      // Snapped to five minutes. Nothing plays before the one ahead of it
      // ends, so a drag to the left of that lands there — and if it had a
      // pin, the pin goes: "as early as possible" is the absence of one.
      const at = d.at;
      const it = segments.flatMap((sg) => sg.items).find((x) => x.key === d.key);
      if (at <= d.earliest + 60) {
        if (it?.startAt) await act(() => api.tonightSetItem(d.key, { startAt: null }), 'Pin cleared — it plays as soon as the one before ends.');
        else flash(`It cannot start before ${clock(d.earliest)}, when the one ahead of it ends.`);
        return;
      }
      await act(() => api.tonightSetItem(d.key, { startAt: at }), `Programmed for ${clock(at)}.`);
    } else {
      // The flag lands on the item whose block it was dropped in.
      const seg = d.seg;
      const rows = placed.filter((p) => p.segKey === seg.key && (p.state === 'upcoming' || p.state === 'past'));
      let idx = rows.findIndex((r) => d.at < r.end);
      if (idx < 0) idx = rows.length;
      const target = rows[idx];
      const index = target ? seg.items.findIndex((i) => i.key === target.key) : seg.items.length;
      await act(() => api.tonightSegStart(seg.key, index), 'Start moved.');
    }
  }

  // ── list drag (rows within a segment, segments among themselves) ─────
  let rowDrag = $state(null);   // { seg, key }
  let rowOver = $state(null);
  let segDrag = $state(null);
  let segOver = $state(null);
  // A saved schedule dragged from the rail: dropped on the lineup it is
  // appended; dropped on a segment it goes in before that one.
  let cardDrag = $state(null);
  let zoneOver = $state(false);
  function cardDragStart(e, sid) {
    if (!dnd) { e.preventDefault(); return; }
    cardDrag = sid; e.dataTransfer.effectAllowed = 'copy';
    try { e.dataTransfer.setData('text/plain', `schedule:${sid}`); } catch { /* firefox */ }
  }
  async function cardDrop(e, beforeSeg = null) {
    e.preventDefault(); e.stopPropagation();
    const sid = cardDrag; cardDrag = null; zoneOver = false; segOver = null;
    if (!sid) return;
    const sch = view.schedules.find((x) => x.id === sid);
    const restart = Boolean(sch?.finished && atEndOf(sch) === 'stop');
    await act(async () => {
      const v = await api.appendSchedule(sid, null, restart);
      if (!beforeSeg) return v;
      const segs = v.tonight.segments;
      const added = segs[segs.length - 1];
      const keys = segs.map((g) => g.key).filter((k) => k !== added.key);
      const at = keys.indexOf(beforeSeg);
      keys.splice(at < 0 ? keys.length : at, 0, added.key);
      return api.tonightOrder(keys.map((k) => ({ seg: k, items: segs.find((g) => g.key === k).items.map((i) => i.key) })));
    }, `${restart ? 'Started over' : 'Appended'} "${sch?.name ?? 'schedule'}".`);
  }
  function rowDragStart(e, seg, it) {
    if (!dnd || it.state !== 'upcoming') { e.preventDefault(); return; }
    rowDrag = { seg: seg.key, key: it.key };
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', it.key); } catch { /* firefox needs data */ }
  }
  function rowDragOver(e, seg, it) {
    if (!rowDrag || rowDrag.seg !== seg.key || it.state !== 'upcoming') return;
    e.preventDefault(); rowOver = it.key;
  }
  /** Drop on a row: before it. Drop on the segment itself: at the end. */
  async function rowDrop(e, seg, it = null) {
    e.preventDefault();
    e.stopPropagation();
    if (!rowDrag || rowDrag.seg !== seg.key) { rowDrag = null; rowOver = null; return; }
    const keys = seg.items.filter((i) => i.state === 'upcoming').map((i) => i.key);
    const from = keys.indexOf(rowDrag.key);
    const to = it ? keys.indexOf(it.key) : keys.length - 1;
    rowDrag = null; rowOver = null;
    if (from < 0 || to < 0 || from === to) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    await act(() => api.tonightOrder([{ seg: seg.key, items: keys }]));
  }
  function segDragStart(e, seg) {
    if (!dnd) { e.preventDefault(); return; }
    segDrag = seg.key; e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', seg.key); } catch { /* firefox */ }
  }
  async function segDrop(e, seg) {
    e.preventDefault();
    if (!segDrag || segDrag === seg.key) { segDrag = null; segOver = null; return; }
    const keys = segments.map((s) => s.key);
    const from = keys.indexOf(segDrag); const to = keys.indexOf(seg.key);
    segDrag = null; segOver = null;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    await act(() => api.tonightOrder(keys.map((k) => ({ seg: k, items: segments.find((s) => s.key === k).items.map((i) => i.key) }))));
  }

  // ── pins ─────────────────────────────────────────────────────────────
  let pinKey = $state(null);      // item key, or `seg:<key>`
  let pinValue = $state('');
  let pinBase = $state(null);
  let pinFloor = $state(null);
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  function openPin(key, current, floor) {
    pinKey = key;
    pinBase = current ?? floor ?? Math.floor(now);
    pinFloor = floor ?? Math.floor(now);
    pinValue = hhmm(pinBase);
  }
  function stepTime(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const t = parseClock(pinValue) ?? parseClock(hhmm(pinBase));
    if (!t) return;
    e.preventDefault();
    const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 60 : 5);
    const mins = (((t.h * 60 + t.m + step) % 1440) + 1440) % 1440;
    pinValue = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  function timeSuggestions(floor) {
    const out = [];
    const start = new Date((floor ?? now) * 1000);
    start.setSeconds(0, 0);
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
    for (let i = 0; i < 5; i++) out.push(new Date(start.getTime() + i * 15 * 60_000));
    const hour = new Date(start); hour.setMinutes(0, 0, 0);
    for (let i = 1; i <= 6; i++) out.push(new Date(hour.getTime() + i * 3_600_000));
    return [...new Set(out.map((d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`))];
  }
  function epochFor(hm, base, floor) {
    const t = parseClock(hm);
    if (!t) return null;
    const anchor = floor ?? base ?? Math.floor(now);
    const d = new Date(anchor * 1000);
    d.setHours(t.h, t.m, 0, 0);
    let at = Math.floor(d.getTime() / 1000);
    while (at + 60 <= anchor) at += 86_400;
    return at;
  }
  const pinTarget = $derived(pinValue ? epochFor(pinValue, pinBase, pinFloor) : null);
  async function savePin() {
    const key = pinKey;
    if (pinValue && pinTarget == null) { error = `"${pinValue}" is not a time. Use 24-hour HH:MM, like 20:30.`; return; }
    const at = pinValue ? pinTarget : null;
    pinKey = null;
    if (key.startsWith('seg:')) await act(() => api.tonightSetSeg(key.slice(4), { startAt: at }));
    else await act(() => api.tonightSetItem(key, { startAt: at }));
  }
  async function clearPin(key) {
    pinKey = null;
    if (key.startsWith('seg:')) await act(() => api.tonightSetSeg(key.slice(4), { startAt: null }));
    else await act(() => api.tonightSetItem(key, { startAt: null }));
  }
  function nudgeDay() { pinBase = (pinTarget ?? pinBase) + 86400; pinFloor = pinBase - 60; pinValue = hhmm(pinBase); }
  /** The earliest an item could air: the end of what comes before it. */
  function floorFor(key) {
    const i = placed.findIndex((p) => p.key === key);
    if (i <= 0) return Math.floor(now);
    return Math.floor(placed[i - 1].end);
  }

  // ── segments: show past, breaks, remove ───────────────────────────────
  let showPast = $state({});
  // Folded segments show only their header. Playing segments start open.
  let folded = $state({});
  const pastOf = (seg) => seg.items.filter((i) => i.state === 'past' || i.state === 'aired' || i.state === 'skipped');
  const PAST_SHOWN = 2;
  const visibleRows = (seg) => {
    const past = pastOf(seg);
    const hide = showPast[seg.key] ? 0 : Math.max(0, past.length - PAST_SHOWN);
    let skipped = 0;
    return seg.items.filter((i) => {
      const isPast = i.state === 'past' || i.state === 'aired' || i.state === 'skipped';
      if (isPast && skipped < hide) { skipped++; return false; }
      return true;
    });
  };
  const segCounts = (seg) => {
    const watched = seg.items.filter((i) => i.watched || i.state === 'aired').length;
    const up = seg.items.filter((i) => i.state === 'upcoming').length;
    return { watched, up, total: seg.items.length };
  };
  const segRange = (seg) => {
    const ups = seg.items.filter((i) => i.state === 'upcoming' || i.state === 'onair');
    if (!ups.length) return 'nothing left to play';
    const a = epName(ups[0].title), b = epName(ups[ups.length - 1].title);
    return ups.length === 1 ? a : `${a} → ${b}`;
  };
  const isBreak = (it) => it.breakBefore > 0 || view.tonight.entries?.find((e) => e.seg.item === it.key)?.breakBefore > 0;
  const breakOf = (it) => it.breakBefore ?? view.tonight.entries?.find((e) => e.seg.item === it.key)?.breakBefore ?? 0;
  const autoBreak = (it) => !it.breakBefore && breakOf(it) > 0;

  // ── saved schedules: rail, edit panel, picker ────────────────────────
  let tab = $state('saved');
  let editId = $state(null);
  let edit = $state(null);
  let newName = $state('');
  let naming = $state(false);        // "Save lineup as…" inline input
  let saveName = $state('');
  let appendOpen = $state(false);
  const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const progress = (s) => (s.items.length ? Math.round((s.watched.length / s.items.length) * 100) : 0);
  const atEndOf = (s) => s.atEnd ?? 'stop';
  const startLabel = (s) => (s.finished ? (atEndOf(s) === 'loop' ? 'finished · loops' : atEndOf(s) === 'restart' ? 'finished · starts over' : 'finished') : `at ${epName(s.items[s.start]?.title ?? '')}`);
  const recur = (s) => {
    const a = s.autoStart;
    if (!a?.enabled) return 'no auto-start';
    if (a.date) return `once · ${a.date} ${a.time}`;
    return `${a.days.map((d) => DAYS[d]).join(' ')} ${a.time} · weekly`;
  };
  // Dates are typed as day.month.year — what the operator's own calendar
  // says — and stored as ISO. The browser's date picker formats by its own
  // locale, which put the month first.
  const isoToDmy = (iso) => (iso ? iso.split('-').reverse().join('.') : '');
  const dmyToIso = (v) => {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[1]) return null;
    return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  };
  let editError = $state('');
  /** When the edited schedule would fire next, from what is typed. */
  const editNext = $derived.by(() => {
    if (!edit?.auto) return null;
    const t = parseClock(edit.time);
    if (!t) return null;
    const nowD = new Date();
    if (edit.date) {
      const iso = dmyToIso(edit.date);
      if (!iso) return null;
      const [y, m, d] = iso.split('-').map(Number);
      const at = new Date(y, m - 1, d, t.h, t.m).getTime();
      return at > Date.now() ? at / 1000 : null;
    }
    if (!edit.days.length) return null;
    for (let off = 0; off < 8; off++) {
      const at = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + off, t.h, t.m);
      if (edit.days.includes(at.getDay()) && at.getTime() > Date.now()) return at.getTime() / 1000;
    }
    return null;
  });
  function openEdit(s) {
    editId = s.id;
    editError = '';
    edit = {
      name: s.name, start: s.start,
      auto: Boolean(s.autoStart?.enabled), time: s.autoStart?.time ?? '20:00',
      days: [...(s.autoStart?.days ?? [])], date: isoToDmy(s.autoStart?.date),
      countdownMin: s.autoStart?.countdownMin ?? 15,
      breaks: s.breaks === 'none' ? 'none' : s.breaks === 'global' ? 'global' : 'custom',
      atEnd: ['restart', 'loop'].includes(s.atEnd) ? s.atEnd : 'stop',
      every: s.breaks?.every ?? 3, minutes: s.breaks?.minutes ?? 5,
      items: s.items.map((i) => i.id),
    };
    tab = 'saved';
  }
  async function saveEdit() {
    const id = editId; const e = edit;
    editError = '';
    const iso = e.date ? dmyToIso(e.date) : null;
    if (e.auto && e.date && !iso) { editError = 'The date should read day.month.year, like 05.09.2026.'; return; }
    const autoStart = e.auto && parseClock(e.time) ? {
      time: e.time, days: iso ? [] : e.days, date: iso, countdownMin: Number(e.countdownMin), enabled: true,
    } : null;
    if (e.auto && !autoStart) { editError = 'Auto-start needs a time like 20:00.'; return; }
    if (e.auto && !iso && !e.days.length) { editError = 'Pick the days it repeats on, or type a date.'; return; }
    const breaks = e.breaks === 'custom' ? { every: Number(e.every), minutes: Number(e.minutes) } : e.breaks;
    const s = view.schedules.find((x) => x.id === id);
    const itemsChanged = s && s.items.map((i) => i.id).join('|') !== e.items.join('|');
    await act(() => api.updateSchedule(id, { name: e.name, start: e.start, autoStart, breaks, atEnd: e.atEnd, ...(itemsChanged ? { itemIds: e.items } : {}) }), 'Saved.');
    if (error) { editError = error; return; }
    editId = null; edit = null;
  }
  const editItems = $derived(edit ? edit.items.map((id) => view.schedules.find((x) => x.id === editId)?.items.find((i) => i.id === id)).filter(Boolean) : []);
  function removeEditItem(i) {
    edit.items.splice(i, 1);
    if (edit.start > edit.items.length) edit.start = edit.items.length;
  }

  let picker = $state(null);   // { libraries, libraryId, q, results, series, episodes, selected, target }
  async function openPicker() {
    picker = { libraries: [], libraryId: null, q: '', results: [], series: null, episodes: [], selected: new Set(), target: 'tonight', loading: true };
    try {
      picker.libraries = await api.libraries();
      picker.libraryId = picker.libraries[0]?.id ?? null;
      await searchPicker();
    } catch (err) { error = err.message; }
  }
  let searchTimer;
  async function searchPicker() {
    if (!picker?.libraryId) return;
    picker.loading = true;
    try {
      const r = await api.items(picker.libraryId, { search: picker.q, limit: 60 });
      picker.results = r.items ?? r ?? [];
    } catch (err) { error = err.message; }
    finally { picker.loading = false; }
  }
  function pickerInput() { clearTimeout(searchTimer); searchTimer = setTimeout(searchPicker, 250); }
  async function openPickSeries(item) {
    picker.series = item; picker.episodes = []; picker.selected = new Set(); picker.loading = true;
    try { picker.episodes = await api.episodes(item.id); }
    catch (err) { error = err.message; }
    finally { picker.loading = false; }
  }
  /** Where a saved schedule holding this series picks up, else the start. */
  function continueIndex() {
    for (const s of view.schedules ?? []) {
      const next = s.items[s.start];
      if (!next || next.series !== picker.series?.title) continue;
      const i = picker.episodes.findIndex((e) => e.id === next.id);
      if (i >= 0) return i;
    }
    return 0;
  }
  function selectFrom(i) { picker.selected = new Set(picker.episodes.slice(i).map((e) => e.id)); }
  function togglePick(id) { const n = new Set(picker.selected); if (n.has(id)) n.delete(id); else n.add(id); picker.selected = n; }
  async function addPicked(ids) {
    const list = ids ?? [...picker.selected];
    if (!list.length) return;
    const target = picker.target;
    if (target === 'tonight') await act(() => api.tonightAdd(list), `Added ${list.length} to tonight.`);
    else if (target === 'new') {
      const name = picker.series?.title ?? 'New schedule';
      await act(() => api.createSchedule({ name, itemIds: list }), `Saved as "${name}".`);
    } else {
      const s = view.schedules.find((x) => x.id === target);
      if (s) await act(() => api.updateSchedule(s.id, { itemIds: [...s.items.map((i) => i.id), ...list] }), `Added ${list.length} to "${s.name}".`);
    }
    picker.selected = new Set();
  }

  // ── on-air controls (as before) ──────────────────────────────────────
  let tracks = $state(null);
  let switching = $state(false);
  let skipping = $state(false);
  async function loadTracks() {
    if (tracks) { tracks = null; return; }
    try { tracks = await api.liveTracks(); } catch (err) { error = err.message; }
  }
  async function applyTracks(audioIndex, subtitleKey, subtitleMode) {
    switching = true; error = '';
    try {
      const r = await api.setTracks({ audioIndex, subtitleKey, subtitleMode });
      flash(`Now: ${r.tracks}`);
      status = await api.streamStatus();
      await loadTracks();
    } catch (err) { error = err.message; }
    finally { switching = false; }
  }
  async function stop() { try { await api.stop(); } catch (err) { error = err.message; } }
  async function skipCurrent() {
    skipping = true; error = '';
    try { status = await api.next(); tracks = null; }
    catch (err) { error = err.message; }
    finally { skipping = false; }
  }
  /** The media inspector: { id, title } while open. */
  let inspect = $state(null);
  let goTime = $state('');
  let goAt = $state(false);
  async function goLive() {
    const at = goAt && goTime ? epochFor(goTime, null, Math.floor(now)) : null;
    if (goAt && goTime && at == null) { error = `"${goTime}" is not a time.`; return; }
    busy = true; error = '';
    try { await api.goLive(at); flash(at ? `Going live at ${clock(at)} — countdown card until then.` : 'Going live.'); }
    catch (err) { error = err.message; }
    finally { busy = false; }
  }
  const airTime = () => {
    const pos = fmtTime(status.position ?? 0);
    const dur = status.playing?.duration;
    return dur ? `${pos} / ${fmtTime(dur)}` : pos;
  };
</script>

<svelte:window onpointermove={onDragMove} onpointerup={onDragEnd} onpointercancel={onDragCancel} onblur={onDragCancel} />

<div class="ph">
  <h1>Schedule</h1>
  {#if playingSeg}<span class="chip ok">{playingSeg.name} · playing</span>{/if}
  <span class="sp"></span>
  <label class="switch" title="Drag blocks on the strip and rows in the lineup. Off, the arrow buttons do the same.">
    <input type="checkbox" checked={dnd} onchange={(e) => act(() => api.scheduleSettings({ dnd: e.currentTarget.checked }))} />
    Drag and drop
  </label>
  {#if naming}
    <input class="tin wide" placeholder="Name this lineup" bind:value={saveName}
           onkeydown={(e) => { if (e.key === 'Enter') { act(() => api.createSchedule({ fromTonight: true, name: saveName }), `Saved as "${saveName}".`); naming = false; } if (e.key === 'Escape') naming = false; }}
           {@attach (el) => el.focus()} />
    <button class="sm primary" disabled={!saveName.trim()} onclick={() => { act(() => api.createSchedule({ fromTonight: true, name: saveName }), `Saved as "${saveName}".`); naming = false; }}>Save</button>
    <button class="sm ghost" onclick={() => (naming = false)}>Cancel</button>
  {:else}
    <button class="sm" disabled={!segments.length} onclick={() => { naming = true; saveName = ''; }}>Save lineup as…</button>
  {/if}
</div>
{#if error}<p class="err">{error}</p>{/if}
{#if note}<p class="small note">{note}</p>{/if}

<!-- ── the strip ─────────────────────────────────────────────────────── -->
<div class="tl" class:dragging={Boolean(drag)} bind:this={tlEl} bind:clientWidth={tlW}>
  <div class="scale" style:width={`${laneW}px`}>
    {#each ticks as t (t)}<span style:left={pct(t)}>{hhmm(t)}</span>{/each}
  </div>
  <div class="lane" bind:this={stripEl} style:width={`${laneW}px`}>
    {#if live && card && placed.find((p) => p.state === 'upcoming')}
      {@const first = placed.find((p) => p.state === 'upcoming')}
      <div class="cd2" style:left={pct(now)} style:width={`${Math.max(0.5, ((first.at - now) / (win.b - win.a)) * 100)}%`}>{status.status === 'break' ? 'off air' : 'countdown'}</div>
    {:else if nextStart && !live && !placed.length}
      <div class="cd2" style:left={pct(nextStart.at - nextStart.schedule.autoStart.countdownMin * 60)} style:width={`${Math.max(0.5, (nextStart.schedule.autoStart.countdownMin * 60 / (win.b - win.a)) * 100)}%`}>countdown</div>
    {/if}
    {#each placed as p (p.key)}
      {#if breakOf(p) > 0 && p.state === 'upcoming'}
        <div class="brk2" style:left={pct(p.at - breakOf(p))} style:width={`${(breakOf(p) / (win.b - win.a)) * 100}%`} title={`${fmtGap(breakOf(p))} break`}>{fmtGap(breakOf(p))}</div>
      {/if}
      {#if p.startAt}<div class="flag" style:left={pct(p.startAt)} data-t={`pinned ${hhmm(p.startAt)}`}></div>{/if}
      <div class="blk" class:past={p.state === 'past' || p.state === 'aired' || p.state === 'skipped'} class:now={p.onAir}
           class:seg2={p.scheduleId && p.segKey !== segments[0]?.key} class:ghost={p.ghost} class:grab={dnd && p.state === 'upcoming'}
           class:lift={drag?.kind === 'block' && drag.key === p.key}
           style:left={pct(drag?.kind === 'block' && drag.key === p.key ? drag.at : p.at)}
           style:width={`${Math.max(0.6, ((p.dur || 1200) / (win.b - win.a)) * 100)}%`}
           title={`${p.title}${!p.ghost ? ` · ${fmtTime(p.dur)}` : ''} · ${hhmm(p.at)}`}
           role="button" tabindex="0"
           onpointerdown={(e) => startBlockDrag(e, p)}>
        {#if p.image}<img class="cv" src={p.image} alt="" draggable="false" onerror={(e) => e.currentTarget.remove()} />{/if}
        <span class="bt">{epName(p.title)}{#if p.onAir} · on air{/if}</span>
        {#if drag?.kind === 'block' && drag.key === p.key}
          <span class="dt" class:early={drag.at <= drag.earliest + 60}>{drag.at <= drag.earliest + 60 ? `earliest ${hhmm(drag.earliest)}` : hhmm(drag.at)}</span>
        {/if}
      </div>
    {/each}
    {#if live && status.playing && !card}<div class="nowline" style:left={pct(now)}></div>{/if}
    {#if startFlag}
      <div class="startflag" class:grab={dnd} style:left={pct(drag?.kind === 'flag' ? drag.at : startFlag.at)}
           title={dnd ? 'Drag to change where the schedule starts' : 'Where the schedule starts — move it with the arrows in the lineup'}
           role="button" tabindex="0"
           onpointerdown={startFlagDrag}></div>
    {/if}
    {#if !placed.length}
      <p class="empty">{live ? 'Nothing lined up after this.' : 'Nothing lined up. Load a saved schedule or add from the library.'}</p>
    {/if}
  </div>
  <div class="legend">
    <span><i class="l-now"></i>on air</span><span><i class="l-past"></i>watched</span><span><i class="l-brk"></i>break</span><span><i class="l-pin"></i>pin / start</span>
    <span class="zoom"><button class="ic" onclick={() => zoom(-1)} title="Zoom out" aria-label="Zoom out">−</button><button class="ic" onclick={() => zoom(1)} title="Zoom in" aria-label="Zoom in">+</button></span>
    {#if endsAt && placed.some((p) => p.state === 'upcoming')}<span class="sp"></span><span class="num">ends around {clock(endsAt)}</span>{/if}
  </div>
</div>

<div class="two">
  <div>
    <!-- ── on air ────────────────────────────────────────────────────── -->
    {#if status.status === 'break'}
      <div class="card">
        <p class="muted small" style="margin:0 0 2px">Off air</p>
        <p style="margin:0"><strong>Back at {clock(status.breakUntil)}</strong></p>
        <div class="row">
          <button onclick={skipCurrent} disabled={skipping}>{skipping ? 'Going live…' : 'Go live now'}</button>
          <span class="sp"></span>
          <button class="danger" onclick={stop}>Stop broadcast</button>
        </div>
      </div>
    {:else if live}
      <div class="card onair">
        {#if status.playing?.image}<img class="cover" src={status.playing.image} alt="" />{/if}
        <div class="np">
          <p class="muted small" style="margin:0">On air</p>
          <p style="margin:0"><strong>{status.playing?.title ?? '—'}</strong></p>
          <p class="muted small num" style="margin:0">
            {#if card}live in {fmtTime(Math.max(0, (status.playing.duration ?? 0) - (status.position ?? 0)))}{:else}{airTime()}{/if}
          </p>
          {#if !card}
            <div class="chips">
              <span class="chip" title="Audio track being broadcast">{audioLabel(status.tracks?.audio)}</span>
              <span class="chip" class:off={!status.tracks?.subtitle} title="Subtitle track burned into the picture">{subtitleLabel(status.tracks?.subtitle)}</span>
            </div>
          {/if}
          {#if status.queue?.length}
            <p class="muted small next" style="margin:6px 0 0">
              Next: {status.queue[0].title}{#if status.queue[0].at} · {clock(status.queue[0].at)}{/if}
            </p>
          {/if}
        </div>
        <div class="acts">
          <button onclick={skipCurrent} disabled={skipping || (!card && !status.queue?.length)}
                  title={card ? 'Start the show now instead of waiting' : status.queue?.length ? `Skip to ${status.queue[0].title}` : 'Nothing queued to skip to'}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 5v14l9-7zM16 5h3v14h-3z"/></svg>
            {skipping ? 'Skipping…' : card ? 'Start now' : 'Skip episode'}
          </button>
          {#if !card && status.playing?.id}
            <button onclick={() => (inspect = { id: status.playing.id, title: status.playing.title })} title="What this file is, and what the encoder is doing with it">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>
              Details
            </button>
          {/if}
          {#if !card}
            <button onclick={loadTracks} disabled={switching} class:on={Boolean(tracks)}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 5h18v14H3zM7 15h4M14 15h3"/></svg>
              {tracks ? 'Close tracks' : 'Audio & subtitles'}
            </button>
          {/if}
          <button class="danger" onclick={stop}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop broadcast
          </button>
        </div>
        {#if tracks}
          <div class="tracks">
            <p class="muted small">Switching restarts the encoder and resumes at the same point, so viewers see a few seconds of interruption.</p>
            <p class="muted small">Audio</p>
            {#each tracks.audio as a}
              <button class="line" class:on={a.typeIndex === tracks.chosen.audioIndex} disabled={switching}
                      onclick={() => applyTracks(a.typeIndex, tracks.chosen.subtitleKey, undefined)}>
                {a.language ?? '?'} · {a.codec} · {a.channels ?? '?'}ch{a.title ? ` — ${a.title}` : ''}
              </button>
            {/each}
            <p class="muted small">Subtitles</p>
            <button class="line" class:on={tracks.chosen.subtitleKey === null} disabled={switching}
                    onclick={() => applyTracks(tracks.chosen.audioIndex, null, 'off')}>None</button>
            {#each tracks.subtitles as s}
              <button class="line" class:on={String(s.key) === String(tracks.chosen.subtitleKey)} disabled={switching}
                      onclick={() => applyTracks(tracks.chosen.audioIndex, s.key, 'always')}>{subtitleChoice(s)}</button>
            {/each}
            {#if switching}<p class="muted small">Restarting the encoder…</p>{/if}
          </div>
        {/if}
      </div>
    {:else if nextStart}
      <div class="cdbanner">
        <div><div class="lbl">Next planned start</div><div class="big num">{clock(nextStart.at)}</div></div>
        <div class="small">{nextStart.schedule.name}
          {#if nextStart.schedule.autoStart.countdownMin} · countdown card from {hhmm(nextStart.at - nextStart.schedule.autoStart.countdownMin * 60)}{/if}
          · {recur(nextStart.schedule)}</div>
        <button class="sm" onclick={() => openEdit(nextStart.schedule)}>Edit</button>
      </div>
    {/if}

    <!-- ── lineup ───────────────────────────────────────────────────── -->
    <div class="uphead">
      <h2>Lineup</h2>
      {#if upcomingCount}<span class="muted small">{upcomingCount} to play{#if endsAt} · ends around {clock(endsAt)}{/if}</span>{/if}
      <span class="sp"></span>
      {#if segments.length}
        <button class="sm ghost" disabled={busy} onclick={() => armed('clear', () => act(() => api.tonightClear(), 'Tonight cleared.'))}
                title="Empty tonight's lineup — saved schedules are not touched">
          {confirmOnce.key === 'clear' ? 'Really clear?' : 'Clear'}
        </button>
      {/if}
      <button class="sm ghost" onclick={openPicker}>Add from library</button>
      <span class="menu">
        <button class="sm ghost" onclick={() => (appendOpen = !appendOpen)} disabled={!view.schedules.length}>Append schedule…</button>
        {#if appendOpen}
          <div class="pop">
            {#each view.schedules as s (s.id)}
              <button class="line" onclick={() => { appendOpen = false; act(() => api.appendSchedule(s.id), `Appended "${s.name}".`); }}>{s.name} <span class="muted">· {startLabel(s)}</span></button>
            {/each}
          </div>
        {/if}
      </span>
      {#if !live && upcomingCount}
        {#if goAt}
          <input class="tin" type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" bind:value={goTime}
                 oninput={(e) => { goTime = maskClock(e.currentTarget.value); }} aria-label="Go live at (24-hour)" />
        {/if}
        <button class="sm" class:on={goAt} onclick={() => (goAt = !goAt)} title="Go live at a time — a countdown card runs until then" aria-pressed={goAt}>⏱</button>
        <button class="sm primary" disabled={busy} onclick={goLive}>{goAt && goTime ? `Go live at ${goTime}` : 'Go live'}</button>
      {/if}
    </div>

    <div class="zone" class:drop={zoneOver && Boolean(cardDrag)} class:armed={Boolean(cardDrag)} role="region" aria-label="Lineup"
         ondragover={(e) => { if (cardDrag) { e.preventDefault(); zoneOver = true; } }}
         ondragleave={(e) => { if (e.target === e.currentTarget) zoneOver = false; }}
         ondrop={(e) => { if (cardDrag) cardDrop(e, null); }}>
    {#if !segments.length}
      <p class="muted zone-empty">{cardDrag ? 'Drop it here' : 'Nothing lined up. Load a saved schedule from the right, or add from the library.'}</p>
    {/if}

    {#each segments as seg (seg.key)}
      {@const c = segCounts(seg)}
      {@const past = pastOf(seg)}
      <div class="blkw" class:pinned={seg.startAt} class:over={segOver === seg.key} class:rowend={rowDrag?.seg === seg.key && rowOver === `end:${seg.key}`} role="group"
           ondragover={(e) => {
             if (segDrag || cardDrag) { e.preventDefault(); segOver = seg.key; }
             else if (rowDrag?.seg === seg.key) { e.preventDefault(); if (e.target === e.currentTarget || e.target.classList?.contains('q')) rowOver = `end:${seg.key}`; }
           }}
           ondrop={(e) => (cardDrag ? cardDrop(e, seg.key) : rowDrag ? rowDrop(e, seg, null) : segDrop(e, seg))}>
        <div class="bh" draggable={dnd} role="group" ondragstart={(e) => segDragStart(e, seg)} ondragend={() => { segDrag = null; segOver = null; }}>
          {#if dnd}<span class="handle" title="Drag to move this schedule"></span>{/if}
          <button class="fold" onclick={() => (folded[seg.key] = !folded[seg.key])} aria-expanded={!folded[seg.key]}
                  title={folded[seg.key] ? 'Show the episodes' : 'Collapse'}>
            <svg class="chev" class:closed={folded[seg.key]} viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>
            <strong>{seg.name}</strong>
          </button>
          <span class="bl"><span class="muted">{segRange(seg)}</span></span>
          <span class="bm">{c.up} to play{#if c.watched} · {c.watched} watched{/if}</span>
          {#if seg.items.some((i) => i.onAir)}<span class="chip ok">playing</span>{/if}
          {#if pinKey === `seg:${seg.key}`}
            <span class="tcell edit">
              <input class="tin" type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" bind:value={pinValue}
                     oninput={(e) => { pinValue = maskClock(e.currentTarget.value); }}
                     onkeydown={(e) => { if (e.key === 'Enter') savePin(); else if (e.key === 'Escape') pinKey = null; else stepTime(e); }}
                     {@attach (el) => { el.focus(); el.select(); }} aria-label="Air time (24-hour, HH:MM)" />
              <button class="ic ok" onclick={savePin} title="Set time">✓</button>
              <button class="ic" onclick={nudgeDay} title="A day later">→</button>
              {#if seg.startAt}<button class="ic rm" onclick={() => clearPin(`seg:${seg.key}`)} title="Clear the programmed time">×</button>{:else}<button class="ic" onclick={() => (pinKey = null)} title="Cancel">×</button>{/if}
            </span>
          {:else}
            <button class="t" class:pinned={seg.startAt} onclick={() => openPin(`seg:${seg.key}`, seg.startAt, placed.find((p) => p.segKey === seg.key && p.state === 'upcoming') ? floorFor(placed.find((p) => p.segKey === seg.key && p.state === 'upcoming').key) : null)}
                    title={seg.startAt ? 'Programmed — click to change' : 'Program when this schedule starts'}>
              {seg.startAt ? clock(seg.startAt) : 'set time'}
            </button>
          {/if}
          <span class="mv">
            <button class="ic" disabled={busy || segments[0] === seg} onclick={() => act(() => api.tonightSegMove(seg.key, -1))} title="Move up">↑</button>
            <button class="ic" disabled={busy || segments[segments.length - 1] === seg} onclick={() => act(() => api.tonightSegMove(seg.key, 1))} title="Move down">↓</button>
          </span>
          <button class="ic rm" disabled={busy} onclick={() => armed(`seg:${seg.key}`, () => act(() => api.tonightRemoveSeg(seg.key)))}
                  title={confirmOnce.key === `seg:${seg.key}` ? 'Click again to remove this schedule from tonight' : 'Remove from tonight'}>
            {confirmOnce.key === `seg:${seg.key}` ? '!' : '×'}
          </button>
        </div>
        {#if !folded[seg.key]}
        {#if past.length > PAST_SHOWN}
          <button class="showpast" onclick={() => (showPast[seg.key] = !showPast[seg.key])}>
            {showPast[seg.key] ? `Hide ${past.length - PAST_SHOWN} earlier` : `Show all ${past.length} earlier`}
          </button>
        {/if}
        <ul class="q">
          {#each visibleRows(seg) as it, i (it.key)}
            {@const isPast = it.state === 'past' || it.state === 'aired' || it.state === 'skipped'}
            {@const p = placed.find((x) => x.key === it.key)}
            {#if it.state === 'upcoming' && seg.items.find((x) => x.state === 'upcoming') === it && !seg.items.some((x) => x.onAir || x.state === 'aired' || x.state === 'skipped')}
              <li class="startbar">
                <span>▶ starts here</span><span class="ln"></span>
                <span class="mv">
                  <button class="ic" disabled={busy || seg.items.indexOf(it) === 0} onclick={() => act(() => api.tonightSegStart(seg.key, seg.items.indexOf(it) - 1))} title="Start one earlier">↑</button>
                  <button class="ic" disabled={busy || seg.items.indexOf(it) >= seg.items.length - 1} onclick={() => act(() => api.tonightSegStart(seg.key, seg.items.indexOf(it) + 1))} title="Start one later">↓</button>
                </span>
              </li>
            {/if}
            {#if it.state === 'upcoming' && breakOf(it) > 0}
              <li class="brk">
                <span class="ln"></span>
                <span>break · {fmtGap(breakOf(it))}</span>
                {#if autoBreak(it)}<span class="chip amber" title="From the break rule">auto</span>{/if}
                {#if it.breakBefore}<button class="ic rm" onclick={() => act(() => api.tonightSetItem(it.key, { breakBefore: null }))} title="Remove this break">×</button>{/if}
                <span class="ln"></span>
              </li>
            {/if}
            <li class:past={isPast} class:start={it.onAir} class:over={rowOver === it.key} class:skipped={it.state === 'skipped'}
                draggable={dnd && it.state === 'upcoming'}
                ondragstart={(e) => rowDragStart(e, seg, it)} ondragover={(e) => rowDragOver(e, seg, it)}
                ondrop={(e) => rowDrop(e, seg, it)} ondragend={() => { rowDrag = null; rowOver = null; }}>
              {#if dnd && it.state === 'upcoming'}<span class="handle"></span>{/if}
              {#if it.image}<img class="cv xs" src={it.image} alt="" onerror={(e) => e.currentTarget.remove()} />{/if}
              <span class="qt">
                {#if isPast}<span class="tick" class:sk={it.state === 'skipped'}>{it.state === 'skipped' ? '↷' : '✓'}</span>{/if}
                {epName(it.title)}
                {#if it.onAir}<small>on air</small>{:else if it.state === 'skipped'}<small>skipped</small>{:else if it.state === 'aired'}<small>aired</small>{:else if it.watched}<small>watched</small>{/if}
              </span>
              {#if it.state === 'upcoming'}
                {#if pinKey === it.key}
                  <span class="tcell edit">
                    <input class="tin" type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" bind:value={pinValue}
                           list={`ts-${it.key}`} class:bad={pinValue && !parseClock(pinValue)}
                           oninput={(e) => { pinValue = maskClock(e.currentTarget.value); }}
                           onkeydown={(e) => { if (e.key === 'Enter') savePin(); else if (e.key === 'Escape') pinKey = null; else stepTime(e); }}
                           {@attach (el) => { el.focus(); el.select(); try { el.showPicker?.(); } catch { /* gesture */ } }}
                           aria-label="Air time (24-hour, HH:MM)" title={`24-hour, HH:MM. Arrow keys nudge by 5 minutes, shift-arrow by an hour. Earliest ${clock(pinFloor)}.`} />
                    <datalist id={`ts-${it.key}`}>{#each timeSuggestions(pinFloor) as t}<option value={t}></option>{/each}</datalist>
                    {#if pinTarget && !sameDay(pinTarget, now)}<span class="onday">{new Date(pinTarget * 1000).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>{/if}
                  </span>
                {:else}
                  {@const late = it.startAt && p?.at && p.at > it.startAt + 30}
                  <button class="t" class:pinned={it.startAt && !late} class:late disabled={busy}
                          onclick={() => openPin(it.key, it.startAt ?? p?.at ?? null, floorFor(it.key))}
                          title={late ? `Programmed for ${clock(it.startAt)}, but what runs before it does not finish until then` : it.startAt ? 'Programmed — click to change' : 'Click to program an air time'}>
                    {it.startAt ? '⏱ ' : ''}{p?.at && p.sure !== false ? clock(p.at) : '—:—'}
                  </button>
                {/if}
              {/if}
              {#if it.duration}<span class="muted small dur num">{fmtTime(it.duration)}</span>{/if}
              <span class="qctl">
                {#if pinKey === it.key}
                  <button class="ic ok" onclick={savePin} title="Set time">✓</button>
                  <button class="ic" onclick={nudgeDay} title="A day later">→</button>
                  {#if it.startAt}<button class="ic rm" onclick={() => clearPin(it.key)} title="Clear the programmed time">×</button>{:else}<button class="ic" onclick={() => (pinKey = null)} title="Cancel">×</button>{/if}
                {:else if it.state === 'upcoming'}
                  {#if it.startAt}
                    <button class="brkmode" disabled={busy} onclick={() => act(() => api.tonightSetItem(it.key, { breakOffline: !it.breakOffline }))}
                            title={it.breakOffline ? 'Keep the stream up with a countdown card instead' : 'Go off air until then instead of showing a card'}>
                      {it.breakOffline ? 'card' : 'off air'}
                    </button>
                  {/if}
                  {#if !breakOf(it) && seg.items.find((x) => x.state === 'upcoming') !== it}
                    <button class="ic" disabled={busy} onclick={() => act(() => api.tonightSetItem(it.key, { breakBefore: (view.settings.breakMinutes || 5) * 60 }))} title={`Add a ${view.settings.breakMinutes || 5} minute break before this one`}>⏸</button>
                  {/if}
                  <button class="ic" onclick={() => (inspect = { id: it.id, title: it.title })} title="What this file is, and what the encoder will do with it">i</button>
                  <span class="mv">
                    <button class="ic" disabled={busy} onclick={() => act(() => api.tonightMove(it.key, -1))} title="Move up">↑</button>
                    <button class="ic" disabled={busy} onclick={() => act(() => api.tonightMove(it.key, 1))} title="Move down">↓</button>
                  </span>
                  <button class="ic rm" disabled={busy} onclick={() => act(() => api.tonightRemove(it.key))} title="Remove from tonight">×</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        {/if}
      </div>
    {/each}
    </div>
  </div>

  <!-- ── rail ─────────────────────────────────────────────────────────── -->
  <div class="rail">
    <div class="card">
      <div class="tabs">
        <button class:on={tab === 'saved'} onclick={() => (tab = 'saved')}>Saved</button>
        <button class:on={tab === 'breaks'} onclick={() => (tab = 'breaks')}>Breaks</button>
        <button class:on={tab === 'history'} onclick={() => (tab = 'history')}>History</button>
      </div>

      {#if tab === 'saved'}
        {#if editId && edit}
          {@const s = view.schedules.find((x) => x.id === editId)}
          <div class="form">
            <h3>Edit · {s?.name}</h3>
            <label>Name <input bind:value={edit.name} /></label>
            <label>Starts from
              <select bind:value={edit.start}>
                {#each editItems as it, i}<option value={i}>{epName(it.title)}{#if s?.watched.includes(i)} · watched{/if}</option>{/each}
                <option value={editItems.length}>finished</option>
              </select>
            </label>
            <label class="chk"><input type="checkbox" bind:checked={edit.auto} /> Auto-start</label>
            {#if edit.auto}
              <label>Time <input class="tin" type="text" inputmode="numeric" maxlength="5" bind:value={edit.time} oninput={(e) => { edit.time = maskClock(e.currentTarget.value); }} /></label>
              <div class="dayrow">
                <span>Repeat</span>
                <div class="days">
                  {#each DAYS as d, i}
                    <button type="button" class:on={edit.days.includes(i)} disabled={Boolean(edit.date)}
                            onclick={() => { edit.days = edit.days.includes(i) ? edit.days.filter((x) => x !== i) : [...edit.days, i].sort(); }}>{d}</button>
                  {/each}
                </div>
              </div>
              <label>Or once on <input class="tin wide" placeholder="day.month.year" bind:value={edit.date} /></label>
              <p class="muted tiny" style="margin:0">
                {#if editNext}Next: {clock(editNext)}{#if edit.date} · once{:else} · then weekly{/if}
                {:else if edit.date || edit.days.length}No start ahead — check the time and date.
                {:else}Pick the days it repeats on, or type a date.{/if}
              </p>
              <label>Countdown card
                <select bind:value={edit.countdownMin}><option value={0}>Off</option><option value={5}>5 minutes before</option><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option></select>
              </label>
            {/if}
            <label>Breaks
              <select bind:value={edit.breaks}><option value="global">Use the break rule</option><option value="none">None</option><option value="custom">Custom</option></select>
            </label>
            <label>When finished
              <select bind:value={edit.atEnd}>
                <option value="stop">Stop — Load offers a start-over, auto-start pauses</option>
                <option value="restart">Start over next time it is loaded or auto-started</option>
                <option value="loop">Loop — keep playing from the first item until stopped</option>
              </select>
            </label>
            {#if edit.breaks === 'custom'}
              <div class="l"><span>Every</span><span><input class="tin" bind:value={edit.every} /> episodes · <input class="tin" bind:value={edit.minutes} /> min</span></div>
            {/if}
            <details>
              <summary>{editItems.length} items</summary>
              <ul class="edititems">
                {#each editItems as it, i (it.id + i)}
                  <li><span class="qt">{i + 1}. {it.title}</span><button class="ic rm" onclick={() => removeEditItem(i)} title="Remove from this schedule">×</button></li>
                {/each}
              </ul>
            </details>
            {#if editError}<p class="err" style="margin:0">{editError}</p>{/if}
            <div class="row" style="justify-content:space-between">
              <button class="sm danger" onclick={() => armed(`del:${editId}`, () => { const id = editId; editId = null; edit = null; act(() => api.deleteSchedule(id), 'Deleted.'); })}>
                {confirmOnce.key === `del:${editId}` ? 'Really delete?' : 'Delete'}
              </button>
              <span><button class="sm ghost" onclick={() => { editId = null; edit = null; }}>Cancel</button> <button class="sm primary" onclick={saveEdit}>Save</button></span>
            </div>
          </div>
        {:else}
          <div class="saved">
            {#each view.schedules as s (s.id)}
              <div class="sv" class:playing={playingSeg?.scheduleId === s.id} class:grab={dnd} draggable={dnd} role="listitem"
                   ondragstart={(e) => cardDragStart(e, s.id)} ondragend={() => { cardDrag = null; zoneOver = false; segOver = null; }}
                   title={dnd ? 'Drag into the lineup to append it, or onto a schedule to go in before it' : ''}>
                <span class="nm">{s.name}</span>
                {#if playingSeg?.scheduleId === s.id}<span class="chip ok">playing</span>
                {:else if segments.some((g) => g.scheduleId === s.id)}<span class="chip">tonight</span>{/if}
                <div class="progress" class:done={s.start >= s.items.length}><i style:width={`${progress(s)}%`}></i></div>
                <div class="meta">
                  <span>{s.items.length} items · {startLabel(s)}</span>
                  <span class={s.autoStart?.enabled ? 'rec' : ''}>{recur(s)}{#if s.nextRun} · next {clock(s.nextRun)}{/if}{#if s.finished && s.autoStart?.enabled && atEndOf(s) === 'stop'} · paused, played through{/if}</span>
                </div>
                <div class="acts">
                  {#if s.finished && atEndOf(s) === 'stop'}
                    <button onclick={() => act(() => api.loadSchedule(s.id, null, true), `"${s.name}" starts over.`)} disabled={busy} title="Every item has aired — load it from the first item again">Start over</button>
                    <button onclick={() => act(() => api.appendSchedule(s.id, null, true), `Appended "${s.name}" from the start.`)} disabled={busy} title="Add it after what is lined up, from the first item">Append</button>
                  {:else}
                    <button onclick={() => act(() => api.loadSchedule(s.id), `Loaded "${s.name}".`)} disabled={busy} title="Replace tonight with this schedule">Load</button>
                    <button onclick={() => act(() => api.appendSchedule(s.id), `Appended "${s.name}".`)} disabled={busy} title="Add it after what is already lined up">Append</button>
                  {/if}
                  <button onclick={() => openEdit(s)}>Edit</button>
                  <button onclick={() => act(() => api.duplicateSchedule(s.id), 'Duplicated.')} disabled={busy}>Copy</button>
                  {#if s.start >= s.items.length || s.watched.length}<button onclick={() => act(() => api.resetSchedule(s.id), 'Progress reset.')} disabled={busy} title="Forget what was watched; start from the first item">Reset</button>{/if}
                </div>
              </div>
            {/each}
            {#if !view.schedules.length}
              <p class="muted small">No saved schedules yet. Line something up and use "Save lineup as…", or add from the library into a new schedule.</p>
            {/if}
          </div>
        {/if}
      {:else if tab === 'breaks'}
        <div class="form">
          <div class="l"><span>Every</span><span><input class="tin" type="number" min="0" max="99" value={view.settings.breakEvery} onchange={(e) => act(() => api.scheduleSettings({ breakEvery: +e.currentTarget.value }))} /> episodes</span></div>
          <div class="l"><span>Length</span><span><input class="tin" type="number" min="1" max="180" value={view.settings.breakMinutes} onchange={(e) => act(() => api.scheduleSettings({ breakMinutes: +e.currentTarget.value }))} /> minutes</span></div>
          <div class="l"><span>While waiting</span>
            <select value={view.settings.breakOffline ? 'off' : 'card'} onchange={(e) => act(() => api.scheduleSettings({ breakOffline: e.currentTarget.value === 'off' }))}>
              <option value="card">Countdown card</option><option value="off">Go off air</option>
            </select>
          </div>
          <p class="muted tiny">{view.settings.breakEvery ? `A ${view.settings.breakMinutes}-minute break after every ${view.settings.breakEvery} episodes` : 'No automatic breaks'}. Schedules can override this in their own settings. Breaks you place by hand stay.</p>
        </div>
      {:else}
        <div class="hh"><span class="muted tiny">{view.history.length} of 100 kept</span><span class="sp"></span>
          <button class="sm ghost" disabled={!view.history.length} onclick={() => armed('hist', () => act(() => api.clearHistory(), 'History cleared.'))}>{confirmOnce.key === 'hist' ? 'Really clear?' : 'Clear'}</button></div>
        <ul class="hist">
          {#each view.history as h, i (h.at + ':' + i)}
            <li class:sk={h.outcome === 'skipped'}>
              <span class="when num">{sameDay(h.at / 1000, now) ? hhmm(h.at / 1000) : new Date(h.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
              <span class="qt">{h.title}{#if h.schedule}<small> · {h.schedule}</small>{/if}</span>
              <span class="v">{h.outcome === 'skipped' ? `skipped at ${fmtTime(h.seconds)}` : 'aired'}</span>
            </li>
          {/each}
          {#if !view.history.length}<li class="muted small">Nothing has aired yet.</li>{/if}
        </ul>
      {/if}
    </div>
  </div>
</div>

{#if inspect}
  <Inspector id={inspect.id} title={inspect.title} onclose={() => (inspect = null)} />
{/if}

<!-- ── picker ─────────────────────────────────────────────────────────── -->
{#if picker}
  <div class="backdrop" onclick={(e) => { if (e.target === e.currentTarget) picker = null; }} role="presentation">
    <div class="modal" role="dialog" aria-label="Add from library">
      <div class="mh">
        {#if picker.series}<button class="sm ghost" onclick={() => (picker.series = null)}>← back</button><h3>{picker.series.title}</h3>
        {:else}
          <h3>Add from library</h3>
          <select bind:value={picker.libraryId} onchange={searchPicker}>{#each picker.libraries as l}<option value={l.id}>{l.name}</option>{/each}</select>
          <input class="find" placeholder="Search…" bind:value={picker.q} oninput={pickerInput} {@attach (el) => el.focus()} />
        {/if}
        <span class="sp"></span>
        <label class="small">Add to
          <select bind:value={picker.target}>
            <option value="tonight">tonight</option>
            {#each view.schedules as s}<option value={s.id}>{s.name}</option>{/each}
            <option value="new">a new schedule</option>
          </select>
        </label>
        <button class="ic" onclick={() => (picker = null)} title="Close">×</button>
      </div>
      {#if picker.series}
        {@const ci = continueIndex()}
        <div class="row">
          <button class="sm primary" disabled={ci >= picker.episodes.length} onclick={() => { selectFrom(ci); addPicked(); }}>
            {ci > 0 ? `Continue · ${epName(picker.episodes[ci]?.title ?? '')}` : 'Whole season'}
          </button>
          <button class="sm" onclick={() => selectFrom(0)}>Select all</button>
          <button class="sm" disabled={!picker.selected.size} onclick={() => addPicked()}>Add {picker.selected.size} selected</button>
          <span class="muted small">Click an episode to pick it, or "from here" to take the rest.</span>
        </div>
        <ul class="eps">
          {#each picker.episodes as ep, i (ep.id)}
            <li class:sel={picker.selected.has(ep.id)}>
              <label><input type="checkbox" checked={picker.selected.has(ep.id)} onchange={() => togglePick(ep.id)} /> {ep.title}</label>
              <button class="sm ghost" onclick={() => selectFrom(i)}>from here</button>
            </li>
          {/each}
          {#if picker.loading}<li class="muted small">Loading…</li>{/if}
        </ul>
      {:else}
        <ul class="results">
          {#each picker.results as it (it.id)}
            <li>
              <button class="line" onclick={() => (it.type === 'Movie' ? addPicked([it.id]) : openPickSeries(it))}>
                {#if it.image}<img class="cv xs" src={it.image} alt="" onerror={(e) => e.currentTarget.remove()} />{/if}
                <span class="qt">{it.title}</span>
                <span class="muted small">{it.type === 'Movie' ? 'add' : `${it.childCount ?? ''} episodes ›`}</span>
              </button>
            </li>
          {/each}
          {#if picker.loading}<li class="muted small">Loading…</li>{:else if !picker.results.length}<li class="muted small">Nothing found.</li>{/if}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ph { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .ph h1 { margin: 0; }
  .sp { flex: 1; }
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .switch input { width: auto; }
  .note { color: var(--success); margin: 0 0 8px; }
  button.sm { padding: 4px 10px; font-size: 13px; }
  button.ghost { background: transparent; }
  button.on { border-color: var(--accent); color: var(--accent); }
  .num { font-variant-numeric: tabular-nums; }
  .tiny { font-size: 11.5px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
  .chip.off { color: var(--muted); }
  .chip.ok { color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, transparent); background: color-mix(in srgb, var(--success) 12%, transparent); }
  .chip.amber { color: #c98a2e; border-color: color-mix(in srgb, #c98a2e 45%, transparent); background: color-mix(in srgb, #c98a2e 14%, transparent); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }

  /* the strip */
  .tl { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 12px 14px 12px; overflow-x: auto; user-select: none; }
  .tl.dragging { cursor: grabbing; }
  .scale { position: relative; height: 16px; margin-bottom: 6px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .scale span { position: absolute; top: 0; transform: translateX(-50%); }
  .lane { position: relative; height: 56px; border-radius: 6px; background: repeating-linear-gradient(90deg, transparent 0 calc(12.5% - 1px), var(--border) calc(12.5% - 1px) 12.5%); }
  .blk { position: absolute; top: 9px; height: 38px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); display: flex; align-items: center; gap: 6px; padding: 0 7px; font-size: 12px; overflow: hidden; white-space: nowrap; box-sizing: border-box; }
  .blk.grab { cursor: grab; }
  .blk.lift { z-index: 3; box-shadow: 0 6px 18px rgba(0,0,0,.35); border-color: var(--accent); }
  .blk.past { opacity: .5; }
  .blk.ghost { border-style: dashed; }
  .blk.now { border-color: var(--success); background: color-mix(in srgb, var(--success) 16%, var(--surface-2)); }
  .blk.seg2 { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
  .blk .cv { width: 20px; height: 28px; object-fit: cover; border-radius: 3px; flex-shrink: 0; -webkit-user-drag: none; user-select: none; pointer-events: none; }
  .blk .dt { position: absolute; top: -26px; left: 0; padding: 1px 7px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .blk .dt.early { background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
  .blk.lift { overflow: visible; }
  .blk .bt { overflow: hidden; text-overflow: ellipsis; }
  .brk2 { position: absolute; top: 16px; height: 24px; border-radius: 4px; background: color-mix(in srgb, #c98a2e 14%, transparent); border: 1px dashed color-mix(in srgb, #c98a2e 60%, transparent); color: #c98a2e; font-size: 10.5px; display: grid; place-items: center; overflow: hidden; }
  .cd2 { position: absolute; top: 9px; height: 38px; border-radius: 6px; border: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 11px; display: grid; place-items: center; }
  .nowline { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--success); z-index: 2; }
  .nowline::before { content: "now"; position: absolute; top: -13px; left: -10px; font-size: 10px; color: var(--success); }
  .flag { position: absolute; top: 2px; width: 2px; height: 52px; background: var(--accent); z-index: 1; }
  .flag::after { content: attr(data-t); position: absolute; top: -2px; left: 5px; font-size: 10px; color: var(--accent); white-space: nowrap; }
  .startflag { position: absolute; top: 0; width: 3px; height: 56px; background: var(--accent); z-index: 2; border-radius: 2px; }
  .startflag.grab { cursor: ew-resize; }
  .startflag::before { content: "▶ starts here"; position: absolute; bottom: -15px; left: -3px; font-size: 10px; color: var(--accent); white-space: nowrap; letter-spacing: .04em; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); font-size: 13px; }
  .legend { display: flex; gap: 14px; margin-top: 22px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; align-items: center; position: sticky; left: 0; }
  .legend .zoom { display: inline-flex; gap: 2px; margin-left: 6px; }
  .legend .zoom .ic { width: 22px; height: 22px; font-size: 14px; border: 1px solid var(--border); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; vertical-align: -1px; margin-right: 5px; border: 1px solid var(--border); }
  .legend .l-now { background: color-mix(in srgb, var(--success) 40%, var(--surface-2)); }
  .legend .l-past { background: var(--surface-2); opacity: .5; }
  .legend .l-brk { background: color-mix(in srgb, #c98a2e 14%, transparent); border: 1px dashed #c98a2e; }
  .legend .l-pin { background: var(--accent); }

  .two { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 22px; align-items: start; margin-top: 18px; }
  @media (max-width: 980px) { .two { grid-template-columns: 1fr; } }

  /* on air */
  .onair { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; }
  .onair .tracks { grid-column: 1 / -1; border-top: 1px solid var(--border); padding-top: 10px; }
  .onair .acts { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; align-self: center; justify-content: flex-end; }
  .onair .acts button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; }
  .onair .next { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cover { width: 52px; height: 74px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .line { display: block; width: 100%; text-align: left; margin: 3px 0; background: transparent; border-color: var(--border); font-size: 13px; }
  .line.on { border-color: var(--accent); color: var(--accent); }
  .cdbanner { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: center; border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%); border-radius: 12px; padding: 12px 16px; }
  .cdbanner .big { font-size: 24px; font-weight: 500; }
  .cdbanner .lbl { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }

  /* lineup */
  .uphead { display: flex; align-items: center; gap: 10px; margin: 20px 0 8px; flex-wrap: wrap; }
  .uphead h2 { margin: 0; }
  .menu { position: relative; }
  .pop { position: absolute; top: 110%; right: 0; z-index: 5; min-width: 260px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .blkw { border: 1px solid var(--border); border-left: 3px solid var(--success); border-radius: var(--radius); margin-top: 10px; overflow: hidden; }
  .blkw.pinned { border-left-color: var(--accent); }
  .blkw.over { outline: 2px dashed var(--accent); }
  .blkw.rowend { box-shadow: inset 0 -2px 0 var(--accent); }
  .zone { min-height: 48px; border-radius: var(--radius); border: 1px dashed transparent; transition: border-color .12s ease, background .12s ease; }
  .zone.armed { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .zone.drop { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .zone .zone-empty { padding: 12px 10px; margin: 0; }
  .sv.grab { cursor: grab; }
  .bh { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--surface); flex-wrap: wrap; }
  .bh .bl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bh .fold { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; font: inherit; color: inherit; }
  .bh .chev { color: var(--muted); transition: transform .14s ease; }
  .bh .chev.closed { transform: rotate(-90deg); }
  .bh .fold:hover .chev { color: inherit; }
  .bh .bm { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .handle { width: 12px; height: 18px; flex-shrink: 0; color: var(--muted); cursor: grab; background: radial-gradient(circle, currentColor 1.3px, transparent 1.5px) 0 0 / 6px 6px; opacity: .7; }
  .showpast { display: block; width: 100%; text-align: left; background: transparent; border: none; border-bottom: 1px solid var(--border); border-radius: 0; color: var(--accent); font-size: 12px; padding: 4px 12px; }
  .q { list-style: none; padding: 0; margin: 0; }
  .q li { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 14px; }
  .q li:last-child { border-bottom: none; }
  .q li:hover { background: var(--surface-2); }
  .q li.over { box-shadow: inset 0 2px 0 var(--accent); }
  .q li.past { color: var(--muted); }
  .q li.past .cv { filter: grayscale(1) brightness(.75); }
  .q li.start { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .tick { color: var(--success); margin-right: 6px; font-size: 12px; }
  .tick.sk { color: var(--muted); }
  .qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qt small { color: var(--muted); margin-left: 6px; }
  .cv.xs { width: 26px; height: 36px; object-fit: cover; border-radius: 3px; flex-shrink: 0; }
  .dur { flex-shrink: 0; }
  .startbar { display: flex; align-items: center; gap: 8px; padding: 3px 10px !important; font-size: 11px; color: var(--accent); letter-spacing: .06em; text-transform: uppercase; border-bottom: none !important; }
  .startbar .ln { flex: 1; border-top: 2px solid var(--accent); }
  .startbar:hover { background: transparent !important; }
  .q li.brk { border-bottom: none; padding: 6px 8px; font-size: 12px; color: #c98a2e; }
  .q li.brk .ln { flex: 1; border-top: 1px dashed color-mix(in srgb, currentColor 45%, transparent); }
  .q li.brk:hover { background: transparent; }
  .t { padding: 3px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .t.pinned { color: var(--accent); font-weight: 500; }
  .t.late { text-decoration: underline dotted; }
  .tcell.edit { display: inline-flex; align-items: center; gap: 4px; }
  .tin { width: 74px; padding: 3px 6px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .tin.wide { width: 220px; }
  .tin.bad { border-color: var(--danger); color: var(--danger); }
  .onday { font-size: 11px; color: var(--accent); white-space: nowrap; }
  .qctl { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .mv { display: inline-flex; gap: 0; }
  .ic { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border-radius: 999px; background: transparent; border: none; color: var(--muted); font-size: 13px; }
  .ic:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .ic.rm:hover:not(:disabled) { color: var(--danger); }
  .ic.ok { color: var(--success); }
  .brkmode { padding: 1px 8px; font-size: 11.5px; border-radius: 999px; background: transparent; border: 1px solid color-mix(in srgb, currentColor 45%, transparent); color: var(--muted); }

  /* rail */
  .rail .card { padding: 14px 16px; min-width: 0; overflow: hidden; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
  .tabs button { border: none; background: transparent; padding: 6px 10px; border-radius: 6px 6px 0 0; color: var(--muted); font-size: 13px; border-bottom: 2px solid transparent; }
  .tabs button.on { color: var(--text); border-bottom-color: var(--accent); }
  .saved { display: grid; gap: 8px; }
  .sv { border: 1px solid var(--border); border-radius: var(--radius); padding: 9px 10px; display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; align-items: center; }
  .sv.playing { border-color: var(--success); }
  .sv .nm { font-weight: 500; font-size: 14px; }
  .sv .meta { grid-column: 1 / -1; font-size: 12px; color: var(--muted); display: grid; gap: 2px; }
  .sv .meta .rec { color: var(--accent); }
  .sv .acts { grid-column: 1 / -1; display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .sv .acts button { padding: 3px 8px; font-size: 12px; }
  .sv .progress { grid-column: 1 / -1; }
  .progress { height: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: 4px; }
  .progress i { display: block; height: 100%; background: var(--accent); }
  .progress.done i { background: var(--success); }
  .form { display: grid; gap: 8px; font-size: 13px; min-width: 0; }
  /* Every child stays inside the column: a long title in the items list
     or a select's longest option must not widen the panel. */
  .form > * { min-width: 0; max-width: 100%; }
  .form details { overflow: hidden; }
  .form summary { cursor: pointer; }
  .form h3 { margin: 0 0 4px; }
  .form label { display: grid; gap: 3px; min-width: 0; }
  .form label.chk { display: flex; align-items: center; gap: 8px; }
  .form label.chk input { width: auto; }
  .form input, .form select { padding: 5px 8px; font-size: 13px; width: 100%; max-width: 100%; box-sizing: border-box; min-width: 0; }
  .form .l { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px; align-items: center; }
  .form .tin { width: 70px; }
  .form .tin.wide { width: 140px; }
  .form .dayrow { display: grid; gap: 4px; }
  .days { display: flex; gap: 3px; flex-wrap: wrap; }
  .days button { padding: 3px 0; width: 32px; font-size: 12px; border-radius: 6px; flex: 0 0 auto; }
  .days button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .edititems { list-style: none; padding: 0; margin: 6px 0 0; max-height: 200px; overflow: auto; font-size: 12.5px; }
  .edititems li { display: flex; align-items: center; gap: 6px; padding: 2px 0; min-width: 0; }
  .edititems li .qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hh { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .hist { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  .hist li { display: grid; grid-template-columns: 52px 1fr auto; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border); align-items: baseline; }
  .hist li:last-child { border-bottom: none; }
  .hist li.sk { color: var(--muted); }
  .hist .when { color: var(--muted); font-size: 12px; }
  .hist .v { color: var(--muted); font-size: 12px; white-space: nowrap; }

  /* picker */
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; padding: 20px; z-index: 30; }
  .modal { width: min(720px, 100%); max-height: 85vh; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .mh { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .mh h3 { margin: 0; }
  .mh .find { flex: 1; min-width: 160px; }
  .mh select { padding: 5px 8px; font-size: 13px; }
  .results, .eps { list-style: none; padding: 0; margin: 0; }
  .results { margin-top: 6px; }
  .results .line { display: flex; align-items: center; gap: 10px; }
  .eps { margin-top: 14px; border-top: 1px solid var(--border); }
  .eps li { display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-bottom: 1px solid var(--border); font-size: 13.5px; }
  .eps li.sel { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .eps label { flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .eps input { width: auto; }
</style>
