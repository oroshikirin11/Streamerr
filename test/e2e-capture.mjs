/**
 * Screen sharing, end to end, with a real browser.
 *
 * Starts the service on its own ports with a throwaway config (auth off,
 * the secure address on, a raw-TCP destination pointing at a sink in this
 * process), drives a headless Chrome through the Capture page over the
 * DevTools protocol — pick a tab as the screen, go live, apply a Studio
 * caption (a respawn), pause and resume, stop — and then inspects what the
 * "ingest" received with ffprobe.
 *
 * Needs: google-chrome-stable (or CHROME=<path>), ffmpeg/ffprobe, a built
 * web/ bundle. Not part of `npm test` — it takes a minute and a browser.
 *
 *   node test/e2e-capture.mjs            # keep going, print a report
 *   KEEP=1 node test/e2e-capture.mjs     # leave the temp dir behind
 */
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';
import { mkdtempSync, writeFileSync, mkdirSync, createWriteStream, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.CHROME || 'google-chrome-stable';
const HTTP = 18099;
const HTTPS = 18443;
const SINK = 19741;
const CDP = 19222;
const BASE = `http://127.0.0.1:${HTTP}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const notes = [];
function check(ok, what) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}
function note(s) { notes.push(s); console.log(`  note  ${s}`); }

// ── the throwaway install ────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'jsr-e2e-'));
for (const d of ['cache', 'run', 'overlays', 'media']) mkdirSync(join(dir, d), { recursive: true });
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  server: { port: HTTP, host: '127.0.0.1', tls: { enabled: true, port: HTTPS } },
  auth: { disabled: true },
  onboarded: true,
  publish: { protocol: 'tcp', enabled: true, tcp: { url: `tcp://127.0.0.1:${SINK}`, key: 'e2e-key-123456' } },
  streamingestarr: { enabled: false, url: '', accessToken: '' },
  library: { sources: [], autoRefresh: { enabled: false } },
  encoder: {
    backend: 'x264', codec: 'h264', width: 1280, height: 720, fps: 30, fpsMode: 'auto',
    videoBitrate: '3000k', audioBitrate: '128k', gopSeconds: 2, frameSize: 'native',
  },
  buffer: { seconds: 15, applySeconds: 15 },
  capture: { delaySeconds: 0, passthrough: true, quality: 'balanced', fps: 30, audio: 'auto', onEnd: 'end' },
  preview: { enabled: false },
  devMode: true,
  paths: { cache: join(dir, 'cache'), run: join(dir, 'run'), overlays: join(dir, 'overlays') },
}, null, 2));

// ── the ingest: preamble line, then TS bytes to a file ───────────────────
const tsPath = join(dir, 'received.ts');
const tsOut = createWriteStream(tsPath);
let rxBytes = 0;
let rxConnections = 0;
const sink = createServer((c) => {
  rxConnections += 1;
  let head = Buffer.alloc(0);
  let inBody = false;
  c.on('data', (d) => {
    if (inBody) { rxBytes += d.length; tsOut.write(d); return; }
    head = Buffer.concat([head, d]);
    const nl = head.indexOf(10);
    if (nl >= 0) {
      inBody = true;
      const body = head.subarray(nl + 1);
      if (body.length) { rxBytes += body.length; tsOut.write(body); }
    }
  });
  c.on('error', () => {});
});
sink.listen(SINK, '127.0.0.1');

// ── the service ──────────────────────────────────────────────────────────
const serverLog = [];
const srv = spawn('node', ['src/index.js'], {
  cwd: ROOT,
  env: { ...process.env, STREAMERR_CONFIG: join(dir, 'config.json'), NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => serverLog.push(d.toString()));
srv.stderr.on('data', (d) => serverLog.push(d.toString()));

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* none */ }
  return { status: r.status, data };
};
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* retry */ }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(250);
  }
}
let logCursor = 0;
const logLines = [];
async function pullLog() {
  const { data } = await api('GET', `/api/debug/log?after=${logCursor}`);
  for (const e of data?.entries ?? []) {
    logCursor = Math.max(logCursor, e.id ?? logCursor);
    logLines.push(e.line ?? '');
  }
  return logLines;
}
const spawns = () => logLines.filter((l) => l.includes('[spawn:live]'));

