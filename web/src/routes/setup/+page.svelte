<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api.js';
  import DirBrowser from '$lib/DirBrowser.svelte';

  // Each step validates rather than just collecting — a value that has been
  // proven to work is worth far more than one that has been typed.
  const STEPS = ['Destination', 'Encoder', 'Media', 'Artwork', 'Languages'];
  let step = $state(0);
  let saving = $state(false);
  let error = $state('');

  let cfg = $state(null);

  // step 1
  let rtmpUrl = $state('');
  let streamKey = $state('');
  /**
   * The wizard writes the same publish block the settings page does — one
   * slot per protocol, so a new install can be set up for any of them
   * without going to find Settings.
   */
  const PROTOCOLS = [
    { id: 'tcp', label: 'TCP' }, { id: 'rtmp', label: 'RTMP' },
    { id: 'rtmps', label: 'RTMPS' }, { id: 'srt', label: 'SRT' },
  ];
  const MODERN_CARRIERS = ['srt', 'tcp'];
  let protocol = $state('rtmp');
  /**
   * The codec is part of the connection: it decides which protocols can
   * carry the stream, so it is chosen here and the buttons below follow.
   */
  let codec = $state('h264');
  function chooseCodec(c) {
    codec = c;
    if (c !== 'h264' && !MODERN_CARRIERS.includes(protocol)) protocol = 'tcp';
  }
  let srtUrl = $state('');
  let srtStreamId = $state('');
  let srtPassphrase = $state('');
  let tcpPassphrase = $state('');

  function publishPatch() {
    const slot = {};
    if (protocol === 'srt') {
      if (srtUrl.trim()) slot.url = srtUrl.trim();
      if (srtStreamId.trim()) slot.streamId = srtStreamId.trim();
      if (srtPassphrase.trim()) slot.passphrase = srtPassphrase.trim();
    } else {
      // rtmp, rtmps and tcp all speak "address + stream key"; tcp adds an
      // optional passphrase on top.
      if (rtmpUrl.trim()) slot.url = rtmpUrl.trim();
      if (streamKey.trim()) slot.key = streamKey.trim();
      if (protocol === 'tcp' && tcpPassphrase.trim()) slot.passphrase = tcpPassphrase.trim();
    }
    // Nothing typed: record the choice of protocol and touch no credentials.
    if (!Object.keys(slot).length) return { publish: { protocol } };
    return { publish: { protocol, [protocol]: slot } };
  }
  let showKey = $state(false);
  /**
   * Whether a secret is already stored for the chosen protocol. The value
   * itself never reaches the browser — the server sends the sentinel — so
   * the field stays empty and blank means "keep what's there"; putting the
   * sentinel in the input would make it look like a 7-character key.
   * Derived from the publish slot, per protocol: switching to SRT asks
   * about SRT's stream id and passphrase, not RTMP's key.
   */
  const stored = (field) => cfg?.publish?.[protocol]?.[field] === '__SET__';
  const keyStored = $derived(protocol !== 'srt' && stored('key'));
  const passStored = $derived((protocol === 'srt' || protocol === 'tcp') && stored('passphrase'));
  const streamIdStored = $derived(protocol === 'srt' && stored('streamId'));
  let destResult = $state(null);
  let testing = $state(false);

  // step 2
  let encoders = $state(null);
  let backend = $state('auto');
  let width = $state(1920);
  let height = $state(1080);
  let fps = $state(30);
  // The same presets the settings page offers — a bare width/height pair
  // asks a newcomer to know broadcast dimensions by heart.
  const RES_PRESETS = [
    { key: '2160p', label: '2160p (4K)', w: 3840, h: 2160 },
    { key: '1440p', label: '1440p', w: 2560, h: 1440 },
    { key: '1080p', label: '1080p', w: 1920, h: 1080 },
    { key: '720p', label: '720p', w: 1280, h: 720 },
    { key: '480p', label: '480p', w: 854, h: 480 },
  ];
  let resSel = $state('1080p');
  function chooseRes() {
    const r = RES_PRESETS.find((x) => x.key === resSel);
    if (r) { width = r.w; height = r.h; }
  }
  const FPS_PRESETS = [24, 25, 30, 48, 50, 60];
  let fpsSel = $state('30');
  let videoBitrate = $state('4500k');
  /**
   * Presets with a Custom escape, the same shape the settings page uses.
   *
   * The field here was a bare text box under a "(kbps)" label, bound to a
   * value that actually reads "4500k" — so it showed the unit inside the box
   * and contradicted its own label. Bitrates are picked from a short list
   * far more often than typed.
   */
  const VBR_PRESETS = ['2000k', '3000k', '4500k', '6000k', '8000k', '12000k', '16000k'];
  let vbrSel = $state('4500k');
  /**
   * The render node, which the wizard never asked about.
   *
   * Settings has offered it all along, and it is the difference between
   * hardware encoding working and not: a host with two nodes may only encode
   * on one, and a container with none cannot do it at all. Finishing setup
   * and discovering that at the first broadcast is the wrong order.
   */
  let device = $state('/dev/dri/renderD128');
  let devSel = $state('/dev/dri/renderD128');
  // Reused when one already exists, so re-running setup edits the first
  // source instead of replacing whatever is configured with a new one.
  let srcId = $state('setup');

  /**
   * The catalogue is optional and layered on top of the media, never an
   * alternative to it. Jellyfin knows the artwork and episode order; it does
   * not hand over bytes, so it can never be the answer to "where is my
   * media" — which is what made picking it produce a library that would not
   * play.
   */
  /**
   * Which catalogue, not whether. TheTVDB is next, so this is a provider
   * rather than a Jellyfin switch — otherwise adding the second one means
   * rewriting the step.
   */
  let metaProvider = $state('none');
  let metaUrl = $state('');
  let metaKey = $state('');
  let metaRules = $state([]);
  let match = $state(null);
  let matching = $state(false);

  /** The media half alone — what the matcher compares a catalogue against. */
  function mediaSource() {
    const b = { id: srcId, name: 'Library', provider };
    if (provider === 'smb') {
      return { ...b,
        smb: {
          host: smbHost.trim(), share: smbShare.trim(), path: smbPath.trim(),
          guest: smbGuest, username: smbGuest ? '' : smbUser.trim(),
          ...(smbPass ? { password: smbPass } : {}),
        } };
    }
    return { ...b, filesystem: { roots: parseList(fsRoots.replace(/\n/g, ',')) } };
  }

  /**
   * Ask the server to line the two libraries up. The rules it derives are
   * saved with the source, so a path mapping is never typed by hand.
   */
  async function runMatch() {
    matching = true; match = null;
    try {
      const r = await api.matchLibrary({
        media: mediaSource(),
        jellyfin: { url: metaUrl.trim(), apiKey: metaKey || '__SET__' },
      });
      metaRules = r.rules ?? [];
      match = { ok: true, ...r };
    } catch (err) {
      match = { ok: false, error: err.message };
    } finally { matching = false; }
  }

  // step 3
  let provider = $state('jellyfin');
  let jellyfinUrl = $state('');
  let jellyfinKey = $state('');
  let smbHost = $state('');
  let smbShare = $state('');
  let smbPath = $state('');
  let smbGuest = $state(false);
  let smbUser = $state('');
  let smbPass = $state('');

  /**
   * A pasted smb:// URL or UNC path spreads into the fields below, so what is
   * shown is exactly what will be read. Same behaviour as the settings page —
   * an operator who has a share address in the clipboard should not have to
   * take it apart by hand.
   */
  function splitSmbHost() {
    let h = smbHost.trim().replace(/^smb:\/\//i, '').replace(/^\\\\/, '').replace(/\\/g, '/');
    const at = h.indexOf('@');
    if (at !== -1) {
      const cred = h.slice(0, at); h = h.slice(at + 1);
      const colon = cred.indexOf(':');
      smbUser = colon === -1 ? cred : cred.slice(0, colon);
      if (colon !== -1) smbPass = cred.slice(colon + 1);
      smbGuest = false;
    }
    const segs = h.split('/').filter(Boolean);
    smbHost = segs[0] ?? '';
    if (segs.length > 1) { smbShare = segs[1]; smbPath = segs.slice(2).join('/'); }
  }
  let fsRoots = $state('');
  let browsing = $state(false);

  function addRoot(path) {
    const roots = fsRoots.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!roots.includes(path)) fsRoots = [...roots, path].join('\n');
    browsing = false;
  }
  let libResult = $state(null);

  // step 4
  let pathmap = $state(null);
  let rules = $state([]);

  // step 5
  let cfgTracks = $state({ languages: ['eng'], audioMode: 'original', subtitleMode: 'auto' });
  /** The offered languages, from the server, so onboarding matches Settings. */
  let options = $state(null);
  let extraLangs = $state('');

  const langRank = (code) => (cfgTracks.languages ?? []).indexOf(code);

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
    const list = [...(cfgTracks.languages ?? [])];
    const at = list.indexOf(code);
    if (at >= 0) list.splice(at, 1);
    else list.push(code);
    cfgTracks = { ...cfgTracks, languages: normalizeLangs(list) };
  }

  function applyExtras() {
    const offered = new Set((options?.languages ?? []).map((l) => l.code));
    const kept = (cfgTracks.languages ?? []).filter((c) => offered.has(c));
    cfgTracks = { ...cfgTracks, languages: normalizeLangs([...kept, ...parseList(extraLangs)]) };
  }

  onMount(async () => {
    try {
      cfg = await api.config();
      // Prefilled from the publish block, so re-running setup shows what
      // is configured rather than an empty box that step one would then
      // write back as emptiness.
      protocol = cfg.publish?.protocol || 'rtmp';
      codec = cfg.encoder?.codec || 'h264';
      rtmpUrl = cfg.publish?.[protocol]?.url || '';
      srtUrl = cfg.publish?.srt?.url || '';
      streamKey = '';
      backend = cfg.encoder.backend;
      width = cfg.encoder.width; height = cfg.encoder.height;
      fps = cfg.encoder.fps; videoBitrate = cfg.encoder.videoBitrate;
      resSel = RES_PRESETS.find((r) => r.w === +width && r.h === +height)?.key ?? 'custom';
      fpsSel = FPS_PRESETS.includes(+fps) ? String(+fps) : 'custom';
      vbrSel = VBR_PRESETS.includes(String(videoBitrate)) ? String(videoBitrate) : 'custom';
      if (cfg.encoder.device) device = cfg.encoder.device;
      /**
       * The library is a LIST of sources; this step edits the first one.
       *
       * Both reading and writing used a flat { provider, jellyfin } shape
       * that nothing else speaks — makeLibrary only ever looks at
       * library.sources — so the step showed nothing on a configured
       * install and saved something no reader could see.
       */
      const src0 = cfg.library?.sources?.[0] ?? {};
      srcId = src0.id ?? srcId;
      /**
       * A source that used to BE Jellyfin becomes media plus a catalogue.
       * Its credentials carry over so nothing is retyped; the operator only
       * has to say where the files are, which was always the missing half.
       */
      provider = src0.provider === 'jellyfin' ? 'filesystem' : (src0.provider || 'filesystem');
      const meta = src0.metadata ?? (src0.provider === 'jellyfin' ? src0.jellyfin : null);
      metaProvider = meta?.url ? 'jellyfin' : 'none';
      metaUrl = meta?.url || '';
      metaKey = meta?.apiKey === '__SET__' ? '__SET__' : '';
      metaRules = src0.metadata?.pathMap ?? src0.pathMap ?? [];
      fsRoots = (src0.filesystem?.roots || []).join('\n');
      rules = src0.pathMap ?? rules;
      const sm = src0.smb ?? {};
      smbHost = sm.host || ''; smbShare = sm.share || ''; smbPath = sm.path || '';
      smbGuest = sm.guest === true; smbUser = sm.username || '';
      rules = cfg.library.pathMap || [];
      cfgTracks = {
        languages: cfg.tracks?.languages ?? ['eng'],
        audioMode: cfg.tracks?.audioMode ?? 'original',
        subtitleMode: cfg.tracks?.subtitleMode ?? 'auto',
      };
      try { options = await api.get('/api/options'); } catch { options = null; }
      const devs = options?.renderDevices ?? [];
      devSel = devs.includes(device) ? device : (devs.length ? 'custom' : device);
      const offered = new Set((options?.languages ?? []).map((l) => l.code));
      cfgTracks = { ...cfgTracks, languages: normalizeLangs(cfgTracks.languages ?? []) };
      extraLangs = (cfgTracks.languages ?? []).filter((c) => !offered.has(c)).join(', ');
    } catch (err) { error = err.message; }
  });

  const parseList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  /**
   * Tests the destination as the form has it: the typed key, or the
   * sentinel so the server uses the stored one when the field is blank.
   */
  async function testDestination(watch = false) {
    testing = watch ? 'watch' : 'quick'; destResult = null;
    try {
      destResult = await api.checkDestination({
        publish: {
          protocol,
          [protocol]: { url: rtmpUrl.trim(), key: streamKey.trim() || (keyStored ? '__SET__' : '') },
        },
        watch,
      });
    } catch (err) {
      destResult = { ok: false, error: err.message };
    } finally { testing = ''; }
  }

  async function loadEncoders() {
    encoders = null;
    try { encoders = await api.checkEncoders(); }
    catch (err) { error = err.message; }
  }

  function libraryPayload() {
    const src = mediaSource();
    if (metaProvider === 'jellyfin' && metaUrl.trim()) {
      src.metadata = {
        provider: 'jellyfin',
        url: metaUrl.trim(),
        // Only when typed, so a saved key survives a pass through setup.
        ...(metaKey ? { apiKey: metaKey } : {}),
        pathMap: metaRules,
      };
    }
    if (metaProvider === 'tmdb' && metaKey.trim()) {
      src.metadata = { provider: 'tmdb', url: '', apiKey: metaKey.trim(), pathMap: [] };
    }
    return { sources: [src] };
  }

  /**
   * Tests the media half only.
   *
   * It used to send the whole payload, catalogue included, so pressing Test
   * while configuring a share reported "Jellyfin rejected the API key" — an
   * error about a step the operator had not reached yet, on a screen asking
   * about something else. The catalogue has its own Check, one step later.
   */
  async function testLibrary() {
    testing = true; libResult = null;
    try { libResult = { ok: true, ...(await api.checkLibrary({ sources: [mediaSource()] })) }; }
    catch (err) { libResult = { ok: false, error: err.message }; }
    finally { testing = false; }
  }

  async function loadPathmap() {
    pathmap = null;
    try {
      pathmap = await api.checkPathmap(libraryPayload());
      if (pathmap.noMappingNeeded) rules = rules.filter((r) => r.from && r.to);
      if (!rules.length && pathmap.suggested?.length) rules = pathmap.suggested;
    } catch (err) { error = err.message; }
  }

  async function next() {
    error = '';
    if (step === 1 && !encoders) await loadEncoders();
    // Every media source now goes on to the optional catalogue step; there
    // is no branch to skip, because there is no mapping to fill in.
    if (step === STEPS.length - 1) { await finish(); return; }
    await save();
    step += 1;
  }

  async function save() {
    saving = true;
    try {
      const patch = {
        /**
         * Only fields with something in them.
         *
         * Writing an empty address was silent data loss: stepping past this
         * page without typing — or skipping setup entirely — replaced a
         * working server address with "". The stream key was already
         * conditional for the same reason; the address needed to be too.
         */
        ...publishPatch(),
        encoder: { backend, width: +width, height: +height, fps: +fps, videoBitrate, device,
          codec },
        library: libraryPayload(),
        tracks: cfgTracks,
      };
      if (provider === 'jellyfin' && jellyfinKey === '__SET__') {
        delete patch.library.sources[0].jellyfin.apiKey;
      }
      await api.saveConfig(patch);
    } catch (err) { error = err.message; }
    finally { saving = false; }
  }

  async function finish() {
    await save();
    await api.saveConfig({ onboarded: true });
    goto('/');
  }

  function addRule() { rules = [...rules, { from: '', to: '' }]; }
  function removeRule(i) { rules = rules.filter((_, j) => j !== i); }
