import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createScheduleStore, nextRun, HISTORY_MAX, buildQueue } from '../src/schedules.js';
// Server-side fixes (publish redaction, library artwork) ride along here so
// `npm test` covers them without a package.json change.
import './server-fixes.test.mjs';

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

test('a finished schedule: stop by default, start over when set to or asked', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(2), watched: [0, 1], start: 2 });
  assert.equal(st.finished(s.id), true);
  st.load(s.id);
  assert.equal(st.upcomingEntries().length, 0, 'default: nothing lined up');
  st.load(s.id, { restart: true });
  assert.equal(st.upcomingEntries().length, 2, 'asked to start over');
  assert.equal(st.get(s.id).start, 0);
  assert.deepEqual(st.get(s.id).watched, []);
  const r = st.create({ name: 'R', items: eps(2), watched: [0, 1], start: 2, atEnd: 'restart' });
  st.load(r.id);
  assert.equal(st.upcomingEntries().length, 2, "set to 'restart': starts over by itself");
});

test('auto-start skips a finished schedule set to stop, and runs one set to restart', () => {
  const st = createScheduleStore({ now });
  const base = new Date(2026, 8, 4, 19, 50).getTime();   // Friday 19:50
  const a = st.create({ name: 'Stop', items: eps(1), watched: [0], start: 1, autoStart: { time: '20:00', days: [5], countdownMin: 15 } });
  const b = st.create({ name: 'Loop', items: eps(1), watched: [0], start: 1, atEnd: 'restart', autoStart: { time: '20:00', days: [5], countdownMin: 15 } });
  const due = st.dueAutoStarts(base);
  assert.deepEqual(due.map((d) => [d.schedule.name, d.skipped]), [['Stop', true], ['Loop', false]]);
  st.load(b.id);
  assert.equal(st.upcomingEntries().length, 1);
  assert.equal(st.dueAutoStarts(base + 60_000).length, 0, 'each occurrence once, skipped or not');
});

test('a loop pass appends from the first item without touching the schedule memory', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'L', items: eps(2), watched: [0], start: 1, atEnd: 'loop' });
  st.load(s.id);
  assert.equal(st.upcomingEntries().length, 1, 'plays on from the marker');
  st.append(s.id, { fromStart: true });
  assert.equal(st.upcomingEntries().length, 3, 'a whole pass follows');
  assert.equal(st.get(s.id).start, 1, 'memory untouched');
  assert.deepEqual(st.get(s.id).watched, [0]);
  // Finished and looping: load starts over by itself, and auto-start is not skipped.
  st.update(s.id, { watched: [0, 1], start: 2 });
  st.load(s.id);
  assert.equal(st.upcomingEntries().length, 2);
});

// ---- server review fixes ----------------------------------------------------

test('auto-start with no countdown fires on the first 30 s tick at or after its minute, once', () => {
  for (const offsetSec of [0, 1, 17]) {
    let t = new Date(2026, 8, 4, 12, 0, offsetSec).getTime(); // Friday, ticks at :00/:30 (+offset)
    const st = createScheduleStore({ now: () => t });
    st.create({ name: 'A', items: eps(2), autoStart: { time: '12:05', days: [5], countdownMin: 0 } });
    let fired = 0;
    for (let k = 0; k < 40; k++) { t += 30_000; if (st.dueAutoStarts(t).length) fired += 1; }
    assert.equal(fired, 1, `ticks offset by ${offsetSec}s`);
  }
  // Bounded lateness: a run a few minutes old still fires, a stale one does not.
  const at = new Date(2026, 8, 4, 12, 5).getTime();
  const st = createScheduleStore({ now });
  st.create({ name: 'B', items: eps(1), autoStart: { time: '12:05', days: [5], countdownMin: 0 } });
  assert.equal(st.dueAutoStarts(at + 4 * 60_000).length, 1, 'four minutes late still fires');
  const st2 = createScheduleStore({ now });
  st2.create({ name: 'C', items: eps(1), autoStart: { time: '12:05', days: [5], countdownMin: 0 } });
  assert.equal(st2.dueAutoStarts(at + 20 * 60_000).length, 0, 'twenty minutes late is next week');
  assert.equal(nextRun({ autoStart: { time: '12:05', days: [5], enabled: true } }, at + 60_000) > at / 1000 + 60, true, 'nextRun itself still looks forward');
});

test('saving an auto-start block without firedKey keeps the memory of having fired', () => {
  let t = new Date(2026, 8, 4, 19, 46).getTime();
  const st = createScheduleStore({ now: () => t });
  const s = st.create({ name: 'A', items: eps(2), autoStart: { time: '20:00', days: [5], countdownMin: 15 } });
  assert.equal(st.dueAutoStarts(t).length, 1);
  // What the panel sends on Save: the same time and days, no firedKey.
  st.update(s.id, { name: 'A', autoStart: { time: '20:00', days: [5], date: null, countdownMin: 10, enabled: true } });
  t += 30_000;
  assert.equal(st.dueAutoStarts(t).length, 0, 'an edit during the countdown does not fire again');
  assert.equal(st.get(s.id).autoStart.countdownMin, 10, 'the edit itself took');
  // A different time is a different occurrence: it may fire.
  st.update(s.id, { autoStart: { time: '20:01', days: [5], countdownMin: 15 } });
  assert.equal(st.get(s.id).autoStart.firedKey, null);
});