// ── the browser, over the DevTools protocol ──────────────────────────────
let chrome = null;
let page = null;
async function cdpPage(match) {
  const list = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${CDP}/json`);
    const pages = await r.json();
    return pages.find((p) => p.type === 'page' && match(p)) ?? null;
  }, 15000, 'devtools page');
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, { gesture = false } = {}) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: gesture,
    });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function main() {
  console.log(`temp dir ${dir}`);
  await until(() => api('GET', '/api/auth/status').then((r) => r.status === 200), 20000, 'service up');
  const tls = await until(() => api('GET', '/api/tls').then((r) => (r.data?.listening ? r.data : null)), 10000, 'https listener');
  check(tls.listening === true, `secure address up on ${HTTPS} (${tls.fingerprint?.slice(0, 20)}…)`);
  const rc = await fetch(`https://127.0.0.1:${HTTPS}/api/auth/status`).catch((e) => e);
  // Node refuses the self-signed cert by default — the refusal itself is the proof it is TLS.
  check(rc instanceof Error && /self.signed|certificate/i.test(String(rc.cause ?? rc)), 'the listener speaks TLS with the generated certificate');

  // The surface: a tab with a title the picker can be told to choose, and
  // something moving on it so the encoder has real frames to send.
  const surface = 'data:text/html,' + encodeURIComponent(`<title>JSR Test Surface</title>
    <style>body{margin:0;background:#123;color:#fff;font:48px sans-serif}
    .b{width:120px;height:120px;background:#f80;border-radius:20px;animation:m 2s linear infinite alternate}
    @keyframes m{from{transform:translate(0,0)}to{transform:translate(900px,400px)}}</style>
    <div class=b></div><p id=t></p><script>setInterval(()=>{document.getElementById('t').textContent=new Date().toISOString()},100)</script>`);
  const userData = join(dir, 'chrome');
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=${CDP}`,
    '--ignore-certificate-errors',
    '--auto-select-tab-capture-source-by-title=JSR Test Surface',
    // Never the desktop portal: the test captures its own tab.
    '--disable-features=WebRtcPipeWireCapturer',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,800',
    // Headless takes ONE url; the surface tab is opened over DevTools below.
    `https://127.0.0.1:${HTTPS}/capture`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Cut off from the operator's desktop session, so a real screen picker
    // can never pop up over their work while the test runs.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WAYLAND_DISPLAY|DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_RUNTIME_DIR)$/.test(k))),
  });
  const chromeLog = [];
  chrome.stderr.on('data', (d) => chromeLog.push(d.toString()));

  page = await cdpPage((p) => p.url.includes('/capture'));
  await until(() => page.evaluate('Boolean(window.__jsrCapture)'), 20000, 'capture page ready');
  const created = await page.send('Target.createTarget', { url: surface, background: true });
  check(Boolean(created.result?.targetId), 'the surface tab exists');
  await sleep(1500);
  const secure = await page.evaluate('window.isSecureContext');
  check(secure === true, 'the page is a secure context');
  const canShare = await page.evaluate('Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)');
  check(canShare, 'getDisplayMedia is available');

  // Pick — a user gesture is required, which DevTools can grant.
  await page.evaluate('window.__jsrCapture.pick()', { gesture: true });
  const phase = await until(async () => {
    const p = await page.evaluate('window.__jsrCapture.cap.phase');
    const err = await page.evaluate('window.__jsrCapture.cap.error');
    if (err) throw new Error(`pick failed: ${err}`);
    return p === 'armed' ? p : null;
  }, 20000, 'armed');
  check(phase === 'armed', 'the browser picked a screen and is armed');
  const mime = await page.evaluate('window.__jsrCapture.cap.mime');
  note(`recorder type: ${mime}`);

  const armed = await until(async () => {
    const st = await page.evaluate('JSON.stringify({ phase: window.__jsrCapture.cap.phase, error: window.__jsrCapture.cap.error, sending: window.__jsrCapture.cap.sending, sessionId: window.__jsrCapture.cap.sessionId })');
    const pst = JSON.parse(st);
    if (pst.phase !== 'armed') throw new Error(`page left armed: ${st}`);
    const r = await api('GET', '/api/capture');
    return r.data?.session?.feed?.bytesIn > 0 && r.data.session.codec ? r.data : null;
  }, 15000, 'bytes at the box');
  check(armed.session.state === 'armed', `the box holds the share (${armed.session.codec} ${armed.session.width}x${armed.session.height}, ${armed.session.sender.ua})`);
  check(armed.blocked == null, 'nothing else is on air, so going live is allowed');

  // Go live.
  const shot = async (name) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) writeFileSync(join(dir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  await shot('armed');
  const tGo = Date.now();
  const go = await api('POST', '/api/capture/go');
  check(go.status === 200, `go live accepted (${go.status} ${go.data?.error ?? ''})`);
  const running = await until(() => api('GET', '/api/stream/status').then((r) => (r.data?.status === 'running' ? r.data : null)), 30000, 'running');
  check(running.playing?.live === true, 'the broadcast item is the live share');
  check(running.playing?.duration == null, 'a share has no duration');
  const tFirstByte = await until(() => Promise.resolve(rxBytes > 0 ? Date.now() : null), 30000, 'ingest receiving');
  const toFirst = (tFirstByte - tGo) / 1000;
  {
    // Where the seconds go: spawn, first source byte, publisher connect.
    const { data } = await api('GET', '/api/debug/log?after=0');
    const ev = (data?.entries ?? []).filter((e) => e.t >= tGo - 500);
    const at = (re) => ev.find((e) => re.test(e.line ?? ''))?.t;
    const d = (t) => (t ? `${((t - tGo) / 1000).toFixed(2)}s` : '-');
    note(`timeline after Go: source spawn ${d(at(/\[spawn:live\]/))}, first source byte ${d(at(/first byte in/))}, publisher up ${d(at(/\[spawn:publisher\]|publisher.*connect|\[publisher\]/i))}, first ingest byte ${d(tFirstByte)}`);
  }
  note(`first bytes reached the ingest ${toFirst.toFixed(1)}s after Go live (no-delay mode)`);
  check(toFirst < 5, 'no-delay mode reaches the ingest within 5s of Go live');
  await sleep(3000);
  await shot('live');
  await sleep(8000);
  await pullLog();
  const first = spawns()[0] ?? '';
  const copied = /-c:v copy/.test(first);
  const h264 = /h264|avc1/i.test(mime);
  check(spawns().length >= 1, 'a live source spawned');
  check(copied === h264, `${h264 ? 'H.264 from the browser ships untouched (-c:v copy)' : 'a non-H.264 recorder is transcoded'}`);
  const rate1 = rxBytes;
  await sleep(4000);
  check(rxBytes > rate1 + 100_000, `the ingest keeps receiving (${((rxBytes - rate1) * 8 / 4 / 1000).toFixed(0)} kb/s)`);
  const st1 = await api('GET', '/api/capture');
  note(`sender health: ${JSON.stringify(st1.data?.session?.health)}; feed: ${JSON.stringify(st1.data?.session?.feed)}`);
  check((st1.data?.session?.feed?.backlogSeconds ?? 99) < 3, 'the box is not falling behind the sender');
  const gap = st1.data?.session?.feed?.keyGapSeconds;
  note(`keyframe spacing from the browser: ${gap == null ? 'not yet measured' : `${gap.toFixed(2)}s`}`);
  const secondShareRefused = await api('POST', '/api/capture/go');
  check(secondShareRefused.status === 409, 'a second go-live is refused while on air');

  // A Studio caption: applies through a respawn, the share continues.
  const nSpawn = spawns().length;
  const ov = await api('PUT', '/api/config', {
    overlay: { hidden: false, items: [{ id: 'e2e', type: 'text', text: 'E2E {title}', x: 0.5, y: 0.1, size: 0.06, enabled: true }] },
  });
  check(ov.status === 200, 'overlay applied');
  await until(async () => { await pullLog(); return spawns().length > nSpawn ? true : null; }, 20000, 'respawn after apply');
  const second = spawns()[spawns().length - 1];
  check(!/-c:v copy/.test(second), 'with a caption drawn, the share is transcoded');
  await sleep(6000);
  const s2 = await api('GET', '/api/stream/status');
  check(s2.data?.status === 'running', 'still running after the apply');
  const rate2 = rxBytes;
  await sleep(4000);
  check(rxBytes > rate2 + 100_000, 'ingest still receiving after the apply');

  // Pause = hold card, resume = fresh re-attach.
  const p = await api('POST', '/api/stream/pause');
  check(p.status === 200, 'paused');
  await sleep(4000);
  const sp = await api('GET', '/api/stream/status');
  check(sp.data?.status === 'paused', 'status is paused');
  const nSpawn2 = spawns().length;
  const r = await api('POST', '/api/stream/resume');
  check(r.status === 200, 'resumed');
  await until(async () => { await pullLog(); return spawns().length > nSpawn2 ? true : null; }, 20000, 'respawn after resume');
  await until(() => api('GET', '/api/stream/status').then((x) => (x.data?.status === 'running' ? true : null)), 20000, 'running after resume');
  await sleep(5000);
  const rate3 = rxBytes;
  await sleep(4000);
  check(rxBytes > rate3 + 100_000, 'ingest receiving after resume');

  // Hide the overlay: back to copy for an H.264 sender.
  const nSpawn3 = spawns().length;
  await api('PUT', '/api/config', { overlay: { hidden: true } });
  await until(async () => { await pullLog(); return spawns().length > nSpawn3 ? true : null; }, 20000, 'respawn after hiding the overlay');
  check(/-c:v copy/.test(spawns()[spawns().length - 1]) === h264, 'nothing drawn again: the copy path returns');
  await sleep(5000);

  // The transport-bar picture: what the panel status carries.
  const st = await api('GET', '/api/stream/status');
  check(st.data?.capture?.session?.state === 'live', 'status carries the live session');
  check(typeof st.data?.capture?.session?.health?.kbps === 'number', 'sender health reaches the status');

  // Stop sharing from the browser: the broadcast ends by itself.
  const bytesBeforeStop = rxBytes;
  await page.evaluate('window.__jsrCapture.stop()', { gesture: true });
  const stopped = await until(() => api('GET', '/api/stream/status').then((x) => (x.data?.status === 'stopped' ? x.data : null)), 30000, 'stopped after the share ended');
  check(stopped.status === 'stopped', 'the broadcast ended when the share stopped');
  check(stopped.capture?.session == null, 'no session left behind');
  note(`${((rxBytes - bytesBeforeStop) / 1024).toFixed(0)} KB drained after stop`);
  page.close();

  // What the ingest got.
  await sleep(1500);
  tsOut.end();
  await sleep(300);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', tsPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const info = JSON.parse(probe.stdout || '{}');
  const vs = (info.streams ?? []).find((s) => s.codec_type === 'video');
  const as = (info.streams ?? []).find((s) => s.codec_type === 'audio');
  check(vs?.codec_name === 'h264', `ingest video is ${vs?.codec_name ?? 'missing'} ${vs?.width ?? '?'}x${vs?.height ?? '?'}`);
  check(as?.codec_name === 'aac', `ingest audio is ${as?.codec_name ?? 'missing'}`);
  const frames = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', tsPath], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const nFrames = Number(String(frames.stdout).trim().split(/[,\s]+/).filter(Boolean)[0]);
  check(nFrames > 300, `${nFrames} video frames reached the ingest (${statSync(tsPath).size >> 10} KB, ${rxConnections} connection${rxConnections === 1 ? '' : 's'})`);
  const dec = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-i', tsPath, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const warnLines = String(dec.stderr).split('\n').filter((l) => l.trim()).filter((l) => !/Last message repeated/.test(l));
  note(`decoder warnings over the whole stream: ${warnLines.length}${warnLines.length ? ` (e.g. "${warnLines[0].slice(0, 100)}")` : ''}`);
  check(dec.status === 0, 'the received stream decodes');
  const health = logLines.filter((l) => l.includes('[health]'));
  note(`${health.length} health beats; last: ${health[health.length - 1]?.trim() ?? '-'}`);
  const warns = logLines.filter((l) => /^\[warn\]|warn/i.test(l) && !/\[spawn/.test(l)).slice(0, 5);
  if (warns.length) note(`server warnings: ${warns.map((w) => w.trim().slice(0, 120)).join(' | ')}`);
  const cl = chromeLog.join('').split('\n').filter((l) => /error|fail/i.test(l) && !/GPU|dbus|Fontconfig|ALSA|bluez|vulkan/i.test(l)).slice(0, 5);
  if (cl.length) note(`chrome: ${cl.join(' | ').slice(0, 400)}`);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.log(`  FAIL  ${err.message}`);
  failures.push(err.message);
  try {
    const st = await page?.evaluate('JSON.stringify({ phase: window.__jsrCapture.cap.phase, error: window.__jsrCapture.cap.error, sending: window.__jsrCapture.cap.sending, sessionId: window.__jsrCapture.cap.sessionId, mime: window.__jsrCapture.cap.mime })');
    console.log(`--- page state --- ${st}`);
    const c = await api('GET', '/api/capture');
    console.log(`--- /api/capture --- ${JSON.stringify(c.data).slice(0, 600)}`);
    await pullLog();
  } catch (e2) { console.log(`(diagnostics failed: ${e2.message})`); }
  const tail = serverLog.join('').split('\n').slice(-25).join('\n');
  console.log('--- server log tail ---\n' + tail);
  console.log('--- engine log tail ---\n' + logLines.slice(-30).join(''));
} finally {
  try { chrome?.kill('SIGKILL'); } catch { /* gone */ }
  try { await api('POST', '/api/stream/stop'); } catch { /* down */ }
  await sleep(500);
  try { srv.kill('SIGKILL'); } catch { /* gone */ }
  sink.close();
  if (failures.length) {
    console.log(`\n${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
    exitCode = 1;
  } else {
    console.log('\nall passed');
  }
  if (process.env.KEEP) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
