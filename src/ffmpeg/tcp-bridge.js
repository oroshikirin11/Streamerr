/**
 * The local end of a raw-TCP publish destination.
 *
 * Plain TCP has nowhere to carry a stream key — SRT has streamid, RTMP has
 * the path — and ffmpeg cannot send bytes ahead of its own muxer output. So
 * the connection is owned here instead: ffmpeg writes its stream to a
 * loopback listener, and for every publisher connection the bridge dials the
 * real target, authenticates with one preamble line and splices bytes.
 *
 *     publisher ffmpeg → tcp://127.0.0.1:<port> → [bridge] → tcp://host:port
 *                                                   `SGR-TS/1 <key>\n` first
 *
 * Optionally the remote leg is TLS. The receiver listens on ONE port for
 * both — it peeks the first byte, a ClientHello or the plain preamble — and
 * may be set to require TLS, in which case it closes a plain connection
 * right after the preamble. Over TLS the wire is otherwise identical: the
 * preamble goes out once the handshake is done, then the container bytes.
 * The setting is not per destination but the receiver protocol's own,
 * under `streamingestarr.tcpTls`; it reaches every tcp destination —
 * primary and extras — through the creds closure as `creds.tls`.
 * Verification is always on: there is no insecure switch, only an
 * optional CA/self-signed certificate to trust for LAN setups.
 *
 * Failure semantics are deliberately the RTMP ones: if the remote refuses or
 * drops, the bridge closes the local socket, the publisher exits, and the
 * engine's existing publisher supervision restarts the chain with its usual
 * backoff. No retry logic lives here — supervision already owns that job,
 * and a second retry loop underneath it caused exactly the kind of fight
 * the fifo-era transports were full of.
 *
 * The listener is created once and survives publisher restarts; only the
 * per-connection remote dial is fresh each time (a fresh TLS session per
 * dial too — no resumption, nothing to keep). It binds 127.0.0.1 — the
 * bridge must never be reachable from outside the host, since anyone who
 * can write to it broadcasts as us.
 */

import { spawn } from 'node:child_process';
import { createConnection, createServer, isIP } from 'net';
import { connect as tlsConnect } from 'tls';
import { readFileSync } from 'fs';

/** The receiver contract's greeting. Version first so it can ever change. */
export const TCP_PREAMBLE = (key) => `SGR-TS/1 ${key}\n`;

/** Where the operator turns TLS on and names a certificate to trust. */
const TLS_SETTINGS = 'Settings › Streamingestarr';

/**
 * A filtered port drops the SYN and answers NOTHING — without a dial
 * deadline the connect hangs forever, the local socket backpressures, and
 * the publisher freezes at ~0x with no error anywhere (measured on the
 * first live attempt: firewall closed, 40s of silent stall). Ten seconds is
 * generous for a WAN dial; then fail loudly and let supervision retry. The
 * same deadline covers the TLS handshake: a peer that accepts the TCP
 * connection and then never answers the ClientHello is just as silent.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * `tcp://host:port` — a hostname, an IPv4 literal, or a bracketed IPv6
 * literal. Returns {host, port} with the brackets stripped, or null.
 */
export function parseTcpTarget(url) {
  const m = /^tcp:\/\/(\[[0-9a-f:.]+\]|[^/\s:[\]]+):(\d+)$/i.exec(String(url ?? '').trim());
  if (!m) return null;
  const host = m[1].startsWith('[') ? m[1].slice(1, -1) : m[1];
  return { host, port: Number(m[2]) };
}

/**
 * Did the peer's certificate fail verification? Node surfaces OpenSSL's
 * X509 verify results as the error code (CERT_HAS_EXPIRED,
 * DEPTH_ZERO_SELF_SIGNED_CERT, SELF_SIGNED_CERT_IN_CHAIN,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, UNABLE_TO_GET_ISSUER_CERT_LOCALLY,
 * CERT_UNTRUSTED, HOSTNAME_MISMATCH, …) and its own hostname check as
 * ERR_TLS_CERT_ALTNAME_INVALID.
 */
