/**
 * The panel's own secure address.
 *
 * Browsers only allow screen sharing (getDisplayMedia) from a secure
 * context: https, or localhost. The panel is normally opened on a plain
 * http LAN address, where the API simply does not exist. Rather than ask
 * every operator to run a reverse proxy, the service can serve https
 * itself with a certificate it generates once — the operator accepts it in
 * the browser a single time, and the address works from then on.
 *
 * Generation shells out to `openssl`, which every image this runs in
 * carries (ffmpeg pulls it in). The certificate names every address the
 * box answers on — hostname, localhost, each IPv4 — so the browser's
 * name check passes wherever the panel is opened from; when the box moves
 * to a network the certificate does not name, it is regenerated.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { hostname, networkInterfaces } from 'os';
import { join } from 'path';
import { X509Certificate } from 'crypto';

export const TLS_DEFAULT_PORT = 8443;

/** Every non-internal IPv4 address this machine has right now. */
export function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** The names the certificate should carry. */
export function wantedNames() {
  const names = new Set(['localhost']);
  const h = String(hostname() || '').trim();
  if (h) names.add(h);
  const ips = new Set(['127.0.0.1', ...localAddresses()]);
  return { dns: [...names], ips: [...ips] };
}

/** Parse a certificate's subjectAltName into { dns, ips }. */
export function namesOf(certPem) {
  const x = new X509Certificate(certPem);
  const dns = [];
  const ips = [];
  for (const part of String(x.subjectAltName ?? '').split(',')) {
    const [kind, ...rest] = part.trim().split(':');
    const v = rest.join(':').trim();
    if (!v) continue;
    if (kind === 'DNS') dns.push(v);
    else if (kind.startsWith('IP')) ips.push(v);
  }
  return { dns, ips, validTo: x.validTo, fingerprint: x.fingerprint256 };
}

/** Does this certificate name every address we currently have? */
export function certCovers(certPem, want = wantedNames()) {
  try {
    const have = namesOf(certPem);
    if (new Date(have.validTo).getTime() - Date.now() < 30 * 86400_000) return false;
    return want.dns.every((d) => have.dns.includes(d))
      && want.ips.every((i) => have.ips.includes(i));
  } catch {
    return false;
  }
}

/**
 * Make sure a usable key + certificate exist in `dir`; generate or replace
 * them when missing or when they no longer name this box's addresses.
 *
 * @returns {{ keyPath, certPath, created: boolean, fingerprint: string, names: {dns, ips} }}
 */
export function ensureCert(dir, { want = wantedNames(), days = 3650, log = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  let created = false;
  const have = existsSync(keyPath) && existsSync(certPath)
    && statSync(keyPath).size > 0 && statSync(certPath).size > 0;
  if (!have || !certCovers(readFileSync(certPath, 'utf8'), want)) {
    const san = [
      ...want.dns.map((d) => `DNS:${d}`),
      ...want.ips.map((i) => `IP:${i}`),
    ].join(',');
    const r = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-days', String(days),
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=Streamerr',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      const why = r.error?.code === 'ENOENT'
        ? 'openssl is not installed on this machine'
        : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').pop();
      throw new Error(`could not generate a certificate: ${why}`);
    }
    created = true;
    log?.(`[tls] certificate ${have ? 'renewed' : 'created'} for ${san}`);
  }
  const names = namesOf(readFileSync(certPath, 'utf8'));
  return { keyPath, certPath, created, fingerprint: names.fingerprint, names };
}

/** Key and certificate PEMs for https.createServer. */
export function loadTls(dir) {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) return null;
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
