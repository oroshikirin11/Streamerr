/**
 * Saved schedules, Tonight and history.
 *
 * Three things, one store:
 *
 *  - A SAVED SCHEDULE is a named, ordered list of library items with its
 *    own memory: which items have aired (`watched`, by index) and where it
 *    starts next time (`start`, an index). It may auto-start at a time,
 *    weekly or once, with a countdown card ahead of it.
 *  - TONIGHT is the draft lineup: segments, each a loaded or appended
 *    schedule or a run of ad-hoc items. It exists offline, survives a
 *    restart, and is what "Go live" plays. While a broadcast runs the
 *    engine's queue is DERIVED from it (upcomingEntries), never the other
 *    way round, so the page can keep showing what already aired.
 *  - HISTORY is the last 100 things that aired or were skipped, across
 *    every schedule and ad-hoc play.
 *
 * Everything here is synchronous and pure apart from the file; the server
 * wires it to the engine and the library. Persisted beside config.json,
 * written atomically (tmp + rename) so a crash mid-write cannot eat it.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';

export const HISTORY_MAX = 100;
const uid = () => Math.random().toString(36).slice(2, 10);
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const DEFAULT_SETTINGS = {
  // Auto-break rule: every N episodes, M minutes. 0 = off.
  breakEvery: 0, breakMinutes: 5, breakOffline: false,
  // Drag and drop in the panel; the buttons always work.
  dnd: true,
  // How much of an item must have aired to count as watched.
  watchedAt: 0.6,
};

/** The fields of a library item a schedule keeps. Paths are resolved at play time. */
export function pickItem(it) {
  return {
    id: String(it.id),
    title: String(it.title ?? ''),
    series: it.series ?? it.seriesName ?? null,
    season: it.season ?? null,
    episode: it.episode ?? null,
    duration: Number.isFinite(Number(it.duration)) && it.duration != null ? Number(it.duration) : null,
    image: it.image ?? null,
  };
}

function normalizeAutoStart(a) {
  if (!a || typeof a !== 'object') return null;
  const time = /^\d{1,2}:\d{2}$/.test(String(a.time ?? '')) ? String(a.time) : null;
  if (!time) return null;
  const days = Array.isArray(a.days)
    ? [...new Set(a.days.map((d) => clampInt(d, 0, 6, -1)).filter((d) => d >= 0))].sort()
    : [];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date ?? '')) ? String(a.date) : null;
  if (!days.length && !date) return null;
  return {
    time, days, date,
    countdownMin: clampInt(a.countdownMin ?? 15, 0, 180, 15),
    enabled: a.enabled !== false,
    firedKey: a.firedKey ?? null,
  };
}

function normalizeBreaks(b) {
  if (b === 'none') return 'none';
  if (b && typeof b === 'object') {
    return { every: clampInt(b.every, 0, 99, 0), minutes: clampInt(b.minutes, 1, 180, 5) };
  }
  return 'global';
}

/**
 * When a schedule fires next, in epoch seconds, or null. Local time on the
 * box: an operator programs "Friday 20:00" in their own clock.
 */
export function nextRun(schedule, nowMs = Date.now()) {
  const a = schedule?.autoStart;
  if (!a?.enabled) return null;
  const [hh, mm] = a.time.split(':').map(Number);
  if (a.date) {
    const [y, m, d] = a.date.split('-').map(Number);
    const t = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
    return t > nowMs ? Math.round(t / 1000) : null;
  }
  const now = new Date(nowMs);
  for (let off = 0; off < 8; off++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off, hh, mm, 0, 0);
    if (a.days.includes(t.getDay()) && t.getTime() > nowMs) return Math.round(t.getTime() / 1000);
  }
  return null;
}

