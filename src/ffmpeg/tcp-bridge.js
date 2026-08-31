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
 * Failure semantics are deliberately the RTMP ones: if the remote refuses or
 * drops, the bridge closes the local socket, the publisher exits, and the
 * engine's existing publisher supervision restarts the chain with its usual
 * backoff. No retry logic lives here — supervision already owns that job,
 * and a second retry loop underneath it caused exactly the kind of fight
 * the fifo-era transports were full of.
 *
 * The listener is created once and survives publisher restarts; only the
 * per-connection remote dial is fresh each time. It binds 127.0.0.1 — the
 * bridge must never be reachable from outside the host, since anyone who
 * can write to it broadcasts as us.
 */

import { createConnection, createServer } from 'net';

/**
 * The receiver contract's greeting. Version first so it can ever change.
 * With a passphrase the line is `SGR-TS/1 <key> <passphrase>` — the second
 * token is the receiver's optional TCP passphrase; a receiver without one
 * configured ignores it.
 */
export const TCP_PREAMBLE = (key, passphrase = '') => (passphrase
  ? `SGR-TS/1 ${key} ${passphrase}\n`
  : `SGR-TS/1 ${key}\n`);

export class TcpBridge {
  /**
   * @param {() => {url: string, key: string}} creds  read at CONNECT time,
   *        so a settings change applies on the next publisher spawn without
   *        rebuilding the bridge.
   * @param {(m: string) => void} log
   */
  constructor(creds, log = () => {}) {
    this._creds = creds;
    this.log = log;
    this._server = null;
    this.port = null;
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
    const { url, key, passphrase } = this._creds() ?? {};
    const m = /^tcp:\/\/([^/\s:]+):(\d+)$/i.exec(String(url ?? '').trim());
    if (!m) {
      this.log('[tcp-bridge] no valid tcp:// target configured — closing\n');
      local.destroy();
      return;
    }
    local.setNoDelay(true);
    // Publisher bytes arriving before the dial completes buffer in the
    // socket; pause until the remote is ready so nothing is read-and-lost.
    local.pause();

    const remote = createConnection({ host: m[1], port: Number(m[2]) });
    remote.setNoDelay(true);
    /**
     * A filtered port drops the SYN and answers NOTHING — without a dial
     * deadline the connect hangs forever, the local socket backpressures,
     * and the publisher freezes at ~0x with no error anywhere (measured on
     * the first live attempt: firewall closed, 40s of silent stall). Ten
     * seconds is generous for a WAN dial; then fail loudly and let
     * supervision retry.
     */
    remote.setTimeout(10_000);
    const drop = (why) => {
      // Closing the LOCAL side is the whole failure model: the publisher
      // gets EPIPE, exits, and supervision restarts with backoff.
      if (why) this.log(`[tcp-bridge] ${why}\n`);
      local.destroy();
      remote.destroy();
    };
    remote.on('timeout', () => drop(
      `no answer from ${m[1]}:${m[2]} within 10s — port filtered, `
      + 'receiver down, or firewall closed'));
    remote.on('connect', () => {
      remote.setTimeout(0);
      this.log(`[tcp-bridge] connected to ${m[1]}:${m[2]} — authenticated, splicing\n`);
      remote.write(TCP_PREAMBLE(String(key ?? ''), String(passphrase ?? '').trim()));
      local.pipe(remote);
      local.resume();
    });
    // The receiver never speaks — bytes back mean a rejection notice or a
    // confused endpoint; either way the contract is over. Discard content,
    // keep the socket draining so a chatty peer cannot backpressure us.
    remote.on('data', () => {});
    remote.on('error', (err) => drop(`remote ${m[1]}:${m[2]}: ${err.message}`));
    remote.on('close', () => drop(null));
    local.on('error', () => drop(null));
    local.on('close', () => remote.destroy());
  }

  close() {
    try { this._server?.close(); } catch { /* already down */ }
    this._server = null;
    this.port = null;
  }
}
