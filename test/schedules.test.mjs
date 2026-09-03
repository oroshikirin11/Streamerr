import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createScheduleStore, nextRun, HISTORY_MAX } from '../src/schedules.js';

const ep = (n, series = 'JJK') => ({ id: `${series.toLowerCase()}-${n}`, title: `${series} — S1E${n}`, series, season: 1, episode: n, duration: 1420, image: null });
const eps = (n, series) => Array.from({ length: n }, (_, i) => ep(i + 1, series));
let clock = 1_800_000_000_000;
const now = () => clock;

test('create, update, reorder keeps progress on the item, delete unlinks tonight', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: '  Friday anime night ', items: eps(5) });
  assert.equal(s.name, 'Friday anime night');
  assert.equal(s.start, 0);
  st.update(s.id, { watched: [0, 1], start: 2 });
  // Reverse the order: E2 and E1 are still the watched ones, start follows E3.
  st.update(s.id, { items: [...eps(5)].reverse() });
  const u = st.get(s.id);
  assert.deepEqual(u.watched.map((i) => u.items[i].id), ['jjk-2', 'jjk-1']);
  assert.equal(u.items[u.start].id, 'jjk-3');
  st.load(s.id);
  st.remove(s.id);
  assert.equal(st.list().length, 0);
  assert.equal(st.tonight().segments[0].scheduleId, null, 'tonight keeps playing, unlinked');
  assert.throws(() => st.update('nope', {}), /No such schedule/);
});

test('load marks watched-before items as past and plays from the start marker', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(4), watched: [0, 1], start: 2 });
  st.load(s.id);
  const seg = st.tonight().segments[0];
  assert.deepEqual(seg.items.map((i) => i.state), ['past', 'past', 'upcoming', 'upcoming']);
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-3', 'jjk-4']);
  assert.deepEqual(st.upcomingEntries()[0].seg, { seg: seg.key, item: seg.items[2].key, scheduleId: s.id, idx: 2 });
});

test('the start marker moves in tonight and writes back to the schedule', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(4), start: 2 });
  st.load(s.id);
  const seg = st.tonight().segments[0];
  st.setSegmentStart(seg.key, 0);
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-1', 'jjk-2', 'jjk-3', 'jjk-4']);
  assert.equal(st.get(s.id).start, 0);
  st.setSegmentStart(seg.key, 3);
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-4']);
  assert.equal(st.get(s.id).start, 3);
});

test('append after a loaded schedule, with a pin on the segment', () => {
  const st = createScheduleStore({ now });
  const a = st.create({ name: 'A', items: eps(2) });
  const b = st.create({ name: 'B', items: eps(2, 'Robot') });
  st.load(a.id);
  st.append(b.id, { startAt: 1_800_000_900 });
  const ents = st.upcomingEntries();
  assert.deepEqual(ents.map((e) => e.id), ['jjk-1', 'jjk-2', 'robot-1', 'robot-2']);
  assert.equal(ents[2].startAt, 1_800_000_900, 'the pin lands on the first upcoming item of the segment');
  assert.equal(ents[3].startAt, null);
});

test('airing advances the schedule; skipping does not; history records both', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(3) });
  st.load(s.id);
  const [e1, e2] = st.upcomingEntries();
  st.onAir(e1.seg.item);
  assert.equal(st.tonight().segments[0].items[0].state, 'onair');
  st.settle(e1.seg, { id: e1.id, title: 'JJK — S1E1', series: 'JJK', outcome: 'aired', seconds: 1400 });
  assert.deepEqual(st.get(s.id).watched, [0]);
  assert.equal(st.get(s.id).start, 1);
  assert.equal(st.tonight().segments[0].items[0].state, 'aired');
  st.settle(e2.seg, { id: e2.id, title: 'JJK — S1E2', series: 'JJK', outcome: 'skipped', seconds: 30 });
  assert.deepEqual(st.get(s.id).watched, [0]);
  assert.equal(st.get(s.id).start, 1, 'a skip leaves the marker where it was');
  assert.equal(st.tonight().segments[0].items[1].state, 'skipped');
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-3']);
  assert.deepEqual(st.history().map((h) => [h.outcome, h.schedule]), [['skipped', 'A'], ['aired', 'A']]);
  // An ad-hoc play with no tag still lands in history.
  st.settle(null, { id: 'x', title: 'A Film', outcome: 'aired', seconds: 5000 });
  assert.equal(st.history()[0].schedule, null);
});

test('history is capped and clearable', () => {
  const st = createScheduleStore({ now });
  for (let i = 0; i < HISTORY_MAX + 20; i++) st.settle(null, { id: `i${i}`, title: `t${i}`, outcome: 'aired' });
  assert.equal(st.history().length, HISTORY_MAX);
  assert.equal(st.history()[0].id, `i${HISTORY_MAX + 19}`, 'newest first');
  st.clearHistory();
  assert.equal(st.history().length, 0);
});

test('auto breaks: every N episodes, never before the first, pins reset the count', () => {
  const st = createScheduleStore({ now });
  st.setSettings({ breakEvery: 2, breakMinutes: 5 });
  const s = st.create({ name: 'A', items: eps(6) });
  st.load(s.id);
  const ents = st.upcomingEntries();
  assert.deepEqual(ents.map((e) => e.breakBefore ?? 0), [0, 0, 300, 0, 300, 0]);
  // A schedule with its own rule ignores the global one; 'none' has no breaks.
  st.update(s.id, { breaks: 'none' });
  st.load(s.id);
  assert.ok(st.upcomingEntries().every((e) => !e.breakBefore));
  st.update(s.id, { breaks: { every: 1, minutes: 2 } });
  st.load(s.id);
  assert.deepEqual(st.upcomingEntries().map((e) => e.breakBefore ?? 0), [0, 120, 120, 120, 120, 120]);
});