</script>


<div class="wrap">
  <p class="muted small">Setup — step {step + 1} of {STEPS.length}</p>
  <div class="steps">
    {#each STEPS as s, i}<div class="seg" class:done={i <= step}></div>{/each}
  </div>

  <div class="card">
    {#if step === 0}
      <h2>Where does the stream go?</h2>
      <p class="muted">
        Most receivers speak RTMP; pick RTMPS if yours requires TLS. SRT and
        TCP carry every codec (H.265, AV1) — SRT for relays, TCP for a link
        whose packet loss shows up as picture artifacts. You can change this
        later and add more destinations in Settings.
      </p>
      <label>Codec</label>
      <select bind:value={codec} onchange={() => chooseCodec(codec)}>
        <option value="h264">H.264 — universal; every protocol and player</option>
        <option value="hevc">H.265 — 2/3 the bandwidth; needs TCP or SRT</option>
        <option value="av1">AV1 — half the bandwidth; patchy; software encode</option>
      </select>

      <label>Protocol</label>
      <div class="protos">
        {#each PROTOCOLS as pr}
          <button type="button" class="proto" class:on={protocol === pr.id}
                  disabled={codec !== 'h264' && !MODERN_CARRIERS.includes(pr.id)}
                  title={codec !== 'h264' && !MODERN_CARRIERS.includes(pr.id)
                    ? `${pr.label} cannot carry this codec` : undefined}
                  onclick={() => (protocol = pr.id)}>{pr.label}</button>
        {/each}
      </div>

      {#if protocol === 'srt'}
        <label>Server address</label>
        <input bind:value={srtUrl} placeholder="srt://relay.example.com:9000" spellcheck="false" />
        <label>Stream ID <span class="muted small">optional</span></label>
        <input bind:value={srtStreamId} spellcheck="false"
               placeholder={streamIdStored ? 'leave blank to keep the saved stream ID' : 'e.g. #!::r=live/stream,m=publish'} />
        <label>Passphrase <span class="muted small">optional, 10–79 characters</span></label>
        <input type="password" bind:value={srtPassphrase}
               placeholder={passStored ? 'leave blank to keep the saved passphrase' : 'encrypts the link'} />
        <p class="muted small">
          The connection test below only speaks RTMP, so it is not offered for
          SRT — finish setup and start a broadcast to check it.
        </p>
      {:else}
      <label>Server address</label>
      <input bind:value={rtmpUrl} spellcheck="false"
             placeholder={protocol === 'rtmps' ? 'rtmps://stream.example.com:443/live'
               : protocol === 'tcp' ? 'tcp://ingest.example.com:9711'
                 : 'rtmp://192.168.1.10:1935/live'} />
      <label>Stream key</label>
      <div class="row">
        {#if showKey}
          <input bind:value={streamKey}
                 placeholder={keyStored ? 'leave blank to keep the saved key' : 'from your receiver'}
                 spellcheck="false" />
        {:else}
          <input type="password" bind:value={streamKey}
                 placeholder={keyStored ? 'leave blank to keep the saved key' : 'from your receiver'} />
        {/if}
        {#if streamKey}
          <button onclick={() => (showKey = !showKey)}>{showKey ? 'Hide' : 'Show'}</button>
        {/if}
      </div>
      {#if keyStored && !streamKey}
        <p class="muted small">A key is saved. It is never sent back to the browser.</p>
      {/if}
      {#if protocol === 'tcp'}
        <label>Passphrase <span class="muted small">optional, 10–79 characters, no spaces</span></label>
        <input type="password" bind:value={tcpPassphrase}
               placeholder={passStored ? 'leave blank to keep the saved passphrase' : 'if the receiver demands one'} />
      {/if}
      {/if}
      {#if protocol !== 'srt' && protocol !== 'tcp'}
      <div class="row">
        <button onclick={() => testDestination(false)} disabled={!!testing || !rtmpUrl}>
          {testing === 'quick' ? 'Checking…' : 'Test connection'}
        </button>
        <button onclick={() => testDestination(true)} disabled={!!testing || !rtmpUrl}>
          {testing === 'watch' ? 'Streaming… 30s' : 'Send 30s to watch'}
        </button>
      </div>
      <p class="muted small">
        The quick check just proves the key is accepted. To actually see colour
        bars on the receiver's watch page, use the 30-second version &mdash; an
        HLS receiver buffers several seconds of video before it can play
        anything, so a short burst is accepted and then gone before it ever
        becomes visible.
      </p>
      {/if}
      {#if destResult}
        <div class="result" class:bad={!destResult.ok}>
          {#if destResult.ok}
            The receiver accepted the stream — {destResult.seconds}s pushed in {(destResult.ms / 1000).toFixed(1)}s
          {:else}
            {destResult.error}
          {/if}
        </div>
      {/if}

    {:else if step === 1}
      <h2>How should it encode?</h2>
      <p class="muted">
        Each encoder below was tested by actually encoding a few frames, not by
        asking ffmpeg what it supports.
      </p>
      {#if !encoders}
        <p class="muted">Probing…</p>
      {:else}
        <ul class="enc">
          {#each encoders.encoders as e}
            <li>
              <input type="radio" bind:group={backend} value={e.backend} disabled={!e.ok} id={e.backend} />
              <label for={e.backend} class:dim={!e.ok}>
                <strong>{e.label}</strong>
                {#if !e.ok}<span class="muted small"> — {e.error}</span>{/if}
              </label>
            </li>
          {/each}
          <li>
            <input type="radio" bind:group={backend} value="auto" id="auto" />
            <label for="auto"><strong>Automatic</strong> <span class="muted small">— pick the best that works</span></label>
          </li>
        </ul>
        <p class="muted small">ffmpeg {encoders.ffmpeg}{encoders.recursionDepth ? '' : ' — no recursion_depth, playlists are capped at 10 clips'}</p>
      {/if}
      <div class="grid4">
        <div>
          <label>Resolution</label>
          <select bind:value={resSel} onchange={chooseRes}>
            {#each RES_PRESETS as r}<option value={r.key}>{r.label}</option>{/each}
            <option value="custom">Custom</option>
          </select>
          {#if resSel === 'custom'}
            <input type="number" bind:value={width} aria-label="Width" placeholder="width" style="margin-top:6px" />
            <input type="number" bind:value={height} aria-label="Height" placeholder="height" style="margin-top:6px" />
          {/if}
          <p class="muted small" style="margin-top:6px">
            {resSel === '1080p' ? 'The right answer for most setups.'
              : resSel === '720p' ? 'Easier on weak hardware.'
              : resSel === '2160p' || resSel === '1440p'
                ? 'Heavy — few machines encode this in real time.'
                : ''}
          </p>
        </div>
        <div>
          <label>Framerate</label>
          <select bind:value={fpsSel} onchange={() => { if (fpsSel !== 'custom') fps = Number(fpsSel); }}>
            {#each FPS_PRESETS as f}<option value={String(f)}>{f} fps</option>{/each}
            <option value="custom">Custom</option>
          </select>
          {#if fpsSel === 'custom'}
            <input type="number" min="1" max="240" bind:value={fps} aria-label="Exact framerate" style="margin-top:6px" />
          {/if}
        </div>
        <div>
          <label>Video bitrate</label>
          <select bind:value={vbrSel}
                  onchange={() => { if (vbrSel !== 'custom') videoBitrate = vbrSel; }}>
            {#each VBR_PRESETS as b}<option value={b}>{parseInt(b, 10).toLocaleString()} kbps</option>{/each}
            <option value="custom">Custom</option>
          </select>
          {#if vbrSel === 'custom'}
            <input bind:value={videoBitrate} spellcheck="false"
                   aria-label="Exact video bitrate" placeholder="4500k" style="margin-top:6px;" />
          {/if}
        </div>
      </div>

      <label>Render device</label>
      {#if options?.renderDevices?.length}
        <select bind:value={devSel}
                onchange={() => { if (devSel !== 'custom') device = devSel; }}>
          {#each options.renderDevices as d}<option value={d}>{d}</option>{/each}
          <option value="custom">Custom</option>
        </select>
        {#if devSel === 'custom'}
          <input bind:value={device} spellcheck="false" style="margin-top:8px;" />
        {/if}
        {#if options.renderDevices.length > 1}
          <p class="muted small">
            {options.renderDevices.length} render nodes here. If the probe
            fails on one, try the other.
          </p>
        {/if}
      {:else}
        <input bind:value={device} spellcheck="false" />
        <p class="muted small">
          No <code>/dev/dri</code> render node here &mdash; hardware encoding needs
          one passed into the container.
        </p>
      {/if}

    {:else if step === 2}
      <h2>Where is your media?</h2>
      <div class="row">
        <label class="pick"><input type="radio" bind:group={provider} value="filesystem" /> A folder &mdash; recommended</label>
        <label class="pick"><input type="radio" bind:group={provider} value="smb" /> SMB share &mdash; experimental</label>
      </div>
      {#if provider === 'smb'}
        <p class="muted small">
          Read over the network &mdash; no mount, no privileges, read-only.
          <em>Experimental, and prone to slowness</em>: first playbacks and
          heavy titles take longer to prepare. A local folder is the fast
          path when you have one.
        </p>
        <label>Server (hostname, IP, or a full smb:// address)</label>
        <input bind:value={smbHost} spellcheck="false"
               placeholder="nas.local  or  smb://user@nas/share/folder"
               onchange={splitSmbHost} />
        <label>Share name</label>
        <input bind:value={smbShare} spellcheck="false" placeholder="media" />
        <label>Folder within the share (optional)</label>
        <input bind:value={smbPath} spellcheck="false" placeholder="anime" />
        <label class="pick" style="margin-top:10px;">
          <input type="checkbox" bind:checked={smbGuest} /> No password (guest share)
        </label>
        {#if !smbGuest}
          <label>Username</label>
          <input bind:value={smbUser} spellcheck="false" />
          <label>Password</label>
          <input type="password" bind:value={smbPass} />
        {/if}
      {:else}
        <p class="muted">
          One directory per line. Posters are read from poster.jpg or folder.jpg
          next to the media, if present.
        </p>
        <textarea rows="4" bind:value={fsRoots} placeholder="/extHdd/media/tv" spellcheck="false"></textarea>
        <div class="row">
          <button onclick={() => (browsing = true)}>Browse…</button>
        </div>
        {#if browsing}
          <DirBrowser start={fsRoots.split('\n')[0]?.trim() || '/'}
                      onpick={addRoot} onclose={() => (browsing = false)} />
        {/if}
      {/if}
      <div class="row">
        <button onclick={testLibrary} disabled={testing}>{testing ? 'Checking…' : 'Test'}</button>
      </div>
      {#if libResult}
        <div class="result" class:bad={!libResult.ok}>
          {#if libResult.ok}
            Connected{libResult.serverName ? ` to ${libResult.serverName}` : ''}{libResult.version ? ` (${libResult.version})` : ''}{libResult.roots ? ` — ${libResult.roots} folder(s)` : ''}
          {:else}{libResult.error}{/if}
        </div>
      {/if}

    {:else if step === 3}
      <h2>Where should titles and artwork come from?</h2>
      <p class="muted">
        Optional. Without it, we use the filenames.
      </p>

      <!-- Best option first: TMDB needs one free key and nothing else
           running, Jellyfin needs a whole second server, and filenames are
           the fallback the page already promises above. -->
      <div class="row">
        <label class="pick">
          <input type="radio" bind:group={metaProvider} value="tmdb" /> TMDB
        </label>
        <label class="pick">
          <input type="radio" bind:group={metaProvider} value="jellyfin" /> Jellyfin
        </label>
        <label class="pick">
          <input type="radio" bind:group={metaProvider} value="none" /> Filenames
        </label>
      </div>

      {#if metaProvider === 'tmdb'}
        <p class="muted small">
          Titles, episode names and posters from The Movie Database. Enter
          the key and that is everything — matching runs in the background
          after setup and the library fills in as answers land.
        </p>
        <label>API key</label>
        <input type="password" bind:value={metaKey}
               placeholder="themoviedb.org → Settings → API" />
        <p class="muted small">A free account's key is enough. Both the short
          v3 key and the long v4 token work.</p>
      {/if}

      {#if metaProvider === 'jellyfin'}
        <p class="muted small">
          Jellyfin is a media server. If you run one for this library, it has
          already fetched the posters and episode order — we can borrow them.
        </p>
        <label>Address</label>
        <input bind:value={metaUrl} placeholder="http://192.168.1.10:8096" spellcheck="false" />
        <label>API key</label>
        <input type="password" bind:value={metaKey} placeholder="Dashboard → API Keys" />
        <div class="row">
          <button onclick={runMatch} disabled={matching || !metaUrl.trim()}>
            {matching ? 'Checking…' : 'Check'}
          </button>
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
          {#if match.ok && match.matched === 0}
            <p class="muted small">
              Nothing lined up, so this is a different library. Continue and
              we will use filenames.
            </p>
          {:else if match.ok && match.matched < match.total}
            <p class="muted small">
              The rest are elsewhere. Continue either way.
            </p>
          {/if}
        {:else}
          <p class="muted small">We work the paths out ourselves. Nothing to type.</p>
        {/if}
      {/if}

    {:else}
      <h2>Languages</h2>
      <p class="muted">
        Your preferred language is picked automatically. You can override it
        per episode, or change it while something is playing.
      </p>
    <label>Languages you understand</label>
      {#if options?.languages?.length}
        <div class="langs">
          {#each options.languages as l}
            <button class="chip" class:on={langRank(l.code) >= 0}
                    onclick={() => toggleLang(l.code)} title={l.code}>
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
        <input value={(cfgTracks.languages || []).join(', ')}
               oninput={(e) => (cfgTracks.languages = parseList(e.currentTarget.value))}
               placeholder="eng" spellcheck="false" />
        <p class="muted small">
          Used both to pick a dub and to choose a subtitle language.
        </p>
      {/if}

      <label>Audio</label>
      <select bind:value={cfgTracks.audioMode}>
        <option value="original">Original language &mdash; Japanese for anime</option>
        <option value="dubbed">Dubbed into your language when available</option>
      </select>

      <label>Subtitles</label>
      <select bind:value={cfgTracks.subtitleMode}>
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

    {/if}

    {#if error}<p class="err">{error}</p>{/if}
  </div>

  <div class="nav">
    <button onclick={() => (step = Math.max(0, step - 1))} disabled={step === 0}>Back</button>
    <div class="spacer"></div>
    <button onclick={finish}>Skip setup</button>
    <button class="primary" onclick={next} disabled={saving}>
      {step === STEPS.length - 1 ? 'Finish' : 'Continue'}
    </button>
  </div>
</div>

<style>
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

  .wrap { max-width: 620px; margin: 0 auto; }
  .steps { display: flex; gap: 4px; margin: 8px 0 16px; }
  .seg { flex: 1; height: 3px; border-radius: 2px; background: var(--surface-2); }
  .seg.done { background: var(--accent); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input, select, textarea {
    width: 100%; font: inherit; color: inherit;
    border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--surface); padding: 8px 11px;
  }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .row input { flex: 1; }
  .row button { flex-shrink: 0; }
  .spacer { flex: 1; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .grid4 label { margin-top: 12px; }
  .nav { display: flex; gap: 8px; margin-top: 14px; }
  .result {
    margin-top: 12px; padding: 10px 12px; border-radius: var(--radius);
    font-size: 13px;
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }
  .result.bad {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger); white-space: pre-wrap;
  }
  .enc { list-style: none; padding: 0; margin: 6px 0; }
  .enc li { display: flex; gap: 9px; align-items: baseline; padding: 5px 0; }
  .enc input { width: auto; }
  .enc label { margin: 0; color: inherit; font-size: 14px; }
  .enc label.dim { color: var(--muted); }
  .pick { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; color: inherit; }
  .pick input { width: auto; }
  .protos { display: flex; gap: 8px; margin-bottom: 4px; }
  .proto {
    flex: 1; padding: 8px 10px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer;
  }
  .proto.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); }

  @media (max-width: 720px) {
    .card { padding: 14px; }
    .grid4 { grid-template-columns: 1fr; gap: 0; }
    .row { flex-wrap: wrap; }
    .protos { flex-wrap: wrap; }
    .proto { flex: 1 1 40%; min-height: 40px; }
    input, select, textarea { min-height: 40px; }
    input[type="checkbox"], input[type="radio"] { min-height: 0; width: 18px; height: 18px; }
    .row button { min-height: 40px; }
    .langs .chip { min-height: 36px; }
    /* Back and Skip share a line; Continue takes a full one. */
    .nav { flex-wrap: wrap; }
    .nav .spacer { display: none; }
    .nav button { flex: 1 1 40%; min-height: 44px; }
    .nav .primary { flex: 1 1 100%; }
  }
</style>
