import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'net';
import { connect } from 'net';
import {
  muxerFor, protocolCarries, targetUrl, destinations, publishDefaults,
  redactPublish, restorePublishSecrets,
} from '../src/publish.js';
import { TcpBridge, TCP_PREAMBLE } from '../src/ffmpeg/tcp-bridge.js';

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
  assert.throws(() => targetUrl('tcp', { url: 'tcp://host.example', key: 'k' }),
    /host:port/);
  assert.throws(() => targetUrl('tcp', { url: 'tcp://h:1', key: '' }),
    /stream key/);

  // A modern codec KEEPS a tcp primary — no silent reroute to SRT.
  const pub = { ...publishDefaults(), protocol: 'tcp' };
  pub.tcp = { url: 'tcp://h:9711', key: 'k123456' };
  const dests = destinations(pub, 'hevc');
  assert.equal(dests[0].protocol, 'tcp');
});

test('tcp passphrase: preamble form, validation, creds plumbing, masking', () => {
  // Two-token line only when a passphrase exists; single-token otherwise.
  assert.equal(TCP_PREAMBLE('k1'), 'SGR-TS/1 k1\n');
  assert.equal(TCP_PREAMBLE('k1', 'pass-123456'), 'SGR-TS/1 k1 pass-123456\n');

  // It rides a space-delimited line: spaces and newlines are refused.
  assert.throws(() => targetUrl('tcp',
    { url: 'tcp://h:1', key: 'k123456', passphrase: 'has space here' }), /spaces/);
  assert.throws(() => targetUrl('tcp',
    { url: 'tcp://h:1', key: 'k 123456' }), /spaces/);

  // The destination creds the bridge will read must CARRY the passphrase —
  // primary and extras both.
  const pub = { ...publishDefaults(), protocol: 'tcp' };
  pub.tcp = { url: 'tcp://h:9711', key: 'k123456', passphrase: 'pp-1234567' };
  pub.extras = [{ id: 'x1', enabled: true, protocol: 'tcp',
    url: 'tcp://h2:9711', key: 'k2', passphrase: 'pp-2234567' }];
  const dests = destinations(pub, 'hevc');
  assert.equal(dests[0].creds.passphrase, 'pp-1234567');
  assert.equal(dests[1].creds.passphrase, 'pp-2234567');

  // Round trip: masked on the way out, restored from the sentinel on the
  // way back — a saved passphrase must survive an unrelated settings save.
  const masked = redactPublish(pub);
  assert.equal(masked.tcp.key, '__SET__');
  assert.equal(masked.tcp.passphrase, '__SET__');
  assert.equal(masked.extras[0].passphrase, '__SET__');
  const restored = restorePublishSecrets(
    JSON.parse(JSON.stringify(masked)), pub);
  assert.equal(restored.tcp.passphrase, 'pp-1234567');
  assert.equal(restored.extras[0].passphrase, 'pp-2234567');
});

test('tcp bridge authenticates then splices; remote death fails the local side', async () => {
  // A fake receiver that records everything it is sent.
  const got = [];
  let remoteSock;
  const receiver = createServer((s) => { remoteSock = s; s.on('data', (d) => got.push(d)); });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const rport = receiver.address().port;

  const bridge = new TcpBridge(() => (
    { url: `tcp://127.0.0.1:${rport}`, key: 'sekrit99', passphrase: 'pp-abcdef1' }
  ));
  const lport = await bridge.listen();

  // "Publisher": connect to the bridge, send payload bytes.
  const pub = connect({ host: '127.0.0.1', port: lport });
  await new Promise((r) => pub.on('connect', r));
  pub.write(Buffer.from('AAAA-payload-BBBB'));
  await new Promise((r) => setTimeout(r, 150));

  const all = Buffer.concat(got).toString();
  assert.ok(all.startsWith(TCP_PREAMBLE('sekrit99', 'pp-abcdef1')),
    `preamble first, got: ${JSON.stringify(all.slice(0, 40))}`);
  assert.ok(all.endsWith('AAAA-payload-BBBB'), 'payload follows the preamble');

  // Remote hangs up -> the local side must die so publisher supervision
  // notices; a silently-black-holed destination would be worse than a dead one.
  const localClosed = new Promise((r) => pub.on('close', r));
  remoteSock.destroy();
  await localClosed;

  bridge.close();
  receiver.close();
});
