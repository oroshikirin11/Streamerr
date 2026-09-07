/**
 * The screen share, browser side.
 *
 * A module store rather than page state: the MediaStream, the recorder and
 * the socket must survive navigation — the operator picks a screen here,
 * walks to the Studio to place a caption, and comes back — so they live for
 * as long as the app does. The Capture page and the transport bar both
 * render from `cap`.
 *
 *   getDisplayMedia ─► MediaRecorder ─► ws /ws/capture ─► the box
 *
 * The browser encodes (H.264 where it can, so the box may ship it
 * untouched), the box does everything else. Nothing here touches the
 * broadcast until goLive().
 */
import { api } from './api.js';

export const cap = $state({
  /** idle | picking | armed | live */
  phase: 'idle',
  /** The picked MediaStream, for the local preview. */
  stream: null,
  surface: null,
  width: null,
  height: null,
  fps: null,
  audio: false,
  audioFrom: '',
  mime: '',
  title: 'Screen',
  error: '',
  /** Our session id on the server, once it has acknowledged the hello. */
  sessionId: null,
  /** What the server last said about the capture (its status block). */
  server: null,
  /** Sender-side health, refreshed every second while sharing. */
  sending: { kbps: 0, backlog: 0, fps: null, bytes: 0 },
  busy: '',
});

const QUALITY_BPS = { sharp: 12_000_000, balanced: 8_000_000, light: 4_000_000 };

/** The recorder types worth asking for, best first. H.264 lets the box copy. */
const MIME_CANDIDATES = [
  'video/webm;codecs=h264,opus',
  'video/x-matroska;codecs=avc1,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export const supported = () => typeof navigator !== 'undefined'
  && Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== 'undefined';
export const secure = () => typeof window !== 'undefined' && window.isSecureContext === true;

let rec = null;
let ws = null;
let healthTimer = null;
let audioCtx = null;
let extraTracks = [];
let sendChain = Promise.resolve();
let sentBytes = 0;
let sentAtTick = 0;
let ended = false;

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* next */ }
  }
  return '';
}

function shortUa() {
  const s = navigator.userAgent;
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  const b = /Edg\/(\d+)/.exec(s) ? `Edge ${RegExp.$1}` : /Firefox\/(\d+)/.exec(s) ? `Firefox ${RegExp.$1}`
    : /Chrome\/(\d+)/.exec(s) ? `Chrome ${RegExp.$1}` : 'Browser';
  return os ? `${b} on ${os}` : b;
}

const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/**
 * A microphone track — or, with `monitor`, the device that carries what
 * the speakers play. On Linux (PipeWire/Pulse) every output has a
 * "Monitor of …" input; capturing it sends what you hear without opening a
 * real microphone, which is the one route measured to work on the A50
 * without cutting local playback. Device labels are only readable once
 * some audio permission exists, so a first open may be needed to find it.
 */
async function openMic(monitor) {
  if (!monitor) {
    const m = await navigator.mediaDevices.getUserMedia({ audio: raw });
    return m.getAudioTracks()[0] ?? null;
  }
  const find = async () => (await navigator.mediaDevices.enumerateDevices())
    .find((d) => d.kind === 'audioinput' && /monitor/i.test(d.label));
  let dev = await find();
  let first = null;
  if (!dev) {
    first = await navigator.mediaDevices.getUserMedia({ audio: raw });
    dev = await find();
  }
  if (!dev) {
    first?.getTracks().forEach((t) => t.stop());
    throw new Error('no "Monitor of …" device is offered by this browser — on Windows and macOS choose Microphone and share a tab for its sound; on Linux check that PipeWire exposes the output\'s monitor');
  }
  const m = await navigator.mediaDevices.getUserMedia({ audio: { ...raw, deviceId: { exact: dev.deviceId } } });
  first?.getTracks().forEach((t) => t.stop());
  return m.getAudioTracks()[0] ?? null;
}

/**
 * Ask the browser for a screen, wire the recorder and the socket, and
 * hold the stream (armed). Nothing goes on air yet.
 *
 * @param {object} o
 * @param {object} o.settings   config.capture: quality, fps, audio
 * @param {object} o.encoder    config.encoder: width, height (the frame the box outputs)
 */
