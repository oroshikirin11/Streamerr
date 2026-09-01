<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import DirBrowser from '$lib/DirBrowser.svelte';

  // Everything the wizard configures is editable here. Setup exists to get a
  // working system quickly, not to be the only way to change something.
  let cfg = $state(null);
  let error = $state('');
  let saved = $state('');
  let testing = $state('');

  // Secrets are write-only: the server returns a sentinel, never the value.
  let keyStored = $state(false);
  let streamKey = $state('');

  const PROTOCOL_INFO = [
    { id: 'tcp', label: 'TCP' },
    { id: 'rtmp', label: 'RTMP' },
    { id: 'rtmps', label: 'RTMPS' },
    { id: 'srt', label: 'SRT' },
  ];
  // Protocols that can carry a non-H.264 codec — mirror of the server's
  // protocolCarries(): container-honest transports only.
  const MODERN_CARRIERS = ['srt', 'tcp'];
  const uid = () => Math.random().toString(36).slice(2, 10);

  /**
   * Lowering the depth must carry the apply point down with it, or the
   * setting would ask for more cushion than exists and the engine would
   * quietly clamp it — the slider would then be showing a number that never
   * happens.
   */
  const BUFFER_PRESETS = [5, 10, 15, 30, 45, 60];
  let bufferSel = $state('15');

  /**
   * Simple mode: two orthogonal levers instead of the full page. A lever
   * writes the same config Advanced edits and saves immediately — there is
   * no second source of truth. Settings always opens in Simple; Advanced
   * is a per-visit choice, not a remembered one.
   */
  let viewMode = $state('simple');
  function setView(m) {
    viewMode = m;
  }
  const PICTURE_LEVERS = [
    { id: 'best', name: 'Best',
      desc: 'H.265, HDR kept, originals ship untouched when they fit the link.' },
    { id: 'compat', name: 'Compatible',
      desc: 'H.264 — plays on every device, ~1.5× the bandwidth.' },
  ];
  const TIMING_LEVERS = [
    { id: 30, name: 'Smooth', desc: '30 s cushion. Nothing interrupts the show.' },
    { id: 15, name: 'Balanced', desc: '15 s cushion. The default trade.' },
    { id: 5, name: 'Snappy', desc: '5 s cushion. Chat and stream feel close.' },
  ];
  const pictureCurrent = $derived.by(() => {
    if (!cfg) return null;
    // Simple's posture has no studio overlays: an enabled item changes the
    // pipeline (it can demote HDR), so a config carrying one is
    // "customized" until the operator picks a lever, which switches every
    // item off.
    if ((cfg.overlay?.items ?? []).some((i) => i?.enabled)) return null;
    const c = cfg.encoder?.codec || 'h264';
    if (c === 'hevc' && cfg.encoder?.hdrOutput) return 'best';
    if (c === 'h264') return 'compat';
    return null;
  });
  const timingCurrent = $derived.by(() => (cfg
    && TIMING_LEVERS.some((t) => t.id === cfg.buffer?.seconds) ? cfg.buffer.seconds : null));
  /**
   * "My settings": a snapshot of exactly the fields the two levers
   * overwrite, kept in the config so it follows the operator across
   * browsers. Saved automatically the moment a lever click would clobber
   * a hand-tuned state, restorable as a third chip on each lever, and
   * overwritable on demand.
   */
  const pictureSnapFields = () => ({
    codec: cfg.encoder.codec || 'h264',
    hdrOutput: Boolean(cfg.encoder.hdrOutput),
    copyLimitKbps: +cfg.encoder.copyLimitKbps || 0,
    overlayEnabled: (cfg.overlay?.items ?? []).map((i) => Boolean(i?.enabled)),
  });
  const timingSnapFields = () => ({
    seconds: +cfg.buffer.seconds,
    applySeconds: +cfg.buffer.applySeconds,
  });
  // A snapshot carries a name and a save time alongside its fields; a
  // legacy flat snapshot (the first shipped shape) is wrapped on read.
  const snapWrap = (s) => (s ? (s.fields ? s : { name: 'My settings', savedAt: null, fields: s }) : null);
  const pictureSnap = $derived(snapWrap(cfg?.presets?.picture));
  const timingSnap = $derived(snapWrap(cfg?.presets?.timing));
  const snapWhen = (s) => (s?.savedAt
    ? new Date(s.savedAt).toLocaleString(undefined,
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null);
  let pictureName = $state('');
  let timingName = $state('');
  const sameSnap = (a, b) => Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
  const pictureIsCustom = $derived(Boolean(cfg) && sameSnap(pictureSnapFields(), pictureSnap?.fields));
  const timingIsCustom = $derived(Boolean(cfg) && sameSnap(timingSnapFields(), timingSnap?.fields));

  async function savePictureSnap() {
    const snap = { name: (pictureName.trim() || pictureSnap?.name || 'My settings'),
      savedAt: new Date().toISOString(), fields: pictureSnapFields() };
    cfg.presets = { ...(cfg.presets ?? {}), picture: snap };
    pictureName = '';
    await api.saveConfig({ presets: { picture: snap } });
  }
  async function saveTimingSnap() {
    const snap = { name: (timingName.trim() || timingSnap?.name || 'My settings'),
      savedAt: new Date().toISOString(), fields: timingSnapFields() };
    cfg.presets = { ...(cfg.presets ?? {}), timing: snap };
    timingName = '';
    await api.saveConfig({ presets: { timing: snap } });
  }
  // Rename changes the label ONLY — never the captured fields. Re-saving
  // fields on rename would silently replace the saved setup with whatever
  // preset happens to be active at the time.
  async function renameSnap(which, name) {
    const cur = which === 'picture' ? pictureSnap : timingSnap;
    if (!cur) return;
    const snap = { ...cur, name: (name.trim() || cur.name) };
    cfg.presets = { ...(cfg.presets ?? {}), [which]: snap };
    await api.saveConfig({ presets: { [which]: snap } });
  }
  async function applyPictureSnap() {
    const s = pictureSnap?.fields;
    if (!s) return;
    cfg.encoder.codec = s.codec;
    cfg.encoder.hdrOutput = s.hdrOutput;
    cfg.encoder.copyLimitKbps = s.copyLimitKbps;
    syncPickers();
    await save('encoder');
    if (Array.isArray(s.overlayEnabled) && cfg.overlay?.items?.length) {
      cfg.overlay.items = cfg.overlay.items.map((i, idx) => (
        { ...i, enabled: Boolean(s.overlayEnabled[idx]) }));
      await api.saveConfig({ overlay: { items: cfg.overlay.items } });
    }
  }
  async function applyTimingSnap() {
    const s = timingSnap?.fields;
    if (!s) return;
    setBuffer(s.seconds);
    cfg.buffer.applySeconds = Math.min(+s.applySeconds, cfg.buffer.seconds);
    bufferSel = String(cfg.buffer.seconds);
    await save('timing');
  }
  async function applyPicture(id) {
    // A lever click on a hand-tuned state saves it as "My settings"
    // first, so the custom setup is one click away instead of gone.
    if (pictureCurrent === null && !pictureIsCustom) await savePictureSnap();
    if (id === 'best') {
      cfg.encoder.codec = 'hevc';
      cfg.encoder.hdrOutput = true;
      // Passthrough is half the point of Best; a limit below the default
      // would silently keep re-encoding, so it is lifted — never lowered.
      if (+cfg.encoder.copyLimitKbps < 30000) cfg.encoder.copyLimitKbps = 30000;
    } else {
      cfg.encoder.codec = 'h264';
    }
    syncPickers();
    await save('encoder');
    // Simple means no studio overlays: an enabled item (even hidden) can
    // demote HDR and change the pipeline. The lever switches every item
    // off; the items themselves stay in Studio, one click from returning.
    if ((cfg.overlay?.items ?? []).some((i) => i?.enabled)) {
      cfg.overlay.items = cfg.overlay.items.map((i) => ({ ...i, enabled: false }));
      await api.saveConfig({ overlay: { items: cfg.overlay.items } });
    }
  }
  async function applyTiming(n) {
    if (timingCurrent === null && !timingIsCustom) await saveTimingSnap();
    setBuffer(n);
    // The lever sets the whole timing posture, not just the depth: apply
    // point at the full cushion is the shipped default (seamless applies),
    // and without this a trip through Snappy would pin it low forever.
    cfg.buffer.applySeconds = n;
    bufferSel = String(n);
    await save('timing');
  }
  /** The lever's diff, shown under "what this sets". */
  const pictureDiff = (id) => (id === 'best'
    ? [['Codec', 'H.265'], ['HDR output', 'on'],
      ['Passthrough limit', 'at least 30 Mbps'],
      ['Studio overlays', 'all switched off']]
    : [['Codec', 'H.264'],
      ['Studio overlays', 'all switched off']]);

  function setBuffer(n) {
    const secs = Math.min(60, Math.max(1, Math.round(Number(n) || 15)));
    cfg.buffer.seconds = secs;
    if (cfg.buffer.applySeconds > secs) cfg.buffer.applySeconds = secs;
  }

  /**
   * A saved secret arrives as the sentinel, and rendering that in a password
   * box shows eight dots that look like a value and are not: the placeholder
   * never appears, and editing means clearing a fake string first. So the
   * field is blanked for display and the sentinel is put back on save for
   * anything the operator did not type into — which is exactly what the
   * server expects, and how the Owncast key field has always behaved.
   */
  const SECRET_OF = { rtmp: ['key'], rtmps: ['key'], srt: ['streamId', 'passphrase'], tcp: ['key', 'passphrase'] };
  let publishSaved = $state({});

  /**
   * Which catalogue supplies titles and artwork for this source. A provider
   * rather than a switch, because TheTVDB is next and a Jellyfin-shaped
   * control would have to be rebuilt to add it.
   */
  const metaProvider = $derived(src?.metadata?.provider ?? 'none');
  let metaKey = $state('');
  let match = $state(null);
  let matching = $state(false);

  function setMeta(p) {
    if (!src) return;
    src.metadata = { ...(src.metadata ?? {}), provider: p };
    match = null;
  }

  /** The media half alone — what a catalogue is compared against. */
  function mediaSourceOnly() {
    const { metadata, ...rest } = src ?? {};
    return rest;
  }

  /**
   * Compare the two libraries and keep the rules that fall out, so a path
   * mapping is never typed by hand.
   */
  async function runMatch() {
    matching = true; match = null;
    try {
      const r = await api.matchLibrary({
        media: mediaSourceOnly(),
        jellyfin: { url: src.metadata.url?.trim(), apiKey: metaKey || '__SET__' },
      });
      src.metadata = { ...src.metadata, pathMap: r.rules ?? [] };
      match = { ok: true, ...r };
    } catch (err) {
      match = { ok: false, error: err.message };
    } finally { matching = false; }
  }
  function unmaskPublish(pub) {
    const seen = {};
    for (const proto of ['rtmp', 'rtmps', 'srt', 'tcp']) {
      for (const f of SECRET_OF[proto]) {
        if (pub?.[proto]?.[f] === '__SET__') { seen[`${proto}.${f}`] = true; pub[proto][f] = ''; }
      }
    }
    for (const e of pub?.extras ?? []) {
      for (const f of SECRET_OF[e.protocol] ?? []) {
        if (e[f] === '__SET__') { seen[`x.${e.id}.${f}`] = true; e[f] = ''; }
      }
    }
    publishSaved = seen;
    return pub;
  }
  function maskPublish(pub) {
    const out = JSON.parse(JSON.stringify(pub));
    for (const proto of ['rtmp', 'rtmps', 'srt', 'tcp']) {
      for (const f of SECRET_OF[proto]) {
        if (!out[proto][f] && publishSaved[`${proto}.${f}`]) out[proto][f] = '__SET__';
      }
    }
    for (const e of out.extras ?? []) {
      for (const f of SECRET_OF[e.protocol] ?? []) {
        if (!e[f] && publishSaved[`x.${e.id}.${f}`]) e[f] = '__SET__';
      }
    }
    return out;
  }
  const savedHint = (k) => (publishSaved[k] ? 'saved — type to replace' : null);
  // The codec decides the carrier: H.264 rides the protocol chosen below,
  // anything newer needs SRT — the server routes the primary to its SRT
  // slot automatically. These helpers let the card say what will happen.
  const codecLabel = () => ({ hevc: 'H.265', av1: 'AV1' }[cfg.encoder.codec] ?? 'H.264');
  const effProto = () => {
    if ((cfg.encoder.codec || 'h264') === 'h264') return cfg.publish.protocol;
    // A modern codec keeps a carrier that can hold it; otherwise the
    // server routes to the SRT slot, so show that.
    return MODERN_CARRIERS.includes(cfg.publish.protocol) ? cfg.publish.protocol : 'srt';
  };
  const sitOuts = () => (cfg.publish.extras ?? [])
    .filter((e) => e.enabled !== false && !MODERN_CARRIERS.includes(e.protocol))
    .map((e) => e.name || e.protocol);
  function addExtra() {
    cfg.publish.extras = [...(cfg.publish.extras ?? []),
      { id: uid(), enabled: true, protocol: 'rtmp', url: '', key: '',
        streamId: '', passphrase: '', latencyMs: 200 }];
  }
  function removeExtra(id) {
    cfg.publish.extras = (cfg.publish.extras ?? []).filter((e) => e.id !== id);
  }
  let tokenStored = $state(false);
  let accessToken = $state('');
  let titleTest = $state(null);
  let jfKeyStored = $state(false);
  let jellyfinKey = $state('');

  let owncastResult = $state(null);
  let sgTests = $state({});
  let sgSaved = $state({});
  let libResult = $state(null);
  let encoders = $state(null);
  let pathmap = $state(null);

  let pwCurrent = $state('');
  let pwNext = $state('');
  let pwMsg = $state('');

  let fsRoots = $state('');
  let browsing = $state(false);

  function addRoot(path) {
    const roots = parseList(fsRoots);
    if (!roots.includes(path)) fsRoots = [...roots, path].join('\n');
    browsing = false;
  }

  // Common output sizes; Custom reveals the manual fields.
  const RES_PRESETS = [
    { key: '2160p', label: '2160p (4K)', w: 3840, h: 2160 },
    { key: '1440p', label: '1440p', w: 2560, h: 1440 },
    { key: '1080p', label: '1080p', w: 1920, h: 1080 },
    { key: '720p', label: '720p', w: 1280, h: 720 },
    { key: '480p', label: '480p', w: 854, h: 480 },
  ];
  let resPreset = $state('1080p');

  /**
   * The values worth offering for the fields that used to be open boxes.
   *
   * Each keeps a "Custom" escape hatch, so nothing that was settable before
   * stopped being settable — the list just means the common answer is one
   * click and a typo is not a silent misconfiguration.
   */
  const FPS_PRESETS = [24, 25, 30, 48, 50, 60];
  const GOP_PRESETS = [1, 2, 3, 4];
  const VBR_PRESETS = ['2000k', '3000k', '4500k', '6000k', '8000k', '12000k', '16000k'];
  const ABR_PRESETS = ['96k', '128k', '160k', '192k', '256k'];
  const SCAN_PRESETS = [6, 12, 24, 48, 168];
  // Passthrough-limit choices, labeled in Mbps: the number is really "how
  // much of the link a raw file may claim", so it reads in link units.
  const CLIM_PRESETS = [10000, 15000, 20000, 26000, 30000, 40000, 50000];
  const CHUNK_PRESETS = [10, 20, 30, 60];
  const scanLabel = (h) => (h === 168 ? 'Weekly' : h === 24 ? 'Daily' : `Every ${h} hours`);

  /** Server-supplied choices: the language table and the real /dev/dri nodes. */
  let options = $state(null);

  // Which dropdown entry is showing. 'custom' reveals the original free field.
  let fpsSel = $state('30');
  let gopSel = $state('2');
  let vbrSel = $state('6000k');
  let abrSel = $state('160k');
  let scanSel = $state('12');
  let climSel = $state('30000');
  let chunkSel = $state('20');
  let devSel = $state('/dev/dri/renderD128');
  /**
   * A render node's path says nothing about which GPU it is — the numbering
   * is enumeration order. Showing the name is what turns "renderD128" into
   * a decision the operator can actually make.
   */
  const nodeFor = (path) => options?.renderNodes?.find((n) => n.path === path) ?? null;
  const nodeLabel = (path) => {
    const n = nodeFor(path);
    const short = path.replace('/dev/dri/', '');
    return n?.name ? `${short} — ${n.name}` : short;
  };
  const chosenNode = $derived(nodeFor(cfg?.encoder?.device));
  /** Codes the picker does not offer — normLang passes those through. */
  let extraLangs = $state('');

  /** A bitrate may be stored bare ("4500") or suffixed ("4500k"); one form. */
  const brKey = (v) => {
    const t = String(v ?? '').trim().toLowerCase();
    return /^\d+$/.test(t) ? `${t}k` : t;
  };

  const pick = (list, value) => (list.some((x) => String(x) === String(value)) ? String(value) : 'custom');

  /**
   * The bitrate SLOT the codec choice selects — the protocol-slots idea
   * applied to bitrate. One dropdown ever shows one number: the rate of
   * the codec that is live. Each codec remembers its own; switching
   * codecs never loses the others. 'Auto' (non-H.264 only) keeps the slot
   * empty so the rate keeps deriving from the H.264 anchor.
   */
  const bitrateSlot = $derived((cfg?.encoder?.codec ?? 'h264') === 'h264'
    ? 'videoBitrate' : `${cfg.encoder.codec}Bitrate`);
  const derivedKbps = $derived.by(() => {
    const n = parseFloat(cfg?.encoder?.videoBitrate) || 6000;
    return Math.round(n * (cfg?.encoder?.codec === 'hevc' ? 2 / 3 : 1 / 2));
  });
  function syncVbr() {
    const v = cfg.encoder[bitrateSlot];
    if (bitrateSlot !== 'videoBitrate' && (v == null || v === '')) { vbrSel = 'auto'; return; }
    vbrSel = pick(VBR_PRESETS, brKey(v));
  }
  function chooseVbr(value) {
    if (value === 'auto') { cfg.encoder[bitrateSlot] = ''; return; }
    if (value !== 'custom') cfg.encoder[bitrateSlot] = value;
  }

  /**
   * The encoder choices: the static list straight away, replaced by the
   * probe's verdict once it has run so failures show their reason.
   */
  const encoderList = $derived(encoders?.encoders ?? options?.encoderBackends ?? []);

  /** Frame-size mode, tolerating a config written by an older build. */
  const frameSize = $derived(
    ['fixed', 'fit', 'native', 'source'].includes(cfg?.encoder?.frameSize)
      ? cfg.encoder.frameSize
      : (cfg?.encoder?.trimBars ? 'fit' : 'fixed'));
  /** A concrete 4:3 size for the explanation, derived from the chosen height. */
  const fitExample = $derived(
    `${Math.round(((+cfg?.encoder?.height || 1080) * 4 / 3) / 2) * 2}×${+cfg?.encoder?.height || 1080}`);

  /** Point every dropdown at whatever is actually stored. */
  function syncPickers() {
    fpsSel = pick(FPS_PRESETS, cfg.encoder.fps);
    gopSel = pick(GOP_PRESETS, cfg.encoder.gopSeconds);
    syncVbr();
    abrSel = pick(ABR_PRESETS, brKey(cfg.encoder.audioBitrate));
    scanSel = pick(SCAN_PRESETS, cfg.library.autoRefresh.hours);
    climSel = pick(CLIM_PRESETS, +cfg.encoder.copyLimitKbps || 30000);
    chunkSel = pick(CHUNK_PRESETS, +cfg.encoder.chunkSeconds || 20);
    const devs = options?.renderDevices ?? [];
    devSel = devs.includes(cfg.encoder.device) ? cfg.encoder.device : 'custom';
    const offered = new Set((options?.languages ?? []).map((l) => l.code));
    // A config written before this invariant existed may interleave the two;
    // settle it once on load so the badges and the stored order agree.
    cfg.tracks.languages = normalizeLangs(cfg.tracks.languages ?? []);
    extraLangs = (cfg.tracks.languages ?? []).filter((c) => !offered.has(c)).join(', ');
  }

  /** Apply a dropdown choice; 'custom' leaves the stored value alone. */
  function choose(key, value) {
    if (value !== 'custom') cfg.encoder[key] = /^\d+$/.test(value) ? Number(value) : value;
  }

  // ── languages ──────────────────────────────────────────────────────────
  // Order is preference order: the matcher walks the list and takes the
  // first track that matches, so a chip shows its rank, not just on/off.
  const langRank = (code) => (cfg?.tracks?.languages ?? []).indexOf(code);

  /**
   * Listed languages first (in preference order), then anything typed into
   * "other languages". The picker has no way to place a typed code above a
   * chip, so this is the only ordering it can honestly represent — enforcing
   * it keeps the rank badges reading 1..n instead of skipping numbers that
   * belong to codes shown nowhere.
   */
  function normalizeLangs(list) {
    const offered = new Set((options?.languages ?? []).map((l) => l.code));
    return [...list.filter((c) => offered.has(c)), ...list.filter((c) => !offered.has(c))];
  }

  function toggleLang(code) {
    const list = [...(cfg.tracks.languages ?? [])];
    const at = list.indexOf(code);
    if (at >= 0) list.splice(at, 1);
    else list.push(code);
    cfg.tracks.languages = normalizeLangs(list);
  }

  /** Merge the free-text box back in, keeping the offered codes in order. */
  function applyExtras() {
    const offered = new Set((options?.languages ?? []).map((l) => l.code));
    const kept = (cfg.tracks.languages ?? []).filter((c) => offered.has(c));
    cfg.tracks.languages = normalizeLangs([...kept, ...parseList(extraLangs)]);
  }

  /**
   * A rough bitrate for the chosen frame size and rate — about 0.07 bits per
   * pixel per frame, the usual H.264 streaming ballpark. Advisory only.
   */
  const recommendedVbr = $derived.by(() => {
    const w = +cfg?.encoder?.width || 1920;
    const h = +cfg?.encoder?.height || 1080;
    const f = +cfg?.encoder?.fps || 30;
    // Anchored to measurement, not vibes: CRF-20 transparency at 1080p
    // needs 2.1-4.3 Mbps on real library files, so ~6 Mbps carries margin
    // and anything above buys nothing — the picture is bounded by the
    // source. The factor scales that anchor with resolution and rate.
    // The transparency point tracks the codec: HEVC reaches the same
    // picture at ~2/3 of H.264's rate, AV1 at ~half.
    const codecF = cfg?.encoder?.codec === 'hevc' ? 2 / 3
      : cfg?.encoder?.codec === 'av1' ? 0.5 : 1;
    return Math.round((w * h * f * 0.096 * codecF) / 1000 / 500) * 500;
  });

  function syncPresetFromCfg() {
    const hit = RES_PRESETS.find((r) => r.w === +cfg.encoder.width && r.h === +cfg.encoder.height);
    resPreset = hit ? hit.key : 'custom';
  }
  function applyPreset() {
    const r = RES_PRESETS.find((x) => x.key === resPreset);
    if (r) { cfg.encoder.width = r.w; cfg.encoder.height = r.h; }
  }

  onMount(() => {
    // Settings always opens in Simple — Advanced is a per-visit choice,
    // not a remembered one.
    load();
  });

  async function load() {
    try {
      cfg = await api.config();
      if (cfg.publish) cfg.publish = unmaskPublish(cfg.publish);
      cfg.buffer = { seconds: 15, applySeconds: 15, studioWarnings: true, ...(cfg.buffer ?? {}) };
      bufferSel = BUFFER_PRESETS.includes(cfg.buffer.seconds)
        ? String(cfg.buffer.seconds) : 'custom';
      keyStored = cfg.owncast.streamKey === '__SET__';
      tokenStored = cfg.owncast.accessToken === '__SET__';
      // migrate: a legacy single receiver becomes row one of the list
      if (!(cfg.streamingestarr?.receivers ?? []).length && cfg.streamingestarr?.url) {
        cfg.streamingestarr.receivers = [{
          id: 'r' + Math.random().toString(36).slice(2, 8),
          name: '', url: cfg.streamingestarr.url,
          accessToken: cfg.streamingestarr.accessToken, enabled: true,
        }];
      }
      const seen = {};
      for (const r of cfg.streamingestarr?.receivers ?? []) {
        if (r.accessToken === '__SET__') { seen[r.id] = true; r.accessToken = ''; }
      }
      sgSaved = seen;
      accessToken = '';
      streamKey = '';
      jellyfinKey = '';
      cfg.library ??= {};
      cfg.library.sources = (cfg.library.sources ?? []).map(shapeSource);
      if (!cfg.library.sources.length) {
        cfg.library.sources = [shapeSource({
          id: Math.random().toString(36).slice(2, 10), name: 'Library', provider: 'filesystem',
        })];
      }
      cfg.preview ??= { enabled: true };
      cfg.ui ??= { lazyImages: false };
      cfg.library.autoRefresh ??= { enabled: true, hours: 12 };
      cfg.runAhead ??= { enabled: true, ramMB: 'auto' };
      cfg.tracks ??= {};
      cfg.tracks.languages ??= ['eng'];
      cfg.tracks.audioMode ??= 'original';
      cfg.tracks.subtitleMode ??= 'auto';
      selectSource(Math.min(sel, cfg.library.sources.length - 1));
      syncPresetFromCfg();
      // Best-effort: if this fails the pickers fall back to free text
      // rather than the page failing to render.
      try { options = await api.get('/api/options'); } catch { options = null; }
      syncPickers();
    } catch (err) { error = err.message; }
  }

  const parseList = (s) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  let smbPassword = $state('');

  /**
   * Which source the editor below is pointed at. The form is the same one
   * that existed when there was only ever one library — it just edits a
   * selected entry now, so nothing about it had to be relearned.
   */
  let sel = $state(0);
  const src = $derived(cfg?.library?.sources?.[sel] ?? null);

  /** Fill in whatever the chosen provider needs but the entry lacks. */
  function shapeSource(x) {
    x.jellyfin ??= { url: '', apiKey: '' };
    x.filesystem ??= { roots: [] };
    // guest: false — most shares want credentials, and starting in guest mode
    // hides the username and password fields, which reads as SMB not
    // supporting authentication at all. The wizard already defaults this way.
    x.smb ??= { host: '', share: '', path: '', username: '', password: '', guest: false };
    // The catalogue is a block on the source, not a provider of its own.
    x.metadata ??= { provider: 'none', url: '', apiKey: '', pathMap: [] };
    x.pathMap ??= [];
    return x;
  }

  /** Secrets and the roots box are per source, so re-seed them on a switch. */
  function selectSource(i) {
    sel = i;
    jellyfinKey = '';
    smbPassword = '';
    libResult = null;
    const x = cfg.library.sources[i];
    jfKeyStored = x?.jellyfin?.apiKey === '__SET__';
    fsRoots = (x?.filesystem?.roots ?? []).join('\n');
  }

  function addSource() {
    cfg.library.sources = [...cfg.library.sources, shapeSource({
      id: Math.random().toString(36).slice(2, 10),
      name: `Source ${cfg.library.sources.length + 1}`,
      provider: 'filesystem',
    })];
    selectSource(cfg.library.sources.length - 1);
  }

  async function removeSource(i) {
    const name = cfg.library.sources[i]?.name ?? 'this source';
    if (!confirm(`Remove ${name}? Its media disappears from the library.`)) return;
    cfg.library.sources = cfg.library.sources.filter((_, j) => j !== i);
    selectSource(Math.max(0, Math.min(sel, cfg.library.sources.length - 1)));
    await save('library');
  }


  /** Same rule the server applies when a source has never been saved. */
  const stillsDefault = (provider) => provider === 'filesystem' || !provider;

  function libraryPayload() {
    // The whole list every time: sources are identified by id, and the
    // server puts real credentials back wherever the panel echoed the
    // sentinel, so an untouched key survives a save of anything else.
    return {
      sources: cfg.library.sources.map((x, i) => {
        const out = {
          id: x.id, name: x.name?.trim() || `Source ${i + 1}`, provider: x.provider,
          generateStills: x.generateStills ?? stillsDefault(x.provider),
        };
        // Every provider's settings go back, not just the active one's.
        // Sending only the selected provider meant switching from Jellyfin
        // to a folder silently threw the server url and api key away — and
        // the array is replaced wholesale on save, so nothing restored it.
        // Whichever is chosen, the others wait untouched for a switch back.
        out.jellyfin = {
          url: x.jellyfin?.url ?? '',
          apiKey: x.provider === 'jellyfin' && i === sel && jellyfinKey
            ? jellyfinKey
            : (x.jellyfin?.apiKey || ''),
        };
        out.pathMap = x.pathMap ?? [];
        /**
         * The catalogue block, with its derived rules. The key follows the
         * same sentinel rule as every other secret: sent only when typed,
         * so a stored one survives a save of anything else.
         */
        const m = x.metadata ?? {};
        out.metadata = {
          provider: m.provider ?? 'none',
          url: m.url ?? '',
          apiKey: x === src && metaKey ? metaKey : (m.apiKey || ''),
          pathMap: m.pathMap ?? [],
        };
        out.smb = {
          host: x.smb?.host ?? '', share: x.smb?.share ?? '', path: x.smb?.path ?? '',
          guest: x.smb?.guest ?? false,
          username: x.smb?.guest ? '' : (x.smb?.username ?? ''),
          password: x.smb?.guest ? ''
            : ((x.provider === 'smb' || x.provider === 'smbmount') && i === sel && smbPassword
              ? smbPassword
              : (x.smb?.password || '')),
        };
        out.filesystem = {
          roots: x.provider === 'filesystem' && i === sel
            ? parseList(fsRoots)
            : (x.filesystem?.roots ?? []),
        };
        return out;
      }),
    };
  }

  async function save(section) {
    error = ''; saved = '';
    try {
      const patch = {};
      if (section === 'streamingestarr') {
        patch.streamingestarr = {
          enabled: cfg.streamingestarr?.enabled !== false,
          receivers: (cfg.streamingestarr?.receivers ?? []).map((r) => ({
            ...r,
            accessToken: r.accessToken || (sgSaved[r.id] ? '__SET__' : ''),
          })),
        };
      }
      if (section === 'owncast') {
        patch.owncast = {
          rtmpUrl: cfg.owncast.rtmpUrl,
          apiUrl: cfg.owncast.apiUrl,
          syncTitle: cfg.owncast.syncTitle !== false,
          ...(streamKey ? { streamKey } : {}),
          ...(accessToken ? { accessToken } : {}),
        };
      }
      if (section === 'encoder') {
        patch.encoder = {
          backend: cfg.encoder.backend,
          width: +cfg.encoder.width, height: +cfg.encoder.height,
          fps: +cfg.encoder.fps, fpsMode: cfg.encoder.fpsMode || 'auto',
          videoBitrate: cfg.encoder.videoBitrate,
          hevcBitrate: cfg.encoder.hevcBitrate ?? '',
          av1Bitrate: cfg.encoder.av1Bitrate ?? '',
          copyLimitKbps: +cfg.encoder.copyLimitKbps || 30000,
          audioBitrate: cfg.encoder.audioBitrate,
          gopSeconds: +cfg.encoder.gopSeconds, device: cfg.encoder.device,
          codec: cfg.encoder.codec || 'h264',
          tonemap: cfg.encoder.tonemap || 'auto',
          tonemapCurve: cfg.encoder.tonemapCurve || 'hable',
          hdrOutput: Boolean(cfg.encoder.hdrOutput),
          deinterlace: cfg.encoder.deinterlace || 'auto',
          frameSize: frameSize,
          hwDecode: Boolean(cfg.encoder.hwDecode),
          overlayPipe: cfg.encoder.overlayPipe === 'always'
            ? 'always' : cfg.encoder.overlayPipe !== false,
          chunkSeconds: +cfg.encoder.chunkSeconds || 20,
        };
      }
      if (section === 'publish') {
        patch.publish = maskPublish(cfg.publish);
        // The codec choice lives on this card now; it rides along so one
        // Save keeps connection and codec consistent. The server merges
        // per-key, so the encoder card's other fields are untouched.
        patch.encoder = { codec: cfg.encoder.codec || 'h264' };
      }
      // Two cards write to the same block; the server merges, so each sends
      // only the keys it owns and neither can clobber the other's.
      if (section === 'buffer') patch.buffer = { seconds: cfg.buffer.seconds };
      // The Simple Timing lever: depth and the studio apply point move
      // together (setBuffer clamps), so both keys ride one save.
      if (section === 'timing') {
        patch.buffer = {
          seconds: cfg.buffer.seconds,
          applySeconds: cfg.buffer.applySeconds,
        };
      }
      if (section === 'studio') {
        patch.buffer = {
          applySeconds: cfg.buffer.applySeconds,
          studioWarnings: cfg.buffer.studioWarnings !== false,
        };
      }
      if (section === 'runahead') {
        patch.runAhead = { enabled: cfg.runAhead.enabled, ramMB: cfg.runAhead.ramMB };
      }
      if (section === 'preview') patch.preview = { enabled: cfg.preview.enabled };
      if (section === 'autoscan') {
        const ar = cfg.library?.autoRefresh ?? {};
        patch.library = { autoRefresh: { enabled: ar.enabled, hours: ar.hours } };
      }
      if (section === 'ui') patch.ui = { lazyImages: cfg.ui.lazyImages };
      if (section === 'dev') patch.devMode = cfg.devMode;
      if (section === 'library') patch.library = libraryPayload();
      if (section === 'tracks') {
        // Send intent; the server derives the ordered lists the engine uses.
        patch.tracks = {
          languages: cfg.tracks.languages,
          audioMode: cfg.tracks.audioMode,
          subtitleMode: cfg.tracks.subtitleMode,
        };
      }
      await api.saveConfig(patch);
      // The Console nav entry appears without a reload.
      if (section === 'dev') {
        window.dispatchEvent(new CustomEvent('jsr-devmode', { detail: cfg.devMode }));
      }
      if (streamKey) { keyStored = true; streamKey = ''; }
      if (accessToken) { tokenStored = true; accessToken = ''; }
      if (jellyfinKey) { jfKeyStored = true; jellyfinKey = ''; }
      saved = section;
      setTimeout(() => { if (saved === section) saved = ''; }, 2500);
    } catch (err) { error = err.message; }
  }

  async function testOwncast(watch = false) {
    testing = watch ? 'owncast-watch' : 'owncast'; owncastResult = null;
    try {
      owncastResult = await api.checkOwncast({
        rtmpUrl: cfg.owncast.rtmpUrl,
        streamKey: streamKey || (keyStored ? '__SET__' : ''),
        watch,
      });
    } catch (err) { owncastResult = { ok: false, error: err.message }; }
    finally { testing = ''; }
  }

  async function testLibrary() {
    testing = 'library'; libResult = null;
    try { libResult = { ok: true, ...(await api.checkLibrary(libraryPayload())) }; }
    catch (err) { libResult = { ok: false, error: err.message }; }
    finally { testing = ''; }
  }

  async function probeEncoders() {
    testing = 'encoder'; encoders = null;
    try { encoders = await api.checkEncoders(); }
    catch (err) { error = err.message; }
    finally { testing = ''; }
  }

  async function checkPaths() {
    testing = 'paths'; pathmap = null;
    try { pathmap = await api.checkPathmap(libraryPayload()); }
    catch (err) { error = err.message; }
    finally { testing = ''; }
  }

  function addRule() { src.pathMap = [...src.pathMap, { from: '', to: '' }]; }
  function removeRule(i) {
    src.pathMap = src.pathMap.filter((_, j) => j !== i);
  }

  async function changePassword() {
    pwMsg = '';
    try {
      await api.changePassword(pwCurrent, pwNext);
      pwCurrent = ''; pwNext = '';
      pwMsg = 'Password changed.';
    } catch (err) { pwMsg = err.message; }
  }

  async function logout() { await api.logout(); location.reload(); }
</script>


<div class="wrap">
<div class="pagehead">
  <h1>Settings</h1>
  <div class="segc" role="radiogroup" aria-label="Settings view">
    <button type="button" class:on={viewMode === 'simple'}
            onclick={() => setView('simple')}>Simple</button>
    <button type="button" class:on={viewMode !== 'simple'}
            onclick={() => setView('advanced')}>Advanced</button>
  </div>
</div>

{#if !cfg}
  <p class="muted">Loading…</p>
{:else}
  {#if error}<p class="err">{error}</p>{/if}

  {#if viewMode === 'simple'}
  <div class="simplecol">
    <section class="card">
      <h3>Picture</h3>
      <p class="lead muted small">What quality the stream aims for. Picking a lever switches all studio overlays off.</p>
      <div class="choices">
        {#each PICTURE_LEVERS as l}
          <button type="button" class="choice" class:on={pictureCurrent === l.id && !pictureIsCustom}
                  onclick={() => applyPicture(l.id)}>
            <span class="cname">{l.name}</span>
            <span class="cdesc">{l.desc}</span>
          </button>
        {/each}
        {#if pictureSnap}
          <button type="button" class="choice" class:on={pictureIsCustom}
                  onclick={applyPictureSnap}>
            <span class="cname">{pictureSnap.name}</span>
            <span class="cdesc">{snapWhen(pictureSnap) ? `Saved ${snapWhen(pictureSnap)} — ` : ''}codec, HDR, passthrough, studio state.</span>
          </button>
        {/if}
      </div>
      <details class="diff">
        <summary>what this sets</summary>
        <ul>
          {#each pictureDiff(pictureCurrent ?? 'best') as [k, v]}
            <li>{k} → <b>{v}</b></li>
          {/each}
        </ul>
      </details>
      {#if pictureSnap && (pictureCurrent !== null || pictureIsCustom)}
        <p class="driftline">{pictureIsCustom ? 'This is your saved setup' : `“${pictureSnap.name}” is one click away`}{snapWhen(pictureSnap) ? `, saved ${snapWhen(pictureSnap)}` : ''}.
          Rename it:
          <input class="snapname" type="text" bind:value={pictureName}
                 placeholder={pictureSnap.name} aria-label="New name for this saved setup" />
          <button type="button" class="snapbtn"
                  onclick={() => { renameSnap('picture', pictureName); pictureName = ''; }}>save</button></p>
      {/if}
      {#if pictureCurrent === null && !pictureIsCustom}
        <p class="driftline">Picture is <b>customized</b> in Advanced. Picking a lever saves it
          automatically — or name and save it now:
          <input class="snapname" type="text" bind:value={pictureName}
                 placeholder={pictureSnap?.name ?? 'My settings'}
                 aria-label="Name for this saved setup" />
          <button type="button" class="snapbtn" onclick={savePictureSnap}>
            {pictureSnap ? 'overwrite' : 'save'}</button></p>
      {/if}
      {#if saved === 'encoder'}<p class="ok small">Saved</p>{/if}
    </section>

    <section class="card">
      <h3>Timing</h3>
      <p class="lead muted small">How much safety cushion the broadcast keeps between encoder and air.</p>
      <div class="choices">
        {#each TIMING_LEVERS as l}
          <button type="button" class="choice" class:on={timingCurrent === l.id && !timingIsCustom}
                  onclick={() => applyTiming(l.id)}>
            <span class="cname">{l.name}</span>
            <span class="cdesc">{l.desc}</span>
          </button>
        {/each}
        {#if timingSnap}
          <button type="button" class="choice" class:on={timingIsCustom}
                  onclick={applyTimingSnap}>
            <span class="cname">{timingSnap.name}</span>
            <span class="cdesc">{snapWhen(timingSnap) ? `Saved ${snapWhen(timingSnap)} — ` : ''}{timingSnap.fields.seconds} s cushion, applies at {timingSnap.fields.applySeconds} s.</span>
          </button>
        {/if}
      </div>
      {#if timingSnap && (timingCurrent !== null || timingIsCustom)}
        <p class="driftline">{timingIsCustom ? 'This is your saved cushion' : `“${timingSnap.name}” is one click away`}{snapWhen(timingSnap) ? `, saved ${snapWhen(timingSnap)}` : ''}.
          Rename it:
          <input class="snapname" type="text" bind:value={timingName}
                 placeholder={timingSnap.name} aria-label="New name for this saved cushion" />
          <button type="button" class="snapbtn"
                  onclick={() => { renameSnap('timing', timingName); timingName = ''; }}>save</button></p>
      {/if}
      {#if timingCurrent === null && !timingIsCustom}
        <p class="driftline">Timing is <b>customized</b> in Advanced ({cfg.buffer.seconds} s).
          Picking a lever saves it automatically — or name and save it now:
          <input class="snapname" type="text" bind:value={timingName}
                 placeholder={timingSnap?.name ?? 'My settings'}
                 aria-label="Name for this saved cushion" />
          <button type="button" class="snapbtn" onclick={saveTimingSnap}>
            {timingSnap ? 'overwrite' : 'save'}</button></p>
      {/if}
      {#if saved === 'timing'}<p class="ok small">Saved</p>{/if}
    </section>

    <p class="muted small">A lever writes the same settings Advanced shows and saves right away.
      Everything else — connection, library, studio — lives in Advanced.</p>
  </div>
  {:else}
  <div class="cols">
  <div class="col">

  <!-- ===== Broadcast: connection, receivers, metadata ===== -->
  <section class="card group">
    <h3>Broadcast</h3>
    <p class="lead muted small">Where the stream goes and what carries it.</p>
  <!-- Broadcast destination -->
  <section class="subcard">

    <!-- The codec is part of the connection — it decides which protocol
         can carry the stream — so it lives here and the protocol follows
         it. The server mirrors this: destinations() routes a non-H.264
         primary to the SRT slot on its own. -->
    <label>Codec</label>
    <select bind:value={cfg.encoder.codec} onchange={syncVbr}>
      <option value="h264">H.264 — baseline bitrate; universal</option>
      <option value="hevc">H.265 — 2/3 the bitrate; most</option>
      <option value="av1">AV1 — half the bitrate; patchy; software encode, no preview</option>
    </select>
    {#if (cfg.encoder.codec || 'h264') !== 'h264'}
      <p class="muted small">
        {codecLabel()} needs SRT or TCP. Pick either below — with RTMP
        selected the stream uses the SRT slot automatically, and your RTMP
        setup is kept and comes back with H.264.
        {#if !cfg.publish[effProto()]?.url}
          <strong>No {effProto().toUpperCase()} server is configured yet —
          fill the slot or the stream will refuse to start.</strong>
        {/if}
        {#if sitOuts().length}
          Sitting out: {sitOuts().join(', ')} — RTMP cannot carry
          {codecLabel()}; they rejoin on H.264.
        {/if}
      </p>
      <p class="muted small">
        Its bitrate is set in the Output card — the Video bitrate dropdown
        always shows the rate of the codec chosen here, and each codec
        keeps its own.
      </p>
    {/if}

    <!-- Credentials live in a slot per protocol, so switching here never
         discards the other set. Switch back and the fields are as they
         were; overwrite by typing over them. -->
    <label>Protocol</label>
    <div class="segc" role="radiogroup" aria-label="Protocol">
      {#each PROTOCOL_INFO as pr}
        <!-- A protocol that already holds credentials is marked, so it is
             obvious at a glance that switching away from one will not lose
             it — and that the one in use is genuinely configured. -->
        <button type="button" class:on={effProto() === pr.id}
                disabled={(cfg.encoder.codec || 'h264') !== 'h264' && !MODERN_CARRIERS.includes(pr.id)}
                title={(cfg.encoder.codec || 'h264') !== 'h264' && !MODERN_CARRIERS.includes(pr.id)
                  ? `${pr.label} cannot carry ${codecLabel()} — pick SRT or TCP`
                  : undefined}
                onclick={() => {
                  // With H.264 any protocol is choosable; with a modern
                  // codec only the carriers that can hold it are, and the
                  // impossible ones are disabled above.
                  if ((cfg.encoder.codec || 'h264') === 'h264'
                    || MODERN_CARRIERS.includes(pr.id)) cfg.publish.protocol = pr.id;
                }}>
          <strong>{pr.label}</strong>
          {#if cfg.publish[pr.id]?.url}
            <span class="tag">{effProto() === pr.id ? 'in use' : 'saved'}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if effProto() === 'srt'}
      <label>Server address</label>
      <input bind:value={cfg.publish.srt.url} spellcheck="false"
             placeholder="srt://relay.example.com:9000" />

      <label>Stream ID <span class="muted small">optional</span></label>
      <input type="password" bind:value={cfg.publish.srt.streamId}
             placeholder={savedHint('srt.streamId') ?? 'e.g. #!::r=live/stream,m=publish'} />

      <label>Passphrase <span class="muted small">optional, 10–79 characters</span></label>
      <input type="password" bind:value={cfg.publish.srt.passphrase}
             placeholder={savedHint('srt.passphrase') ?? 'encrypts the link'} />

      <label>Latency <span class="muted small">{cfg.publish.srt.latencyMs ?? 200} ms</span></label>
      <input type="range" min="20" max="8000" step="10"
             value={cfg.publish.srt.latencyMs ?? 200}
             oninput={(e) => { cfg.publish.srt.latencyMs = +e.currentTarget.value; }} />
      <p class="muted small">
      Time allowed to re-request lost packets. Higher survives a worse link,
      at the cost of delay. Rule of thumb: four times the round trip — but
      for high-bitrate passthrough (a 25 Mbps 4K film over a ~50 Mbps
      upload) go to 2000+: burst loss at the line&rsquo;s edge needs a deep
      window or it surfaces as picture artifacts at the viewer.
    </p>
    {:else if effProto() === 'tcp'}
      <label>Server address</label>
      <input bind:value={cfg.publish.tcp.url} spellcheck="false"
             placeholder="tcp://ingest.example.com:9711" />

      <label>Stream key</label>
      <input type="password" bind:value={cfg.publish.tcp.key}
             placeholder={savedHint('tcp.key') ?? 'from your server'} />

      <label>Passphrase <span class="muted small">optional, 10–79 characters, no spaces</span></label>
      <input type="password" bind:value={cfg.publish.tcp.passphrase}
             placeholder={savedHint('tcp.passphrase') ?? 'if the receiver demands one'} />
      <p class="muted small">
        Raw MPEG-TS over plain TCP: every codec, and reliable on an upload
        whose UDP loss SRT cannot ride out — lost packets retransmit instead
        of becoming picture artifacts, and the buffer absorbs the delay.
      </p>
    {:else}
      <label>Server address</label>
      <input bind:value={cfg.publish[cfg.publish.protocol].url} spellcheck="false"
             placeholder={`${cfg.publish.protocol}://stream.example.com${cfg.publish.protocol === 'rtmps' ? ':443' : ':1935'}/live`} />

      <label>Stream key</label>
      <input type="password" bind:value={cfg.publish[cfg.publish.protocol].key}
             placeholder={savedHint(`${cfg.publish.protocol}.key`) ?? 'from your server'} />
    {/if}
    <p class="muted small">Secrets are never sent back to the browser.</p>

    <label>Nickname <span class="muted small">optional — how this destination appears in logs and the on-air badge</span></label>
    <input bind:value={cfg.publish.name} spellcheck="false" maxlength="40"
           placeholder="e.g. Owncast VPS" />

    <!-- Fan-out. One encode, several destinations: the box cannot afford a
         second encoder, and it does not need one. -->
    <h4 class="sub">Also send to</h4>
    {#each cfg.publish.extras as ex (ex.id)}
      <div class="extra">
        <div class="extrahead">
          <label style="display:flex; align-items:center; gap:8px; margin:0;">
            <input type="checkbox" bind:checked={ex.enabled} style="width:auto" />
            <select bind:value={ex.protocol} style="width:auto">
              {#each PROTOCOL_INFO as pr}<option value={pr.id}>{pr.label}</option>{/each}
            </select>
          </label>
          <button type="button" class="danger" onclick={() => removeExtra(ex.id)}>Remove</button>
        </div>
        <input bind:value={ex.name} spellcheck="false" maxlength="40"
               placeholder="nickname (optional) — e.g. Cinema receiver" />
        <input bind:value={ex.url} spellcheck="false" placeholder={`${ex.protocol}://…`} />
        {#if ex.protocol === 'srt'}
          <input type="password" bind:value={ex.streamId}
                 placeholder={savedHint(`x.${ex.id}.streamId`) ?? 'stream ID (optional)'} />
        {:else}
          <input type="password" bind:value={ex.key}
                 placeholder={savedHint(`x.${ex.id}.key`) ?? 'stream key'} />
        {/if}
        {#if ex.protocol === 'tcp'}
          <input type="password" bind:value={ex.passphrase}
                 placeholder={savedHint(`x.${ex.id}.passphrase`) ?? 'passphrase (if the receiver demands one)'} />
        {/if}
      </div>
    {/each}
    <button type="button" onclick={addExtra}>Add a destination</button>
    <p class="muted small">
      Extras share the one encode, so they cost almost nothing. An unreachable
      destination is skipped; the rest keep streaming.
    </p>
    <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('publish')}>Save</button>
      {#if saved === 'publish'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  <!-- Streamingestarr -->
  <section class="subcard">
    <h3>Now-playing &amp; artwork push</h3>
    <p class="muted small">
      Our own receiver. Beyond the video, it takes structured
      now&#8209;playing, up&#8209;next and schedule metadata &mdash; the
      theater page shows real titles with a live progress ring instead of a
      stream title. Works alongside the Owncast integration.
    </p>

    <label style="display:flex; align-items:center; gap:8px;">
      <input type="checkbox" style="width:auto"
             checked={cfg.streamingestarr?.enabled !== false}
             onchange={(e) => { cfg.streamingestarr = { ...(cfg.streamingestarr ?? {}), enabled: e.target.checked }; }} />
      Push metadata to a Streamingestarr receiver
    </label>

    {#if cfg.streamingestarr?.enabled !== false}
      {#each cfg.streamingestarr?.receivers ?? [] as rc (rc.id)}
        <div class="extra">
          <div class="extrahead">
            <label style="display:flex; align-items:center; gap:8px; margin:0;">
              <input type="checkbox" bind:checked={rc.enabled} style="width:auto" />
              <input bind:value={rc.name} spellcheck="false" maxlength="40"
                     placeholder="nickname — e.g. VPS theater" style="width:auto" />
            </label>
            <button type="button" class="danger" onclick={() => {
              cfg.streamingestarr.receivers = cfg.streamingestarr.receivers.filter((x) => x.id !== rc.id);
            }}>Remove</button>
          </div>
          <input bind:value={rc.url} spellcheck="false" placeholder="https://stream.example.com" />
          <input type="password" bind:value={rc.accessToken}
                 placeholder={sgSaved[rc.id] && !rc.accessToken ? 'leave blank to keep the saved token' : 'access token (system-messages scope)'} />
          <div class="actions" style="margin-top:2px;">
            <button onclick={async () => {
              sgTests = { ...sgTests, [rc.id]: null };
              try {
                sgTests = { ...sgTests, [rc.id]: await api.post('/api/check/streamingestarr', {
                  url: rc.url,
                  ...(rc.accessToken ? { accessToken: rc.accessToken }
                    : sgSaved[rc.id] ? {} : {}),
                  ...(rc.accessToken ? {} : { receiverId: rc.id }),
                }) };
              } catch (err) { sgTests = { ...sgTests, [rc.id]: { ok: false, error: err.message } }; }
            }} disabled={!!testing}>Test</button>
          </div>
          {#if sgTests[rc.id]}
            <div class="result" class:bad={!sgTests[rc.id].ok}>
              {#if sgTests[rc.id].ok}
                {@const c = sgTests[rc.id].caps}
                Connected &mdash; apiVersion {c.apiVersion}.
                Ingest: RTMP :{c.ingest?.rtmpPort}{c.ingest?.srtEnabled ? `, SRT :${c.ingest?.srtPort}` : ''}.
                Metadata: {[c.metadata?.nowPlaying && 'now playing', c.metadata?.schedule && 'schedule', c.metadata?.artwork && 'artwork'].filter(Boolean).join(' + ')}.
              {:else}
                {sgTests[rc.id].error}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      <button type="button" onclick={() => {
        cfg.streamingestarr.receivers = [...(cfg.streamingestarr?.receivers ?? []), {
          id: 'r' + Math.random().toString(36).slice(2, 8),
          name: '', url: '', accessToken: '', enabled: true,
        }];
      }}>Add a receiver</button>
    {/if}

    <div class="actions">
      <button class="primary" onclick={() => save('streamingestarr')}>Save</button>
      {#if saved === 'streamingestarr'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  <!-- Owncast -->
  <section class="subcard">
    <h3>Owncast title sync</h3>

    <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
      <input type="checkbox" bind:checked={cfg.owncast.syncTitle} style="width:auto" />
      Update the Owncast stream title as episodes change
    </label>
    <p class="muted small">
      Viewers see the episode ("Show &mdash; S1E4") on the watch page.
    </p>

    {#if cfg.owncast.syncTitle !== false}
      <label>Owncast address (web)</label>
      <input bind:value={cfg.owncast.apiUrl} spellcheck="false"
             placeholder="https://stream.example.com" />

      <label>Access token</label>
      <input type="password" bind:value={accessToken}
             placeholder={tokenStored ? 'leave blank to keep the saved token' : 'Owncast admin → Integrations → Access Tokens'} />
      <p class="muted small">
        Create it in the Owncast admin under Integrations, with the
        "can change stream title" permission.
        {#if tokenStored && !accessToken}A token is saved.{/if}
      </p>

      {#if !cfg.owncast.apiUrl || (!tokenStored && !accessToken)}
        <!-- The switch is on but the sync has nothing to talk to, and it
             fails silently by design. Say so before it is relied on. -->
        {@const missing = [
          !cfg.owncast.apiUrl && 'address',
          !tokenStored && !accessToken && 'token',
        ].filter(Boolean)}
        <p class="warnline">
          Not active yet — the {missing.join(' and ')}
          {missing.length > 1 ? 'are' : 'is'} still empty, so nothing is sent.
        </p>
      {/if}

      <div class="actions" style="margin-top:2px;">
        <button onclick={async () => {
          titleTest = null;
          try { titleTest = await api.post('/api/check/owncast-title', {
            apiUrl: cfg.owncast.apiUrl,
            ...(accessToken ? { accessToken } : {}),
          }); }
          catch (err) { titleTest = { ok: false, error: err.message }; }
        }} disabled={!!testing}>Test title sync</button>
      </div>
      {#if titleTest}
        <div class="result" class:bad={!titleTest.ok}>
          {titleTest.ok
            ? `Owncast accepted the title — check the header of your watch page`
            : titleTest.error}
        </div>
      {/if}
    {/if}

    <div class="actions">
      <button class="primary" onclick={() => save('owncast')}>Save</button>
      <button onclick={() => testOwncast(false)} disabled={!!testing}>
        {testing === 'owncast' ? 'Checking…' : 'Test connection'}
      </button>
      <button onclick={() => testOwncast(true)} disabled={!!testing}>
        {testing === 'owncast-watch' ? 'Streaming… 30s' : 'Send 30s to watch'}
      </button>
      {#if saved === 'owncast'}<span class="ok small">Saved</span>{/if}
    </div>
    {#if owncastResult}
      <div class="result" class:bad={!owncastResult.ok}>
        {owncastResult.ok
          ? `Accepted — ${owncastResult.seconds}s pushed in ${(owncastResult.ms / 1000).toFixed(0)}s`
          : owncastResult.error}
      </div>
    {/if}
  </section>

  </section>

  <!-- ===== Library: sources, metadata, languages, browsing ===== -->
  <section class="card group">
    <h3>Library</h3>
    <p class="lead muted small">Where media comes from and how it is presented.</p>
  <!-- Library -->
  <section class="subcard">
    <h3>Sources</h3>
    <!-- One row per place media lives. Hidden entirely while there is only
         one, so a setup that never wants a second never sees the concept. -->
    {#if cfg.library.sources.length > 1 || sel > 0}
      <div class="srcbar">
        {#each cfg.library.sources as x, i (x.id)}
          <button class="chip" class:on={i === sel} onclick={() => selectSource(i)}>
            {x.name?.trim() || `Source ${i + 1}`}
          </button>
        {/each}
        <button class="chip add" onclick={addSource}>+ Add source</button>
      </div>
    {/if}

    {#if src}
      <label>Name</label>
      <input bind:value={src.name} spellcheck="false" placeholder="Shows" />

      <!-- Two answers, because these are the only two places bytes live.
           A catalogue is chosen separately, below. -->
      <div class="segc" role="radiogroup" aria-label="Where the media is">
        <button class:on={src.provider === 'filesystem'}
                onclick={() => (src.provider = 'filesystem')}>A folder
          <span class="tag">recommended</span></button>
        <button class:on={src.provider === 'smb'}
                onclick={() => (src.provider = 'smb')}>SMB share
          <span class="tag">experimental</span></button>
      </div>

    {#if src.provider === 'smb'}
      <label>Server (hostname, IP, or a full smb:// address)</label>
      <input bind:value={src.smb.host} spellcheck="false"
             placeholder="nas.local  or  smb://user@nas/share/folder"
             onchange={() => {
               // A pasted smb:// URL or UNC path distributes into the
               // fields below, so what you see is exactly what mounts.
               let h = src.smb.host.trim()
                 .replace(/^smb:\/\//i, '').replace(/^\\\\/, '').replace(/\\/g, '/');
               const at = h.indexOf('@');
               if (at !== -1) {
                 const cred = h.slice(0, at); h = h.slice(at + 1);
                 const colon = cred.indexOf(':');
                 src.smb.username = colon === -1 ? cred : cred.slice(0, colon);
                 if (colon !== -1) smbPassword = cred.slice(colon + 1);
                 src.smb.guest = false;
               }
               const segs = h.split('/').filter(Boolean);
               if (segs.length > 1) {
                 src.smb.host = segs[0];
                 src.smb.share = segs[1];
                 src.smb.path = segs.slice(2).join('/');
               } else {
                 src.smb.host = segs[0] ?? '';
               }
             }} />
      <label>Share name</label>
      <input bind:value={src.smb.share} spellcheck="false" placeholder="media" />
      <label>Folder within the share (optional)</label>
      <input bind:value={src.smb.path} spellcheck="false" placeholder="anime" />
      <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
        <input type="checkbox" bind:checked={src.smb.guest} style="width:auto" />
        No password (guest share)
      </label>
      {#if !src.smb.guest}
        <label>Username</label>
        <input bind:value={src.smb.username} spellcheck="false" />
        <label>Password</label>
        <input type="password" bind:value={smbPassword}
               placeholder={src.smb.password === '__SET__' ? 'leave blank to keep the saved password' : ''} />
      {/if}
      <p class="muted small" style="margin-top:6px;">
      Read over the network &mdash; no mount, no privileges, read-only.
      <em>Experimental, and prone to slowness</em>: first playback of each file
      reads it in full, and heavy titles take longer to prepare. A local
      folder is the fast path when you have one.
    </p>
    {:else}
      <label>Folders, one per line</label>
      <textarea rows="3" bind:value={fsRoots} spellcheck="false"></textarea>
      <div class="actions" style="margin-top:8px;">
        <button onclick={() => (browsing = true)}>Browse…</button>
      </div>
    {/if}

    {#if src.provider !== 'jellyfin'}
    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" style="width:auto"
             checked={src.generateStills ?? stillsDefault(src.provider)}
             onchange={(e) => (src.generateStills = e.currentTarget.checked)} />
      Make episode pictures from the video when there are none
    </label>
    <p class="muted small">
      {#if src.provider === 'smb' || src.provider === 'smbmount'}
        Off by default over a share: one network seek per episode. Cached
        after the first visit.
      {:else}
        About a fifth of a second per episode, then cached.
      {/if}
    </p>
    {/if}

    <div class="actions">
      <button class="primary" onclick={() => save('library')}>Save</button>
      <button onclick={testLibrary} disabled={testing === 'library'}>
        {testing === 'library' ? 'Checking…' : 'Test'}
      </button>
      {#if saved === 'library'}<span class="ok small">Saved</span>{/if}
    </div>
    {#if libResult}
      <div class="result" class:bad={!libResult.ok}>
        {libResult.ok
          ? `Connected${libResult.serverName ? ` to ${libResult.serverName}` : ''}${libResult.roots ? ` — ${libResult.roots} folder(s)` : ''}`
          : libResult.error}
      </div>
    {/if}

    <div class="srcfoot">
      {#if cfg.library.sources.length <= 1 && sel === 0}
        <button onclick={addSource}>Add another source</button>
        <span class="muted small">A Jellyfin server and a folder can run side by side.</span>
      {:else}
        <button class="danger" onclick={() => removeSource(sel)}>Remove this source</button>
      {/if}
    </div>
    {/if}
  </section>

  <!-- Titles and artwork -->
  {#if src}
    <section class="subcard">
      <h3>Titles and artwork</h3>
      <p class="muted small" style="margin-top:0">
        Optional. Without it we use the filenames.
      </p>

      <div class="segc" role="radiogroup" aria-label="Metadata source">
        <button class:on={metaProvider === 'none'}
                onclick={() => setMeta('none')}>Filenames</button>
        <button class:on={metaProvider === 'jellyfin'}
                onclick={() => setMeta('jellyfin')}>Jellyfin</button>
        <button class:on={metaProvider === 'tmdb'}
                onclick={() => setMeta('tmdb')}>TMDB</button>
      </div>

      {#if metaProvider === 'tmdb'}
        <p class="muted small">
          Titles, episode names and posters from The Movie Database. Enter
          the key and that is everything — matching runs in the background
          and the library fills in as answers land.
        </p>
        <label>API key</label>
        <input type="password" bind:value={metaKey}
               placeholder={src.metadata.apiKey === '__SET__'
                 ? 'saved — type to replace' : 'themoviedb.org → Settings → API'} />
        <p class="muted small">A free account's key is enough. Both the short
          v3 key and the long v4 token work.</p>
      {/if}

      {#if metaProvider === 'jellyfin'}
        <p class="muted small">
          Jellyfin is a media server. If you run one for this library, it has
          already fetched the posters and episode order.
        </p>
        <label>Address</label>
        <input bind:value={src.metadata.url} spellcheck="false"
               placeholder="http://192.168.1.10:8096" />
        <label>API key</label>
        <input type="password" bind:value={metaKey}
               placeholder={src.metadata.apiKey === '__SET__'
                 ? 'saved — type to replace' : 'Dashboard → API Keys'} />
        <div class="row" style="margin-top:10px">
          <button onclick={runMatch} disabled={matching || !src.metadata.url?.trim()}>
            {matching ? 'Checking…' : 'Check'}
          </button>
          {#if src.metadata.pathMap?.length}
            <span class="muted small">{src.metadata.pathMap.length} rule(s) saved</span>
          {/if}
        </div>
        {#if match}
          <div class="result" class:bad={!match.ok || match.matched === 0}>
            {match.ok ? match.description : match.error}
          </div>
          {#if match.ok && match.counts}
            <p class="muted small">
              Catalogue: {match.counts.catalogue} files · Media: {match.counts.media} files
            </p>
          {/if}
        {:else}
          <p class="muted small">We work the paths out ourselves. Nothing to type.</p>
        {/if}
      {/if}

      <div class="row" style="margin-top:12px">
        <button class="primary" onclick={() => save('library')}>Save</button>
        {#if saved === 'library'}<span class="ok small">Saved</span>{/if}
      </div>
    </section>
  {/if}

  <!-- Languages -->
  <section class="subcard">
    <h3>Languages</h3>
    <p class="muted small">
      Chosen automatically, like Jellyfin. Change audio or subtitles any time,
      including mid-episode.
    </p>
    <label>Languages you understand</label>
    {#if options?.languages?.length}
      <div class="langs">
        {#each options.languages as l}
          <button class="chip" class:on={langRank(l.code) >= 0}
                  onclick={() => toggleLang(l.code)}
                  title={l.code}>
            {#if langRank(l.code) >= 0}<span class="pri">{langRank(l.code) + 1}</span>{/if}
            {l.name}
          </button>
        {/each}
      </div>
      <p class="muted small">
      In order of preference &mdash; the first a file offers wins. Used for both dubs
      and subtitles.
    </p>
      <label>Other languages (optional)</label>
      <input bind:value={extraLangs} onchange={applyExtras} spellcheck="false"
             placeholder="swe, dan — ISO codes not listed above" />
      <p class="muted small">Tried after the ones selected above.</p>
    {:else}
      <!-- The options fetch failed; fall back to the raw list so the setting
           stays editable rather than disappearing. -->
      <input value={(cfg.tracks.languages || []).join(', ')}
             oninput={(e) => (cfg.tracks.languages = parseList(e.currentTarget.value))}
             placeholder="eng" spellcheck="false" />
      <p class="muted small">
        Used both to pick a dub and to choose a subtitle language.
      </p>
    {/if}

    <label>Audio</label>
    <select bind:value={cfg.tracks.audioMode}>
      <option value="original">Original language &mdash; Japanese for anime</option>
      <option value="dubbed">Dubbed into your language when available</option>
    </select>

    <label>Subtitles</label>
    <select bind:value={cfg.tracks.subtitleMode}>
      <option value="auto">Only when you don&rsquo;t understand the audio</option>
      <option value="always">Always</option>
      <option value="forced">Forced only &mdash; signs and foreign dialogue</option>
      <option value="off">Never</option>
    </select>
    <p class="muted small">
      Original audio plus the first subtitle option gives Japanese anime with
      subtitles and English film with none. Overridable per episode.
    </p>
    <div class="actions">
      <button class="primary" onclick={() => save('tracks')}>Save</button>
      {#if saved === 'tracks'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  <!-- Automatic scan -->
  <section class="subcard">
    <h3>Automatic scan</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.library.autoRefresh.enabled} style="width:auto"
 />
      Scan for new media automatically
    </label>
    {#if cfg.library.autoRefresh.enabled}
      <div style="margin-top:10px; max-width: 260px;">
        <select bind:value={scanSel} onchange={() => {
          if (scanSel !== 'custom') cfg.library.autoRefresh.hours = Number(scanSel);
        }}>
          {#each SCAN_PRESETS as h}<option value={String(h)}>{scanLabel(h)}</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if scanSel === 'custom'}
          <label class="row" style="margin-top:8px;">
            <span>Every</span>
            <input type="number" min="1" max="168" step="1"
                   bind:value={cfg.library.autoRefresh.hours}
                   style="width:80px" />
            <span>hours</span>
          </label>
        {/if}
      </div>
    {/if}
    <p class="muted small">
      Rescans Jellyfin sources and reloads the shelves, so new episodes appear
      on their own.
    </p>
      <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('autoscan')}>Save</button>
      {#if saved === 'autoscan'}<span class="ok small">Saved</span>{/if}
    </div>
</section>

  <!-- Library display -->
  <section class="subcard">
    <h3>Display</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.ui.lazyImages} style="width:auto" />
      Load artwork only as it scrolls into view
    </label>
    <p class="muted small">
      Mainly for Jellyfin &mdash; folder and SMB libraries only show artwork sitting
      beside the media.
    </p>
      <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('ui')}>Save</button>
      {#if saved === 'ui'}<span class="ok small">Saved</span>{/if}
    </div>
</section>

  </section>

  </div>
  <div class="col">

  <!-- ===== Output: encoder, picture, cushion ===== -->
  <section class="card group">
    <h3>Output</h3>
    <p class="lead muted small">What the encoder produces, and the cushion behind it.
      Encoder choices apply from the next broadcast; the buffer applies live.</p>
  <!-- Encoder -->
  <section class="subcard">
    <div class="g3">
      <div>
        <label>Resolution</label>
        <select bind:value={resPreset} onchange={applyPreset}>
          {#each RES_PRESETS as r}<option value={r.key}>{r.label}</option>{/each}
          <option value="custom">Custom</option>
        </select>
      </div>
      {#if resPreset === 'custom'}
        <div><label>Width</label><input type="number" bind:value={cfg.encoder.width} /></div>
        <div><label>Height</label><input type="number" bind:value={cfg.encoder.height} /></div>
      {:else}
        <div><label>{frameSize === 'fixed' ? 'Size' : 'Limit'}</label>
          <input value={`${cfg.encoder.width} × ${cfg.encoder.height}`} disabled /></div>
      {/if}
      <div>
        <label>Framerate</label>
        <select bind:value={cfg.encoder.fpsMode}>
          <option value="auto">Auto</option>
          <option value="fixed">Fixed</option>
        </select>
      </div>
      <div>
        <label>{cfg.encoder.fpsMode === 'fixed' ? 'Framerate' : 'Framerate cap'}</label>
        <select bind:value={fpsSel} onchange={() => choose('fps', fpsSel)}>
          {#each FPS_PRESETS as f}<option value={String(f)}>{f} fps</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if fpsSel === 'custom'}
          <input class="exact" type="number" min="1" max="240" aria-label="Exact framerate"
                 bind:value={cfg.encoder.fps} />
        {/if}
      </div>
      <div>
        <label>Video bitrate{#if (cfg.encoder.codec || 'h264') !== 'h264'}&nbsp;&mdash; {codecLabel()}{/if}</label>
        <select bind:value={vbrSel} onchange={() => chooseVbr(vbrSel)}>
          {#if (cfg.encoder.codec || 'h264') !== 'h264'}
            <option value="auto">Auto &mdash; {derivedKbps.toLocaleString()} kbps ({cfg.encoder.codec === 'hevc' ? '2/3 of' : 'half'} the H.264 rate)</option>
          {/if}
          {#each VBR_PRESETS as b}<option value={b}>{parseInt(b, 10).toLocaleString()} kbps</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if vbrSel === 'custom'}
          <input class="exact" bind:value={cfg.encoder[bitrateSlot]} spellcheck="false"
                 aria-label="Exact video bitrate" placeholder="8000k" />
        {/if}
      </div>
      <div>
        <label>Audio bitrate</label>
        <select bind:value={abrSel} onchange={() => choose('audioBitrate', abrSel)}>
          {#each ABR_PRESETS as b}<option value={b}>{parseInt(b, 10)} kbps</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if abrSel === 'custom'}
          <input class="exact" bind:value={cfg.encoder.audioBitrate} spellcheck="false"
                 aria-label="Exact audio bitrate" placeholder="160k" />
        {/if}
      </div>
      <div>
        <label>Keyframes</label>
        <select bind:value={gopSel} onchange={() => choose('gopSeconds', gopSel)}>
          {#each GOP_PRESETS as g}<option value={String(g)}>{g} second{g === 1 ? '' : 's'}</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if gopSel === 'custom'}
          <input class="exact" type="number" min="1" max="60" aria-label="Exact keyframe interval"
                 bind:value={cfg.encoder.gopSeconds} />
        {/if}
      </div>
    </div>
    <label>Scaling</label>
    <select bind:value={cfg.encoder.frameSize}>
      <option value="fixed">Always {cfg.encoder.width}&times;{cfg.encoder.height}</option>
      <option value="fit">Fill the frame &mdash; up to the limit</option>
      <option value="native">Match the file &mdash; up to the limit</option>
      <option value="source">Match the file &mdash; ignore the limit</option>
    </select>
    <p class="muted small">
      {#if frameSize === 'fixed'}
        Everything at {cfg.encoder.width}&times;{cfg.encoder.height}, bars around
        other shapes. Never reconnects.
      {:else if frameSize === 'fit'}
        Shape kept, bars gone &mdash; 4:3 goes out at {fitExample}, about a fifth
        less to encode. Scales SD <em>up</em>, which costs effort for no detail.
      {:else if frameSize === 'native'}
        Each file at its own size, only ever scaled <em>down</em>. Sizes vary
        most, so expect the most reconnects.
      {:else}
        As above, but the resolution limit is <strong>ignored</strong> &mdash; a 4K
        file is encoded at 4K, which most machines cannot do in real time.
        Choose this only if you know the hardware keeps up.
      {/if}
    </p>
    {#if frameSize !== 'fixed'}
      <p class="warnline">
        The frame size is fixed for one connection, so moving between clips of
        different shapes reconnects the stream and viewers see it drop for a
        moment. Within a series that never happens.
      </p>
    {/if}

    <label>Passthrough limit</label>
    <select bind:value={climSel} onchange={() => {
      if (climSel !== 'custom') cfg.encoder.copyLimitKbps = Number(climSel);
    }}>
      {#each CLIM_PRESETS as k}<option value={String(k)}>{k / 1000} Mbps</option>{/each}
      <option value="custom">Custom</option>
    </select>
    {#if climSel === 'custom'}
      <input class="exact" type="number" min="1000" max="200000" step="1000"
             bind:value={cfg.encoder.copyLimitKbps} aria-label="Passthrough limit in kbps"
             placeholder="kbps" />
    {/if}
    <p class="muted small">
      HEVC files under this rate ship untouched (zero encode cost); denser
      ones are re-encoded at the bitrate above. Set it to what the LINK to
      your receiver can actually carry &mdash; a lossy tunnel shows exactly
      as picture corruption at the viewer.
    </p>

    <p class="muted small">
      About {recommendedVbr.toLocaleString()} kbps is visually transparent at
      {cfg.encoder.width}&times;{cfg.encoder.height} {cfg.encoder.fps}fps —
      measured against real files, the picture is bounded by the source above
      that, so more bits buy upload, not quality. Above your upload speed,
      viewers stutter.
    </p>
    <p class="muted small">
      Must divide Owncast&rsquo;s segment length. Two seconds is its recommendation;
      changing it can break segmenting.
    </p>


    <label>Encoder</label>
    {#if encoderList.length}
      <ul class="enc">
        <li>
          <input type="radio" bind:group={cfg.encoder.backend} value="auto" id="s-auto" />
          <label for="s-auto">Automatic <span class="muted small">— best that works</span></label>
        </li>
        {#each encoderList as e}
          <li>
            <!-- Before the probe has run nothing is known to be broken, so
                 nothing is disabled; the probe fills in the failures. -->
            <input type="radio" bind:group={cfg.encoder.backend} value={e.backend}
                   disabled={e.ok === false} id={`s-${e.backend}`} />
            <label for={`s-${e.backend}`} class:dim={e.ok === false}>
              {e.label}{#if e.ok === false}<span class="muted small"> — {e.error}</span>{/if}
            </label>
          </li>
        {/each}
      </ul>
      {#if encoders}
        <p class="muted small">ffmpeg {encoders.ffmpeg}</p>
      {:else}
        <p class="muted small">Probe to see which of these this machine can actually use.</p>
      {/if}
    {:else}
      <input bind:value={cfg.encoder.backend} spellcheck="false" />
    {/if}

    <label>HDR tone mapping</label>
    <select bind:value={cfg.encoder.tonemap}>
      <option value="auto">Automatic</option>
      <option value="vaapi" disabled={options?.tonemapEngines?.vaapi === false}>
        GPU{#if options?.tonemapEngines?.vaapi === false} — not available on this driver{/if}
      </option>
      <option value="cpu" disabled={options?.tonemapEngines?.cpu === false}>
        CPU{#if options?.tonemapEngines?.cpu === false} — not available in this build{/if}
      </option>
      <option value="none">Off</option>
    </select>
    <p class="muted small">
      {#if cfg.encoder.tonemap === 'auto'}
        Picks whatever this machine can do, and falls back on its own.
      {:else if cfg.encoder.tonemap === 'vaapi'}
        {#if options?.tonemapEngines?.vaapi === false}
          This driver has no VAAPI tone-map filter, so every HDR clip will fall
          back to the CPU. Pick Automatic or CPU instead.
        {:else}
          Free, but the curve is fixed. Falls back to the CPU if a file turns
          out not to work.
        {/if}
      {:else if cfg.encoder.tonemap === 'cpu'}
        Works anywhere and looks different; costs CPU that subtitles and
        decoding may also want. Roughly four times dearer at 4K than at 1080p.
      {:else}
        HDR goes out untouched — fastest, but the colours will look washed out.
      {/if}
    </p>

    {#if cfg.encoder.tonemap !== 'none'}
      <label>Tone-map curve</label>
      <select bind:value={cfg.encoder.tonemapCurve}>
        <option value="hable">Hable — keeps highlight detail (default)</option>
        <option value="mobius">Möbius — favours midtones</option>
        <option value="reinhard">Reinhard — soft, never clips harshly</option>
        <option value="clip">Clip — cheapest, crushes highlights</option>
      </select>
      <p class="muted small">
        Applies when tone mapping runs on the CPU. The GPU filter has a
        fixed curve — the driver decides its look.
      </p>
    {/if}

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.hdrOutput} style="width:auto"
             disabled={options?.hdr10 === false || (cfg.encoder.codec || 'h264') !== 'hevc'} />
      HDR output — keep HDR sources HDR
    </label>
    <p class="muted small">
      {#if options?.hdr10 === false}
        This driver cannot encode 10-bit HEVC, so there is no HDR to output.
      {:else if (cfg.encoder.codec || 'h264') !== 'hevc'}
        Needs the H.265 codec (H.264 cannot carry HDR) — pick it in the
        Broadcast card.
      {:else}
        HDR clips go out 10-bit with their colours intact instead of being
        tone-mapped down. A clip that must draw — subtitles, studio items —
        still tone-maps to SDR, because SDR text on an HDR frame looks
        broken. Viewers need an HDR-capable player; browsers mostly are not.
      {/if}
    </p>

    <label>Deinterlacing</label>
    <select bind:value={cfg.encoder.deinterlace}>
      <option value="auto">Auto — when the file says it is interlaced</option>
      <option value="on">Always — for mislabeled files that comb</option>
      <option value="off">Off</option>
    </select>
    <p class="muted small">
      DVD rips and broadcast captures comb without this. Costs one GPU pass
      (or a CPU filter on the software path) only when it actually runs.
    </p>

    <label>Render device</label>
    {#if options?.renderDevices?.length}
      <select bind:value={devSel} onchange={() => { if (devSel !== 'custom') cfg.encoder.device = devSel; }}>
        {#each options.renderDevices as d}<option value={d}>{nodeLabel(d)}</option>{/each}
        <option value="custom">Custom</option>
      </select>
      {#if devSel === 'custom'}
        <input bind:value={cfg.encoder.device} spellcheck="false" style="margin-top:8px" />
      {/if}
      <!-- The path alone is not identifying: renderD128 is whichever card
           enumerated first, so naming it is what lets someone notice they
           are encoding on the iGPU, or that only one node reached the
           container. -->
      {#if chosenNode}
        <p class="muted small">
          Encoding on <strong>{chosenNode.name ?? 'an unidentified device'}</strong>{#if chosenNode.driver}, via {chosenNode.driver}{/if}.
          {#if !chosenNode.usable}This node did not open — hardware encoding will fail on it.{/if}
        </p>
      {/if}
      {#if options.renderDevices.length > 1}
        <p class="muted small">
          Other nodes here:
          {#each (options.renderNodes ?? []).filter((n) => n.path !== cfg.encoder.device) as n, i}{#if i}, {/if}<code>{n.path.replace('/dev/dri/', '')}</code> ({n.name ?? 'unknown'}){/each}.
        </p>
      {:else}
        <p class="muted small">
          Only one render node reached this machine. If it has another GPU you
          would rather use, pass that node through as well.
        </p>
      {/if}
    {:else}
      <!-- No /dev/dri to enumerate: a CPU-only host, or the device was never
           passed into the container. Nothing to offer, so ask. -->
      <input bind:value={cfg.encoder.device} spellcheck="false" />
      <p class="muted small">
      No <code>/dev/dri</code> render node here &mdash; hardware encoding needs one
      passed into the container.
    </p>
    {/if}

    <p class="muted small">
      The output codec is chosen with the connection, in the Broadcast card
      — it decides which protocol carries the stream. Run "Test encoders"
      after changing it there; hardware support varies.
    </p>

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.hwDecode} style="width:auto" />
      Decode on the GPU
    </label>
    <p class="muted small">
      Depends on machine and file: a large win for 10-bit HEVC on a weak CPU, a
      loss for 8-bit H.264 on a strong one. Measure it.
    </p>

    <label>Live overlay compositor</label>
    <select value={cfg.encoder.overlayPipe === 'always' ? 'always'
        : cfg.encoder.overlayPipe !== false ? 'auto' : 'off'}
      onchange={(e) => {
        cfg.encoder.overlayPipe = e.currentTarget.value === 'always' ? 'always'
          : e.currentTarget.value === 'auto';
      }}>
      <option value="off">Off — the classic engine; every change lands behind the buffer</option>
      <option value="auto">When studio items exist — experimental; otherwise the classic engine runs</option>
      <option value="always">Always on — experimental; the compositor arms on every broadcast</option>
    </select>
    <p class="muted small">
      {#if cfg.encoder.overlayPipe === 'always'}
        Experimental. The compositor runs even with nothing to draw, so studio
        applies are live from the first show. A title that cannot afford the
        pass sheds it on its own.
      {:else if cfg.encoder.overlayPipe !== false}
        Experimental. Studio changes apply live while items exist; without
        any, the classic engine runs. Subtitle and audio switches land behind
        the buffer in every mode.
      {:else}
        The proven engine. Subtitle, audio and studio changes apply behind
        the buffer — viewers never see a seam; the change surfaces as the
        cushion drains.
      {/if}
    </p>

    <div class="g3" style="margin-top:6px">
      <div></div>
      <div>
        <label>Chunk length</label>
        <select bind:value={chunkSel} onchange={() => {
          if (chunkSel !== 'custom') cfg.encoder.chunkSeconds = Number(chunkSel);
        }}>
          {#each CHUNK_PRESETS as c}<option value={String(c)}>{c} seconds</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if chunkSel === 'custom'}
          <input class="exact" type="number" min="4" max="120"
                 bind:value={cfg.encoder.chunkSeconds} aria-label="Exact chunk length" />
        {/if}
      </div>
    </div>
    <p class="muted small">
      Video per worker on the CPU path. Longer means fewer seams but a longer
      wait to start. 20s suits most machines.
    </p>

    <p class="muted small" style="margin-top:14px;">
      Embedded subtitles are extracted to a local cache before first broadcast
      (the &ldquo;Preparing&rdquo; state); burning straight from a share stalls.
    </p>

    <div class="actions">
      <button class="primary" onclick={() => save('encoder')}>Save</button>
      <button onclick={probeEncoders} disabled={testing === 'encoder'}>
        {testing === 'encoder' ? 'Probing…' : 'Probe encoders'}
      </button>
      {#if saved === 'encoder'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  <!-- Buffer -->
  <section class="subcard">
    <h3>Buffer</h3>
    <p class="muted small" style="margin-top:0">
      Encoded video held ahead of air. Deeper survives a title that cannot keep
      up; shallower applies changes sooner and wastes less on a skip. GPU path only.
    </p>

    <label>Depth</label>
    <div style="max-width: 260px;">
      <select bind:value={bufferSel} onchange={() => {
        if (bufferSel !== 'custom') setBuffer(Number(bufferSel));
      }}>
        {#each BUFFER_PRESETS as n}<option value={String(n)}>{n} seconds</option>{/each}
        <option value="custom">Custom</option>
      </select>
      {#if bufferSel === 'custom'}
        <label class="row" style="margin-top:8px;">
          <input type="number" min="1" max="60" step="1" value={cfg.buffer.seconds}
                 oninput={(e) => setBuffer(+e.currentTarget.value)} style="width:80px" />
          <span>seconds</span>
        </label>
      {/if}
    </div>
    <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('buffer')}>Save</button>
      {#if saved === 'buffer'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  <!-- Run-ahead cache -->
  <section class="subcard">
    <h3>Run-ahead cache</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.runAhead.enabled} style="width:auto" />
      Build a deep cushion in RAM when there is spare horsepower
    </label>
    <p class="muted small" style="margin-top:6px;">
      How much encoded video may wait in RAM ahead of air. Off does not stop
      encoding ahead &mdash; CPU clips still build the head start they need to
      start at all.
    </p>
    {#if cfg.runAhead.enabled}
      <div style="margin-top:10px; max-width: 320px;">
        <label>RAM limit (MB)</label>
        <input type="number" min="64" step="64"
               placeholder={`auto — recommended ${cfg.recommendedCacheMB ?? '?'} MB`}
               value={cfg.runAhead.ramMB === 'auto' ? '' : cfg.runAhead.ramMB}
               onchange={(e) => {
                 const v = e.currentTarget.value.trim();
                 cfg.runAhead.ramMB = v === '' ? 'auto' : Number(v);
               }} />
        <p class="muted small" style="margin-top:6px;">
          Empty for auto: {cfg.recommendedCacheMB ?? '?'} MB here. RAM only; if
          /dev/shm cannot hold it, caching switches off. Applies next broadcast.
        </p>
        <p class="muted small" style="margin-top:6px;">
          Only CPU clips use it &mdash; working ahead is what makes their seeking
          instant. GPU clips restart in under a second anyway.
        </p>
      </div>
    {/if}
      <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('runahead')}>Save</button>
      {#if saved === 'runahead'}<span class="ok small">Saved</span>{/if}
    </div>
</section>

  </section>

  <!-- ===== Studio: the engine behind the Studio tab ===== -->
  <section class="card group">
    <h3>Studio</h3>
    <p class="lead muted small">The engine behind the Studio tab — items themselves are placed there.</p>
  <!-- Studio -->
  <section class="subcard">

    <label>
      Overlay changes go on air
      <span class="muted small">
        {cfg.buffer.applySeconds < 1
          ? 'immediately'
          : `after about ${cfg.buffer.applySeconds}s`}
      </span>
    </label>
    <input type="range" min="0" max={cfg.buffer.seconds} step="1"
           value={cfg.buffer.applySeconds}
           oninput={(e) => { cfg.buffer.applySeconds = +e.currentTarget.value; }} />
    <p class="muted small">
      {#if cfg.buffer.applySeconds >= cfg.buffer.seconds}
        Nothing discarded, no interruption. Safest.
      {:else if cfg.buffer.applySeconds < 1}
        Cushion dropped &mdash; viewers re-buffer while the encoder catches up.
      {:else}
        Part of the cushion is re-encoded. Fine while the encoder stays ahead.
      {/if}
      Maximum is the buffer depth, {cfg.buffer.seconds}s.
    </p>

    <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
      <input type="checkbox" bind:checked={cfg.buffer.studioWarnings} style="width:auto" />
      Show encoder cost warnings in Studio
    </label>
    <p class="muted small">
      The red notes in Studio about moving pictures and GIFs. The console report
      is unaffected.
    </p>
    <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('studio')}>Save</button>
      {#if saved === 'studio'}<span class="ok small">Saved</span>{/if}
    </div>
  </section>

  </section>

  <!-- ===== System ===== -->
  <section class="card group">
    <h3>System</h3>
    <p class="lead muted small">Panel access and diagnostics.</p>
  <!-- Live preview -->
  <section class="subcard">
    <h3>Live preview</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.preview.enabled} style="width:auto" />
      Floating preview window while broadcasting
    </label>
    <p class="muted small">
      The exact stream Owncast receives, straight from the encoder. No extra
      encoding, just its bitrate to each viewer.
    </p>
      <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('preview')}>Save</button>
      {#if saved === 'preview'}<span class="ok small">Saved</span>{/if}
    </div>
</section>

  <!-- Developer -->
  <section class="subcard">
    <h3>Developer</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.devMode} style="width:auto" />
      Developer mode — show the read-only Console page
    </label>
    <p class="muted small">
      Live server and ffmpeg logs, keys redacted. Useful for bug reports.
    </p>
      <div class="row" style="margin-top:12px">
      <button class="primary" onclick={() => save('dev')}>Save</button>
      {#if saved === 'dev'}<span class="ok small">Saved</span>{/if}
    </div>
</section>

  <!-- Account -->
  <section class="subcard">
    <h3>Password</h3>
    <label>Current password</label>
    <input type="password" bind:value={pwCurrent} autocomplete="current-password" />
    <label>New password</label>
    <input type="password" bind:value={pwNext} autocomplete="new-password"
           placeholder="at least 8 characters" />
    <div class="actions">
      <button class="primary" onclick={changePassword}
              disabled={!pwNext || pwNext.length < 8}>Change password</button>
      <div style="flex:1"></div>
      <button onclick={logout}>Sign out</button>
    </div>
    {#if pwMsg}<p class="small">{pwMsg}</p>{/if}
  </section>
  </section>



  </div>

  </div>
  {/if}
  {#if browsing}
    <DirBrowser start={parseList(fsRoots)[0] ?? '/'}
                onpick={addRoot} onclose={() => (browsing = false)} />
  {/if}

  <p class="muted small foot" class:centered={viewMode === 'simple'}>
      Prefer the guided flow? <a href="/setup">Re-run setup</a> &mdash; same settings, in order.
    </p>
{/if}
</div>

<style>
  /* Full-width inputs on a wide monitor stretch absurdly; settings read as a
     form, and forms want a centered column, not a strip down the left edge. */
  .wrap { max-width: 1120px; margin: 0 auto; }
  section { margin-bottom: 16px; }

  /* Two explicit columns of group cards — curated, not masonry: with only
     five cards of very different heights the browser's own balancing
     reorders the visual flow, so the pairing is chosen by hand instead.
     Left: the streaming concerns (Broadcast, Studio, System). Right: the
     machine and the content (Output, Library). */
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
          align-items: start; }
  .col { min-width: 0; }
  .simplecol { max-width: 640px; margin: 0 auto; }
  .pagehead { display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
              margin: 0 0 26px; }
  .pagehead h1 { margin: 0; flex: 1; }
  .pagehead .segc { margin-top: 0; }

  /* A group card holds the old cards as quiet subsections. */
  .group > .lead { margin: 0 0 2px; }
  .subcard { margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border); }
  .subcard:first-of-type { border-top: 0; padding-top: 4px; margin-top: 10px; }
  .subcard h3 {
    font-size: 13px; color: var(--muted); font-weight: 600;
    border-bottom: 0; padding-bottom: 0; margin-bottom: 2px;
    text-transform: uppercase; letter-spacing: .06em;
  }

  /* Simple mode levers. */
  .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
             gap: 10px; margin-top: 10px; }
  .choice { text-align: left; padding: 12px 14px; display: flex; flex-direction: column;
            gap: 2px; background: var(--surface); width: auto; }
  .choice.on { border-color: var(--accent);
               box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  .choice .cname { font-weight: 500; font-size: 14px; }
  .choice .cdesc { font-size: 12.5px; color: var(--muted); line-height: 1.45; }
  .diff { font-size: 13px; color: var(--muted); margin-top: 10px; }
  .diff summary { cursor: pointer; user-select: none; }
  .diff b { color: var(--text); font-weight: 500; }
  .driftline { font-size: 12.5px; color: var(--muted); margin: 8px 0 0; }
  .driftline b { color: var(--text); }
  .snapbtn { background: none; border: 0; padding: 0; font-size: inherit;
    color: var(--accent, #7aa2f7); cursor: pointer; text-decoration: underline; }
  .snapname { font-size: 12px; padding: 2px 6px; margin: 0 2px; width: 130px;
    display: inline-block; vertical-align: baseline; }
  .foot { margin-top: 18px; }
  /* Simple mode centers a narrow column; the footer follows it instead of
     hugging the page edge. */
  .foot.centered { max-width: 640px; margin-left: auto; margin-right: auto; }

  @media (max-width: 900px) {
    .wrap { max-width: 680px; }
    .cols { grid-template-columns: 1fr; }
  }
  section h3 {
    margin: 0 0 4px; padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input, select, textarea {
    width: 100%; font: inherit; color: inherit;
    border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--surface); padding: 8px 11px;
  }
  /* The text-field chrome above must not apply to sliders: padding insets
     the native track inside the border box, so the thumb visually never
     reaches the ends — it reads as "cannot be maxed out". */
  input[type="range"] {
    padding: 0; border: 0; background: transparent; height: 28px;
  }
  .g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  /* The free field a "Custom" choice reveals, tucked under its own select so
     the pair never gets split across a wrapped grid row. */
  .exact { margin-top: 6px; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  /* Direct children only: this rule sizes the path-mapping text fields, and
     unscoped it also stretched radio buttons nested inside labels. */
  .actions > input { flex: 1; min-width: 120px; }
  .actions button { flex-shrink: 0; }
  .ok { color: var(--success); animation: okin .2s ease; }
  @keyframes okin { from { opacity: 0; transform: translateX(-4px); } }
  .langs { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 0; }
  .langs .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 13px; border-radius: 999px; font-size: 13px;
    background: var(--surface-2); border: 1px solid transparent; color: var(--muted);
  }
  .langs .chip:hover { color: var(--text); }
  .langs .chip.on { color: var(--accent); border-color: var(--accent); background: transparent; }
  /* The rank, not a count: preference order decides which dub is picked. */
  .langs .pri {
    display: inline-grid; place-items: center;
    width: 17px; height: 17px; border-radius: 50%;
    background: var(--accent); color: var(--bg);
    font-size: 11px; font-weight: 600;
  }

  .srcbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
  .srcbar .chip {
    padding: 5px 13px; border-radius: 999px; font-size: 13px;
    background: var(--surface-2); border: 1px solid transparent; color: var(--muted);
  }
  .srcbar .chip:hover { color: var(--text); }
  .srcbar .chip.on { color: var(--accent); border-color: var(--accent); background: transparent; }
  .srcbar .chip.add { border-style: dashed; border-color: var(--border); }
  .srcfoot {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
  }
  .srcfoot .danger { color: var(--danger); border-color: transparent; }
  .srcfoot .danger:hover { border-color: var(--danger); }

  .segc {
    display: inline-flex; gap: 2px; margin-top: 10px; padding: 3px;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 999px;
  }
  .segc button {
    border: none; background: transparent; border-radius: 999px;
    padding: 6px 16px; font-size: 13px; color: var(--muted);
  }
  .segc button.on {
    background: var(--surface); color: var(--text);
    box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  .result {
    margin-top: 10px; padding: 9px 12px; border-radius: var(--radius); font-size: 13px;
    background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success);
  }
  .result.bad {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger); white-space: pre-wrap;
  }
  .enc { list-style: none; padding: 0; margin: 4px 0; }
  .enc li { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; }
  .enc input { width: auto; }
  .enc label { margin: 0; color: inherit; font-size: 14px; }
  .enc label.dim { color: var(--muted); }
  a { color: var(--accent); }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  .warnline {
    font-size: 12.5px; margin: 6px 0 0;
    color: #c98a2e;
  }
  .segc .tag {
    font-size: 9px; text-transform: uppercase; letter-spacing: .04em;
    margin-left: 5px; opacity: .75;
  }
  h4.sub { margin: 18px 0 6px; font-size: 13px; color: var(--muted); font-weight: 600; }
  .extra {
    border: 1px solid var(--border); border-radius: var(--radius);
    padding: 9px 10px; margin-bottom: 8px; background: var(--surface-2);
  }
  .extrahead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .extra input { margin-top: 5px; }
</style>

