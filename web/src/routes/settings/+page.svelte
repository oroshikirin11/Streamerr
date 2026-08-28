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
  let tokenStored = $state(false);
  let accessToken = $state('');
  let titleTest = $state(null);
  let jfKeyStored = $state(false);
  let jellyfinKey = $state('');

  let owncastResult = $state(null);
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
    ['fixed', 'fit', 'source'].includes(cfg?.encoder?.frameSize)
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
      keyStored = cfg.owncast.streamKey === '__SET__';
      tokenStored = cfg.owncast.accessToken === '__SET__';
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
    x.smb ??= { host: '', share: '', path: '', username: '', password: '', guest: true };
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

  async function saveAutoRefresh() {
    const a = cfg.library.autoRefresh;
    // Mirror the server's clamp so the field cannot show a value that is not
    // the one actually in effect.
    a.hours = Math.min(168, Math.max(1, Math.round(Number(a.hours) || 12)));
    await api.saveConfig({ library: { autoRefresh: { enabled: a.enabled, hours: a.hours } } });
    saved = 'autoscan';
    setTimeout(() => { if (saved === 'autoscan') saved = ''; }, 2500);
  }

  function libraryPayload() {
    // The whole list every time: sources are identified by id, and the
    // server puts real credentials back wherever the panel echoed the
    // sentinel, so an untouched key survives a save of anything else.
    return {
      sources: cfg.library.sources.map((x, i) => {
        const out = { id: x.id, name: x.name?.trim() || `Source ${i + 1}`, provider: x.provider };
        if (x.provider === 'jellyfin') {
          out.jellyfin = { url: x.jellyfin.url, apiKey: i === sel && jellyfinKey ? jellyfinKey : (x.jellyfin.apiKey || '') };
          out.pathMap = x.pathMap ?? [];
        } else if (x.provider === 'smb' || x.provider === 'smbmount') {
          out.smb = {
            host: x.smb.host, share: x.smb.share, path: x.smb.path,
            guest: x.smb.guest,
            username: x.smb.guest ? '' : x.smb.username,
            password: x.smb.guest ? '' : (i === sel && smbPassword ? smbPassword : (x.smb.password || '')),
          };
        } else {
          out.filesystem = { roots: i === sel ? parseList(fsRoots) : (x.filesystem.roots ?? []) };
        }
        return out;
      }),
    };
  }

  async function save(section) {
    error = ''; saved = '';
    try {
      const patch = {};
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
          frameSize: frameSize,
          hwDecode: Boolean(cfg.encoder.hwDecode),
          chunkSeconds: +cfg.encoder.chunkSeconds || 20,
        };
      }
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
  <!-- Owncast -->
  <section class="card">
    <h3>Owncast</h3>
    <label>Server address</label>
    <input bind:value={cfg.owncast.rtmpUrl} spellcheck="false" />

    <label>Stream key</label>
    <input type="password" bind:value={streamKey}
           placeholder={keyStored ? 'leave blank to keep the saved key' : 'from Owncast admin'} />
    {#if keyStored && !streamKey}
      <p class="muted small">A key is saved. It is never sent back to the browser.</p>
    {/if}

    <label style="display:flex; align-items:center; gap:8px; margin-top:10px;">
      <input type="checkbox" bind:checked={cfg.owncast.syncTitle} style="width:auto" />
      Update the Owncast stream title as episodes change
    </label>
    <p class="muted small">
      Viewers see the episode on air ("Show — S1E4") in the header of the
      watch page while you are live.
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
        <div><label>Size</label>
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
    <p class="muted small">
      About {recommendedVbr.toLocaleString()} kbps suits
      {cfg.encoder.width}&times;{cfg.encoder.height} at {cfg.encoder.fps}fps, and
      anything above your upload speed will stutter for viewers. Auto
      framerate outputs each file at its native rate (24fps anime stays
      24fps &mdash; less GPU work, no judder) up to the cap; 60fps sources
      are brought down to it.
    </p>
    <p class="muted small">
      Keyframe interval must divide Owncast's segment length. Two seconds is
      what its documentation recommends; changing it can break segmenting.
    </p>

    <label style="margin-top:14px;">Frame size</label>
    <div class="segc" role="radiogroup" aria-label="Frame size">
      <button class:on={frameSize === 'fixed'}
              onclick={() => (cfg.encoder.frameSize = 'fixed')}>Always the same</button>
      <button class:on={frameSize === 'fit'}
              onclick={() => (cfg.encoder.frameSize = 'fit')}>Fit the picture</button>
      <button class:on={frameSize === 'source'}
              onclick={() => (cfg.encoder.frameSize = 'source')}>Match the file</button>
    </div>
    <p class="muted small">
      {#if frameSize === 'fixed'}
        Every clip is sent at {cfg.encoder.width}&times;{cfg.encoder.height}, with
        black bars added around anything that is not that shape. The stream
        never reconnects.
      {:else if frameSize === 'fit'}
        Bars are dropped: a 4:3 episode goes out at {fitExample} instead of
        {cfg.encoder.width}&times;{cfg.encoder.height} &mdash; about a fifth less to
        encode &mdash; and a scope film loses its top and bottom bars.
        <strong>{cfg.encoder.width}&times;{cfg.encoder.height} stays the maximum</strong>,
        so a 4K file still comes down to it.
      {:else}
        Each file is sent at its own size, <strong>with no maximum</strong> &mdash; a
        4K file is encoded at 4K, which most machines cannot do in real time.
        The resolution above is ignored. Choose this only if you know the
        hardware can keep up.
      {/if}
    </p>
    {#if frameSize !== 'fixed'}
      <p class="warnline">
        The frame size is fixed for one connection, so moving between clips of
        different shapes reconnects the stream and viewers see it drop for a
        moment. Within a series that never happens.
      </p>
    {/if}

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

    <label>Render device</label>
    {#if options?.renderDevices?.length}
      <select bind:value={devSel} onchange={() => { if (devSel !== 'custom') cfg.encoder.device = devSel; }}>
        {#each options.renderDevices as d}<option value={d}>{d}</option>{/each}
        <option value="custom">Custom</option>
      </select>
      {#if devSel === 'custom'}
        <input bind:value={cfg.encoder.device} spellcheck="false" style="margin-top:8px" />
      {/if}
      {#if options.renderDevices.length > 1}
        <p class="muted small">
          This machine exposes {options.renderDevices.length} render nodes. If
          the encoder probe fails on one, try the other.
        </p>
      {/if}
    {:else}
      <!-- No /dev/dri to enumerate: a CPU-only host, or the device was never
           passed into the container. Nothing to offer, so ask. -->
      <input bind:value={cfg.encoder.device} spellcheck="false" />
      <p class="muted small">
        No <code>/dev/dri</code> render node is visible here, so hardware
        encoding will not work until one is passed into the container.
      </p>
    {/if}

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.hwDecode} style="width:auto" />
      Decode on the GPU
    </label>
    <p class="muted small">
      Whether this helps depends on the machine and the file &mdash; a large
      win for 10-bit HEVC on a weak CPU, a loss for 8-bit H.264 on a strong
      one. Measure it with <code>cli.js benchmark &lt;file&gt;</code> rather
      than guessing.
    </p>

    <div class="g3" style="margin-top:6px">
      <div></div>
      <div>
        <label>Chunk length (s)</label>
        <input type="number" min="4" max="120" bind:value={cfg.encoder.chunkSeconds} />
      </div>
    </div>
    <p class="muted small">
      How much video each worker on the CPU path encodes at a time. Longer
      chunks mean fewer seams, but a longer wait before playback starts &mdash;
      the first chunk has to finish before anything goes out. 20s suits most
      machines; shorten it if startup feels slow. How many workers run at once
      is decided per clip by the engine, since the right answer depends on
      whether that file can use the GPU compositor.
    </p>

    <p class="muted small" style="margin-top:14px;">
      Embedded subtitles are extracted to a local cache before their first
      broadcast (the &ldquo;Preparing&rdquo; state) &mdash; burning them
      straight from the media file would read the whole file a second time
      during playback, which is slower on every file and fatal on large ones.
      Cached files make every later broadcast start instantly.
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

      <div class="segc" role="radiogroup" aria-label="Library provider">
        <button class:on={src.provider === 'jellyfin'}
                onclick={() => (src.provider = 'jellyfin')}>Jellyfin</button>
        <button class:on={src.provider === 'filesystem'}
                onclick={() => (src.provider = 'filesystem')}>A folder</button>
        <button class:on={src.provider === 'smb'}
                onclick={() => (src.provider = 'smb')}>SMB share</button>
      </div>

    {#if src.provider === 'jellyfin'}
      <label>Jellyfin URL</label>
      <input bind:value={src.jellyfin.url} spellcheck="false" />
      <label>API key</label>
      <input type="password" bind:value={jellyfinKey}
             placeholder={jfKeyStored ? 'leave blank to keep the saved key' : 'Dashboard → API Keys'} />
    {:else if src.provider === 'smb'}
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
        Read directly over the network — no mount, no privileges, works in
        any container. The share is only ever read. Note: the first
        playback of each file is slower than from local disk (subtitle
        extraction reads it once in full over the network), and heavy
        CPU-transcoded media may start noticeably slower than it would
        from a local folder or Jellyfin mount.
      </p>
    {:else}
      <label>Folders, one per line</label>
      <textarea rows="3" bind:value={fsRoots} spellcheck="false"></textarea>
      <div class="actions" style="margin-top:8px;">
        <button onclick={() => (browsing = true)}>Browse…</button>
      </div>
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

  <!-- Path mapping -->
  {#if src?.provider === 'jellyfin'}
    <section class="card">
      <h3>Path mapping</h3>
      <p class="muted small">
        Only needed when Jellyfin reports paths this service cannot open — a
        Jellyfin in Docker seeing <code>/media</code> where this sees
        <code>/extHdd</code>. Usually empty.
      </p>
      {#each src.pathMap as r, i}
        <div class="actions">
          <input bind:value={r.from} placeholder="/media/" spellcheck="false" />
          <span class="muted">→</span>
          <input bind:value={r.to} placeholder="/extHdd/" spellcheck="false" />
          <button onclick={() => removeRule(i)}>Remove</button>
        </div>
      {/each}
      <div class="actions">
        <button class="primary" onclick={() => save('library')}>Save</button>
        <button onclick={addRule}>Add rule</button>
        <button onclick={checkPaths} disabled={testing === 'paths'}>
          {testing === 'paths' ? 'Checking…' : 'Check paths'}
        </button>
      </div>
      {#if pathmap}
        <div class="result" class:bad={!pathmap.noMappingNeeded && !src.pathMap.length}>
          {#if pathmap.noMappingNeeded}
            Every path Jellyfin reports is readable here — no mapping needed.
          {:else}
            Jellyfin reports: {pathmap.reported.join(', ') || '—'}<br />
            Readable here: {pathmap.reachable?.join(', ') || 'none'}
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  <!-- Languages -->
  <section class="card">
    <h3>Languages</h3>
    <p class="muted small">
      Your preferred language is selected automatically, like Jellyfin.
      You can change audio or subtitles at any time, including mid-episode.
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
        Click in order of preference &mdash; the first one a file offers wins.
        Used both to pick a dub and to choose a subtitle language.
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
      With original audio and the first subtitle option, anime plays in
      Japanese with your subtitles and an English film plays with none.
      Individual episodes can still be overridden from the library.
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
      <input type="checkbox" bind:checked={cfg.runAhead.enabled} style="width:auto"
             onchange={async () => {
               await api.saveConfig({ runAhead: { enabled: cfg.runAhead.enabled } });
               saved = 'runahead';
               setTimeout(() => { if (saved === 'runahead') saved = ''; }, 2500);
             }} />
      Encode ahead of the broadcast when there is spare horsepower
      {#if saved === 'runahead'}<span class="ok small">Saved</span>{/if}
    </label>
    {#if cfg.runAhead.enabled}
      <div style="margin-top:10px; max-width: 320px;">
        <label>RAM limit (MB)</label>
        <input type="number" min="64" step="64"
               placeholder={`auto — recommended ${cfg.recommendedCacheMB ?? '?'} MB`}
               value={cfg.runAhead.ramMB === 'auto' ? '' : cfg.runAhead.ramMB}
               onchange={async (e) => {
                 const v = e.currentTarget.value.trim();
                 cfg.runAhead.ramMB = v === '' ? 'auto' : Number(v);
                 await api.saveConfig({ runAhead: { ramMB: cfg.runAhead.ramMB } });
                 saved = 'runahead';
                 setTimeout(() => { if (saved === 'runahead') saved = ''; }, 2500);
               }} />
        <p class="muted small" style="margin-top:6px;">
          Leave empty for auto: {cfg.recommendedCacheMB ?? '?'} MB recommended on
          this machine, computed from the memory the container actually has.
          The cache lives in RAM only — if /dev/shm cannot hold it, caching
          switches off rather than touching a disk. Applies from the next
          broadcast.
        </p>
        <p class="muted small" style="margin-top:6px;">
          Only media that must be processed on the CPU — subtitle burn-in
          the GPU cannot composite — uses the cache: those encodes run near
          realtime, so working ahead is what makes seeking and pausing
          instant. GPU-processed media already restarts anywhere in under a
          second and streams at realtime by design, so it plays without a
          cache and shows no cache bar on the timeline.
        </p>
      </div>
    {/if}
  </section>

  <!-- Live preview -->
  <section class="card">
    <h3>Live preview</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.preview.enabled} style="width:auto"
             onchange={async () => {
               await api.saveConfig({ preview: { enabled: cfg.preview.enabled } });
               saved = 'preview';
               setTimeout(() => { if (saved === 'preview') saved = ''; }, 2500);
             }} />
      Floating preview window while broadcasting
      {#if saved === 'preview'}<span class="ok small">Saved</span>{/if}
    </label>
    <p class="muted small">
      Plays the exact stream Owncast receives, straight from the encoder —
      it costs the server no extra encoding work, only the stream's own
      bitrate to each open panel. Each panel can also hide it with the
      button on the play bar; this switch turns it off everywhere.
    </p>
  </section>

  <!-- Automatic scan -->
  <section class="card">
    <h3>Automatic library scan</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.library.autoRefresh.enabled} style="width:auto"
             onchange={saveAutoRefresh} />
      Scan for new media automatically
      {#if saved === 'autoscan'}<span class="ok small">Saved</span>{/if}
    </label>
    {#if cfg.library.autoRefresh.enabled}
      <div style="margin-top:10px; max-width: 260px;">
        <select bind:value={scanSel} onchange={() => {
          if (scanSel !== 'custom') cfg.library.autoRefresh.hours = Number(scanSel);
          saveAutoRefresh();
        }}>
          {#each SCAN_PRESETS as h}<option value={String(h)}>{scanLabel(h)}</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if scanSel === 'custom'}
          <label class="row" style="margin-top:8px;">
            <span>Every</span>
            <input type="number" min="1" max="168" step="1"
                   bind:value={cfg.library.autoRefresh.hours}
                   onchange={saveAutoRefresh} style="width:80px" />
            <span>hours</span>
          </label>
        {/if}
      </div>
    {/if}
    <p class="muted small">
      Asks every Jellyfin source to rescan, then reloads the shelves — so an
      episode added to your server turns up on its own. The Refresh button on
      the library page does the same thing immediately.
    </p>
  </section>

  <!-- Library display -->
  <section class="card">
    <h3>Library display</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.ui.lazyImages} style="width:auto"
             onchange={async () => {
               await api.saveConfig({ ui: { lazyImages: cfg.ui.lazyImages } });
               saved = 'ui';
               setTimeout(() => { if (saved === 'ui') saved = ''; }, 2500);
             }} />
      Load artwork only as it scrolls into view
      {#if saved === 'ui'}<span class="ok small">Saved</span>{/if}
    </label>
    <p class="muted small">
      Mainly for Jellyfin sources &mdash; folder and SMB libraries only show
      artwork where a poster file sits beside the media. Leave off unless a
      shelf is big enough that fetching it all at once is the slower option.
    </p>
  </section>

  <!-- Developer -->
  <section class="card">
    <h3>Developer</h3>
    <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
      <input type="checkbox" bind:checked={cfg.devMode} style="width:auto"
             onchange={async () => {
               await api.saveConfig({ devMode: cfg.devMode });
               // Tell the layout so the Console nav entry appears without a
               // page reload.
               window.dispatchEvent(new CustomEvent('jsr-devmode', { detail: cfg.devMode }));
               saved = 'dev';
               setTimeout(() => { if (saved === 'dev') saved = ''; }, 2500);
             }} />
      Developer mode — show the read-only Console page
      {#if saved === 'dev'}<span class="ok small">Saved</span>{/if}
    </label>
    <p class="muted small">
      Live server and ffmpeg logs in the panel, with stream keys redacted.
      Useful when reporting a problem.
    </p>
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
    Prefer the guided flow? <a href="/setup">Re-run setup</a> — it changes the
    same settings, in order, with a check after each one.
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
</style>