export async function pick({ settings = {}, encoder = {} } = {}) {
  if (cap.phase !== 'idle') return;
  cap.error = '';
  cap.phase = 'picking';
  ended = false;
  const fps = Number(settings.fps) === 60 ? 60 : 30;
  const maxW = Number(encoder.width) > 0 ? Number(encoder.width) : 1920;
  const maxH = Number(encoder.height) > 0 ? Number(encoder.height) : 1080;
  let display;
  const constraints = (withAudio, monitorFirst = true) => ({
    video: {
      // Open the picker on monitors — unless the browser cannot start a
      // monitor capture at all (no compositor support), in which case the
      // hint is dropped and whatever it can capture is offered.
      ...(monitorFirst ? { displaySurface: 'monitor' } : {}),
      frameRate: { ideal: fps, max: fps },
      width: { max: maxW },
      height: { max: maxH },
    },
    audio: withAudio
      ? { systemAudio: 'include', suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false }
      : false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    preferCurrentTab: false,
  });
  let audioFailed = '';
  try {
    const ask = async (withAudio) => {
      try {
        return await navigator.mediaDevices.getDisplayMedia(constraints(withAudio, true));
      } catch (err) {
        if (err?.name === 'NotReadableError' && /video/i.test(String(err?.message ?? ''))) {
          return navigator.mediaDevices.getDisplayMedia(constraints(withAudio, false));
        }
        throw err;
      }
    };
    try {
      display = await ask(settings.audio !== 'none');
    } catch (err) {
      // "Could not start audio source": the picture was fine, the audio
      // side was not (no audio device, a surface without sound). The
      // share is worth having without it — ask again for video only.
      if (settings.audio !== 'none' && /audio/i.test(String(err?.message ?? '')) && err?.name !== 'NotAllowedError') {
        audioFailed = err.message;
        display = await ask(false);
      } else {
        throw err;
      }
    }
  } catch (err) {
    cap.phase = 'idle';
    // The operator closed the picker: not an error worth a red line.
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return;
    cap.error = err?.message ?? String(err);
    return;
  }
  if (audioFailed) cap.error = `Sharing without audio — the browser could not start it (${audioFailed}).`;
  const vtrack = display.getVideoTracks()[0];
  if (!vtrack) { cap.phase = 'idle'; cap.error = 'The browser gave no video track.'; return; }
  const st = vtrack.getSettings?.() ?? {};
  cap.surface = st.displaySurface ?? null;
  cap.width = st.width ?? null;
  cap.height = st.height ?? null;
  cap.fps = st.frameRate ? Math.round(st.frameRate) : fps;

  // Audio: what the picker gave, the microphone, both mixed, or nothing.
  const tracks = [vtrack];
  let displayAudio = display.getAudioTracks()[0] ?? null;
  const want = settings.audio ?? 'auto';
  let mic = null;
  if (want === 'mic' || want === 'both' || want === 'monitor') {
    try {
      mic = await openMic(want === 'monitor');
    } catch (err) {
      cap.error = `${want === 'monitor' ? 'What I hear' : 'Microphone'}: ${err?.message ?? err}`;
    }
  }
  if (want === 'mic' || want === 'monitor') displayAudio = null;
  if (want === 'none') displayAudio = null;
  const sources = [displayAudio, mic].filter(Boolean);
  if (sources.length === 1) {
    tracks.push(sources[0]);
    cap.audioFrom = sources[0] === mic ? (want === 'monitor' ? 'what you hear' : 'microphone') : 'system';
  } else if (sources.length === 2) {
    // Mixed to one track; the recorder takes exactly one audio track.
    try {
      audioCtx = new AudioContext({ sampleRate: 48000 });
      const dest = audioCtx.createMediaStreamDestination();
      for (const t of sources) audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
      cap.audioFrom = 'system + microphone';
    } catch {
      tracks.push(sources[0]);
      cap.audioFrom = 'system';
    }
  } else {
    cap.audioFrom = '';
  }
  extraTracks = [displayAudio, mic].filter((t) => t && !tracks.includes(t));
  cap.audio = tracks.length > 1;
  const stream = new MediaStream(tracks);
  cap.stream = stream;

  const mime = pickMime();
  cap.mime = mime;
  const bps = QUALITY_BPS[settings.quality] ?? QUALITY_BPS.balanced;
  try {
    rec = new MediaRecorder(stream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond: bps,
      audioBitsPerSecond: 128_000,
      // A keyframe every two seconds: what the box segments on, and what
      // bounds the picture lost across an Apply (Chrome honours this).
      videoKeyFrameIntervalDuration: 2000,
    });
  } catch (err) {
    cleanup();
    cap.phase = 'idle';
    cap.error = `The browser cannot record this stream: ${err?.message ?? err}`;
    return;
  }

  // The socket, then hello, then bytes in order.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/capture`);
  ws.binaryType = 'arraybuffer';
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('The box would not take the share (socket error)'));
    ws.onclose = (ev) => reject(new Error(ev.reason || 'The box closed the share'));
  });
  try {
    await opened;
  } catch (err) {
    cleanup();
    cap.phase = 'idle';
    cap.error = err.message;
    return;
  }
  ws.onerror = null;
  ws.onclose = (ev) => {
    const why = ev?.reason || '';
    const wasLive = cap.phase === 'live';
    cleanup();
    cap.phase = 'idle';
    if (!ended && why && !/ended|stopped/.test(why)) cap.error = why;
    else if (!ended && wasLive) cap.error = '';
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'state') {
      cap.server = m;
      if (m.session?.id && !cap.sessionId) cap.sessionId = m.session.id;
      if (m.session?.state === 'live' && cap.phase === 'armed') cap.phase = 'live';
      if (m.session?.title) cap.title = m.session.title;
    } else if (m.type === 'error') {
      cap.error = m.message ?? 'The box refused the share';
    }
  };
  ws.send(JSON.stringify({
    type: 'hello',
    mime, width: cap.width, height: cap.height, fps: cap.fps, audio: cap.audio,
    title: cap.title, surface: cap.surface, kbps: Math.round(bps / 1000), sender: shortUa(),
  }));

  sentBytes = 0;
  sentAtTick = 0;
  rec.ondataavailable = (e) => {
    if (!e.data?.size) return;
    // Blobs resolve asynchronously; chain them so bytes leave in order.
    sendChain = sendChain.then(async () => {
      const buf = await e.data.arrayBuffer();
      if (ws?.readyState === 1) { ws.send(buf); sentBytes += buf.byteLength; }
    }).catch(() => {});
  };
  rec.onerror = (e) => { cap.error = `Recorder: ${e?.error?.message ?? 'failed'}`; stop(); };
  vtrack.onended = () => stop();      // the browser's own "Stop sharing"
  rec.start(250);
  cap.phase = 'armed';

  healthTimer = setInterval(() => {
    const t = cap.stream?.getVideoTracks?.()[0];
    const s = t?.getSettings?.() ?? {};
    const kbps = Math.round(((sentBytes - sentAtTick) * 8) / 1000);
    sentAtTick = sentBytes;
    cap.sending = {
      kbps,
      backlog: ws?.bufferedAmount ?? 0,
      fps: s.frameRate ? Math.round(s.frameRate) : null,
      bytes: sentBytes,
    };
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'health', bufferedAmount: ws.bufferedAmount, kbps,
        fps: cap.sending.fps, muted: Boolean(t?.muted), width: s.width, height: s.height,
      }));
    }
  }, 1000);
}

