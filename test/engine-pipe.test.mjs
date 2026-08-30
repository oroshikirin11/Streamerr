/**
 * Engine-level smoke: does _play actually take the pipe path, and does
 * setOverlay swap the renderer instead of respawning the source?
 *
 * This exists because the e2e proves the BUILDERS and the FEED, while the
 * bugs this feature is most likely to grow live in the engine's wiring —
 * _play forgetting to reset the feed, setOverlay falling through to the
 * respawn branch, stop() leaking a renderer. _spawnSource is stubbed (no
 * real broadcast); the feed and renderer processes are real, and need no
 * GPU — the renderer is a CPU-side lavfi graph.
 *
 * Run: node test/engine-pipe.test.mjs
 */
import { PipelinePlayout } from '../src/ffmpeg/pipeline.js';

const profile = {
  backend: 'vaapi', device: '/dev/dri/renderD128', gpuFull: true, gpuSubs: true,
  overlayPipe: true, width: 1280, height: 720, fps: 30, fpsMode: 'auto',
  videoBitrate: '4000k', audioBitrate: '160k', gopSeconds: 2,
};
const selection = {
  video: { width: 640, height: 360, codec: 'h264', frameRate: '24000/1001', sar: '1:1' },
  audio: { typeIndex: 0 },
  subtitle: null,
};
const e = new PipelinePlayout({
  destinations: [{ protocol: 'rtmp', creds: { url: 'rtmp://x', key: 'k' }, primary: true }],
  profile, selection, cacheDir: (await import('os')).tmpdir(),
});
const spawned = [];
e._spawnSource = (args, opts) => { spawned.push({ args, opts }); e.source = { fake: true }; };
e._killSource = () => { e.source = null; };
e._detached = (p) => { Promise.resolve(p).catch(() => {}); };
e._extract = async () => null;
e._warm = async () => null;
e._fillDuration = () => {};
e.status = 'running';
e.publisher = { fake: true };
e.on('log', (m) => process.stdout.write('  log: ' + m));
e.on('warn', (m) => console.log('  warn:', m));

let ok = 0, fail = 0;
const check = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? ok++ : fail++; };

e._play({ id: '1', title: 'Smoke', srcPath: '/dev/null', duration: 60 }, 0, { duration: 60 });
const args1 = spawned[0]?.args ?? [];
check('_play produced a piped source command', args1.join(' ').includes('.fifo'));
check('the feed is active with a live renderer', e._ovFeed?.active === true && e._pipedClip === true);
check('renderer process is running', Boolean(e._ovFeed?._renderer));

// The apply: must swap the renderer, must NOT respawn the source.
const before = spawned.length;
const oldRenderer = e._ovFeed._renderer.child.pid;
e.position = 10; e.aired = 2;
e.setOverlay([{ type: 'text', text: 'HI', x: 0.1, y: 0.1, size: 0.05, enabled: true }]);
await new Promise((r) => { setTimeout(r, 1500); });
check('setOverlay did NOT respawn the source', spawned.length === before);
check('setOverlay replaced the renderer',
  e._ovFeed?._renderer && e._ovFeed._renderer.child.pid !== oldRenderer);

e.stop();
check('stop() tears the feed down', e._ovFeed === null);
console.log(fail ? `\n${fail} FAILED` : '\nengine smoke: all passed');
process.exit(fail ? 1 : 0);
