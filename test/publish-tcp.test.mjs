import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'net';
import { createServer as createTlsServer } from 'tls';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  muxerFor, protocolCarries, targetUrl, destinations, publishDefaults,
  redactPublish, redactUrl,
} from '../src/publish.js';
import {
  TcpBridge, TCP_PREAMBLE, parseTcpTarget, isCertError, describeCert,
} from '../src/ffmpeg/tcp-bridge.js';

test('tcp protocol table', () => {
  // Container: TS for everything the receiver probes as TS, matroska for AV1.
  assert.equal(muxerFor('tcp', 'h264'), 'mpegts');
  assert.equal(muxerFor('tcp', 'hevc'), 'mpegts');
  assert.equal(muxerFor('tcp', 'av1'), 'matroska');
  // Carriage: tcp is container-honest, rtmp stays H.264-only.
  assert.equal(protocolCarries('tcp', 'hevc'), true);
  assert.equal(protocolCarries('tcp', 'av1'), true);
  assert.equal(protocolCarries('rtmp', 'hevc'), false);

  // URL: validated, key demanded but never embedded, Nagle off.
  assert.equal(
    targetUrl('tcp', { url: 'tcp://host.example:9711', key: 'k123456' }),
    'tcp://host.example:9711?tcp_nodelay=1',
  );
  // A bracketed IPv6 literal is a valid host too.
  assert.equal(targetUrl('tcp', { url: 'tcp://[fd00::7]:9711', key: 'k1' }),
    'tcp://[fd00::7]:9711?tcp_nodelay=1');
  assert.throws(() => targetUrl('tcp', { url: 'tcp://host.example', key: 'k' }),
    /host:port/);
  assert.throws(() => targetUrl('tcp', { url: 'tcp://h:1', key: '' }),
    /stream key/);
  assert.throws(() => targetUrl('tcp', { url: 'tcp://h:1', key: 'k 123456' }), /spaces/);

  // A modern codec KEEPS a tcp primary — no silent reroute to SRT.
  const pub = { ...publishDefaults(), protocol: 'tcp' };
  pub.tcp = { url: 'tcp://h:9711', key: 'k123456' };
  const dests = destinations(pub, 'hevc');
  assert.equal(dests[0].protocol, 'tcp');
});

test('tcp: one-token preamble, no passphrase anywhere, TLS shows in the redacted target', () => {
  assert.equal(TCP_PREAMBLE('k1'), 'SGR-TS/1 k1\n');
  // The passphrase is retired (TLS replaced it): not a default, not a
  // secret field, not masked — a stray one on a patch is just ignored.
  assert.equal('passphrase' in publishDefaults().tcp, false);
  const masked = redactPublish({ ...publishDefaults(), tcp: { url: 'tcp://h:1', key: 'k', passphrase: 'x' } });
  assert.equal(masked.tcp.key, '__SET__');
  assert.equal(masked.tcp.passphrase, 'x', 'not a secret any more, so not masked');

  assert.equal(redactUrl('tcp', { url: 'tcp://h:9711', key: 'k' }),
    'tcp://h:9711 (key=********, via local bridge)');
  assert.equal(redactUrl('tcp', { url: 'tcp://h:9711', key: 'k', tls: { enabled: true } }),
    'tcp://h:9711 (TLS) (key=********, via local bridge)');

  // Host parsing: names, v4 and bracketed v6 literals.
  assert.deepEqual(parseTcpTarget('tcp://host.example:9711'), { host: 'host.example', port: 9711 });
  assert.deepEqual(parseTcpTarget('tcp://[::1]:9711'), { host: '::1', port: 9711 });
  assert.equal(parseTcpTarget('tcp://host.example'), null);
  assert.equal(parseTcpTarget('tcp://a:b:9711'), null);

  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH']) {
    assert.equal(isCertError({ code }), true, code);
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPROTO', 'ETIMEDOUT', undefined]) {
    assert.equal(isCertError({ code }), false, String(code));
  }
  assert.equal(describeCert({ subject: { CN: 'r.test' }, valid_to: 'Jan 1 00:00:00 2030 GMT' }),
    'CN=r.test, valid until Jan 1 00:00:00 2030 GMT');
  assert.equal(describeCert({ subject: {}, subjectaltname: 'DNS:a.test, IP Address:1.2.3.4', valid_to: 'x' }),
    'DNS:a.test, valid until x');
});

// ── helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/** A "publisher": connect to the bridge, push bytes, resolve when closed. */
function publisher(port, payload = 'AAAA-payload-BBBB') {
  const pub = connect({ host: '127.0.0.1', port });
  const closed = new Promise((r) => pub.on('close', r));
  pub.on('error', () => {});
  pub.on('connect', () => pub.write(Buffer.from(payload)));
  return { pub, closed };
}

test('tcp bridge authenticates then splices; remote death fails the local side', async () => {
  // A fake receiver that records everything it is sent.
  const got = [];
  let remoteSock;
  const receiver = createServer((s) => { remoteSock = s; s.on('data', (d) => got.push(d)); });
  const rport = await listen(receiver);

  const bridge = new TcpBridge(() => ({ url: `tcp://127.0.0.1:${rport}`, key: 'sekrit99' }));
  const lport = await bridge.listen();

  const { pub, closed } = publisher(lport);
  await sleep(150);

  const all = Buffer.concat(got).toString();
  assert.ok(all.startsWith(TCP_PREAMBLE('sekrit99')),
    `preamble first, got: ${JSON.stringify(all.slice(0, 40))}`);
  assert.ok(all.endsWith('AAAA-payload-BBBB'), 'payload follows the preamble');

  // Remote hangs up -> the local side must die so publisher supervision
  // notices; a silently-black-holed destination would be worse than a dead one.
  remoteSock.destroy();
  await closed;
  pub.destroy();

  bridge.close();
  receiver.close();
});

test('tcp bridge, TLS off, receiver that requires TLS: the rejection names TLS', async () => {
  // A TLS-requiring receiver peeks the first byte, sees the plain
  // preamble, and closes right after it.
  const receiver = createServer((s) => { s.once('data', () => s.destroy()); });
  const rport = await listen(receiver);
  const logs = [];
  const bridge = new TcpBridge(() => ({ url: `tcp://127.0.0.1:${rport}`, key: 'k1' }), (m) => logs.push(m));
  const lport = await bridge.listen();
  const { pub, closed } = publisher(lport);
  await closed;
  pub.destroy();
  const line = logs.find((l) => l.includes('closed right after the preamble'));
  assert.ok(line, `expected a rejection line, got ${JSON.stringify(logs)}`);
  assert.match(line, /wrong stream key, the receiver requires TLS \(turn it on under Settings › Streamingestarr\), or a broadcast is already running there/);
  bridge.close();
  receiver.close();
});

// ── TLS ──────────────────────────────────────────────────────────────────

const haveOpenssl = spawnSync('openssl', ['version']).status === 0;
const skipTls = haveOpenssl ? false : 'openssl is not on PATH — TLS bridge tests skipped';

/**
 * A throwaway PKI, made with the openssl CLI: one CA and any number of
 * server certificates it signs, each with the SANs asked for. EC keys,
 * because RSA key generation is the slow part of a test run.
 */
