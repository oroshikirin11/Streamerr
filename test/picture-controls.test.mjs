/**
 * The picture controls, pinned: deinterlacing, HDR output, tone-map curve.
 *
 * Run: node test/picture-controls.test.mjs
 */
import { buildSourceArgs, buildChunkArgs, scaleAndTonemap, contentRect } from '../src/ffmpeg/pipeline.js';

const profile = {
  backend: 'vaapi', device: '/dev/dri/renderD128',
  width: 1920, height: 1080, fps: 30, fpsMode: 'auto',
  videoBitrate: '8000k', audioBitrate: '160k', gopSeconds: 2,
  gpuFull: true, gpuSubs: true, codec: 'hevc', tonemap: 'vaapi',
};
const sdr = {
  width: 1920, height: 1080, codec: 'h264', frameRate: '24000/1001',
  sar: '1:1', dar: '16:9', hdr: false, pixFmt: 'yuv420p', interlaced: false,
};
const hdr = { ...sdr, codec: 'av1', hdr: true, pixFmt: 'yuv420p10le' };
const hdrHevc = { ...sdr, codec: 'hevc', hdr: true, pixFmt: 'yuv420p10le' };
const laced = { ...sdr, interlaced: true };
const textSub = { codec: 'ass', typeIndex: 0, external: false };
const still = {
  path: '/app/overlays/logo.png', x: 0.1, y: 0.1, size: 0.2,
  opacity: 1, enabled: true,
};

const base = (video, extra = {}, prof = {}) => buildSourceArgs({
  srcPath: '/media/ep1.mkv', offset: 0,
  profile: { ...profile, ...prof },
  selection: { video, audio: { typeIndex: 0 }, subtitle: null },
  duration: 1440, tsOffset: 0, ...extra,
});
const joined = (args) => args.join(' ');

let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
};

// ── deinterlacing ────────────────────────────────────────────────────
check('progressive + auto -> no deinterlacer',
  !joined(base(sdr)).includes('deinterlace'));
check('interlaced + auto -> deinterlace_vaapi in the chain', (() => {
  // identity-scale geometry, so the scaler may be 'null' — presence is
  // the assertion; ordering is covered by the pillarboxed case below.
  return joined(base(laced, {}, { codec: 'h264' })).includes('deinterlace_vaapi');
})());
check('interlaced 4:3 -> deinterlacer runs before the scale', (() => {
  const nv = { ...laced, width: 1440, height: 1080, dar: '4:3' };
  const s = joined(base(nv, { selection: { video: nv, audio: { typeIndex: 0 }, subtitle: null } }, { codec: 'h264' }));
  const d = s.indexOf('deinterlace_vaapi');
  return d !== -1 && s.indexOf('scale_vaapi') !== -1 && d < s.indexOf('scale_vaapi');
})());
check('interlaced + off -> no deinterlacer',
  !joined(base(laced, {}, { deinterlace: 'off' })).includes('deinterlace'));
check('progressive + on -> forced deinterlacer',
  joined(base(sdr, {}, { deinterlace: 'on' })).includes('deinterlace_vaapi'));