test('the start marker follows the item id, not the idx cached in tonight', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(3) });
  st.load(s.id);
  st.update(s.id, { items: [...eps(3)].reverse() }); // schedule now [3,2,1]; tonight still [1,2,3]
  const seg = st.tonight().segments[0];
  st.setSegmentStart(seg.key, 2);
  const u = st.get(s.id);
  assert.equal(u.items[u.start].id, 'jjk-3');
  st.setSegmentStart(seg.key, 3);
  assert.equal(st.get(s.id).start, 3, 'past the end means finished');
});

test('save tonight puts the marker on the first upcoming item in the saved order', () => {
  const st = createScheduleStore({ now });
  const a = st.create({ name: 'A', items: eps(1) });
  st.load(a.id);
  st.addItems([ep(9)]);
  const segs = st.tonight().segments;
  st.settle({ seg: segs[0].key, item: segs[0].items[0].key, scheduleId: a.id, idx: 0 }, { id: 'jjk-1', outcome: 'aired', seconds: 900, duration: 1000 });
  st.moveSegment(segs[1].key, -1); // upcoming E9 now above aired E1
  const n = st.saveTonightAs('Saved');
  assert.deepEqual(n.items.map((i) => i.id), ['jjk-9', 'jjk-1']);
  assert.equal(n.start, 0);
  assert.deepEqual(n.watched, [1], 'what aired is remembered');
  assert.equal(st.finished(n.id), false);
});

test('duplicate copies the when-finished setting', () => {
  const st = createScheduleStore({ now });
  const s = st.create({ name: 'A', items: eps(2), atEnd: 'loop', breaks: 'none' });
  const d = st.duplicate(s.id);
  assert.equal(d.atEnd, 'loop');
  assert.equal(d.breaks, 'none');
});

test('validation: items need ids, auto-start times and weekdays must be real, pins and breaks plausible', () => {
  const st = createScheduleStore({ now });
  const is400 = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));
  is400(() => st.create({ name: 'R', items: [{}] }), /needs an id/);
  is400(() => st.create({ name: 'R', items: [{ id: { a: 1 } }] }), /needs an id/);
  is400(() => st.addItems([{ title: 'x' }]), /needs an id/);
  assert.equal(st.list().length, 0, 'nothing stored');
  is400(() => st.create({ name: 'A', items: eps(1), autoStart: { time: '99:99', days: [5] } }), /Invalid auto-start time/);
  is400(() => st.create({ name: 'A', items: eps(1), autoStart: { time: '20:00', days: [7, 12] } }), /weekday/);
  is400(() => st.create({ name: 'A', items: eps(1), autoStart: { time: '20:00', days: 'fri' } }), /weekdays/);
  is400(() => st.create({ name: 'A', items: eps(1), autoStart: { time: '20:00', date: '2026/09/05' } }), /date/);
  const ok = st.create({ name: 'A', items: eps(1), autoStart: { time: '23:59', days: [0, 6] } });
  assert.deepEqual(ok.autoStart.days, [0, 6]);
  assert.equal(st.create({ name: 'B', items: eps(1), autoStart: { time: '', days: [1] } }).autoStart, null, 'no time = no auto-start');
  is400(() => st.update(ok.id, { autoStart: { time: '24:00', days: [1] } }), /Invalid auto-start time/);
  assert.equal(st.get(ok.id).autoStart.time, '23:59', 'a refused patch changes nothing');

  st.addItems(eps(2));
  const key = st.tonight().segments[0].items[0].key;
  is400(() => st.setItem(key, { startAt: -1 }), /startAt/);
  is400(() => st.setItem(key, { startAt: 1_800_000_000_000 }), /startAt/); // milliseconds
  is400(() => st.setItem(key, { breakBefore: 99_999_999 }), /breakBefore/);
  is400(() => st.setItem(key, { breakBefore: -5 }), /breakBefore/);
  is400(() => st.setItem(key, { startAt: 1_800_000_000, breakBefore: -5 }), /breakBefore/);
  const it = () => st.tonight().segments[0].items[0];
  assert.equal(it().startAt, null, 'a refused patch applied nothing');
  st.setItem(key, { startAt: 1_800_000_000, breakBefore: 300 });
  assert.equal(it().startAt, 1_800_000_000); assert.equal(it().breakBefore, 300);
  st.setItem(key, { startAt: null, breakBefore: 0 });
  assert.equal(it().startAt, null); assert.equal(it().breakBefore, null);
  const segKey = st.tonight().segments[0].key;
  is400(() => st.setSegment(segKey, { startAt: -1 }), /startAt/);
  is400(() => st.load(ok.id, { startAt: 5 }), /startAt/);
  assert.equal(st.tonight().segments[0].key, segKey, 'a refused load leaves tonight alone');
  is400(() => st.append(ok.id, { startAt: 'soon' }), /startAt/);
});

