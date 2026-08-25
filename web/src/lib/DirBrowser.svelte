<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';

  /**
   * Modal directory picker for the filesystem library provider — typing
   * server-side paths blind is miserable. Directories only; the server never
   * lists files.
   */
  let { start = '/', onpick, onclose } = $props();

  let path = $state('/');
  let parent = $state(null);
  let dirs = $state([]);
  let error = $state('');
  let loading = $state(false);

  async function load(p) {
    loading = true;
    try {
      const r = await api.get(`/api/fs/dirs?path=${encodeURIComponent(p)}`);
      path = r.path;
      parent = r.parent;
      dirs = r.dirs;
      error = '';
    } catch (err) {
      // Stay where we are; an unreadable directory is a dead end, not a crash.
      error = err.message;
    } finally {
      loading = false;
    }
  }

  onMount(() => load(start || '/'));
</script>

<div class="overlay" onclick={onclose} role="presentation">
  <div class="card modal" onclick={(e) => e.stopPropagation()} role="presentation">
    <h3>Choose a folder</h3>
    <p class="path" title={path}>{path}</p>
    {#if error}<p class="err">{error}</p>{/if}

    <div class="list">
      {#if parent}
        <button class="dir up" onclick={() => load(parent)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          ..
        </button>
      {/if}
      {#each dirs as d (d)}
        <button class="dir" onclick={() => load(path === '/' ? `/${d}` : `${path}/${d}`)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.6" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
          {d}
        </button>
      {:else}
        {#if !parent || !loading}<p class="muted small" style="padding: 6px 8px;">No subfolders.</p>{/if}
      {/each}
    </div>

    <div class="foot">
      <button class="primary" onclick={() => onpick?.(path)}>Use this folder</button>
      <div style="flex:1"></div>
      <button onclick={onclose}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: grid; place-items: center; padding: 20px; z-index: 20;
  }
  .modal {
    width: min(460px, 100%); display: flex; flex-direction: column;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 18px; max-height: 80vh;
  }
  .path {
    margin: 0 0 8px; font: 12px/1.5 ui-monospace, monospace;
    color: var(--muted); word-break: break-all;
    border-bottom: 1px solid var(--border); padding-bottom: 8px;
  }
  .list { flex: 1; min-height: 160px; overflow-y: auto; margin-bottom: 12px; }
  .dir {
    display: flex; align-items: center; gap: 9px;
    width: 100%; text-align: left; margin: 1px 0; padding: 7px 8px;
    background: transparent; border-color: transparent; font-size: 14px;
    border-radius: var(--radius);
  }
  .dir:hover { background: var(--surface-2); border-color: transparent; }
  .dir.up { color: var(--muted); }
  .foot { display: flex; gap: 8px; align-items: center; }
  .err { color: var(--danger); font-size: 13px; }
</style>