check('interlaced + subtitles (canvas path) -> deinterlaced too',
  joined(base(laced, {
    selection: { video: laced, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/x.ass',
  })).includes('deinterlace_vaapi'));
check('interlaced + cpu path (gpuFull off) -> bwdif',
  joined(base(laced, {}, { gpuFull: false, gpuSubs: false })).includes('bwdif'));
check('chunked path deinterlaces with bwdif',
  buildChunkArgs({
    srcPath: '/m.mkv', start: 0, dur: 20, out: '/tmp/c.ts',
    profile: { ...profile, gpuFull: false },
    selection: { video: laced, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/x.ass',
  }).join(' ').includes('bwdif'));

// ── HDR output ───────────────────────────────────────────────────────
const hdrOut = joined(base(hdr, {}, { hdrOut: true }));
check('hdrOut + HDR source -> P010 kept, no tone map',
  hdrOut.includes('format=p010') && !hdrOut.includes('tonemap'));
check('hdrOut carries the PQ colour tags',
  hdrOut.includes('-color_trc smpte2084') && hdrOut.includes('bt2020nc'));
check('hdrOut + SDR source -> normal SDR chain',
  !joined(base(sdr, {}, { hdrOut: true })).includes('p010'));
check('hdrOut + subtitles -> tone-mapped SDR (drawing wins)', (() => {
  const s = joined(base(hdr, {
    selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/x.ass',
  }, { hdrOut: true }));
  return s.includes('tonemap_vaapi') && !s.includes('format=p010,');
})());
check('hdrOut + still picture -> tone-mapped SDR (drawing wins)',
  joined(base(hdr, { overlayImages: [still] }, { hdrOut: true }))
    .includes('tonemap_vaapi'));
check('hdrOut off + HDR source -> tone-mapped as always',
  joined(base(hdr)).includes('tonemap_vaapi'));

// ── HDR x passthrough policy ─────────────────────────────────────────
check('HDR hevc-native + hdr WANTED + empty studio -> passthrough copy', (() => {
  const s = base(hdrHevc, {}, { hdrWanted: true, hdrOut: true });
  return s[s.indexOf('-c:v') + 1] === 'copy';
})());
check('HDR hevc-native + hdr OFF -> transcode + tonemap, never copy', (() => {
  const s = base(hdrHevc);
  return s[s.indexOf('-c:v') + 1] !== 'copy' && s.join(' ').includes('tonemap_vaapi');
})());
check('SDR hevc-native + hdr OFF -> passthrough unaffected', (() => {
  const sdrHevc = { ...sdr, codec: 'hevc' };
  const s = base(sdrHevc);
  return s[s.indexOf('-c:v') + 1] === 'copy';
})());

// ── CPU-path tone mapping (the closed gap) ───────────────────────────
check('cpu fallthrough + HDR -> tone-mapped after scale, before pad', (() => {
  const s = joined(base(hdr, {}, { gpuFull: false, gpuSubs: false, tonemap: 'cpu' }));
  const t = s.indexOf('tonemap=');
  return t !== -1 && s.indexOf('scale=') < t && t < s.indexOf(',pad=')
    && s.includes('format=yuv420p');
})());
check('cpu subtitle burn + HDR -> subs land on SDR (tonemap before burn)', (() => {
  const s = joined(base(hdr, {
    selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/x.ass',
  }, { gpuFull: false, gpuSubs: false, tonemap: 'cpu' }));
  const t = s.indexOf('tonemap=');
  return t !== -1 && t < s.indexOf('subtitles=');
})());
check('cpu fallthrough + HDR + tonemap none -> untouched (operator said so)',
  !joined(base(hdr, {}, { gpuFull: false, gpuSubs: false, tonemap: 'none' }))
    .includes('tonemap='));
check('cpu fallthrough + SDR -> no tone map',
  !joined(base(sdr, {}, { gpuFull: false, gpuSubs: false, tonemap: 'cpu' }))
    .includes('tonemap='));
check('chunked + HDR -> tone-mapped with the chosen curve',
  buildChunkArgs({
    srcPath: '/m.mkv', start: 0, dur: 20, out: '/tmp/c.ts',
    profile: { ...profile, gpuFull: false, tonemap: 'cpu', tonemapCurve: 'reinhard' },
    selection: { video: hdr, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/x.ass',
  }).join(' ').includes('tonemap=reinhard'));

// ── tone-map curve ───────────────────────────────────────────────────
const rect = contentRect(hdr, profile);
check('cpu engine takes the chosen curve',
  scaleAndTonemap(hdr, { ...profile, tonemap: 'cpu', tonemapCurve: 'mobius' }, rect, '')
    .includes('tonemap=mobius'));
check('no curve set -> hable, exactly as before',
  scaleAndTonemap(hdr, { ...profile, tonemap: 'cpu' }, rect, '')
    .includes('tonemap=hable:desat=0'));
check('bogus curve falls back to hable',
  scaleAndTonemap(hdr, { ...profile, tonemap: 'cpu', tonemapCurve: 'x,evil' }, rect, '')
    .includes('tonemap=hable'));
check('vaapi engine ignores the curve (driver-fixed)',
  scaleAndTonemap(hdr, { ...profile, tonemap: 'vaapi', tonemapCurve: 'mobius' }, rect, '')
    .includes('tonemap_vaapi'));

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