export function isCertError(err) {
  return /^(CERT_|CRL_|ERR_TLS_CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|HOSTNAME_MISMATCH|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|ERROR_IN_CERT)/
    .test(String(err?.code ?? ''));
}

/**
 * Did the handshake fail because the other end is not TLS at all? A plain
 * receiver reads the ClientHello as a garbage preamble and hangs up
 * (ECONNRESET before secureConnect), or answers with bytes OpenSSL cannot
 * parse (EPROTO / "wrong version number" / "packet length too long").
 */
function isNotTlsError(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  return code === 'EPROTO' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_OSSL_')
    || /wrong version number|packet length too long|unknown protocol|unexpected message|before secure TLS connection/i.test(msg);
}

/**
 * The cert's name for the log: subject CN, else its first SAN. Never any
 * key material — informational only.
 */
export function describeCert(cert) {
  if (!cert || typeof cert !== 'object') return null;
  const cn = cert.subject?.CN;
  const san = String(cert.subjectaltname ?? '').split(',')[0]?.trim();
  const name = cn ? `CN=${cn}` : (san || '(unnamed)');
  return `${name}, valid until ${cert.valid_to ?? '?'}`;
}

export class TcpBridge {
  /**
   * @param {() => {url: string, key: string, tls?: {enabled: boolean, caFile: string}}} creds
   *        read at CONNECT time, so a settings change applies on the next
   *        publisher spawn without rebuilding the bridge.
   * @param {(m: string) => void} log
   */
  constructor(creds, log = () => {}) {
    this._creds = creds;
    this.log = log;
    this._server = null;
    this.port = null;
    /** Fingerprint of the last certificate described in the log — the
     *  details are worth one line per session, not one per reconnect. */
    this._certSeen = null;
  }