function makePki(dir) {
  const run = (args) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  };
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Streamerr test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign']);
  let serial = 1;
  const issue = (name, cn, san) => {
    run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
    run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', String(serial += 1), '-days', '2', '-out', `${name}.pem`,
      '-extfile', `${name}.ext`]);
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  const selfSigned = (name, cn, san) => {
    run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=${cn}`,
      '-addext', `subjectAltName=${san}`]);
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) };
  };
  return { caFile: join(dir, 'ca.pem'), issue, selfSigned };
}

/** A TLS receiver: records bytes and the SNI it saw; swallows client aborts. */
function tlsReceiver({ key, cert }) {
  const got = [];
  const seen = { servername: [], connections: 0 };
  const socks = new Set();
  const server = createTlsServer({ key, cert, minVersion: 'TLSv1.2' }, (s) => {
    seen.connections += 1;
    seen.servername.push(s.servername || null);
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.on('error', () => {});
    s.on('data', (d) => got.push(d));
  });
  server.on('tlsClientError', () => {});
  // close() alone waits for live connections; a failed assertion must not
  // leave the runner hanging on one.
  const close = () => { for (const s of socks) s.destroy(); server.close(); };
  return { server, got, seen, close, text: () => Buffer.concat(got).toString() };
}

test('TLS bridge: CA file trusted, preamble over TLS, cert described once, CA file re-read per dial', { skip: skipTls }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamerr-tls-'));
  const cleanup = [];
  try {
    const pki = makePki(dir);
    const rx = tlsReceiver(pki.issue('srv', 'receiver.test', 'DNS:localhost,IP:127.0.0.1'));
    const rport = await listen(rx.server);
    const logs = [];
    const creds = { url: `tcp://localhost:${rport}`, key: 'sekrit99', tls: { enabled: true, caFile: pki.caFile } };
    const bridge = new TcpBridge(() => creds, (m) => logs.push(m));
    const lport = await bridge.listen();
    cleanup.push(() => { bridge.close(); rx.close(); });

    let { pub } = publisher(lport);
    await waitFor(() => rx.text().endsWith('AAAA-payload-BBBB'), 3000, 'payload over TLS');
    assert.ok(rx.text().startsWith(TCP_PREAMBLE('sekrit99')), 'preamble first, over TLS');
    assert.deepEqual(rx.seen.servername, ['localhost'], 'SNI carries the name dialled');
    const first = logs.find((l) => l.includes('connected over TLS to localhost:'));
    assert.ok(first, `expected an over-TLS line, got ${JSON.stringify(logs)}`);
    assert.match(first, /preamble sent, splicing; receiver certificate CN=receiver\.test, valid until /);
    assert.equal(first.includes('BEGIN'), false, 'no key material in the log');
    pub.destroy();

    // Reconnect (supervision restarts the publisher): a fresh dial, a fresh
    // TLS session, and the certificate is NOT described again.
    await sleep(50);
    ({ pub } = publisher(lport, 'second'));
    await waitFor(() => rx.seen.connections === 2, 3000, 'second TLS connection');
    await waitFor(() => rx.text().endsWith('second'), 3000, 'second payload');
    const overTls = logs.filter((l) => l.includes('connected over TLS'));
    assert.equal(overTls.length, 2);
    assert.equal(overTls[1].includes('receiver certificate'), false, 'described once per session');
    pub.destroy();

    // The CA file changes underfoot: an unrelated CA in the same path is
    // read on the NEXT dial and the receiver is no longer trusted...
    const otherDir = mkdtempSync(join(tmpdir(), 'streamerr-tls-other-'));
    cleanup.push(() => rmSync(otherDir, { recursive: true, force: true }));
    const other = makePki(otherDir);
    const original = readFileSync(pki.caFile);
    writeFileSync(pki.caFile, readFileSync(other.caFile));
    await sleep(50);
    let closed;
    ({ pub, closed } = publisher(lport, 'third'));
    await closed;
    assert.ok(logs.some((l) => /certificate was rejected/.test(l)), `expected rejection, got ${JSON.stringify(logs.slice(-2))}`);
    assert.equal(rx.text().includes('third'), false, 'nothing sent after a rejected certificate');
    // ...and putting it back trusts it again, no restart.
    writeFileSync(pki.caFile, original);
    ({ pub } = publisher(lport, 'fourth'));
    await waitFor(() => rx.text().endsWith('fourth'), 3000, 'payload after the CA file was restored');
    pub.destroy();
  } finally {
    for (const f of cleanup) f();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TLS bridge: self-signed receiver with no CA file is rejected cleanly and the bridge keeps serving', { skip: skipTls }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamerr-tls-'));
  const cleanup = [];
  try {
    const pki = makePki(dir);
    const self = pki.selfSigned('self', 'receiver.test', 'DNS:localhost,IP:127.0.0.1');
    const rx = tlsReceiver(self);
    const rport = await listen(rx.server);
    const logs = [];
    const creds = { url: `tcp://127.0.0.1:${rport}`, key: 'k1', tls: { enabled: true, caFile: '' } };
    const bridge = new TcpBridge(() => creds, (m) => logs.push(m));
    const lport = await bridge.listen();
    cleanup.push(() => { bridge.close(); rx.close(); });

    const first = publisher(lport);
    await first.closed;
    const line = logs.find((l) => l.includes('certificate was rejected'));
    assert.ok(line, `expected a rejection, got ${JSON.stringify(logs)}`);
    assert.match(line, /rejected \(.*self[- ]signed.*\) — connect by the name on its certificate, or set a trusted CA under Settings › Streamingestarr/i);
    assert.equal(logs.filter((l) => /tcp-bridge/.test(l)).length, 1, 'one verdict per dial, not an error and a close');
    assert.equal(rx.got.length, 0, 'no bytes reach an unverified receiver');

    // Next attempt: the operator trusts the self-signed cert itself as the
    // CA file — the bridge is still up and the new setting applies.
    const trust = join(dir, 'trust.pem');
    writeFileSync(trust, self.cert);
    creds.tls = { enabled: true, caFile: trust };
    const second = publisher(lport, 'after-trust');
    await waitFor(() => rx.text().endsWith('after-trust'), 3000, 'payload once trusted');
    assert.ok(rx.text().startsWith(TCP_PREAMBLE('k1')));
    assert.deepEqual(rx.seen.servername, [null], 'an IP literal sends no SNI');
    second.pub.destroy();
  } finally {
    for (const f of cleanup) f();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TLS bridge: a plain receiver does not speak TLS — said so', { skip: skipTls }, async () => {
  // A plain receiver reads the ClientHello as a garbage preamble and hangs up.
  let bytes = 0;
  const receiver = createServer((s) => { s.once('data', (d) => { bytes += d.length; s.destroy(); }); });
  const rport = await listen(receiver);
  const logs = [];
  const bridge = new TcpBridge(() => ({ url: `tcp://127.0.0.1:${rport}`, key: 'k1', tls: { enabled: true, caFile: '' } }),
    (m) => logs.push(m));
  const lport = await bridge.listen();
  const { closed } = publisher(lport);
  await closed;
  const line = logs.find((l) => l.includes('does not speak TLS'));
  assert.ok(line, `expected a not-TLS verdict, got ${JSON.stringify(logs)}`);
  assert.match(line, /turn off TLS under Settings › Streamingestarr, or turn it on at the receiver/);
  assert.ok(bytes > 0, 'the receiver saw a ClientHello, never a preamble');
  assert.equal(logs.filter((l) => /tcp-bridge/.test(l)).length, 1, 'one verdict per dial');
  bridge.close();
  receiver.close();
});

