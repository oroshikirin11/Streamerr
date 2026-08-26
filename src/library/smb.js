/**
 * SMB share access, by mounting.
 *
 * The engine, the prober, the subtitle extractor and the chunk encoders all
 * consume plain file paths — so rather than teach each of them the SMB
 * protocol, the share is mounted once and the ordinary filesystem provider
 * scans the mountpoint. Everything downstream works unchanged, at kernel
 * CIFS speed.
 *
 * Passwordless (guest) shares are first-class: `guest: true` mounts with no
 * credentials at all, which is how most home NAS media shares are exposed.
 *
 * Mounting needs privileges: root, or CAP_SYS_ADMIN in a container
 * (docker: `cap_add: [SYS_ADMIN]`, and on some hosts
 * `security_opt: [apparmor:unconfined]`). The error messages say so rather
 * than leaving a bare EPERM.
 */

import { execFile } from 'child_process';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

/** Where a share gets mounted, derived from its identity — stable across restarts. */
export function smbMountpoint(runDir, host, share) {
  const slug = `${host}-${share}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return join(runDir, 'smb', slug);
}

function isMounted(mountpoint) {
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .some((l) => l.split(' ')[1] === mountpoint.replace(/ /g, '\\040'));
  } catch {
    return false;
  }
}

/**
 * Ensure //host/share is mounted; resolves to the local root to scan
 * (mountpoint plus the optional subfolder). Idempotent: an existing mount
 * is reused, so restarts don't stack mounts or fail on EBUSY.
 */
/**
 * Accept the address in every form people actually paste: a bare host, an
 * smb:// URL with user and share embedded, or a Windows UNC path. Returns
 * normalized components; explicit fields win over URL-embedded ones only
 * where the URL does not carry them.
 */
export function parseSmbTarget({ host = '', share = '', path = '', username = '', password = '', guest = true }) {
  let h = String(host).trim()
    .replace(/^smb:\/\//i, '')
    .replace(/^\\\\/, '')
    .replace(/\\/g, '/');
  let user = username;
  const at = h.indexOf('@');
  if (at !== -1) {
    const cred = h.slice(0, at);
    h = h.slice(at + 1);
    if (!user) {
      const colon = cred.indexOf(':');
      user = colon === -1 ? cred : cred.slice(0, colon);
      if (colon !== -1 && !password) password = cred.slice(colon + 1);
    }
  }
  const segs = h.split('/').filter(Boolean);
  h = segs.shift() ?? '';
  // A URL that names its share is authoritative for share and folder —
  // whatever it says IS where the media lives.
  let sh = share;
  let p = path;
  if (segs.length) {
    sh = segs.shift();
    p = segs.length ? segs.join('/') : p;
  }
  if (user && guest) guest = false;
  return { host: h, share: sh, path: p, username: user, password, guest };
}

export function ensureSmbMount(target, runDir) {
  const { host, share, path = '', username = '', password = '', guest = true } = parseSmbTarget(target);
  return new Promise((resolve, reject) => {
    if (!host || !share) {
      reject(new Error('SMB share is not configured: host and share name are required.'));
      return;
    }
    const mountpoint = smbMountpoint(runDir, host, share);
    const root = path ? join(mountpoint, path) : mountpoint;
    if (isMounted(mountpoint)) {
      resolve(root);
      return;
    }
    mkdirSync(mountpoint, { recursive: true });

    // ro: this service only ever reads media. iocharset for non-ASCII
    // titles. Credentials via the option string; the config file that
    // carries them is already the secret store for every other credential,
    // and the mount command is never logged.
    const opts = ['ro', 'iocharset=utf8'];
    if (guest || (!username && !password)) opts.push('guest');
    else {
      // A comma is CIFS's own option separator, so a value containing one
      // appends mount options of the caller's choosing (rw, uid=0, …).
      for (const [label, v] of [['username', username], ['password', password]]) {
        if (v && /[,\n\r]/.test(String(v))) {
          throw new Error(`SMB ${label} may not contain a comma or newline.`);
        }
      }
      opts.push(`username=${username}`);
      if (password) opts.push(`password=${password}`);
    }

    execFile('mount', ['-t', 'cifs', `//${host}/${share}`, mountpoint, '-o', opts.join(',')],
      { timeout: 20000 }, (err, _out, stderr) => {
        if (!err) { resolve(root); return; }
        const detail = String(stderr ?? '').trim().split('\n').pop() ?? '';
        let hint = '';
        if (/permission denied|operation not permitted|failed mount system call/i.test(detail + err.message)) {
          hint = ' Mounting needs privileges. Docker: cap_add: [SYS_ADMIN]. '
            + 'Inside a Proxmox LXC the container additionally needs the CIFS '
            + 'mount feature from the HOST: pct set <ctid> --features mount=cifs '
            + '(then restart the container) — without it the kernel refuses '
            + 'even root.';
        } else if (/No such device|unknown filesystem/i.test(detail + err.message)) {
          hint = ' The kernel is missing CIFS support (install cifs-utils on the host).';
        } else if (/error.13|NT_STATUS_ACCESS_DENIED|NT_STATUS_LOGON_FAILURE/i.test(detail)) {
          hint = guest
            ? ' The share refused guest access — it may require a username and password.'
            : ' The share rejected these credentials.';
        }
        reject(new Error(`Could not mount //${host}/${share}: ${detail || err.message}.${hint}`));
      });
  });
}

import { FilesystemLibrary } from './filesystem.js';

/**
 * The SMB provider: mounts on first use, then IS the filesystem provider
 * rooted at the mountpoint. Every async surface awaits the mount; the one
 * synchronous method the engine needs (resolvePath) is only ever called
 * after items were listed, which established the mount.
 */
export class SmbLibrary {
  constructor(smb = {}, runDir = '/tmp') {
    this._smb = smb;
    this._runDir = runDir;
    this._fs = null;
    this._mounting = null;
  }

  get configured() {
    return Boolean(this._smb.host && this._smb.share);
  }

  _ready() {
    this._mounting ??= ensureSmbMount(this._smb, this._runDir).then((root) => {
      this._fs = new FilesystemLibrary({ roots: [root] });
      return this._fs;
    }).catch((err) => {
      // A failed mount must not be cached forever — the share may come up.
      this._mounting = null;
      throw err;
    });
    return this._mounting;
  }

  async test() {
    const fs = await this._ready();
    return fs.test();
  }

  async libraries() { return (await this._ready()).libraries(); }
  async items(...a) { return (await this._ready()).items(...a); }
  async seasons(...a) { return (await this._ready()).seasons(...a); }
  async episodes(...a) { return (await this._ready()).episodes(...a); }
  async item(...a) { return (await this._ready()).item(...a); }
  async nextEpisode(...a) { return (await this._ready()).nextEpisode(...a); }

  resolvePath(episode) {
    if (!this._fs) throw new Error('SMB share is not mounted yet');
    return this._fs.resolvePath(episode);
  }
}