  /** Start (or reuse) the loopback listener; resolves to its port. */
  async listen() {
    if (this.port) return this.port;
    this._server = createServer((local) => this._bridge(local));
    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(0, '127.0.0.1', resolve);
    });
    this._server.on('error', (err) => {
      this.log(`[tcp-bridge] listener error: ${err.message}\n`);
    });
    this.port = this._server.address().port;
    return this.port;
  }

  _bridge(local) {
    const { url, key, tls } = this._creds() ?? {};
    const target = parseTcpTarget(url);
    if (!target) {
      this.log('[tcp-bridge] no valid tcp:// target configured — closing\n');
      local.destroy();
      return;
    }
    const { host, port } = target;
    const where = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const useTls = Boolean(tls?.enabled);
    local.setNoDelay(true);
    // Publisher bytes arriving before the dial completes buffer in the
    // socket; pause until the remote is ready so nothing is read-and-lost.
    local.pause();

    let remote;
    if (useTls) {
      /**
       * Verification is never optional. `ca`, when set, REPLACES the system
       * roots with the operator's file — a private CA or the receiver's
       * self-signed certificate — and is read on every dial so a renewed
       * file applies to the next reconnect without a restart. An unreadable
       * file fails here, by name, rather than silently verifying against
       * roots that cannot know a LAN certificate.
       */
      let ca;
      const caFile = String(tls.caFile ?? '').trim();
      if (caFile) {
        try {
          ca = readFileSync(caFile);
        } catch (err) {
          this.log(`[tcp-bridge] cannot read the trusted certificate file ${caFile} `
            + `(${err.code ?? err.message}) — fix the path under ${TLS_SETTINGS}\n`);
          local.destroy();
          return;
        }
      }
      /**
       * SNI carries a NAME, never an address: for an IP literal it is
       * omitted and Node verifies the peer against the certificate's IP
       * SANs instead (checkServerIdentity falls back to `host`).
       */
      remote = tlsConnect({
        host, port, minVersion: 'TLSv1.2', rejectUnauthorized: true,
        ...(isIP(host) ? {} : { servername: host }),
        ...(ca ? { ca } : {}),
      });
    } else {
      remote = createConnection({ host, port });
    }
    remote.setNoDelay(true);
    remote.setTimeout(CONNECT_TIMEOUT_MS);
    let dropped = false;
    const drop = (why) => {
      // Closing the LOCAL side is the whole failure model: the publisher
      // gets EPIPE, exits, and supervision restarts with backoff. One
      // verdict per dial: an error is followed by a close, and the close
      // must not narrate the same failure a second time.
      if (dropped) return;
      dropped = true;
      if (why) this.log(`[tcp-bridge] ${why}\n`);
      local.destroy();
      remote.destroy();
    };
    let tcpUp = false;
    let connectedAt = 0;
    remote.on('timeout', () => drop(
      useTls && tcpUp
        ? `${where} accepted the connection but the TLS handshake did not complete `
          + `within ${CONNECT_TIMEOUT_MS / 1000}s — does the receiver speak TLS on this port?`
        : `no answer from ${where} within ${CONNECT_TIMEOUT_MS / 1000}s — port filtered, `
          + 'receiver down, or firewall closed'));
    const ready = () => {
      remote.setTimeout(0);
      connectedAt = Date.now();
      let line = `[tcp-bridge] connected${useTls ? ' over TLS' : ''} to ${where} — preamble sent, splicing`;
      if (useTls) {
        const cert = remote.getPeerCertificate();
        const fp = cert?.fingerprint256 ?? null;
        if (fp && fp !== this._certSeen) {
          this._certSeen = fp;
          line += `; receiver certificate ${describeCert(cert)}`;
        }
      }
      this.log(`${line}\n`);
      remote.write(TCP_PREAMBLE(String(key ?? '')));
      local.pipe(remote);
      local.resume();
    };
    remote.on('connect', () => { tcpUp = true; });
    if (useTls) remote.on('secureConnect', ready);
    else remote.on('connect', ready);
    // The receiver never speaks — bytes back mean a rejection notice or a
    // confused endpoint; either way the contract is over. Discard content,
    // keep the socket draining so a chatty peer cannot backpressure us.
    remote.on('data', () => {});
    // The receiver never says why it hangs up; a close within seconds of
    // the preamble is a rejection, and the shortlist is short.
    const rejectedEarly = () => connectedAt && Date.now() - connectedAt < 3000;
    const rejectionLine = () => `${where} closed right after the preamble — wrong stream key, `
      + `the receiver requires TLS${useTls ? '' : ` (turn it on under ${TLS_SETTINGS})`}, `
      + 'or a broadcast is already running there';
    remote.on('error', (err) => {
      if (rejectedEarly() && /ended by the other party|EPIPE|ECONNRESET|write after end/i.test(`${err.code} ${err.message}`)) {
        drop(rejectionLine());
      } else if (useTls && !connectedAt && isCertError(err)) {
        const reason = String(err.reason ?? err.message ?? err.code).replace(/:\s*$/, '');
        drop(`${where}: the receiver's certificate was rejected (${reason}) — connect by `
          + `the name on its certificate, or set a trusted CA under ${TLS_SETTINGS}`);
      } else if (useTls && !connectedAt && tcpUp && (isNotTlsError(err) || err.code === 'ECONNRESET')) {
        drop(`${where} does not speak TLS on this port — turn off TLS under ${TLS_SETTINGS}, `
          + 'or turn it on at the receiver');
      } else {
        drop(`remote ${where}: ${err.message}`);
      }
    });
    /**
     * A close seconds after the preamble is the receiver REJECTING us — it
     * cannot say why over this contract, but the shortlist is short, so
     * spell it out; without this the operator sees only a silent restart
     * loop. A close later than that is an ordinary mid-stream drop and the
     * supervision restart says everything there is to say. A close during
     * the TLS handshake with no error is the not-TLS case again.
     */
    remote.on('close', () => drop(
      useTls && tcpUp && !connectedAt
        ? `${where} closed during the TLS handshake — the receiver does not speak TLS `
          + `on this port; turn off TLS under ${TLS_SETTINGS}, or turn it on at the receiver`
        : rejectedEarly() ? rejectionLine() : null));
    local.on('error', () => drop(null));
    local.on('close', () => remote.destroy());
  }

  close() {
    try { this._server?.close(); } catch { /* already down */ }
    this._server = null;
    this.port = null;
  }
}


