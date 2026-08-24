/**
 * Ring buffer of server and engine activity for the read-only web console.
 *
 * Deliberately not a shell: it surfaces what the server is doing — engine
 * events, ffmpeg spawn lines, geometry decisions, warnings — without giving
 * the browser any way to run anything. Everything passes through redact()
 * so the stream key cannot appear in a pasted log.
 */

import { redact } from './config.js';

const MAX_LINES = 2000;
const buf = [];
let seq = 0;

export function dpush(level, line) {
  const text = redact(String(line)).trimEnd();
  if (!text) return;
  for (const l of text.split('\n')) {
    buf.push({ id: ++seq, t: Date.now(), level, line: l });
  }
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
}

/** Entries after `after` (an id from a previous fetch), oldest first. */
export function dlist(after = 0, limit = 500) {
  const out = [];
  for (let i = buf.length - 1; i >= 0 && out.length < limit; i--) {
    if (buf[i].id <= after) break;
    out.push(buf[i]);
  }
  return out.reverse();
}

/** Tee the process console into the buffer so startup lines appear too. */
export function teeConsole() {
  for (const [name, level] of [['log', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const orig = console[name].bind(console);
    console[name] = (...args) => {
      try {
        dpush(level, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      } catch { /* logging must never throw */ }
      orig(...args);
    };
  }
}