test('TLS bridge: unreadable CA file fails the dial naming the path', { skip: skipTls }, async () => {
  const missing = join(tmpdir(), `streamerr-no-such-ca-${process.pid}.pem`);
  const logs = [];
  let dialled = false;
  const receiver = createServer(() => { dialled = true; });
  const rport = await listen(receiver);
  const bridge = new TcpBridge(() => ({ url: `tcp://127.0.0.1:${rport}`, key: 'k1', tls: { enabled: true, caFile: missing } }),
    (m) => logs.push(m));
  const lport = await bridge.listen();
  const { closed } = publisher(lport);
  await closed;
  const line = logs.find((l) => l.includes('cannot read the trusted certificate file'));
  assert.ok(line, `expected a CA-file error, got ${JSON.stringify(logs)}`);
  assert.ok(line.includes(missing), 'names the path');
  assert.match(line, /ENOENT/);
  await sleep(50);
  assert.equal(dialled, false, 'nothing is dialled without the CA it was told to use');
  bridge.close();
  receiver.close();
});

test('TLS bridge: hostname mismatch is rejected with the altname reason', { skip: skipTls }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamerr-tls-'));
  try {
    const pki = makePki(dir);
    // Issued for a name we do not dial: neither localhost nor 127.0.0.1 is
    // in the SAN, so the (trusted!) chain still fails identity.
    const rx = tlsReceiver(pki.issue('other', 'receiver.test', 'DNS:receiver.test'));
    const rport = await listen(rx.server);
    const logs = [];
    const bridge = new TcpBridge(() => ({ url: `tcp://127.0.0.1:${rport}`, key: 'k1', tls: { enabled: true, caFile: pki.caFile } }),
      (m) => logs.push(m));
    const lport = await bridge.listen();
    try {
      const { closed } = publisher(lport);
      await closed;
      const line = logs.find((l) => l.includes('certificate was rejected'));
      assert.ok(line, `expected a rejection, got ${JSON.stringify(logs)}`);
      assert.match(line, /rejected \(.*127\.0\.0\.1.*\)/, 'the altname reason names what was dialled');
      assert.match(line, /connect by the name on its certificate/);
      assert.equal(rx.got.length, 0);
    } finally {
      bridge.close();
      rx.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
