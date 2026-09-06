/**
 * The two zero-upload rules measured on the N100 (6 Sep 2026):
 *
 *  - a bouncing picture (at most two) is composited by the GPU from a
 *    surface uploaded once, cropped per frame (the crop metadata rides into
 *    a VAAPI scale pass), instead of being drawn on a full-rate canvas;
 *  - a bitmap track with nothing else to draw goes up as the composite's
 *    overlay directly, without a generated canvas.
 *
 * And the things that must NOT change: the canvas stays RGBA and continuous
 * (an exact duplicate gate was tried and measured: it bought nothing and a
 * sparse canvas stalls the video behind frame sync); a driver that failed
 * the probe (or was demoted) keeps the canvas for its movers; stills keep
 * their one-time upload; the CPU composite is opt-in only.
 *
 * Run: node test/gpu-move.test.mjs
 */
import { buildSourceArgs, cpuCompositeWanted } from '../src/ffmpeg/pipeline.js';
import { vaapiMovedImageChain, gpuMovable } from '../src/ffmpeg/overlay-image.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};
const graphOf = (args) => {
  const i = args.indexOf('-filter_complex');
  return i >= 0 ? args[i + 1] : (args[args.indexOf('-vf') + 1] ?? '');
};

const vaapi = {
  backend: 'vaapi', device: '/dev/dri/renderD128', width: 1920, height: 1038, fps: 30,
  fpsMode: 'auto', videoBitrate: '16000k', audioBitrate: '160k', gopSeconds: 1,
  gpuFull: true, gpuSubs: true, gpuMove: true, tonemap: 'vaapi', codec: 'hevc',
  frameSize: 'native', overlay: [],
};
const hdr = {
  width: 3836, height: 2072, codec: 'hevc', frameRate: '24000/1001', sar: '1:1',
  dar: '137:74', hdr: true, pixFmt: 'yuv420p10le',
};
const sd = {
  width: 1920, height: 1038, codec: 'h264', frameRate: '24000/1001', sar: '1:1',
  dar: '16:9', hdr: false, pixFmt: 'yuv420p',
};
const bounce = (n) => ({
  path: `/app/overlays/p${n}.png`, x: 0.5, y: 0.5, size: 0.1, opacity: 1,
  motion: 'bounce', speed: 0.06, enabled: true,
});
const still = { path: '/app/overlays/logo.png', x: 0.1, y: 0.1, size: 0.2, opacity: 1, enabled: true };
const gif = { ...still, path: '/app/overlays/anim.gif', animated: true };
const srt = { codec: 'subrip', typeIndex: 0 };
const pgs = { codec: 'hdmv_pgs_subtitle', bitmap: true, typeIndex: 2 };
const build = (o) => buildSourceArgs({
  srcPath: '/m/x.mkv', offset: 600, duration: 6628, tsOffset: 0,
  selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: null },
  ...o,
});

console.log('\nmoving pictures: uploaded once, cropped per frame by the GPU');
{
  const g = graphOf(build({ profile: vaapi, overlayImages: [bounce(1), bounce(2)] }));
  check('no canvas at all for movers alone', g.includes('color=c=black@0.0'), false);
  check('two crop windows, one per picture', (g.match(/,crop=w=1920:h=1038:x=floor\(/g) ?? []).length, 2);
  check('the crop rides into a scale pass that cannot pass through',
    (g.match(/scale_vaapi=w=1920:h=1038:out_range=pc/g) ?? []).length, 2);
  check('each picture uploaded once and looped as references',
    (g.match(/hwupload,loop=loop=-1:size=1:start=0,setpts=N\/\(24000\/1001\)\/TB/g) ?? []).length, 2);
  check('composited with overlay_vaapi at the origin, over the video',
    (g.match(/overlay_vaapi=x=0:y=0:eof_action=repeat/g) ?? []).length, 2);
  check('the bounce keeps the media-timeline phase and the stagger',
    g.includes('(115.200*(t+600.000))') && g.includes('(115.200*(t+603.100))'), true);
  check('the stage is twice the frame less the picture, picture at the far corner',
    g.includes('pad=w=max(2*1920-iw\\,1920):h=max(2*1038-ih\\,1038):x=max(0\\,1920-iw):y=max(0\\,1038-ih):color=black@0.0'), true);
  const args = build({ profile: vaapi, overlayImages: [bounce(1)] });
  check('the loop is unbounded, so the output ends with the clip', args.includes('-shortest'), true);
  check('the picture input carries the clip rate for the loop', args[args.indexOf('-r')] === '-r' && args[args.indexOf('-r') + 1], '24000/1001');
}

console.log('\n...and over the subtitle canvas when there is one');
{
  const g = graphOf(build({
    profile: vaapi, overlayImages: [bounce(1)],
    selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: srt }, extractedPath: '/c/x.srt',
  }));
  check('the canvas composites first, into [vc]', g.includes('[b][ov]overlay_vaapi[vc]'), true);
  check('the mover goes on top of it', g.includes('[vc][mv0]overlay_vaapi=x=0:y=0:eof_action=repeat[v]'), true);
  check('the canvas itself carries no mover (half rate, RGBA)',
    build({ profile: vaapi, overlayImages: [bounce(1)], selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: srt }, extractedPath: '/c/x.srt' })
      .join(' ').includes('r=24000/2002,format=rgba'), true);
  check('the canvas is not drawn with the bounce expression', g.includes('2*(W-w)'), false);
}

