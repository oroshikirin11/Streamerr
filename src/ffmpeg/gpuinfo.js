/**
 * Which GPU a render node actually is.
 *
 * `/dev/dri/renderD128` is enumeration order, not a name — on one machine it
 * is a discrete RX 6900 XT, on another the CPU's integrated graphics. A
 * compose file that passes "renderD128" through is therefore a guess, and
 * the failure is quiet: everything works, on the wrong GPU, slower. Worse is
 * passing exactly one node and never learning that the box has two.
 *
 * VAAPI knows the answer and will say it out loud, so ask it rather than
 * shipping a PCI-ID table that goes stale. sysfs is the fallback for when
 * the node exists but no driver will open it — which is itself the useful
 * signal that a device was passed in but is unusable.
 */

import { spawn } from 'child_process';
import { readdirSync, readFileSync } from 'fs';

/** Pull the marketing name out of a libva driver string. */
export function parseDriverString(s = '') {
  // Mesa:  "Mesa Gallium driver 26.2.1-arch3.1 for AMD Radeon RX 6900 XT (radeonsi, navi21, ...)."
  // Intel: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0"
  const m = /\bfor\s+(.+?)\s*(?:\((?:radeonsi|iHD|i965)|$)/i.exec(s.trim());
  let name = (m ? m[1] : s).trim();
  name = name.replace(/\.$/, '');           // Mesa ends the sentence
  name = name.replace(/\s+-\s+[\d.]+$/, ''); // Intel appends " - 24.1.0"
  return name || null;
}

/** The libva driver family, for a short "who is driving this" hint. */
export function parseDriverFamily(s = '') {
  if (/iHD/i.test(s)) return 'Intel iHD';
  if (/i965/i.test(s)) return 'Intel i965';
  if (/Mesa Gallium/i.test(s)) return 'Mesa';
  return null;
}

function vaapiName(device) {
  return new Promise((resolve) => {
    const c = spawn('ffmpeg', [
      '-hide_banner', '-v', 'verbose', '-nostdin',
      '-init_hw_device', `vaapi=va:${device}`,
      '-f', 'lavfi', '-i', 'nullsrc', '-frames:v', '1', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
    c.on('error', () => { clearTimeout(kill); resolve(null); });
    c.on('close', () => {
      clearTimeout(kill);
      const m = /VAAPI driver:\s*(.+)/i.exec(err);
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** Whatever sysfs will tell us with no tools installed. */
function sysfsInfo(node) {
  const out = { driver: null, pciId: null };
  try {
    const uevent = readFileSync(`/sys/class/drm/${node}/device/uevent`, 'utf8');
    out.driver = /DRIVER=(.+)/.exec(uevent)?.[1]?.trim() ?? null;
    out.pciId = /PCI_ID=(.+)/.exec(uevent)?.[1]?.trim() ?? null;
  } catch { /* not a PCI device, or no sysfs */ }
  return out;
}

/**
 * Every render node on this machine, named.
 *
 * Cached: opening a VAAPI connection per node costs real time and the answer
 * cannot change without the container restarting.
 */
let cached = null;
export async function renderNodes({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  let nodes = [];
  try {
    nodes = readdirSync('/dev/dri').filter((n) => n.startsWith('render')).sort();
  } catch {
    // No /dev/dri at all: a CPU-only host, or nothing was passed in.
    cached = [];
    return cached;
  }
  cached = await Promise.all(nodes.map(async (node) => {
    const path = `/dev/dri/${node}`;
    const raw = await vaapiName(path);
    const sys = sysfsInfo(node);
    return {
      path,
      name: parseDriverString(raw ?? ''),
      driver: parseDriverFamily(raw ?? ''),
      kernelDriver: sys.driver,
      pciId: sys.pciId,
      // A node that will not open is still worth showing: it means a device
      // WAS passed in and cannot be used, which is a different problem from
      // not passing one at all.
      usable: Boolean(raw),
    };
  }));
  return cached;
}
