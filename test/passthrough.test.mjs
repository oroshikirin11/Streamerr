/**
 * HEVC passthrough eligibility, pinned.
 *
 * The rule: codec=hevc + an HEVC-native file + NOTHING to draw = the video
 * stream ships untouched. Anything to draw — a subtitle, a studio item, a
 * pipe — and it transcodes like always. H.264 never takes this path.
 *
 * Run: node test/passthrough.test.mjs
 */
import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';

const profile = {
  backend: 'vaapi', device: '/dev/dri/renderD128',
  width: 1920, height: 1080, fps: 30, fpsMode: 'auto',
  videoBitrate: '8000k', audioBitrate: '160k', gopSeconds: 2,
  gpuFull: true, gpuSubs: true, codec: 'hevc',
};
const hevcVideo = {
  width: 1920, height: 1080, codec: 'hevc', frameRate: '24000/1001',
  sar: '1:1', dar: '16:9', hdr: false,
};
const h264Video = { ...hevcVideo, codec: 'h264' };
const textSub = { codec: 'ass', typeIndex: 0, external: false };
const still = {
  path: '/app/overlays/logo.png', x: 0.1, y: 0.1, size: 0.2,
  opacity: 1, enabled: true,
};

const base = {
  srcPath: '/media/ep1.mkv',
  offset: 0,
  profile,
  selection: { video: hevcVideo, audio: { typeIndex: 0 }, subtitle: null },
  duration: 1440,
  tsOffset: 0,
};

const isCopy = (args) => {
  const i = args.indexOf('-c:v');
  return i !== -1 && args[i + 1] === 'copy';
};

let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
};

// The eligible case, and what its command must carry.
const copy = buildSourceArgs(base);
check('hevc-native, empty studio -> copy', isCopy(copy));
check('copy carries no video filter', !copy.includes('-vf') && !copy.includes('-filter_complex'));
check('copy conforms audio to aac', copy.includes('aac'));
check('copy keeps the timeline offset', copy.includes('-output_ts_offset'));
check('copy at offset 0 does not seek', !copy.includes('-ss'));
const seeked = buildSourceArgs({ ...base, offset: 300.5 });
check('copy mid-clip seeks before input', seeked[seeked.indexOf('-ss') + 1] === '300.500'
  && seeked.indexOf('-ss') < seeked.indexOf('-i'));

// Every ineligibility, one by one.
check('subtitle selected -> transcode', !isCopy(buildSourceArgs({
  ...base,
  selection: { ...base.selection, subtitle: textSub },
  extractedPath: '/cache/x.ass',
})));
check('still picture -> transcode', !isCopy(buildSourceArgs({
  ...base, overlayImages: [still],
})));
check('studio text (overlay ass) -> transcode', !isCopy(buildSourceArgs({
  ...base, overlayPath: '/cache/overlay.ass',
})));
check('bouncing text -> transcode', !isCopy(buildSourceArgs({
  ...base, overlayAnimated: true,
})));
check('h264-native under codec=hevc -> transcode', !isCopy(buildSourceArgs({
  ...base, selection: { ...base.selection, video: h264Video },
})));
check('hevc-native under codec=h264 -> transcode (h264 path untouched)',
  !isCopy(buildSourceArgs({
    ...base, profile: { ...profile, codec: 'h264' },
  })));

// Bitrate ceiling: copy ships the FILE's rate, so remux-dense files encode.
check('25 Mbps 4K HDR film under the 30000k limit -> passthrough (verified use case)',
  isCopy(buildSourceArgs({ ...base, srcKbps: 25300 })));
check('54 Mbps remux over the limit -> transcode', !isCopy(buildSourceArgs({
  ...base, srcKbps: 54000,
})));
check('copyLimitKbps override lifts the ceiling', isCopy(buildSourceArgs({
  ...base, srcKbps: 54000, profile: { ...profile, copyLimitKbps: 60000 },
})));
check('unknown rate -> passthrough (benefit of the doubt)', isCopy(buildSourceArgs({
  ...base, srcKbps: null,
})));

// Seam alignment: with a probed landing, the copy opens the file twice.
check('copyAlign gap -> two inputs, itsoffset folds the gap', (() => {
  const s = buildSourceArgs({ ...base, offset: 115.5,
    copyAlign: { req: 115.5, landing: 110.0 } });
  const j = s.join(' ');
  return j.includes('-itsoffset 5.500') && j.includes('-ss 115.500')
    && j.includes('-ss 110.000') && j.includes('-map 1:a:0?')
    && s.filter((a) => a === '-i').length === 2;
})());
check('copyAlign landing==request -> single input as before', (() => {
  const s = buildSourceArgs({ ...base, offset: 60,
    copyAlign: { req: 60, landing: 60 } });
  return s.filter((a) => a === '-i').length === 1 && s.join(' ').includes('-map 0:a:0?');
})());
check('hevc copy carries initial_discontinuity', buildSourceArgs(base)
  .join(' ').includes('+resend_headers+initial_discontinuity'));

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
