// Splice rig: the real engine and publisher, a TCP sink standing in for the
// ingest, and a scripted sequence of operator actions. Bytes the "ingest"
// receives land in capture.ts for analyze.py; the engine's own log goes to
// stdout for cmp.py.
//
//   MODE=pass|hevc|long|(default)   pass: HEVC copied untouched (B-pyramid)
//                                   hevc: H.264 source transcoded to HEVC
//                                   long: HEVC with a 10s GOP (fails copy gate)
//   QLEN=n        queue depth (default 6 -- a 2-item queue silently REFUSES
//                 every skip after the first, and hid a fault for a day)
//   SEQ=a@t,...   skip | seek:<s> | pause | resume | subs-on | subs-off | stop
//   RUNAHEAD=1    enable the run-ahead cache (off = source paced by encoder,
//                 which is the N100 condition; most splice faults only show
//                 with it OFF)
//   THINBUF=s     shrink the cushion   SUBS=1 start with subtitles on
//   CENSOR=1      one censor box on the picture
//   ALLLOG=1      every engine log line, untruncated
import { createServer } from 'net';
import { createWriteStream, mkdirSync } from 'fs';
import { PipelinePlayout } from '../../src/ffmpeg/pipeline.js';
import { probeTracks, selectTracks, listSubtitles } from '../../src/ffmpeg/tracks.js';

const DIR = new URL('.', import.meta.url).pathname;
const FX = `${DIR}fixtures/`;
const PORT = Number(process.env.PORT || 19731);
const cap = createWriteStream(`${DIR}capture.ts`);
const arrivals = createWriteStream(`${DIR}arrival.log`);
let rxBytes = 0;

// The ingest side of the tcp bridge: one preamble line, then raw TS.
const sink = createServer((c) => {
  let head = Buffer.alloc(0);
  let inBody = false;
  c.on('data', (d) => {
    if (inBody) { rxBytes += d.length; arrivals.write(`${Date.now()} ${rxBytes}\n`); cap.write(d); return; }
    head = Buffer.concat([head, d]);
    const nl = head.indexOf(10);
    if (nl >= 0) {
      inBody = true;
      const b = head.subarray(nl + 1);
      if (b.length) { rxBytes += b.length; arrivals.write(`${Date.now()} ${rxBytes}\n`); cap.write(b); }
    }
  });
  c.on('error', () => {});
});
sink.listen(PORT);

mkdirSync(`${DIR}cache`, { recursive: true });
const MODE = process.env.MODE ?? '';
const PASS = MODE === 'pass';
const LONG = MODE === 'long';
const HEVC = MODE === 'hevc' || PASS || LONG;
const srcPath = FX + (LONG ? 'longgop.mkv' : PASS ? 'hevcsub-e1.mkv' : 'fixture.mkv');
const tracks = await probeTracks(srcPath);
const subs = await listSubtitles(srcPath, tracks);
const selection = selectTracks(tracks, subs, {});
selection.video = tracks.video[0] ?? null;
// Passthrough only happens with nothing to draw: start subs OFF unless asked.
if (!process.env.SUBS) selection.subtitle = null;

const profile = {
  copyLimitKbps: 30000, copyMaxGopSeconds: 4,
  gpuFull: true, gpuSubs: true,
  backend: HEVC ? 'vaapi' : 'x264', codec: HEVC ? 'hevc' : 'h264',
  device: '/dev/dri/renderD128',
  width: 1280, height: 720, fps: 30,
  fpsMode: 'auto', videoBitrate: PASS ? '16000k' : '3000k', audioBitrate: '128k',
  gopSeconds: 2, overlayPipe: false,
  // CENSOR=1 puts one censor box mid-frame: a drawn thing with no canvas,
  // so passthrough must refuse and the transcode graphs must carry it.
  overlay: process.env.CENSOR
    ? [{ id: 'c1', type: 'censor', x: 0.5, y: 0.5, w: 0.3, h: 0.25, strength: 5, enabled: true }]
    : [],
  parallelChunks: 1, chunkSeconds: 20,
};

const e = new PipelinePlayout({
  destinations: [{ protocol: 'tcp', creds: { url: `tcp://127.0.0.1:${PORT}`, key: 'k' }, primary: true, name: 'sink' }],
  profile, selection,
  cacheDir: `${DIR}cache`,
  buffer: process.env.THINBUF ? { seconds: Number(process.env.THINBUF), applySeconds: 3 } : undefined,
  runAhead: process.env.RUNAHEAD ? { ramBytes: 512 * 1024 * 1024 } : null,
});

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const snap = (tag) => console.log(`# ${ts()}s ${tag}: status=${e.status} pos=${e.position?.toFixed(2)} tl=${e.timeline?.toFixed(2)} aired=${e.aired?.toFixed?.(2)}`);
e.on('discontinuity', () => console.log(`# ${ts()}s DISCONTINUITY (preview resync)`));
e.on('status', () => snap('status-event'));
e.on('warn', (m) => console.log(`# ${ts()}s warn: ${m}`));
e.on('fatal', (m) => console.log(`# ${ts()}s FATAL: ${m}`));
e.on('log', (m) => {
  const s = String(m);
  if (process.env.ALLLOG) { process.stdout.write(`# ${ts()}s ${s.slice(0, 4000)}\n`); return; }
  if (/spawn|tracks|cache|resumed|flush|seek|skip|splice/i.test(s)) process.stdout.write(`# ${ts()}s ${s}`);
});

const n = Number(process.env.QLEN || 6);
const items = Array.from({ length: n }, (_, i) => ({
  id: `e${i + 1}`, title: `${LONG ? 'Long' : PASS ? 'Hevc' : 'Fixture'} E${i + 1}`, series: 'Clip',
  srcPath: PASS && i % 2 ? `${FX}hevcsub-e2.mkv` : srcPath,
  duration: LONG ? 120 : PASS ? 100 : 90,
}));
await e.start(items);
console.log(`# ${ts()}s started`);

const seq = (process.env.SEQ || 'skip@16,stop@40').split(',')
  .map((s) => { const [a, at] = s.split('@'); return { a, at: Number(at) }; });
for (const step of seq) {
  const wait = step.at * 1000 - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  snap(`pre-${step.a}`);
  if (step.a === 'pause') e.pause();
  else if (step.a === 'resume') e.resume();
  else if (step.a.startsWith('seek:')) e.seek({ position: Number(step.a.slice(5)) });
  else if (step.a === 'skip') { const ok = e.skip(); if (!ok) console.log(`# ${ts()}s SKIP REFUSED`); }
  else if (step.a === 'subs-on') {
    const cur = e.current?.item?.srcPath ?? srcPath;
    const t = await probeTracks(cur);
    const sl = await listSubtitles(cur, t);
    if (!sl.length) console.log('# NO SUBS FOUND');
    else e.setSelection({ ...e.selection, subtitle: sl[0] });
  } else if (step.a === 'subs-off') e.setSelection({ ...e.selection, subtitle: null });
  else if (step.a === 'stop') { e.stop(); break; }
  snap(`post-${step.a}`);
}
await new Promise((r) => setTimeout(r, 3000));
cap.end(); arrivals.end(); sink.close();
console.log('# done');
process.exit(0);
