import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'net';
import { connect } from 'net';
import {
  muxerFor, protocolCarries, targetUrl, destinations, publishDefaults,
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

test('tcp bridge authenticates then splices; remote death fails the local side', async () => {
  // A fake receiver that records everything it is sent.
  const got = [];
  let remoteSock;
  const receiver = createServer((s) => { remoteSock = s; s.on('data', (d) => got.push(d)); });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const rport = receiver.address().port;

  const bridge = new TcpBridge(() => (
    { url: `tcp://127.0.0.1:${rport}`, key: 'sekrit99' }
  ));
  const lport = await bridge.listen();

  // "Publisher": connect to the bridge, send payload bytes.
  const pub = connect({ host: '127.0.0.1', port: lport });
  await new Promise((r) => pub.on('connect', r));
  pub.write(Buffer.from('AAAA-payload-BBBB'));
  await new Promise((r) => setTimeout(r, 150));

  const all = Buffer.concat(got).toString();
  assert.ok(all.startsWith(TCP_PREAMBLE('sekrit99')),
    `preamble first, got: ${JSON.stringify(all.slice(0, 30))}`);
  assert.ok(all.endsWith('AAAA-payload-BBBB'), 'payload follows the preamble');

  // Remote hangs up -> the local side must die so publisher supervision
  // notices; a silently-black-holed destination would be worse than a dead one.
  const localClosed = new Promise((r) => pub.on('close', r));
  remoteSock.destroy();
  await localClosed;

  bridge.close();
  receiver.close();
});