export function createScheduleStore({ path = null, now = () => Date.now() } = {}) {
  let state = {
    version: 1,
    schedules: [],
    tonight: { segments: [] },
    history: [],
    settings: { ...DEFAULT_SETTINGS },
  };
  const listeners = new Set();

  // ---- persistence -------------------------------------------------------
  if (path && existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw && typeof raw === 'object') {
        state = {
          ...state,
          ...raw,
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
          tonight: raw.tonight?.segments ? raw.tonight : { segments: [] },
          schedules: Array.isArray(raw.schedules) ? raw.schedules : [],
          history: Array.isArray(raw.history) ? raw.history.slice(0, HISTORY_MAX) : [],
        };
        // Whatever was on air when the process died is not on air now.
        for (const seg of state.tonight.segments) {
          for (const it of seg.items) if (it.state === 'onair') it.state = 'upcoming';
        }
      }
    } catch { /* a corrupt file starts fresh; the old one stays on disk */ }
  }
  function save() {
    if (path) {
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 1));
        renameSync(`${path}.tmp`, path);
      } catch { /* read-only disk: the panel still works for the session */ }
    }
    for (const fn of listeners) { try { fn(); } catch { /* listener's problem */ } }
  }

  const get = (id) => state.schedules.find((s) => s.id === id) ?? null;
  const must = (id) => {
    const s = get(id);
    if (!s) throw Object.assign(new Error('No such schedule'), { status: 404 });
    return s;
  };

  // ---- schedules ---------------------------------------------------------
  function create({ name, items = [], start = 0, autoStart = null, breaks = 'global', watched = [], atEnd = 'stop' } = {}) {
    const list = (items ?? []).map(pickItem);
    const s = {
      id: uid(),
      name: String(name ?? '').trim().slice(0, 80) || 'Untitled schedule',
      items: list,
      watched: [...new Set((watched ?? []).map((i) => clampInt(i, 0, list.length - 1, -1)).filter((i) => i >= 0))].sort((a, b) => a - b),
      start: clampInt(start, 0, Math.max(0, list.length), 0),
      autoStart: normalizeAutoStart(autoStart),
      breaks: normalizeBreaks(breaks),
      // When the last item has aired: 'stop' (the marker rests past the
      // end, auto-start pauses, Load offers a start-over), 'restart'
      // (progress resets by itself next time — a fixed weekly programme)
      // or 'loop' (that, and while on air it appends itself from the first
      // item as its last one starts, so the night never runs dry).
      atEnd: ['restart', 'loop'].includes(atEnd) ? atEnd : 'stop',
      createdAt: now(), updatedAt: now(), lastRunAt: null,
    };
    state.schedules.push(s);
    save();
    return s;
  }

  function update(id, patch = {}) {
    const s = must(id);
    if (patch.name != null) s.name = String(patch.name).trim().slice(0, 80) || s.name;
    if (Array.isArray(patch.items)) {
      // Progress follows the ITEM, not its position: reordering or adding
      // an episode must not mark the wrong one watched.
      const wasWatched = new Set(s.watched.map((i) => s.items[i]?.id).filter(Boolean));
      const startId = s.items[s.start]?.id ?? null;
      s.items = patch.items.map(pickItem);
      s.watched = s.items.map((it, i) => (wasWatched.has(it.id) ? i : -1)).filter((i) => i >= 0);
      const si = startId ? s.items.findIndex((it) => it.id === startId) : -1;
      s.start = si >= 0 ? si : Math.min(s.start, s.items.length);
    }
    if (patch.start != null) s.start = clampInt(patch.start, 0, s.items.length, s.start);
    if ('autoStart' in patch) s.autoStart = normalizeAutoStart(patch.autoStart);
    if ('breaks' in patch) s.breaks = normalizeBreaks(patch.breaks);
    if ('atEnd' in patch) s.atEnd = ['restart', 'loop'].includes(patch.atEnd) ? patch.atEnd : 'stop';
    if (Array.isArray(patch.watched)) {
      s.watched = [...new Set(patch.watched.map((i) => clampInt(i, 0, s.items.length - 1, -1)).filter((i) => i >= 0))].sort((a, b) => a - b);
    }
    s.updatedAt = now();
    save();
    return s;
  }

  function remove(id) {
    const s = must(id);
    state.schedules = state.schedules.filter((x) => x.id !== id);
    // Tonight keeps playing what it has; the segment just loses its link.
    for (const seg of state.tonight.segments) {
      if (seg.scheduleId === id) seg.scheduleId = null;
    }
    save();
    return s;
  }

  function resetProgress(id) {
    const s = must(id);
    s.watched = [];
    s.start = 0;
    s.updatedAt = now();
    save();
    return s;
  }

  function duplicate(id) {
    const s = must(id);
    return create({ name: `${s.name} (copy)`, items: s.items, start: s.start, autoStart: null, breaks: s.breaks, watched: s.watched });
  }

  // ---- tonight -----------------------------------------------------------
  function segmentFrom(schedule, { startAt = null, fromStart = false } = {}) {
    const start = fromStart ? 0 : Math.min(schedule.start, schedule.items.length);
    return {
      key: uid(),
      scheduleId: schedule.id,
      name: schedule.name,
      startAt,
      items: schedule.items.map((it, idx) => ({
        ...it,
        key: uid(),
        idx,
        state: idx < start ? 'past' : 'upcoming',
        watched: schedule.watched.includes(idx),
        startAt: null, breakOffline: false, breakBefore: null,
      })),
    };
  }

  const finished = (s) => s.items.length > 0 && s.start >= s.items.length;
  /** A finished schedule starts over when it is set to, or when asked. */
  function readyToPlay(s, opts = {}) {
    if (finished(s) && (opts.restart || s.atEnd === 'restart' || s.atEnd === 'loop')) { s.watched = []; s.start = 0; s.updatedAt = now(); }
  }

  function load(id, opts = {}) {
    const s = must(id);
    readyToPlay(s, opts);
    state.tonight.segments = [segmentFrom(s, opts)];
    save();
    return state.tonight;
  }

  function append(id, opts = {}) {
    const s = must(id);
    readyToPlay(s, opts);
    state.tonight.segments.push(segmentFrom(s, opts));
    save();
    return state.tonight;
  }

  function addItems(items, { name = 'Added from the library' } = {}) {
    const list = (items ?? []).map(pickItem).map((it) => ({
      ...it, key: uid(), idx: null, state: 'upcoming', watched: false,
      startAt: null, breakOffline: false, breakBefore: null,
    }));
    if (!list.length) return state.tonight;
    let seg = state.tonight.segments[state.tonight.segments.length - 1];
    if (!seg || seg.scheduleId) {
      seg = { key: uid(), scheduleId: null, name, startAt: null, items: [] };
      state.tonight.segments.push(seg);
    }
    seg.items.push(...list);
    // Named after what it holds while that is one show; mixed content
    // keeps the generic name.
    const shows = new Set(seg.items.map((it) => it.series ?? it.title));
    seg.name = shows.size === 1 ? [...shows][0] : name;
    save();
    return state.tonight;
  }

  const findItem = (key) => {
    for (const seg of state.tonight.segments) {
      const i = seg.items.findIndex((it) => it.key === key);
      if (i >= 0) return { seg, i, item: seg.items[i] };
    }
    return null;
  };
  const findSeg = (key) => state.tonight.segments.find((s) => s.key === key) ?? null;

  /**
   * Reorder: segments in the given order, and within each the UPCOMING
   * items in the given order of keys. Only upcoming items move, and only
   * among the slots upcoming items occupy — what aired, what is on air and
   * what lies before the start marker keep their places, so a drop can
   * never push the watched episodes to the end of the segment.
   */
  function reorder(order) {
    // order: [{ seg: key, items: [itemKey, ...] }, ...]
    const segs = [];
    for (const o of order ?? []) {
      const seg = findSeg(o.seg);
      if (!seg) continue;
      const slots = seg.items.map((it, i) => (it.state === 'upcoming' ? i : -1)).filter((i) => i >= 0);
      const wanted = [...new Set(o.items ?? [])]
        .map((k) => seg.items.find((it) => it.key === k && it.state === 'upcoming'))
        .filter(Boolean);
      const rest = seg.items.filter((it) => it.state === 'upcoming' && !wanted.includes(it));
      const ordered = [...wanted, ...rest];
      const next = [...seg.items];
      slots.forEach((slot, j) => { next[slot] = ordered[j]; });
      seg.items = next;
      segs.push(seg);
    }
    for (const seg of state.tonight.segments) if (!segs.includes(seg)) segs.push(seg);
    state.tonight.segments = segs;
    save();
    return state.tonight;
  }

  function moveItem(key, delta) {
    const f = findItem(key);
    if (!f) return state.tonight;
    const j = f.i + (delta < 0 ? -1 : 1);
    if (j < 0 || j >= f.seg.items.length) return state.tonight;
    // Only upcoming swaps with upcoming: nothing crosses the start marker
    // or what already aired.
    if (f.item.state !== 'upcoming' || f.seg.items[j].state !== 'upcoming') return state.tonight;
    [f.seg.items[f.i], f.seg.items[j]] = [f.seg.items[j], f.seg.items[f.i]];
    save();
    return state.tonight;
  }

  function moveSegment(key, delta) {
    const i = state.tonight.segments.findIndex((s) => s.key === key);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= state.tonight.segments.length) return state.tonight;
    const segs = state.tonight.segments;
    [segs[i], segs[j]] = [segs[j], segs[i]];
    save();
    return state.tonight;
  }

  function removeItem(key) {
    const f = findItem(key);
    if (!f) return state.tonight;
    f.seg.items.splice(f.i, 1);
    if (!f.seg.items.length) state.tonight.segments = state.tonight.segments.filter((s) => s !== f.seg);
    save();
    return state.tonight;
  }

  function removeSegment(key) {
    state.tonight.segments = state.tonight.segments.filter((s) => s.key !== key);
    save();
    return state.tonight;
  }

  function setItem(key, patch = {}) {
    const f = findItem(key);
    if (!f) return state.tonight;
    if ('startAt' in patch) f.item.startAt = Number(patch.startAt) || null;
    if ('breakOffline' in patch) f.item.breakOffline = Boolean(patch.breakOffline);
    if ('breakBefore' in patch) f.item.breakBefore = Number(patch.breakBefore) > 0 ? Math.round(Number(patch.breakBefore)) : null;
    save();
    return state.tonight;
  }

  /**
   * Move a segment's start marker: everything before it is "past" (shown,
   * not played), everything from it on is upcoming. Aired and on-air items
   * are left alone.
   */
  function setSegmentStart(key, index) {
    const seg = findSeg(key);
    if (!seg) return state.tonight;
    const idx = clampInt(index, 0, seg.items.length, 0);
    seg.items.forEach((it, i) => {
      if (it.state === 'past' || it.state === 'upcoming') it.state = i < idx ? 'past' : 'upcoming';
    });
    if (seg.scheduleId) {
      const s = get(seg.scheduleId);
      if (s && seg.items[idx]?.idx != null) { s.start = seg.items[idx].idx; s.updatedAt = now(); }
    }
    save();
    return state.tonight;
  }

  function setSegment(key, patch = {}) {
    const seg = findSeg(key);
    if (!seg) return state.tonight;
    if ('startAt' in patch) seg.startAt = Number(patch.startAt) || null;
    if (patch.name != null) seg.name = String(patch.name).slice(0, 80);
    save();
    return state.tonight;
  }

  function clearTonight() {
    state.tonight = { segments: [] };
    save();
    return state.tonight;
  }

  /** Save tonight (its upcoming and past items, in order) as a schedule. */
  function saveTonightAs(name) {
    const items = [];
    let start = 0;
    for (const seg of state.tonight.segments) {
      for (const it of seg.items) {
        if (it.state === 'past' || it.state === 'aired' || it.state === 'skipped') start = items.length + 1;
        items.push(it);
      }
    }
    return create({ name, items, start: Math.min(start, items.length) });
  }

  /**
   * What the engine should play next, in order: every upcoming item with
   * its pin and break. The first upcoming item of a pinned segment takes
   * the segment's pin. Auto-breaks come from the schedule's own rule or
   * the global one, counted across tonight so a break never lands on the
   * first item.
   */
  function upcomingEntries() {
    const out = [];
    let sinceBreak = 0;
    for (const seg of state.tonight.segments) {
      const s = seg.scheduleId ? get(seg.scheduleId) : null;
      const rule = s?.breaks && s.breaks !== 'global'
        ? (s.breaks === 'none' ? null : s.breaks)
        : (state.settings.breakEvery > 0 ? { every: state.settings.breakEvery, minutes: state.settings.breakMinutes } : null);
      let first = true;
      for (const it of seg.items) {
        if (it.state !== 'upcoming') continue;
        const e = {
          id: it.id,
          seg: { seg: seg.key, item: it.key, scheduleId: seg.scheduleId, idx: it.idx },
          startAt: it.startAt ?? (first ? seg.startAt : null),
          breakOffline: it.breakOffline || (first && seg.startAt ? Boolean(state.settings.breakOffline) : false),
          breakBefore: it.breakBefore,
        };
        if (!e.startAt && !e.breakBefore && rule && out.length > 0 && sinceBreak >= rule.every) {
          e.breakBefore = rule.minutes * 60;
          e.breakOffline = Boolean(state.settings.breakOffline);
        }
        if (e.breakBefore || e.startAt) sinceBreak = 0;
        sinceBreak += 1;
        first = false;
        out.push(e);
      }
    }
    return out;
  }

  // ---- what happened -----------------------------------------------------
  function onAir(itemKey) {
    for (const seg of state.tonight.segments) {
      for (const it of seg.items) {
        if (it.state === 'onair' && it.key !== itemKey) it.state = 'upcoming';
        if (it.key === itemKey) it.state = 'onair';
      }
    }
    save();
  }

  /**
   * An item finished on air. `seg` is the engine item's tag (or null for a
   * play that never went through tonight); `info` describes the item.
   * Aired items advance their schedule's memory; skipped ones do not.
   */
  function settle(seg, info) {
    const outcome = info.outcome === 'aired' ? 'aired' : 'skipped';
    let scheduleName = null;
    if (seg?.item) {
      const f = findItem(seg.item);
      if (f) f.item.state = outcome;
    }
    if (seg?.scheduleId) {
      const s = get(seg.scheduleId);
      if (s) {
        scheduleName = s.name;
        s.lastRunAt = now();
        // A measured length is worth keeping: the next load projects with it.
        if (seg.idx != null && s.items[seg.idx]?.id === info.id && s.items[seg.idx].duration == null && info.duration > 0) {
          s.items[seg.idx].duration = info.duration;
        }
        if (outcome === 'aired' && seg.idx != null && s.items[seg.idx]?.id === info.id) {
          if (!s.watched.includes(seg.idx)) s.watched.push(seg.idx);
          s.watched.sort((a, b) => a - b);
          if (seg.idx >= s.start) s.start = Math.min(seg.idx + 1, s.items.length);
        }
      }
    } else if (seg?.seg) {
      scheduleName = findSeg(seg.seg)?.name ?? null;
    }
    state.history.unshift({
      at: now(), id: info.id, title: info.title ?? '', series: info.series ?? null,
      schedule: scheduleName, outcome, seconds: Math.round(info.seconds ?? 0),
      duration: info.duration ?? null,
    });
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    save();
  }

  /**
   * The broadcast stopped under an item that had barely started: it goes
   * back to upcoming, as if it had not played, and history says nothing.
   * A skip is different — the broadcast went on without it.
   */
  function release(seg) {
    const f = seg?.item ? findItem(seg.item) : null;
    if (f && f.item.state === 'onair') { f.item.state = 'upcoming'; save(); }
  }

  function broadcastEnded() {
    let changed = false;
    for (const seg of state.tonight.segments) {
      for (const it of seg.items) if (it.state === 'onair') { it.state = 'upcoming'; changed = true; }
    }
    if (changed) save();
  }

  function clearHistory() { state.history = []; save(); }

  // ---- auto-start --------------------------------------------------------
  /**
   * Schedules whose start is within their countdown lead, each returned
   * once per occurrence. The caller decides how to go live.
   */
  function dueAutoStarts(nowMs = now()) {
    const due = [];
    for (const s of state.schedules) {
      const at = nextRun(s, nowMs);
      if (at == null) continue;
      const lead = (s.autoStart.countdownMin ?? 0) * 60;
      const key = String(at);
      if (at * 1000 - nowMs <= lead * 1000 + 500 && s.autoStart.firedKey !== key) {
        s.autoStart.firedKey = key;
        // Played through and set to stop: this occurrence is skipped, once,
        // and the caller says so. 'restart' schedules start over on load.
        due.push({ schedule: s, at, skipped: finished(s) && s.atEnd === 'stop' });
      }
    }
    if (due.length) save();
    return due;
  }

  function setSettings(patch = {}) {
    const st = state.settings;
    if ('breakEvery' in patch) st.breakEvery = clampInt(patch.breakEvery, 0, 99, st.breakEvery);
    if ('breakMinutes' in patch) st.breakMinutes = clampInt(patch.breakMinutes, 1, 180, st.breakMinutes);
    if ('breakOffline' in patch) st.breakOffline = Boolean(patch.breakOffline);
    if ('dnd' in patch) st.dnd = patch.dnd !== false;
    if ('watchedAt' in patch) {
      const v = Number(patch.watchedAt);
      if (Number.isFinite(v)) st.watchedAt = Math.min(1, Math.max(0.05, v));
    }
    save();
    return st;
  }

  return {
    // reads
    state: () => state,
    list: () => state.schedules,
    get,
    finished: (id) => finished(must(id)),
    tonight: () => state.tonight,
    history: () => state.history,
    settings: () => state.settings,
    nextRun: (id, nowMs) => nextRun(must(id), nowMs),
    upcomingEntries,
    // schedules
    create, update, remove, resetProgress, duplicate,
    // tonight
    load, append, addItems, reorder, moveItem, moveSegment, removeItem, removeSegment,
    setItem, setSegment, setSegmentStart, clearTonight, saveTonightAs,
    // what happened
    onAir, settle, release, broadcastEnded, clearHistory,
    // automation + settings
    dueAutoStarts, setSettings,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