/**
 * "Test connection" for a tcp destination: dial the receiver the way the
 * bridge does (TLS as configured), send the preamble, then push a few
 * seconds of test signal — or thirty, paced, to watch it appear. The
 * receiver hangs up on a bad key right after the preamble, and on a TLS
 * mismatch during the handshake; both come back as the sentence the
 * bridge would have logged.
 *
 * @param {{url: string, key: string, tls?: {enabled: boolean, caFile: string}}} creds
 * @param {{seconds?: number, realtime?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function testTcpConnection(creds, { seconds = 3, realtime = false } = {}) {
  return new Promise((resolve) => {
    const target = parseTcpTarget(creds?.url);
    if (!target) return resolve({ ok: false, error: 'The address must look like tcp://host:port' });
    const key = String(creds?.key ?? '').trim();
    if (!key) return resolve({ ok: false, error: 'A stream key is required' });
    const { host, port } = target;
    const where = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const useTls = Boolean(creds?.tls?.enabled);
    let done = false;
    let child = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      try { child?.kill('SIGKILL'); } catch { /* gone */ }
      try { remote.destroy(); } catch { /* gone */ }
      resolve(r);
    };
    const guard = setTimeout(() => finish({ ok: false, error: `no answer from ${where} within ${CONNECT_TIMEOUT_MS / 1000}s — port filtered, receiver down, or firewall closed` }), (seconds + 20) * 1000);

    let remote;
    let tcpUp = false;
    let preambleAt = 0;
    if (useTls) {
      let ca;
      const caFile = String(creds.tls?.caFile ?? '').trim();
      if (caFile) {
        try { ca = readFileSync(caFile); } catch (err) {
          return finish({ ok: false, error: `cannot read the trusted certificate file ${caFile} (${err.code ?? err.message}) — fix the path under ${TLS_SETTINGS}` });
        }
      }
      remote = tlsConnect({ host, port, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) });
      remote.on('secureConnect', ready);
    } else {
      remote = createConnection({ host, port }, ready);
    }
    remote.setNoDelay(true);
    remote.on('connect', () => { tcpUp = true; });
    remote.on('error', (err) => {
      if (useTls && isCertError(err)) {
        finish({ ok: false, error: `${where} presented a certificate that does not verify (${err.code}) — the receiver must use one issued for its name, or set a trusted CA under ${TLS_SETTINGS}` });
      } else if (useTls && tcpUp && !preambleAt && (isNotTlsError(err) || err.code === 'ECONNRESET')) {
        finish({ ok: false, error: `${where} does not speak TLS on this port — turn off TLS under ${TLS_SETTINGS}, or turn it on at the receiver` });
      } else if (preambleAt && /ECONNRESET|EPIPE/.test(String(err.code))) {
        finish({ ok: false, error: `${where} closed the connection right after the preamble — it refused the stream key, or it requires TLS` });
      } else {
        finish({ ok: false, error: `${where}: ${err.message}` });
      }
    });
    remote.on('close', () => {
      if (done) return;
      if (preambleAt && Date.now() - preambleAt < 1500) {
        finish({ ok: false, error: `${where} closed the connection right after the preamble — it refused the stream key, or it requires TLS` });
      } else if (!preambleAt) {
        finish({ ok: false, error: `${where} closed the connection during the handshake` });
      } else {
        finish({ ok: false, error: `${where} ended the connection before the test finished` });
      }
    });

    function ready() {
      preambleAt = Date.now();
      remote.write(TCP_PREAMBLE(key));
      child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...(realtime ? ['-re'] : []),
        '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t', String(seconds),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-f', 'mpegts', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => { if (!done && remote.writable) remote.write(chunk); });
      child.on('error', (err) => finish({ ok: false, error: err.message }));
      child.on('close', () => {
        // Everything went out and the receiver kept the line: accepted.
        if (done) return;
        setTimeout(() => { if (!done) finish({ ok: true }); }, 400);
      });
    }
  });
}
