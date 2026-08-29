/**
 * The HDR filter chain, per strategy.
 *
 * This decides whether an HDR title plays at all. Getting it wrong does not
 * degrade the picture — it kills the clip with -22 on the ENCODER, several
 * stages downstream of the cause, which is exactly why it cost two rounds to
 * find. Two drivers already refuse in two different ways:
 *
 *   Mesa / RX 6900 XT   VAAPI driver doesn't support HDR      (capability)
 *   Intel iHD / N100    No mastering display data from input  (per frame)
 *
 * So the chain each strategy produces is pinned here, and the engine treats
 * a failure as the answer rather than trying to predict one.
 *
 * Run: node test/tonemap.test.mjs
 */
import { scaleAndTonemap } from '../src/ffmpeg/pipeline.js';

let failures = 0;
const check = (name, actual, expected) => {
  if (actual === expected) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${expected}\n          actual   ${actual}`);
};
const rect = { w: 1920, h: 1038 };
const sdr = { hdr: false };
const hdr = { hdr: true };

console.log('\nSDR is never tone mapped, whatever the device can do');
for (const t of ['vaapi', 'cpu', 'none', undefined]) {
  check(`tonemap=${t}`, scaleAndTonemap(sdr, { tonemap: t }, rect, ''),
    'scale_vaapi=w=1920:h=1038:format=nv12');
}

console.log('\nHDR follows the strategy');
check('vaapi keeps the fixed-function filter',
  scaleAndTonemap(hdr, { tonemap: 'vaapi' }, rect, ':mode=fast'),
  'scale_vaapi=w=1920:h=1038:mode=fast,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709');
check('cpu goes down, maps, and comes back',
  scaleAndTonemap(hdr, { tonemap: 'cpu' }, rect, ':mode=fast'),
  'scale_vaapi=w=1920:h=1038:mode=fast,hwdownload,format=p010le,'
  + 'zscale=t=linear:npl=100,tonemap=hable:desat=0,'
  + 'zscale=p=bt709:t=bt709:m=bt709:r=tv,format=nv12,hwupload');
check('none still produces a broadcastable frame',
  scaleAndTonemap(hdr, { tonemap: 'none' }, rect, ''),
  'scale_vaapi=w=1920:h=1038:format=nv12');

console.log('\nthe unknown-hardware cases');
// A later clip can reach the graph before any strategy is recorded, because
// the engine's box is a copy taken at construction. The optimistic default
// is safe only because a failure demotes; assert it stays optimistic.
check('no strategy recorded falls back to the fast path',
  scaleAndTonemap(hdr, {}, rect, ''),
  'scale_vaapi=w=1920:h=1038,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709');
check('a null profile does not throw',
  scaleAndTonemap(hdr, null, rect, ''),
  'scale_vaapi=w=1920:h=1038,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709');
check('a null video is treated as SDR',
  scaleAndTonemap(null, { tonemap: 'cpu' }, rect, ''),
  'scale_vaapi=w=1920:h=1038:format=nv12');

console.log('\nevery HDR chain must still end on a GPU surface');
for (const t of ['vaapi', 'cpu', 'none']) {
  const chain = scaleAndTonemap(hdr, { tonemap: t }, rect, '');
  const ok = !chain.includes('hwdownload') || chain.trimEnd().endsWith('hwupload');
  check(`tonemap=${t} re-uploads if it downloads`, ok, true);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
