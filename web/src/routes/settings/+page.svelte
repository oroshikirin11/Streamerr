<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  // Everything the wizard configures is editable here. Setup exists to get a
  // working system quickly, not to be the only way to change something.
  let cfg = $state(null);
  let error = $state('');
  let saved = $state('');
  let testing = $state('');

  // Secrets are write-only: the server returns a sentinel, never the value.
  let keyStored = $state(false);
  let streamKey = $state('');
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

  onMount(load);

  async function load() {
    try {
      cfg = await api.config();
      keyStored = cfg.owncast.streamKey === '__SET__';
      jfKeyStored = cfg.library.jellyfin?.apiKey === '__SET__';
      streamKey = '';
      jellyfinKey = '';
      cfg.library.pathMap ??= [];
      cfg.tracks ??= {};
      cfg.tracks.languages ??= ['eng'];
      cfg.tracks.audioMode ??= 'original';
      cfg.tracks.subtitleMode ??= 'auto';
      fsRoots = (cfg.library.filesystem?.roots || []).join('\n');
    } catch (err) { error = err.message; }
  }

  const parseList = (s) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  function libraryPayload() {
    return cfg.library.provider === 'jellyfin'
      ? {
          provider: 'jellyfin',
          jellyfin: {
            url: cfg.library.jellyfin.url,
            ...(jellyfinKey ? { apiKey: jellyfinKey } : {}),
          },
          pathMap: cfg.library.pathMap,
        }
      : { provider: 'filesystem', filesystem: { roots: parseList(fsRoots) } };
  }

  async function save(section) {
    error = ''; saved = '';
    try {
      const patch = {};
      if (section === 'owncast') {
        patch.owncast = {
          rtmpUrl: cfg.owncast.rtmpUrl,
          apiUrl: cfg.owncast.apiUrl,
          ...(streamKey ? { streamKey } : {}),
        };
      }
      if (section === 'encoder') {
        patch.encoder = {
          backend: cfg.encoder.backend,
          width: +cfg.encoder.width, height: +cfg.encoder.height,
          fps: +cfg.encoder.fps, videoBitrate: cfg.encoder.videoBitrate,
          audioBitrate: cfg.encoder.audioBitrate,
          gopSeconds: +cfg.encoder.gopSeconds, device: cfg.encoder.device,
          hwDecode: Boolean(cfg.encoder.hwDecode),
          extractSubtitles: Boolean(cfg.encoder.extractSubtitles),
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

  function addRule() { cfg.library.pathMap = [...cfg.library.pathMap, { from: '', to: '' }]; }
  function removeRule(i) {
    cfg.library.pathMap = cfg.library.pathMap.filter((_, j) => j !== i);
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

<svelte:head><title>Settings — Jellystreamerr</title></svelte:head>

<h1>Settings</h1>

{#if !cfg}
  <p class="muted">Loading…</p>
{:else}
  {#if error}<p class="err">{error}</p>{/if}

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
      <div><label>Width</label><input type="number" bind:value={cfg.encoder.width} /></div>
      <div><label>Height</label><input type="number" bind:value={cfg.encoder.height} /></div>
      <div><label>Framerate</label><input type="number" bind:value={cfg.encoder.fps} /></div>
      <div><label>Video bitrate (kbps)</label><input bind:value={cfg.encoder.videoBitrate} /></div>
      <div><label>Audio bitrate (kbps)</label><input bind:value={cfg.encoder.audioBitrate} /></div>
      <div><label>Keyframes (s)</label><input type="number" bind:value={cfg.encoder.gopSeconds} /></div>
    </div>
    <p class="muted small">
      Bitrates are in kbps &mdash; 4500 is a reasonable 1080p30 figure, and
      anything above your upload speed will stutter for viewers.
    </p>
    <p class="muted small">
      Keyframe interval must divide Owncast's segment length. Two seconds is
      what its documentation recommends; changing it can break segmenting.
    </p>

    <label>Encoder</label>
    {#if encoders}
      <ul class="enc">
        <li>
          <input type="radio" bind:group={cfg.encoder.backend} value="auto" id="s-auto" />
          <label for="s-auto">Automatic <span class="muted small">— best that works</span></label>
        </li>
        {#each encoders.encoders as e}
          <li>
            <input type="radio" bind:group={cfg.encoder.backend} value={e.backend}
                   disabled={!e.ok} id={`s-${e.backend}`} />
            <label for={`s-${e.backend}`} class:dim={!e.ok}>
              {e.label}{#if !e.ok}<span class="muted small"> — {e.error}</span>{/if}
            </label>
          </li>
        {/each}
      </ul>
      <p class="muted small">ffmpeg {encoders.ffmpeg}</p>
    {:else}
      <input bind:value={cfg.encoder.backend} spellcheck="false" />
    {/if}

    <label>Render device</label>
    <input bind:value={cfg.encoder.device} spellcheck="false" />

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

    <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
      <input type="checkbox" bind:checked={cfg.encoder.extractSubtitles} style="width:auto" />
      Extract subtitles before burning
    </label>
    <p class="muted small">
      Reads the whole file once to pull the subtitle track and fonts out. On a
      network mount this can take minutes before playback starts, and measured
      here it gained only 6% &mdash; so it is off unless the benchmark shows
      it pays on your storage.
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
    <div class="actions">
      <label class="pick"><input type="radio" bind:group={cfg.library.provider} value="jellyfin" /> Jellyfin</label>
      <label class="pick"><input type="radio" bind:group={cfg.library.provider} value="filesystem" /> A folder</label>
    </div>

    {#if cfg.library.provider === 'jellyfin'}
      <label>Jellyfin URL</label>
      <input bind:value={cfg.library.jellyfin.url} spellcheck="false" />
      <label>API key</label>
      <input type="password" bind:value={jellyfinKey}
             placeholder={jfKeyStored ? 'leave blank to keep the saved key' : 'Dashboard → API Keys'} />
    {:else}
      <label>Folders, one per line</label>
      <textarea rows="3" bind:value={fsRoots} spellcheck="false"></textarea>
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
  </section>

  <!-- Path mapping -->
  {#if cfg.library.provider === 'jellyfin'}
    <section class="card">
      <h3>Path mapping</h3>
      <p class="muted small">
        Only needed when Jellyfin reports paths this service cannot open — a
        Jellyfin in Docker seeing <code>/media</code> where this sees
        <code>/extHdd</code>. Usually empty.
      </p>
      {#each cfg.library.pathMap as r, i}
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
        <div class="result" class:bad={!pathmap.noMappingNeeded && !cfg.library.pathMap.length}>
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
    <input value={(cfg.tracks.languages || []).join(', ')}
           oninput={(e) => (cfg.tracks.languages = parseList(e.currentTarget.value))}
           placeholder="eng" spellcheck="false" />
    <p class="muted small">
      Used both to pick a dub and to choose a subtitle language.
    </p>

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

  <p class="muted small">
    Prefer the guided flow? <a href="/setup">Re-run setup</a> — it changes the
    same settings, in order, with a check after each one.
  </p>
{/if}

<style>
  section { margin-bottom: 16px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; }
  input, select, textarea {
    width: 100%; font: inherit; color: inherit;
    border-radius: var(--radius); border: 1px solid var(--border);
    background: var(--surface); padding: 8px 11px;
  }
  .g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .actions input { flex: 1; min-width: 120px; }
  .actions button { flex-shrink: 0; }
  .ok { color: var(--success); }
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
  .pick { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; color: inherit; }
  .pick input { width: auto; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
</style>
