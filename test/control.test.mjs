/**
 * The viewer control channel (Streamingestarr pause vote), sender side:
 * the frame handler against a fake engine, every refusal reason, the
 * state frame, the dial URL, and the client's socket lifecycle with a
 * fake WebSocket.
 *
 * Run: node --test test/control.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  handleControlFrame, refusalFor, stateFrame, controlUrl, redactToken, pendingOf,
  ControlClient,
} from '../src/control.js';

/** An engine that records pause/resume and answers snapshot() from `snap`. */
function fakeEngine(snap = {}) {
  const e = {
    status: snap.status ?? 'running',
    calls: [],
    snap: { status: 'running', playing: { title: 'A' }, queue: [], pending: null, pausedBy: '', pausedAt: 0, ...snap },
    snapshot() { return { ...this.snap, status: this.status }; },
    pause(opts) { this.calls.push(['pause', opts]); this.status = 'paused'; this.snap.pausedBy = opts?.by ?? 'host'; },
    resume() { this.calls.push(['resume']); this.status = 'running'; this.snap.pausedBy = ''; },
  };
  return e;
}
const on = { enabled: true, locked: false };
const cmd = (type, extra = {}) => JSON.stringify({ type, votes: 3, viewers: 5, by: ['Alex', 'Sam'], id: 'u-1', ...extra });

test('a pause command runs the engine pause tagged as the viewers\', and acks', () => {
  const e = fakeEngine();
  const logs = []; const cmds = [];
  const reply = handleControlFrame(cmd('pause'), { engine: e, pauseVote: on, log: (l) => logs.push(l), onCommand: (c) => cmds.push(c), label: 'vps/main' });
  assert.deepEqual(e.calls, [['pause', { by: 'viewers' }]]);
  assert.deepEqual(reply, { type: 'ack', id: 'u-1', ok: true, reason: '', paused: true });
  assert.equal(cmds.length, 1);
  assert.deepEqual(cmds[0], { type: 'pause', votes: 3, viewers: 5, by: ['Alex', 'Sam'], ok: true, reason: '' });
  assert.match(logs[0], /^\[control\] \[vps\/main\] viewers paused the broadcast \(3\/5: Alex, Sam\)$/);
});

test('a resume command resumes a paused engine; ping is answered; junk is ignored', () => {
  const e = fakeEngine({ status: 'paused', pausedBy: 'viewers' });
  const reply = handleControlFrame(Buffer.from(cmd('resume', { id: 'u-2' })), { engine: e, pauseVote: on });
  assert.deepEqual(e.calls, [['resume']]);
  assert.deepEqual(reply, { type: 'ack', id: 'u-2', ok: true, reason: '', paused: false });
  assert.deepEqual(handleControlFrame('{"type":"ping"}', { engine: e, pauseVote: on }), { type: 'pong' });
  assert.equal(handleControlFrame('{"type":"pong"}', { engine: e, pauseVote: on }), null);
  assert.equal(handleControlFrame('not json', { engine: e, pauseVote: on }), null);
  assert.equal(handleControlFrame('{"type":"skip"}', { engine: e, pauseVote: on }), null);
  assert.equal(e.calls.length, 1, 'nothing else touched the engine');
});