test('ad-hoc items join tonight as their own segment; move, remove, clear', () => {
  const st = createScheduleStore({ now });
  st.addItems([ep(1, 'Film'), ep(2, 'Film')]);
  st.addItems([ep(3, 'Film')]);
  assert.equal(st.tonight().segments.length, 1, 'consecutive ad-hoc adds share a segment');
  const seg = st.tonight().segments[0];
  st.moveItem(seg.items[2].key, -1);
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['film-1', 'film-3', 'film-2']);
  st.removeItem(seg.items[0].key);
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['film-3', 'film-2']);
  st.clearTonight();
  assert.equal(st.tonight().segments.length, 0);
});

test('save tonight as a schedule keeps order and puts the marker after what aired', () => {
  const st = createScheduleStore({ now });
  st.addItems(eps(3));
  const seg = st.tonight().segments[0];
  st.settle({ seg: seg.key, item: seg.items[0].key, scheduleId: null, idx: null }, { id: 'jjk-1', outcome: 'aired' });
  const s = st.saveTonightAs('Kept');
  assert.equal(s.items.length, 3);
  assert.equal(s.start, 1);
});

test('nextRun: weekly and one-shot, local time', () => {
  const base = new Date(2026, 8, 3, 18, 0).getTime();   // Thursday 18:00
  const weekly = { autoStart: { time: '20:00', days: [5], date: null, countdownMin: 15, enabled: true } };
  const at = nextRun(weekly, base);
  const d = new Date(at * 1000);
  assert.equal(d.getDay(), 5); assert.equal(d.getHours(), 20); assert.equal(d.getDate(), 4);
  const today = { autoStart: { time: '19:00', days: [4], date: null, countdownMin: 15, enabled: true } };
  assert.equal(new Date(nextRun(today, base) * 1000).getDate(), 3, 'later today counts');
  const passed = { autoStart: { time: '17:00', days: [4], date: null, countdownMin: 15, enabled: true } };
  assert.equal(new Date(nextRun(passed, base) * 1000).getDate(), 10, 'earlier today rolls a week');
  const once = { autoStart: { time: '21:30', days: [], date: '2026-09-05', countdownMin: 5, enabled: true } };
  assert.equal(new Date(nextRun(once, base) * 1000).getDate(), 5);
  assert.equal(nextRun({ autoStart: { time: '21:30', days: [], date: '2026-09-01', enabled: true } }, base), null);
  assert.equal(nextRun({ autoStart: null }, base), null);
});

test('dueAutoStarts fires once per occurrence, inside the countdown lead', () => {
  const st = createScheduleStore({ now });
  const base = new Date(2026, 8, 4, 19, 40).getTime();   // Friday 19:40
  const s = st.create({ name: 'A', items: eps(2), autoStart: { time: '20:00', days: [5], countdownMin: 15 } });
  assert.equal(st.dueAutoStarts(base).length, 0, 'twenty minutes out is too early for a 15-minute lead');
  const due = st.dueAutoStarts(base + 6 * 60_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].schedule.id, s.id);
  assert.equal(new Date(due[0].at * 1000).getHours(), 20);
  assert.equal(st.dueAutoStarts(base + 7 * 60_000).length, 0, 'not twice');
  assert.equal(st.dueAutoStarts(base + 7 * 24 * 3_600_000 + 15 * 60_000).length, 1, 'next week again');
});

test('persists atomically and reloads, dropping a stale on-air state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const path = join(dir, 'schedules.json');
  const st = createScheduleStore({ path, now });
  const s = st.create({ name: 'A', items: eps(2) });
  st.load(s.id);
  st.onAir(st.tonight().segments[0].items[0].key);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(`${path}.tmp`));
  const again = createScheduleStore({ path, now });
  assert.equal(again.get(s.id).name, 'A');
  assert.equal(again.tonight().segments[0].items[0].state, 'upcoming');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('reordering rows moves only upcoming items among upcoming slots', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(6), watched: [0, 1], start: 2 });
  st.load(s.id);
  const seg = st.tonight().segments[0];
  const up = seg.items.filter((i) => i.state === 'upcoming').map((i) => i.key);
  // Drop the last upcoming row at the top, and hand over the past keys too, as a client might.
  st.reorder([{ seg: seg.key, items: [seg.items[0].key, up[3], up[0], up[1], up[2]] }]);
  const after = st.tonight().segments[0].items;
  assert.deepEqual(after.map((i) => i.state), ['past', 'past', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(after.map((i) => i.id), ['jjk-1', 'jjk-2', 'jjk-6', 'jjk-3', 'jjk-4', 'jjk-5']);
  // The arrows cannot cross the marker either.
  st.moveItem(after[2].key, -1);
  assert.deepEqual(st.tonight().segments[0].items.map((i) => i.id), ['jjk-1', 'jjk-2', 'jjk-6', 'jjk-3', 'jjk-4', 'jjk-5']);
  st.moveItem(after[2].key, 1);
  assert.deepEqual(st.tonight().segments[0].items.map((i) => i.id), ['jjk-1', 'jjk-2', 'jjk-3', 'jjk-6', 'jjk-4', 'jjk-5']);
});

test('a stop under a barely-started item releases it: upcoming again, no history', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(2) });
  st.load(s.id);
  const [e1] = st.upcomingEntries();
  st.onAir(e1.seg.item);
  st.release(e1.seg);
  assert.equal(st.tonight().segments[0].items[0].state, 'upcoming');
  assert.equal(st.history().length, 0);
  assert.equal(st.get(s.id).start, 0);
});