/** Put the picked screen on air. The box refuses while media is on air. */
export async function goLive() {
  if (cap.phase !== 'armed') return;
  cap.busy = 'go';
  cap.error = '';
  try {
    // The recording reaches the box a moment after the picker closes. Wait
    // for its first video rather than refuse, and if nothing comes, say
    // which side is silent: this browser, or the box.
    const t0 = Date.now();
    for (;;) {
      const st = await api.get('/api/capture');
      if (st?.session?.feed?.bytesIn > 0 && st.session.codec) break;
      if (Date.now() - t0 > 10_000) {
        throw new Error(cap.sending.bytes === 0
          ? 'Your browser is not producing a recording of the picked screen — nothing has been sent in ten seconds. Cancel, make sure the shared screen or window is visible, and pick again.'
          : `The box received ${Math.round(cap.sending.bytes / 1024)} KB but no video yet — the recording may be in a format it cannot read (${cap.mime || 'unknown'}). Cancel and try another browser.`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const r = await api.post('/api/capture/go');
    if (r?.capture) cap.server = r.capture;
    cap.phase = 'live';
  } catch (err) {
    cap.error = err.message;
  } finally {
    cap.busy = '';
  }
}

export async function setTitle(title) {
  cap.title = String(title ?? '').trim().slice(0, 80) || 'Screen';
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'title', title: cap.title }));
}

/** Stop sharing: the recorder, the tracks, the socket. The box sees EOF. */
export function stop() {
  if (cap.phase === 'idle') return;
  ended = true;
  try { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'end' })); } catch { /* gone */ }
  cleanup();
  cap.phase = 'idle';
}

function cleanup() {
  clearInterval(healthTimer);
  healthTimer = null;
  try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* gone */ }
  rec = null;
  for (const t of [...(cap.stream?.getTracks?.() ?? []), ...extraTracks]) {
    try { t.stop(); } catch { /* gone */ }
  }
  extraTracks = [];
  try { audioCtx?.close(); } catch { /* gone */ }
  audioCtx = null;
  const w = ws;
  ws = null;
  if (w) {
    w.onclose = null;
    w.onmessage = null;
    // Let queued bytes leave before the close where possible.
    sendChain.then(() => { try { w.close(1000, 'ended'); } catch { /* gone */ } }).catch(() => {});
  }
  cap.stream = null;
  cap.sessionId = null;
  cap.sending = { kbps: 0, backlog: 0, fps: null, bytes: 0 };
}