test('every refusal reason, in the order the contract lists them', () => {
  const now = 1_000_000;
  const cases = [
    ['setting off', fakeEngine(), { enabled: false, locked: false }, 'pause', /turned viewer controls off/],
    ['locked', fakeEngine(), { enabled: true, locked: true }, 'pause', /locked viewer controls/],
    ['no engine', null, on, 'pause', /not running/],
    ['still preparing', fakeEngine({ status: 'preparing' }), on, 'pause', /not running/],
    ['countdown card', fakeEngine({ playing: { title: 'A', countdown: true } }), on, 'pause', /countdown card/],
    ['on a break', fakeEngine({ status: 'break', breakUntil: now + 600 }), on, 'resume', /on a break/],
    ['pinned start in 90s', fakeEngine({ queue: [{ id: 'b', startAt: now + 90 }] }), on, 'pause', /less than two minutes/],
    ['pause pending', fakeEngine({ pending: { kind: 'pause' } }), on, 'resume', /already on its way/],
    ['skip pending', fakeEngine({ pending: { kind: 'skip' } }), on, 'pause', /already on its way/],
    ['already paused', fakeEngine({ status: 'paused' }), on, 'pause', /already paused/],
    ['not paused', fakeEngine(), on, 'resume', /not paused/],
    ['host paused', fakeEngine({ status: 'paused', pausedBy: 'host' }), on, 'resume', /host paused/],
  ];
  for (const [name, engine, pauseVote, type, re] of cases) {
    const reason = refusalFor(type, { engine, pauseVote, now });
    assert.match(String(reason), re, name);
    const logs = [];
    const reply = handleControlFrame(cmd(type), { engine, pauseVote, now, log: (l) => logs.push(l) });
    assert.equal(reply.type, 'ack', name);
    assert.equal(reply.ok, false, name);
    assert.equal(reply.reason, reason, name);
    assert.equal(reply.id, 'u-1', name);
    assert.equal(typeof reply.paused, 'boolean', name);
    assert.equal(engine?.calls?.length ?? 0, 0, `${name}: the engine was not touched`);
    assert.match(logs[0], /^\[control\] refused viewers' (pause|resume) \(3\/5: Alex, Sam\) — /, name);
  }
  // A pin far enough away, or a seek pending, does not refuse.
  assert.equal(refusalFor('pause', { engine: fakeEngine({ queue: [{ id: 'b', startAt: now + 600 }] }), pauseVote: on, now }), null);
  assert.equal(refusalFor('pause', { engine: fakeEngine({ pending: { kind: 'seek' } }), pauseVote: on, now }), null);
});

test('the state frame carries paused, pausedBy, the pause/resume pending and the vote switch', () => {
  assert.deepEqual(stateFrame({ engine: null, pauseVote: on }),
    { type: 'state', paused: false, pausedBy: '', pending: '', pauseVote: true });
  assert.deepEqual(stateFrame({ engine: fakeEngine({ status: 'paused', pausedBy: 'viewers', pending: { kind: 'pause' } }), pauseVote: on }),
    { type: 'state', paused: true, pausedBy: 'viewers', pending: 'pause', pauseVote: true });
  assert.deepEqual(stateFrame({ engine: fakeEngine({ status: 'paused', pausedBy: 'host' }), pauseVote: { enabled: true, locked: true } }),
    { type: 'state', paused: true, pausedBy: 'host', pending: '', pauseVote: false });
  // A skip pending stays out of this field.
  assert.deepEqual(stateFrame({ engine: fakeEngine({ pending: { kind: 'skip' } }), pauseVote: { enabled: false, locked: false } }),
    { type: 'state', paused: false, pausedBy: '', pending: '', pauseVote: false });
  assert.equal(pendingOf({ pending: { kind: 'resume' } }), 'resume');
  assert.equal(pendingOf({ pending: { kind: 'seek' } }), '');
});

test('the dial URL: wss for https, ws for http, token and room in the query, redacted in logs', () => {
  assert.equal(controlUrl({ url: 'https://stream.example.com', accessToken: 'tok en' }, 'anime'),
    'wss://stream.example.com/api/integrations/control?accessToken=tok+en&channel=anime');
  assert.equal(controlUrl({ url: 'http://10.0.0.5:8080/', accessToken: 'abc' }, ''),
    'ws://10.0.0.5:8080/api/integrations/control?accessToken=abc&channel=main');
  assert.equal(redactToken('dial wss://x/api/integrations/control?accessToken=SECRET123&channel=main failed'),
    'dial wss://x/api/integrations/control?accessToken=********&channel=main failed');
});

/** A WebSocket stand-in the test drives by hand. */
class FakeWS extends EventEmitter {
  static made = [];
  constructor(url) {
    super();
    this.url = url; this.sent = []; this.readyState = 0; this.closed = null;
    FakeWS.made.push(this);
  }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, why) { this.closed = { code, why }; this.readyState = 3; }
  terminate() { this.readyState = 3; }
  open() { this.readyState = 1; this.emit('open'); }
}

test('the client dials one socket per receiver and room, states on connect, acks, reconnects, closes at the end', async () => {
  FakeWS.made = [];
  const engine = fakeEngine();
  const logs = [];
  let pv = { enabled: true, locked: false };
  const client = new ControlClient({
    receivers: () => [{ id: 'r1', name: 'vps', url: 'https://stream.example.com', accessToken: 'SECRET' }],
    channels: () => ['', 'anime'],
    ctx: () => ({ engine, pauseVote: pv }),
    log: (l) => logs.push(l),
    WebSocketImpl: FakeWS,
  });
  client.start();
  assert.equal(FakeWS.made.length, 2, 'one socket per room');
  assert.deepEqual(FakeWS.made.map((w) => new URL(w.url).searchParams.get('channel')), ['main', 'anime']);
  const ws = FakeWS.made[0];
  ws.open();
  assert.deepEqual(ws.sent[0], { type: 'state', paused: false, pausedBy: '', pending: '', pauseVote: true });
  assert.ok(logs.some((l) => l === '[control] [vps/main] connected'));

  ws.emit('message', cmd('pause'));
  assert.deepEqual(engine.calls, [['pause', { by: 'viewers' }]]);
  assert.deepEqual(ws.sent[1], { type: 'ack', id: 'u-1', ok: true, reason: '', paused: true });

  // A state change is pushed to every open socket.
  client.pushState();
  assert.deepEqual(ws.sent[2], { type: 'state', paused: true, pausedBy: 'viewers', pending: '', pauseVote: true });
  // Locking flips the switch the receiver sees.
  pv = { enabled: true, locked: true };
  client.pushState();
  assert.equal(ws.sent[3].pauseVote, false);

  // Never a token in a log line, whatever the socket reported.
  ws.emit('error', new Error('bad handshake at wss://x/api/integrations/control?accessToken=SECRET&channel=main'));
  assert.ok(logs.some((l) => l.includes('bad handshake')));
  assert.ok(logs.every((l) => !l.includes('SECRET')), logs.join('\n'));

  // The receiver hangs up: a retry is scheduled with backoff, not a third socket at once.
  ws.emit('close', 1006);
  assert.equal(FakeWS.made.length, 2);
  assert.ok(logs.some((l) => /\[vps\/main\] closed \(1006\) — retrying in 2s/.test(l)));

  // The broadcast ends: every socket closed, nothing redialled.
  client.stop();
  assert.deepEqual(FakeWS.made[1].closed, { code: 1000, why: 'broadcast ended' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.made.length, 2, 'no reconnect after stop');

  // The setting off: start() opens nothing.
  pv = { enabled: false, locked: false };
  client.start();
  assert.equal(FakeWS.made.length, 2);
  client.stop();
});
