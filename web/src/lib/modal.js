/**
 * Shared dialog behaviour, as a Svelte action: `use:modal={{ onClose }}`.
 *
 *  - Escape closes (calls onClose) — only the TOPMOST open dialog reacts,
 *    so a dialog stacked over another does not close both.
 *  - Tab / Shift+Tab stay inside the dialog (`trap: false` turns this off
 *    for a docked panel that shares the screen with the transport bar).
 *  - Focus moves to the first focusable control (or the dialog itself) on
 *    open — unless something inside already took it — and returns to the
 *    element that had it when the dialog closes.
 *  - role="dialog" and aria-modal are set unless the markup already has them.
 *
 * Keys are listened for on the document rather than the dialog: a click on
 * a non-focusable spot inside the card leaves document.activeElement on
 * <body>, and Escape must still work then.
 */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Focusable descendants that are actually rendered (no display:none). */
export function focusables(node) {
  return [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Where Tab should land, or null to let the browser do its thing.
 * Pure, so it can be unit-tested: `active` is document.activeElement.
 */
export function nextFocus(els, active, shiftKey, inside) {
  if (!els.length) return 'self';
  const first = els[0];
  const last = els[els.length - 1];
  if (!inside) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

/** Open dialogs, innermost last. */
const stack = [];

/**
 * The last thing focused outside any open dialog — where focus returns
 * when a dialog closes. Recorded continuously rather than read at open,
 * because a dialog may have moved focus inside itself (an `autofocus`
 * or attachment on a search box) before the action even runs.
 */
let lastOutside = null;
if (typeof document !== 'undefined') {
  const note = (el) => {
    if (el instanceof Element && !stack.some((m) => m.node.contains(el))) lastOutside = el;
  };
  document.addEventListener('focusin', (e) => note(e.target), true);
  // Safari does not focus a clicked button, so the pointer is the record
  // there: the nearest focusable thing under it is what to return to.
  document.addEventListener('mousedown', (e) => note(e.target?.closest?.(FOCUSABLE) ?? e.target), true);
}

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    // An open <select> or a composing IME eats its own Escape.
    if (e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    top.opts.onClose?.();
    return;
  }
  if (e.key === 'Tab' && top.opts.trap !== false) {
    const active = document.activeElement;
    const target = nextFocus(focusables(top.node), active, e.shiftKey, top.node.contains(active));
    if (!target) return;
    e.preventDefault();
    if (target === 'self') top.node.focus();
    else target.focus();
  }
}

export function modal(node, opts = {}) {
  const entry = { node, opts };
  let prev = document.activeElement;
  if (!prev || prev === document.body || node.contains(prev)) prev = lastOutside;

  if (!node.hasAttribute('role')) node.setAttribute('role', 'dialog');
  if (opts.trap !== false && !node.hasAttribute('aria-modal')) node.setAttribute('aria-modal', 'true');
  if (!node.hasAttribute('tabindex')) {
    // Lets the card itself take focus when it holds no controls yet (a
    // dialog still loading). The ring on a card is noise, not guidance.
    node.setAttribute('tabindex', '-1');
    node.style.outline = 'none';
  }

  if (!stack.length) document.addEventListener('keydown', onKeydown, true);
  stack.push(entry);

  // After the first paint: children rendered under {#if} exist by now, and
  // an `autofocus`/attachment inside has had its say.
  const raf = requestAnimationFrame(() => {
    if (opts.autofocus === false) return;
    if (node.contains(document.activeElement)) return;
    (focusables(node)[0] ?? node).focus({ preventScroll: true });
  });

  return {
    update(next) { entry.opts = next ?? {}; },
    destroy() {
      cancelAnimationFrame(raf);
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
      // Only hand focus back if it is still ours to hand back — the user
      // may have clicked somewhere else while the dialog was open.
      const active = document.activeElement;
      const ours = !active || active === document.body || node.contains(active);
      if (ours && prev && prev.isConnected && typeof prev.focus === 'function') {
        prev.focus({ preventScroll: true });
      }
    },
  };
}
