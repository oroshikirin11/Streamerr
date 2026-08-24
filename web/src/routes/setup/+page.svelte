<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api } from '$lib/api.js';

  // Each step validates rather than just collecting — a value that has been
  // proven to work is worth far more than one that has been typed.
  const STEPS = ['Owncast', 'Encoder', 'Library', 'Paths', 'Languages'];
  let step = $state(0);
  let saving = $state(false);
  let error = $state('');

  let cfg = $state(null);

  // step 1
  let rtmpUrl = $state('');
  let streamKey = $state('');
  let showKey = $state(false);
  // Whether a key is already stored. The value itself never reaches the
  // browser, so the field stays empty and blank means "keep what's there" —
  // putting the sentinel in the input makes it look like a 7-character key.
  let keyStored = $state(false);
  let owncastResult = $state(null);
  let testing = $state(false);

  // step 2
  let encoders = $state(null);
  let backend = $state('auto');
  let width = $state(1920);
  let height = $state(1080);
  let fps = $state(30);
  let videoBitrate = $state('4500k');

  // step 3
  let provider = $state('jellyfin');
  let jellyfinUrl = $state('');
  let jellyfinKey = $state('');
  let fsRoots = $state('');
  let libResult = $state(null);

  // step 4
  let pathmap = $state(null);
  let rules = $state([]);

  // step 5
  let cfgTracks = $state({ languages: ['eng'], audioMode: 'original', subtitleMode: 'auto' });

  onMount(async () => {
    try {
      cfg = await api.config();
      rtmpUrl = cfg.owncast.rtmpUrl || '';
      keyStored = cfg.owncast.streamKey === '__SET__';
      streamKey = '';
      backend = cfg.encoder.backend;
      width = cfg.encoder.width; height = cfg.encoder.height;
      fps = cfg.encoder.fps; videoBitrate = cfg.encoder.videoBitrate;
      provider = cfg.library.provider;
      jellyfinUrl = cfg.library.jellyfin?.url || '';
      jellyfinKey = cfg.library.jellyfin?.apiKey === '__SET__' ? '__SET__' : '';
      fsRoots = (cfg.library.filesystem?.roots || []).join('\n');
      rules = cfg.library.pathMap || [];
      cfgTracks = {
        languages: cfg.tracks?.languages ?? ['eng'],
        audioMode: cfg.tracks?.audioMode ?? 'original',
        subtitleMode: cfg.tracks?.subtitleMode ?? 'auto',
      };
    } catch (err) { error = err.message; }
  });

  const parseList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  async function testOwncast() {
    testing = true; owncastResult = null;
    try {
      owncastResult = await api.checkOwncast({
        rtmpUrl,
        streamKey: streamKey || (keyStored ? '__SET__' : ''),
      });
    } catch (err) {
      owncastResult = { ok: false, error: err.message };
    } finally { testing = false; }
  }

  async function loadEncoders() {
    encoders = null;
    try { encoders = await api.checkEncoders(); }
    catch (err) { error = err.message; }
  }

  function libraryPayload() {
    return provider === 'jellyfin'
      ? { provider, jellyfin: { url: jellyfinUrl, apiKey: jellyfinKey }, pathMap: rules }
      : { provider, filesystem: { roots: parseList(fsRoots.replace(/\n/g, ',')) } };
  }

  async function testLibrary() {
    testing = true; libResult = null;
    try { libResult = { ok: true, ...(await api.checkLibrary(libraryPayload())) }; }
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
    if (step === 2 && provider === 'jellyfin') await loadPathmap();
    // The filesystem provider needs no mapping — it already has real paths.
    if (step === 2 && provider !== 'jellyfin') { await save(); step = 4; return; }
    if (step === STEPS.length - 1) { await finish(); return; }
    await save();
    step += 1;
  }

  async function save() {
    saving = true;
    try {
      const patch = {
        owncast: { rtmpUrl, ...(streamKey ? { streamKey } : {}) },
        encoder: { backend, width: +width, height: +height, fps: +fps, videoBitrate },
        library: libraryPayload(),
        tracks: cfgTracks,
      };
      if (provider === 'jellyfin' && jellyfinKey === '__SET__') delete patch.library.jellyfin.apiKey;
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

<svelte:head><title>Setup — Jellystreamerr</title></svelte:head>

<div class="wrap">
  <p class="muted small">Setup — step {step + 1} of {STEPS.length}</p>
  <div class="steps">
    {#each STEPS as s, i}<div class="seg" class:done={i <= step}></div>{/each}
  </div>

  <div class="card">
    {#if step === 0}
      <h2>Where does the stream go?</h2>
      <p class="muted">
        Your Owncast server's RTMP address and stream key. Use a tailnet or LAN
        address if you have one — RTMP sends the key unencrypted.
      </p>
      <label>Server address</label>
      <input bind:value={rtmpUrl} placeholder="rtmp://192.168.1.10:1935/live" spellcheck="false" />
      <label>Stream key</label>
      <div class="row">
        {#if showKey}
          <input bind:value={streamKey}
                 placeholder={keyStored ? 'leave blank to keep the saved key' : 'from Owncast admin'}
                 spellcheck="false" />
        {:else}
          <input type="password" bind:value={streamKey}
                 placeholder={keyStored ? 'leave blank to keep the saved key' : 'from Owncast admin'} />
        {/if}
        {#if streamKey}
          <button onclick={() => (showKey = !showKey)}>{showKey ? 'Hide' : 'Show'}</button>
        {/if}
      </div>
      {#if keyStored && !streamKey}
        <p class="muted small">A key is saved. It is never sent back to the browser.</p>
      {/if}
      <div class="row">
        <button onclick={() => testOwncast()} disabled={testing || !rtmpUrl}>
          {testing ? 'Streaming colour bars…' : 'Test connection'}
        </button>
        <span class="muted small">pushes 10 seconds of colour bars</span>
      </div>
      <p class="muted small">
        Owncast buffers before anything reaches a viewer, so it may go live a
        few seconds after the test finishes rather than during it.
      </p>
      {#if owncastResult}
        <div class="result" class:bad={!owncastResult.ok}>
          {#if owncastResult.ok}
            Owncast accepted the stream — {owncastResult.seconds}s pushed in {(owncastResult.ms / 1000).toFixed(1)}s
          {:else}
            {owncastResult.error}
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
        <div><label>Width</label><input type="number" bind:value={width} /></div>
        <div><label>Height</label><input type="number" bind:value={height} /></div>
        <div><label>FPS</label><input type="number" bind:value={fps} /></div>
        <div><label>Bitrate</label><input bind:value={videoBitrate} /></div>
      </div>

    {:else if step === 2}
      <h2>Where is your media?</h2>
      <div class="row">
        <label class="pick"><input type="radio" bind:group={provider} value="jellyfin" /> Jellyfin</label>
        <label class="pick"><input type="radio" bind:group={provider} value="filesystem" /> A folder</label>
      </div>
      {#if provider === 'jellyfin'}
        <p class="muted">
          Reads the posters, seasons and episode order Jellyfin has already
          scraped. Create a key in Jellyfin under Dashboard → API Keys.
        </p>
        <label>Jellyfin URL</label>
        <input bind:value={jellyfinUrl} placeholder="http://192.168.1.10:8096" spellcheck="false" />
        <label>API key</label>
        <input type="password" bind:value={jellyfinKey} placeholder="from Dashboard → API Keys" />
      {:else}
        <p class="muted">
          One directory per line. Posters are read from poster.jpg or folder.jpg
          next to the media, if present.
        </p>
        <textarea rows="4" bind:value={fsRoots} placeholder="/extHdd/media/tv" spellcheck="false"></textarea>
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
      <h2>Can we open your media?</h2>

      {#if !pathmap}
        <p class="muted">Checking…</p>

      {:else if pathmap.noMappingNeeded && !rules.length}
        <div class="result">
          Nothing to do — every path Jellyfin reports is already readable here.
        </div>
        <p class="muted small" style="margin-top:10px">
          {pathmap.reported.join(', ')}
        </p>
        <p class="muted small">
          This step only matters when the two run with different mounts, such as
          a Jellyfin in Docker that sees <code>/media</code> where this service
          sees <code>/extHdd</code>. Yours match, so continue.
        </p>

      {:else}
        <p class="muted">
          Jellyfin reports paths as its own process sees them. Some of these
          are not readable here, so they need translating.
        </p>
        <p class="muted small">
          Jellyfin reports: {pathmap.reported.join(', ') || '—'}
        </p>
        <p class="muted small">Readable here: {pathmap.reachable?.join(', ') || 'none'}</p>

        {#each rules as r, i}
          <div class="row">
            <input bind:value={r.from} placeholder="/media/" spellcheck="false" />
            <span class="muted">→</span>
            <input bind:value={r.to} placeholder="/extHdd/" spellcheck="false" />
            <button onclick={() => removeRule(i)}>Remove</button>
          </div>
        {/each}
        <button onclick={addRule} style="margin-top:10px">Add rule</button>
      {/if}

    {:else}
      <h2>Languages</h2>
      <p class="muted">
        Most-wanted first. Subtitles are burned into the picture, so this
        applies to a whole broadcast rather than per episode.
      </p>
    <label>Languages you understand</label>
      <input value={(cfgTracks.languages || []).join(', ')}
             oninput={(e) => (cfgTracks.languages = parseList(e.currentTarget.value))}
             placeholder="eng" spellcheck="false" />
      <p class="muted small">
        Used both to pick a dub and to choose a subtitle language.
      </p>

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
</style>
