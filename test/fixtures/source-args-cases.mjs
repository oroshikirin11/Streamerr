/**
 * The buildSourceArgs matrix shared by the golden capture and the golden
 * test. One definition, or the test would quietly assert different inputs
 * than were captured.
 *
 * The shapes mirror real broadcasts from 2026-08-29 logs: JJK (16:9 with
 * subtitles), Berserk (4:3 pillarboxed), Backrooms (HDR, no subtitles),
 * Lain (odd geometry, no subtitles, moving picture).
 */

const vaapi = {
  backend: 'vaapi',
  device: '/dev/dri/renderD128',
  width: 1920,
  height: 1080,
  fps: 30,
  fpsMode: 'auto',
  videoBitrate: '12000k',
  audioBitrate: '160k',
  gopSeconds: 2,
  gpuFull: true,
  tonemap: 'vaapi',
};

const video169 = {
  width: 1920, height: 1080, codec: 'h264', frameRate: '24000/1001',
  sar: '1:1', dar: '16:9', hdr: false,
};
const video43 = {
  width: 1440, height: 1080, codec: 'h264', frameRate: '24000/1001',
  sar: '1:1', dar: '4:3', hdr: false,
};
const videoHdr = {
  width: 3836, height: 2072, codec: 'hevc', frameRate: '24000/1001',
  sar: '1:1', dar: '137:74', hdr: true,
};

const textSub = { codec: 'ass', typeIndex: 0, external: false };
const censor = { id: 'c1', type: 'censor', x: 0.5, y: 0.5, w: 0.25, h: 0.2, strength: 5, enabled: true };

const still = {
  path: '/app/overlays/airfryer.png', x: 0.1, y: 0.1, size: 0.2,
  opacity: 1, enabled: true,
};
const bouncing = { ...still, motion: 'bounce', speed: 0.1 };

export const cases = {
  'subtitled 16:9, gpu canvas': {
    srcPath: '/media/jjk-e1.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: true },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/5079e36bbb7fccf0.ass',
    fontsDir: '/cache/fonts-6f7a0f7df983d8f8',
    duration: 1440.657,
  },
  'subtitled 16:9 mid-clip (apply respawn)': {
    srcPath: '/media/jjk-e1.mkv',
    offset: 66.112,
    profile: { ...vaapi, gpuSubs: true },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/5079e36bbb7fccf0.ass',
    fontsDir: '/cache/fonts-6f7a0f7df983d8f8',
    duration: 1440.657,
    tsOffset: 66.112,
  },
  'subtitled pillarbox, pad-overlay': {
    srcPath: '/media/berserk-e1.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: true, barsGraph: 'pad-overlay' },
    selection: { video: video43, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/berserk.ass',
    duration: 1475,
  },
  'subtitled pillarbox, wide-canvas': {
    srcPath: '/media/berserk-e1.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: true, barsGraph: 'wide-canvas' },
    selection: { video: video43, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/berserk.ass',
    duration: 1475,
  },
  'subtitled pillarbox, bg-composite': {
    srcPath: '/media/berserk-e1.mkv',
    offset: 187,
    profile: { ...vaapi, gpuSubs: true, barsGraph: 'bg-composite' },
    selection: { video: video43, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/berserk.ass',
    duration: 1475,
    tsOffset: 187,
  },
  'no subtitles, fast path': {
    srcPath: '/media/backrooms.mkv',
    offset: 0,
    profile: { ...vaapi },
    selection: { video: videoHdr, audio: { typeIndex: 0 }, subtitle: null },
    duration: 6628.788,
  },
  'no subtitles, still picture on gpu': {
    srcPath: '/media/backrooms.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: true },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: null },
    overlayImages: [still],
    duration: 6628.788,
  },
  'no subtitles, moving picture (canvas forced)': {
    srcPath: '/media/lain-e1.mkv',
    offset: 29.035,
    profile: { ...vaapi, gpuSubs: true },
    selection: {
      video: {
        width: 1512, height: 1072, codec: 'h264', frameRate: '24000/1001',
        sar: '1:1', dar: '189:134', hdr: false,
      },
      audio: { typeIndex: 0 },
      subtitle: null,
    },
    overlayImages: [bouncing],
    duration: 1475,
    tsOffset: 29.035,
  },
  'subtitles + moving picture on canvas': {
    srcPath: '/media/jjk-e1.mkv',
    offset: 66.112,
    profile: { ...vaapi, gpuSubs: true },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/5079e36bbb7fccf0.ass',
    fontsDir: '/cache/fonts-6f7a0f7df983d8f8',
    overlayImages: [bouncing],
    duration: 1440.657,
    tsOffset: 66.112,
  },
  'text overlay only (no subtitle track)': {
    srcPath: '/media/jjk-e1.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: true },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: null },
    overlayPath: '/cache/overlay-abc.ass',
    duration: 1440.657,
  },
  'cpu burn path (gpuSubs off)': {
    srcPath: '/media/jjk-e1.mkv',
    offset: 0,
    profile: { ...vaapi, gpuSubs: false },
    selection: { video: video169, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/5079e36bbb7fccf0.ass',
    duration: 1440.657,
  },
  // Censor boxes: a drawn thing with no canvas. The HDR fast path must
  // give way to a transcode carrying the stage, and a pillarboxed
  // composite must place the box in the bare rect's own coordinates.
  'no subtitles, censor box (no canvas)': {
    srcPath: '/media/backrooms.mkv',
    offset: 0,
    profile: { ...vaapi, overlay: [censor] },
    selection: { video: videoHdr, audio: { typeIndex: 0 }, subtitle: null },
    duration: 6628.788,
  },
  'subtitled pillarbox, bg-composite + censor box': {
    srcPath: '/media/berserk-e1.mkv',
    offset: 187,
    profile: { ...vaapi, gpuSubs: true, barsGraph: 'bg-composite', overlay: [censor] },
    selection: { video: video43, audio: { typeIndex: 0 }, subtitle: textSub },
    extractedPath: '/cache/berserk.ass',
    duration: 1475,
  },
};