test('reorder checks the whole order before touching anything', () => {
  const st = createScheduleStore({ now });
  st.addItems(eps(3));
  const a = st.create({ name: 'B', items: eps(2, 'CSM') });
  st.append(a.id);
  const [s1, s2] = st.tonight().segments;
  const before = s1.items.map((i) => i.id);
  assert.throws(() => st.reorder([
    { seg: s1.key, items: [s1.items[2].key, s1.items[0].key, s1.items[1].key] },
    { seg: s2.key, items: 5 },
  ]), (e) => e.status === 400);
  assert.deepEqual(st.tonight().segments[0].items.map((i) => i.id), before, 'nothing moved');
  assert.throws(() => st.reorder('nope'), (e) => e.status === 400);
  assert.throws(() => st.reorder([{ seg: s1.key, items: [1] }]), (e) => e.status === 400);
  st.reorder([{ seg: s1.key, items: [s1.items[2].key] }]);
  assert.deepEqual(st.tonight().segments[0].items.map((i) => i.id), ['jjk-3', 'jjk-1', 'jjk-2'], 'a good order applies');
});

test('an auto-start of a schedule already lined up pins it instead of appending a copy', () => {
  let t = new Date(2026, 8, 4, 19, 46).getTime();
  const st = createScheduleStore({ now: () => t });
  const s = st.create({ name: 'A', items: eps(3), autoStart: { time: '20:00', days: [5], countdownMin: 15 } });
  st.load(s.id); // lined up by hand
  const due = st.dueAutoStarts(t);
  assert.equal(due.length, 1);
  assert.equal(due[0].linedUp, st.tonight().segments[0].key);
  assert.equal(st.tonight().segments[0].startAt, due[0].at, 'the segment took the pin');
  // What the server did before: a pinned append. Deduplicated in the store too.
  st.append(s.id, { startAt: due[0].at });
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-1', 'jjk-2', 'jjk-3']);
  assert.equal(st.upcomingEntries()[0].startAt, due[0].at);
  // An unpinned append is a deliberate second pass and still adds.
  st.append(s.id);
  assert.equal(st.upcomingEntries().length, 6);
  // Once something of it has aired it is no longer "lined up": a pinned
  // append (a later occurrence) adds a fresh pass.
  const st2 = createScheduleStore({ now: () => t });
  const s2 = st2.create({ name: 'B', items: eps(2) });
  st2.load(s2.id);
  const seg = st2.tonight().segments[0];
  st2.onAir(seg.items[0].key);
  st2.append(s2.id, { startAt: 1_800_000_000 });
  assert.equal(st2.tonight().segments.length, 2);
  assert.equal(st2.linedUp(s2.id).key, st2.tonight().segments[1].key, 'the fresh pass is the one lined up now');
});

test('a tonight item the library lost is marked skipped and leaves the queue', () => {
  const st = createScheduleStore({ now });
  st.addItems(eps(3));
  const seg = st.tonight().segments[0];
  st.markMissing(seg.items[1].key, 'Unknown item');
  assert.deepEqual(st.upcomingEntries().map((e) => e.id), ['jjk-1', 'jjk-3']);
  assert.equal(seg.items[1].state, 'skipped');
  assert.equal(seg.items[1].missing, 'Unknown item');
  st.onAir(seg.items[0].key);
  st.markMissing(seg.items[0].key);
  assert.equal(seg.items[0].state, 'onair', 'only upcoming items are taken out');
});

test('buildQueue leaves out what cannot be built and reports it, keeping pins and extras', async () => {
  const entries = [
    { id: 'a', seg: { item: 'k1' }, startAt: 1_800_000_000, breakOffline: true, breakBefore: null },
    { id: 'gone', seg: { item: 'k2' }, startAt: null, breakOffline: false, breakBefore: null },
    { id: 'b', seg: { item: 'k3' }, startAt: null, breakOffline: false, breakBefore: 120 },
  ];
  const missing = [];
  const items = await buildQueue(entries, {
    build: async (e) => {
      if (e.id === 'gone') throw new Error('Unknown item');
      return { id: e.id, srcPath: `/x/${e.id}`, startAt: 1, seg: 'stale', at: 5 };
    },
    decorate: (e) => (e.breakBefore ? { breakBefore: e.breakBefore, seg: e.seg } : { seg: e.seg }),
    onMissing: (e, err) => missing.push(`${e.id}: ${err.message}`),
  });
  assert.deepEqual(missing, ['gone: Unknown item']);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
  assert.equal(items[0].startAt, 1_800_000_000); assert.equal(items[0].breakOffline, true);
  assert.equal(items[0].at, undefined, 'stale projections are dropped');
  assert.deepEqual(items[0].seg, { item: 'k1' });
  assert.equal(items[1].breakBefore, 120); assert.equal(items[1].startAt, undefined);
});
