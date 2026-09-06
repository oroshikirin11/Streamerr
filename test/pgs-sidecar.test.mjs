/**
 * Bitmap subtitles from a sidecar.
 *
 * sub2video re-sends a PGS frame on every packet read from the media file;
 * from a 40 Mbps remux that is thousands a second, gated to twelve, each a
 * 4K RGBA frame to scale. Extracted into a Matroska sidecar with a tiny
 * heartbeat stream, the GPU graphs open the track as their own input and
 * the frames arrive a few times a second. The software chain is untouched.
 *
 * Run: node test/pgs-sidecar.test.mjs
 */
import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';
import { buildSubtitleFilter } from '../src/ffmpeg/tracks.js';
import { isExtractable, isSidecar } from '../src/ffmpeg/subcache.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const graphOf = (args) => args[args.indexOf('-filter_complex') + 1] ?? '';

const vaapi = {
  backend: 'vaapi', device: '/dev/dri/renderD128', width: 1920, height: 1038, fps: 30,
  fpsMode: 'auto', videoBitrate: '16000k', audioBitrate: '160k', gopSeconds: 1,
  gpuFull: true, gpuSubs: true, gpuMove: true, tonemap: 'vaapi', codec: 'hevc',
  frameSize: 'native', overlay: [],
};
const hdr = {
  width: 3840, height: 2074, codec: 'hevc', frameRate: '24000/1001', sar: '1:1',
  dar: '1920:1037', hdr: true, pixFmt: 'yuv420p10le',
};
const pgs = { codec: 'hdmv_pgs_subtitle', bitmap: true, typeIndex: 2 };
const bounce = (n) => ({
  path: `/app/overlays/p${n}.png`, x: 0.5, y: 0.5, size: 0.1, opacity: 1,
  motion: 'bounce', speed: 0.06, enabled: true,
});
const build = (o) => buildSourceArgs({
  srcPath: '/m/g.mkv', offset: 600, duration: 4958, tsOffset: 0, profile: vaapi,
  selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: pgs },
  ...o,
});

console.log('\nwhat is extractable');
{
  check('PGS is', isExtractable({ codec: 'hdmv_pgs_subtitle' }), true);
  check('DVD subs are', isExtractable({ codec: 'dvd_subtitle' }), true);
  check('text still is', isExtractable({ codec: 'subrip' }), true);
  check('external never', isExtractable({ codec: 'hdmv_pgs_subtitle', external: true }), false);
  check('PGS comes out as a sidecar', isSidecar({ codec: 'hdmv_pgs_subtitle' }), true);
  check('text does not', isSidecar({ codec: 'ass' }), false);
}

console.log('\nthe descriptor');
{
  const d = buildSubtitleFilter(pgs, '/m/g.mkv', { extractedPath: '/c/k.mks' });
  check('carries the sidecar', d.sidecar, '/c/k.mks');
  check('and still names the main-input stream for the software chain', d.overlayInput, '0:s:2');
  const none = buildSubtitleFilter(pgs, '/m/g.mkv', {});
  check('no extracted copy: no sidecar', none.sidecar, null);
}

console.log('\nthe GPU canvas graph');
{
  const args = build({ extractedPath: '/c/k.mks' });
  const g = graphOf(args);
  const i = args.lastIndexOf('-i');
  check('the sidecar is the last input', args[i + 1], '/c/k.mks');
  check('...seeked with the clip', args.slice(i - 2, i), ['-ss', '600.000']);
  check('the canvas reads the frames from it (input 2: media, canvas, sidecar)',
    g.includes('[2:s:0]scale=1920:1038:flags=fast_bilinear[sf]'), true);
  check('...ungated: a sidecar beats a few times a second, and a gate would delay every cue change',
    g.includes('select=isnan(prev_selected_t)'), false);
  check('...not from the media file', g.includes('[0:s:2]'), false);
  const plain = graphOf(build({}));
  check('without a sidecar the media file feeds it, as before', plain.includes('[0:s:2]select='), true);
}

console.log('\n...counted past the pictures');
{
  const args = build({ extractedPath: '/c/k.mks', overlayImages: [bounce(1), bounce(2)] });
  const g = graphOf(args);
  check('two movers sit at 2 and 3, the sidecar at 4', g.includes('[4:s:0]scale='), true);
  check('and the movers are where they were', g.includes('[2:v]format=rgba') && g.includes('[3:v]format=rgba'), true);
  check('the sidecar input follows the picture inputs',
    args.indexOf('/c/k.mks') > args.indexOf('/app/overlays/p2.png'), true);
}

console.log('\nthe CPU composite, opted in');
{
  const g = graphOf(build({ extractedPath: '/c/k.mks', profile: { ...vaapi, subComposite: 'cpu' } }));
  check('reads the sidecar as input 1, ungated', g.includes('[1:s:0]scale=') && !g.includes('select='), true);
  check('and draws it on the downloaded frame', g.includes('[f0][sf]overlay=eof_action=pass:format=yuv420[f1]'), true);
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall passed');
