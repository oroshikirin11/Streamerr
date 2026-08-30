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
    { id: 'rtmp', label: 'RTMP' },
    { id: 'rtmps', label: 'RTMPS' },
    { id: 'srt', label: 'SRT' },
  ];
  const uid = () => Math.random().toString(36).slice(2, 10);

  /**
   * Lowering the depth must carry the apply point down with it, or the
   * setting would ask for more cushion than exists and the engine would
   * quietly clamp it — the slider would then be showing a number that never
   * happens.
   */
  const BUFFER_PRESETS = [5, 10, 15, 30, 45, 60];
  let bufferSel = $state('15');

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
  const SECRET_OF = { rtmp: ['key'], rtmps: ['key'], srt: ['streamId', 'passphrase'] };
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
    for (const proto of ['rtmp', 'rtmps', 'srt']) {
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
    for (const proto of ['rtmp', 'rtmps', 'srt']) {
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
  const scanLabel = (h) => (h === 168 ? 'Weekly' : h === 24 ? 'Daily' : `Every ${h} hours`);

  /** Server-supplied choices: the language table and the real /dev/dri nodes. */
  let options = $state(null);

  // Which dropdown entry is showing. 'custom' reveals the original free field.
  let fpsSel = $state('30');
  let gopSel = $state('2');
  let vbrSel = $state('4500k');
  let abrSel = $state('160k');
  let scanSel = $state('12');
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
    vbrSel = pick(VBR_PRESETS, brKey(cfg.encoder.videoBitrate));
    abrSel = pick(ABR_PRESETS, brKey(cfg.encoder.audioBitrate));
    scanSel = pick(SCAN_PRESETS, cfg.library.autoRefresh.hours);
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
    return Math.round((w * h * f * 0.07) / 1000 / 500) * 500;
  });

  function syncPresetFromCfg() {
    const hit = RES_PRESETS.find((r) => r.w === +cfg.encoder.width && r.h === +cfg.encoder.height);
    resPreset = hit ? hit.key : 'custom';
  }
  function applyPreset() {
    const r = RES_PRESETS.find((x) => x.key === resPreset);
    if (r) { cfg.encoder.width = r.w; cfg.encoder.height = r.h; }
  }

  onMount(load);

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
          audioBitrate: cfg.encoder.audioBitrate,
          gopSeconds: +cfg.encoder.gopSeconds, device: cfg.encoder.device,
          codec: cfg.encoder.codec || 'h264',
          tonemap: cfg.encoder.tonemap || 'auto',
          frameSize: frameSize,
          hwDecode: Boolean(cfg.encoder.hwDecode),
          overlayPipe: cfg.encoder.overlayPipe !== false,
          chunkSeconds: +cfg.encoder.chunkSeconds || 20,
        };
      }
      if (section === 'publish') patch.publish = maskPublish(cfg.publish);
      // Two cards write to the same block; the server merges, so each sends
      // only the keys it owns and neither can clobber the other's.
      if (section === 'buffer') patch.buffer = { seconds: cfg.buffer.seconds };
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
<h1>Settings</h1>