console.log('\nthe canvas is continuous RGBA, never gated');
{
  const g = graphOf(build({
    profile: vaapi, selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: srt }, extractedPath: '/c/x.srt',
  }));
  check('text subtitles: RGBA canvas at half rate', g.includes('setpts=PTS-STARTPTS,format=rgba,hwupload[ov]'), true);
  check('...no duplicate gate (a sparse canvas stalls the video)', g.includes('mpdecimate'), false);
  const p = graphOf(build({ profile: vaapi, selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: pgs } }));
  check('bitmap subtitles alone: the scaled frame IS the overlay, no canvas',
    p.includes('[0:s:2]select=isnan(prev_selected_t)') && p.includes('flags=fast_bilinear,format=rgba,hwupload[ov]'), true);
  check('...and no generated canvas input', build({ profile: vaapi, selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: pgs } }).join(' ').includes('color=c=black@0.0'), false);
  const pc = graphOf(build({ profile: vaapi, selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: pgs }, overlayPath: '/c/ov.ass' }));
  check('bitmap subtitles with a caption: the canvas carries both', pc.includes('[c0][sf]overlay=eof_action=pass:format=auto,format=rgba'), true);
  const a = graphOf(build({ profile: vaapi, overlayAnimated: true, overlayPath: '/c/ov.ass' }));
  check('a moving caption: RGBA canvas at full rate', a.includes('format=rgba,hwupload'), true);
}

console.log('\nwhat falls back, and what is untouched');
{
  const off = graphOf(build({ profile: { ...vaapi, gpuMove: false }, overlayImages: [bounce(1)] }));
  check('no probe pass: the mover is drawn on a full-rate RGBA canvas', off.includes('2*(W-w)') && build({ profile: { ...vaapi, gpuMove: false }, overlayImages: [bounce(1)] }).join(' ').includes('r=24000/1001,format=rgba'), true);
  const dem = graphOf(build({ profile: { ...vaapi, noGpuMove: true }, overlayImages: [bounce(1)] }));
  check('demoted: same canvas', dem.includes('2*(W-w)'), true);
  const bars = graphOf(build({
    profile: { ...vaapi, width: 1920, height: 1080, frameSize: 'fixed' }, overlayImages: [bounce(1)],
  }));
  check('pillarboxed: the mover keeps the canvas (composite shapes are per driver)', bars.includes('2*(W-w)'), true);
  const st = graphOf(build({ profile: vaapi, overlayImages: [still] }));
  check('a still: one upload, one overlay_vaapi, no crop', st.includes('crop=w=1920:h=1038:x=floor('), false);
  check('...still the fixed-function shape', st.includes('[b][img0]overlay_vaapi=x='), true);
  const none = build({ profile: vaapi });
  check('nothing drawn: -vf chain, no canvas', none.includes('-vf') && !graphOf(none).includes('hwupload'), true);
  const three = graphOf(build({ profile: vaapi, overlayImages: [bounce(1), bounce(2), bounce(3)] }));
  check('three movers: all on the canvas (eight passes would cost more than one canvas)', three.includes('2*(W-w)') && !three.includes('crop=w='), true);
  check('a timed picture is not GPU-movable', gpuMovable({ ...bounce(1), start: 1, end: 5 }), false);
  check('an animated picture is not GPU-movable', gpuMovable({ ...bounce(1), animated: true }), false);
  check('a plain bouncing picture is', gpuMovable(bounce(1)), true);
}

console.log('\nthe CPU composite is opt-in');
{
  check('auto does not take it', cpuCompositeWanted({ subComposite: 'auto' }), false);
  check('absent does not take it', cpuCompositeWanted({}), false);
  check("'cpu' does", cpuCompositeWanted({ subComposite: 'cpu' }), true);
  check('...unless demoted', cpuCompositeWanted({ subComposite: 'cpu', noCpuComposite: true }), false);
  const g = graphOf(build({
    profile: { ...vaapi, subComposite: 'cpu' },
    selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: srt }, extractedPath: '/c/x.srt',
  }));
  check('opted in: the frame comes down, is drawn on, goes back up',
    g.includes('hwdownload,format=nv12,format=yuv420p') && g.includes('format=nv12,hwupload[v]'), true);
  check('...with no overlay_vaapi in it', g.includes('overlay_vaapi'), false);
}

console.log('\nthe mover builder on its own');
{
  const c = vaapiMovedImageChain([{ path: '/p.png', size: 0.1, speed: 0.06, motion: 'bounce' }], {
    width: 1280, height: 720, firstInput: 3, inLabel: 'in', outLabel: 'out', rate: '24', phase: 10, end: 100,
  });
  check('inputs: rate then path', c.inputs, ['-r', '24', '-i', '/p.png']);
  check('looping', c.looping, true);
  check('bounded by the caller\'s end', c.filters[0].includes('trim=end=100.000'), true);
  check('input index honoured', c.filters[0].startsWith('[3:v]'), true);
  check('labels join', c.filters[1], '[in][mv0]overlay_vaapi=x=0:y=0:eof_action=repeat[out]');
  check('nothing for no pictures', vaapiMovedImageChain([], {}).filters, []);
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall passed');
