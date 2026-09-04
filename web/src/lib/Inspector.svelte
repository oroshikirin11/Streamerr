<script>
  import { api } from '$lib/api.js';

  /**
   * The media inspector: a drawer that says what a file is and what the
   * encoder will do with it. Keyed by a library item id — a file shows
   * its sheet, a series shows its episodes with a one-line summary each
   * and opens the first. With `pick`, the audio and subtitle rows become
   * a track choice for the next broadcast.
   *
   * pick: { audioIndex, subtitleKey, onAudio(i), onSub(key) } | null
   */
  let { id, title = '', pick = null, onclose } = $props();

  let data = $state(null);
  let error = $state('');
  let sheets = $state({});          // episode id -> sheet | 'loading' | { error }
  let open = $state(null);          // expanded episode id
  let loading = $state(true);

  const up = (s) => String(s ?? '').toUpperCase();
  const fmtTime = (s) => {
    if (s == null || !Number.isFinite(s)) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const fmtSize = (b) => (b == null ? '—' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`);
  const fmtRate = (k) => (k == null ? '' : k >= 1000 ? `${Math.round(k / 100) / 10} Mb/s` : `${k} kb/s`);
  const chan = (c) => (c === 6 ? '5.1' : c === 8 ? '7.1' : c === 2 ? 'stereo' : c === 1 ? 'mono' : `${c ?? '?'} ch`);
  const depthOf = (p) => { const m = /(\d{2})(?:le|be)?$/.exec(p ?? ''); return m ? Number(m[1]) : (p ? 8 : null); };
  const fps = (r) => { if (!r) return null; const [n, d] = String(r).split('/').map(Number); return d ? Math.round((n / d) * 1000) / 1000 : n; };

  async function load() {
    loading = true; error = '';
    try {
      data = await api.inspect(id);
      if (data.kind === 'series') {
        open = data.episodes[0]?.id ?? null;
        fillSummaries();
      }
    } catch (err) { error = err.message; }
    finally { loading = false; }
  }
  /** Episode sheets, one at a time so a season over SMB does not stampede. */
  async function fillSummaries() {
    for (const ep of data.episodes) {
      if (sheets[ep.id]) continue;
      sheets[ep.id] = 'loading';
      try { sheets[ep.id] = await api.inspect(ep.id); }
      catch (err) { sheets[ep.id] = { error: err.message }; }
    }
  }
  const summary = (s) => {
    if (!s || s === 'loading') return 'reading…';
    if (s.error) return s.error;
    const v = s.video; if (!v) return 'no video';
    const d = depthOf(v.pixFmt);
    const a = s.audio?.[0];
    const n = s.subtitles?.length ?? 0;
    return [`${up(v.codec)}${d > 8 ? ` ${d}-bit` : ''} ${v.height ? `${v.height}p` : ''}${v.hdr ? ' HDR' : ''}`.trim(),
      a ? `${up(a.language ?? '?')} ${chan(a.channels)}${s.audio.length > 1 ? ` +${s.audio.length - 1}` : ''}` : null,
      n ? `${n} sub${n > 1 ? 's' : ''}` : 'no subs'].filter(Boolean).join(' · ');
  };
  const pickedAudio = (s) => pick?.audioIndex ?? s.chosen?.audioIndex ?? null;
  const pickedSub = (s) => (pick && 'subtitleKey' in pick ? pick.subtitleKey : (s.chosen?.subtitleKey ?? null));

  $effect(() => { if (id) load(); });
  function onKey(e) { if (e.key === 'Escape') onclose?.(); }
</script>

<svelte:window onkeydown={onKey} />

{#snippet sheet(s)}
  <div class="verdict" class:ok={s.verdict?.passthrough}>
    <strong>{s.verdict?.will}</strong>
    {#if s.verdict?.reasons?.length}
      <ul>{#each s.verdict.reasons as r}<li>{r}</li>{/each}</ul>
    {/if}
    {#if s.verdict?.notes?.length}
      <ul class="notes">{#each s.verdict.notes as n}<li>{n}</li>{/each}</ul>
    {/if}
  </div>
  <dl class="facts">
    <dt>Container</dt><dd>{s.container ?? '—'}</dd>
    <dt>Length</dt><dd>{fmtTime(s.duration)}</dd>
    <dt>Size</dt><dd>{fmtSize(s.size)}{#if s.kbps}{' · '}{fmtRate(s.kbps)}{/if}</dd>
    {#if s.video}
      <dt>Video</dt><dd>{[up(s.video.codec), s.video.profile].filter(Boolean).join(' ')}{#if depthOf(s.video.pixFmt)}{` · ${depthOf(s.video.pixFmt)}-bit`}{/if}{` · ${s.video.width}×${s.video.height}`}{#if s.video.dar}{` (${s.video.dar})`}{/if}</dd>
      <dt>Frame rate</dt><dd>{fps(s.video.frameRate) ?? '—'} fps{#if s.video.fieldOrder && s.video.fieldOrder !== 'progressive'} · interlaced{/if}</dd>
      <dt>Colour</dt><dd>{s.video.hdr ? `HDR (${s.video.colorTransfer})` : 'SDR'}{#if s.video.pixFmt}{` · ${s.video.pixFmt}`}{/if}</dd>
    {/if}
  </dl>
  <h4>Audio</h4>
  <ul class="tracks">
    {#each s.audio ?? [] as a}
      <li>
        <button class="tr" class:pickable={Boolean(pick)} class:on={a.typeIndex === pickedAudio(s)} disabled={!pick}
                onclick={() => pick?.onAudio?.(a.typeIndex)}>
          <span>{up(a.language ?? '?')} · {up(a.codec)} · {chan(a.channels)}{a.title ? ` — ${a.title}` : ''}</span>
          {#if a.typeIndex === (s.chosen?.audioIndex ?? null)}<em>default</em>{/if}
        </button>
      </li>
    {/each}
    {#if !s.audio?.length}<li class="muted">none</li>{/if}
  </ul>
  <h4>Subtitles</h4>
  <ul class="tracks">
    {#if pick}
      <li><button class="tr pickable" class:on={pickedSub(s) === null} onclick={() => pick.onSub?.(null)}><span>None</span></button></li>
    {/if}
    {#each s.subtitles ?? [] as t}
      <li>
        <button class="tr" class:pickable={Boolean(pick)} class:on={pick && String(t.key) === String(pickedSub(s))} disabled={!pick}
                onclick={() => pick?.onSub?.(t.key)}>
          <span>{up(t.language ?? '?')} · {up(t.codec)}{t.forced ? ' · forced' : ''}{t.external ? ' · sidecar' : ''}{t.title ? ` — ${t.title}` : ''}</span>
          {#if String(t.key) === String(s.chosen?.subtitleKey)}<em>default</em>{/if}
        </button>
      </li>
    {/each}
    {#if !s.subtitles?.length}<li class="muted">none</li>{/if}
  </ul>
  {#if s.chosen?.reason}<p class="muted small">Default choice: {s.chosen.reason}</p>{/if}
  {#if pick}<p class="muted small">Click a track to use it for the next broadcast instead.</p>{/if}
{/snippet}

<div class="backdrop" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }} role="presentation">
  <aside class="drawer" role="dialog" aria-label="Media details">
    <header>
      <h3>{title || data?.title}</h3>
      <button class="ic" onclick={onclose} title="Close" aria-label="Close">×</button>
    </header>
    {#if error}<p class="err">{error}</p>
    {:else if loading && !data}<p class="muted">Reading the file…</p>
    {:else if data?.kind === 'series'}
      <ul class="eps">
        {#each data.episodes as ep (ep.id)}
          <li class:open={open === ep.id}>
            <button class="row" onclick={() => (open = open === ep.id ? null : ep.id)} aria-expanded={open === ep.id}>
              <span class="chev" class:down={open === ep.id}>▸</span>
              <span class="t">{ep.title}</span>
              <span class="sum" class:reading={sheets[ep.id] === 'loading' || !sheets[ep.id]}>{summary(sheets[ep.id])}</span>
            </button>
            {#if open === ep.id}
              <div class="body">
                {#if !sheets[ep.id] || sheets[ep.id] === 'loading'}<p class="muted small">Reading the file…</p>
                {:else if sheets[ep.id].error}<p class="err">{sheets[ep.id].error}</p>
                {:else}{@render sheet(sheets[ep.id])}{/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {:else if data}
      {@render sheet(data)}
    {/if}
  </aside>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 40; }
  .drawer {
    position: absolute; top: 0; right: 0; bottom: 0; width: min(560px, 100%);
    background: var(--surface); border-left: 1px solid var(--border); padding: 18px 22px 30px;
    overflow: auto; box-shadow: -20px 0 50px rgba(0,0,0,.35);
  }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  header h3 { margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ic { width: 28px; height: 28px; padding: 0; border-radius: 999px; background: transparent; border: none; color: var(--muted); font-size: 16px; }
  .ic:hover { background: var(--surface-2); color: var(--text); }
  .verdict { border: 1px solid color-mix(in srgb, #c98a2e 50%, var(--border)); background: color-mix(in srgb, #c98a2e 10%, transparent); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 14px; font-size: 13.5px; }
  .verdict.ok { border-color: color-mix(in srgb, var(--success) 50%, var(--border)); background: color-mix(in srgb, var(--success) 10%, transparent); }
  .verdict strong { display: block; font-weight: 500; margin-bottom: 4px; }
  .verdict ul { margin: 4px 0 0; padding-left: 18px; }
  .verdict ul.notes { color: var(--muted); }
  .facts { display: grid; grid-template-columns: 96px 1fr; gap: 4px 10px; margin: 0 0 14px; font-size: 13.5px; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  h4 { margin: 12px 0 4px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
  .tracks { list-style: none; margin: 0; padding: 0; }
  .tracks li { margin: 2px 0; }
  .tr { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border-color: var(--border); font-size: 13px; padding: 6px 10px; }
  .tr:disabled { opacity: 1; cursor: default; color: var(--text); }
  .tr span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr em { font-style: normal; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; }
  .tr.pickable:hover { border-color: var(--muted); }
  .tr.on { border-color: var(--accent); color: var(--accent); }
  .tr.on em { color: var(--accent); border-color: currentColor; }
  .muted { color: var(--muted); } .small { font-size: 13px; } .err { color: var(--danger); font-size: 13px; }
  .eps { list-style: none; margin: 0; padding: 0; }
  .eps li { border-bottom: 1px solid var(--border); }
  .eps .row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent; border: none; padding: 8px 4px; font-size: 13.5px; }
  .eps .row:hover { background: var(--surface-2); }
  .eps .chev { color: var(--muted); font-size: 12px; transition: transform .14s; }
  .eps .chev.down { transform: rotate(90deg); }
  .eps .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eps .sum { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .eps .sum.reading { opacity: .6; }
  .eps .body { padding: 6px 4px 14px 24px; }
</style>