{#if !cfg}
  <p class="muted">Loading…</p>
{:else}
  {#if error}<p class="err">{error}</p>{/if}

  <div class="cols">
  <!-- Broadcast destination -->
  <section class="card">
    <h3>Broadcast</h3>

    <!-- Credentials live in a slot per protocol, so switching here never
         discards the other set. Switch back and the fields are as they
         were; overwrite by typing over them. -->
    <label>Protocol</label>
    <div class="segc" role="radiogroup" aria-label="Protocol">
      {#each PROTOCOL_INFO as pr}
        <!-- A protocol that already holds credentials is marked, so it is
             obvious at a glance that switching away from one will not lose
             it — and that the one in use is genuinely configured. -->
        <button type="button" class:on={cfg.publish.protocol === pr.id}
                onclick={() => { cfg.publish.protocol = pr.id; }}>
          <strong>{pr.label}</strong>
          {#if cfg.publish[pr.id]?.url}
            <span class="tag">{cfg.publish.protocol === pr.id ? 'in use' : 'saved'}</span>
          {/if}
        </button>
      {/each}
    </div>

    {#if cfg.publish.protocol === 'srt'}
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
      <input type="range" min="20" max="2000" step="10"
             value={cfg.publish.srt.latencyMs ?? 200}
             oninput={(e) => { cfg.publish.srt.latencyMs = +e.currentTarget.value; }} />
      <p class="muted small">
      Time allowed to re-request lost packets. Higher survives a worse link,
      at the cost of delay. Rule of thumb: four times the round trip.
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

  <!-- Buffer -->
  <section class="card">
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

  <!-- Studio -->
  <section class="card">
    <h3>Studio</h3>

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

  <!-- Owncast -->
  <section class="card">
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

  <!-- Streamingestarr -->
  <section class="card">
    <h3>Streamingestarr</h3>
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

  <!-- Encoder -->
  <section class="card">
    <h3>Output</h3>
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
        <label>Video bitrate</label>
        <select bind:value={vbrSel} onchange={() => choose('videoBitrate', vbrSel)}>
          {#each VBR_PRESETS as b}<option value={b}>{parseInt(b, 10).toLocaleString()} kbps</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if vbrSel === 'custom'}
          <input class="exact" bind:value={cfg.encoder.videoBitrate} spellcheck="false"
                 aria-label="Exact video bitrate" placeholder="4500k" />
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

    <p class="muted small">
      About {recommendedVbr.toLocaleString()} kbps suits
      {cfg.encoder.width}&times;{cfg.encoder.height} at {cfg.encoder.fps}fps.
      Above your upload speed, viewers stutter. Auto keeps each file&rsquo;s rate
      up to the cap.
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

    <label>Output codec</label>
    <select bind:value={cfg.encoder.codec}>
      <option value="h264">H.264 — plays everywhere (default)</option>
      <option value="hevc">H.265/HEVC — ~35% less bitrate; Apple + hw-decode Chromium only</option>
      <option value="av1">AV1 — best compression; Chromium/Firefox; needs SRT to the receiver</option>
    </select>
    <p class="muted small">
      Run "Test encoders" after changing this — hardware support varies
      (this box may fall back to a software encoder or refuse). AV1 cannot
      travel over RTMP or MPEG-TS; use an SRT destination.
    </p>

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.hwDecode} style="width:auto" />
      Decode on the GPU
    </label>
    <p class="muted small">
      Depends on machine and file: a large win for 10-bit HEVC on a weak CPU, a
      loss for 8-bit H.264 on a strong one. Measure it.
    </p>

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.overlayPipe} style="width:auto" />
      Live overlay compositor
    </label>
    <p class="muted small">
      On: Studio changes reach the stream without restarting the encoder
      (subtitle and overlay changes apply live). Off: the classic engine
      from before the compositor &mdash; every Studio change restarts the
      source behind the buffer. Takes effect from the next episode or the
      next broadcast.
    </p>

    <div class="g3" style="margin-top:6px">
      <div></div>
      <div>
        <label>Chunk length (s)</label>
        <input type="number" min="4" max="120" bind:value={cfg.encoder.chunkSeconds} />
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

  <!-- Library -->
  <section class="card">
    <h3>Library</h3>
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
                onclick={() => (src.provider = 'filesystem')}>A folder</button>
        <button class:on={src.provider === 'smb'}
                onclick={() => (src.provider = 'smb')}>SMB share</button>
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
      Read over the network &mdash; no mount, no privileges, read-only. First playback
      of each file is slower.
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
    <section class="card">
      <h3>Titles and artwork</h3>
      <p class="muted small" style="margin-top:0">
        Optional. Without it we use the filenames.
      </p>

      <div class="segc" role="radiogroup" aria-label="Metadata source">
        <button class:on={metaProvider === 'none'}
                onclick={() => setMeta('none')}>Filenames</button>
        <button class:on={metaProvider === 'jellyfin'}
                onclick={() => setMeta('jellyfin')}>Jellyfin</button>
        <button disabled>TheTVDB <span class="tag">soon</span></button>
      </div>

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
  <section class="card">
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

  <!-- Run-ahead cache -->
  <section class="card">
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

  <!-- Live preview -->
  <section class="card">
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

  <!-- Automatic scan -->
  <section class="card">
    <h3>Automatic library scan</h3>
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
  <section class="card">
    <h3>Library display</h3>
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

  <!-- Developer -->
  <section class="card">
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
  <section class="card">
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
  </div>

  {#if browsing}
    <DirBrowser start={parseList(fsRoots)[0] ?? '/'}
                onpick={addRoot} onclose={() => (browsing = false)} />
  {/if}

  <p class="muted small">
      Prefer the guided flow? <a href="/setup">Re-run setup</a> &mdash; same settings, in order.
    </p>
{/if}
</div>

<style>
  /* Full-width inputs on a wide monitor stretch absurdly; settings read as a
     form, and forms want a centered column, not a strip down the left edge. */
  .wrap { max-width: 1120px; margin: 0 auto; }
  section { margin-bottom: 16px; }

  /* Two columns, packed. Multi-column rather than grid because the cards are
     wildly different heights — a grid aligns them into rows and leaves a
     ragged gap under every short one. The browser balances the two column
     heights itself, so the page ends flat instead of trailing off. */
  .cols { columns: 2; column-gap: 16px; }
  /* Without this a card is sliced in half across the column break. */
  .cols > section { break-inside: avoid; }
  /* One column when there is no room for two readable ones. 680px was the
     old single-column width — a lone column should not stretch past it. */
  @media (max-width: 900px) {
    .wrap { max-width: 680px; }
    .cols { columns: 1; }
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

