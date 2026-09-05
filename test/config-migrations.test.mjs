/**
 * Stored-config migrations in config.js: the pre-destinations RTMP target
 * (`owncast.rtmpUrl/streamKey`) folds into `publish.rtmp` and the block
 * leaves the file on the next save; dead keys (`encoder.extractSubtitles`,
 * `normalizer`) load without complaint and are dropped.
 *
 * config.js reads its file at import, so the fixture is written first and
 * the module imported dynamically after STREAMERR_CONFIG points at it.
 *
 * Run: node --test test/config-migrations.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'streamerr-config-'));
const file = join(dir, 'config.json');
writeFileSync(file, JSON.stringify({
  owncast: {
    rtmpUrl: 'rtmp://legacy.example:1935/live',
    streamKey: 'legacy-key-123',
    apiUrl: 'https://legacy.example',
    accessToken: 'tok',
    syncTitle: true,
  },
  publish: {
    protocol: 'rtmp', rtmp: { url: '', key: '' },
    // A retired TCP passphrase, stored by an older build, and an SRT one
    // that must survive — only the tcp field is dead.
    tcp: { url: 'tcp://h:9711', key: 'k123456', passphrase: 'old-tcp-pass' },
    srt: { url: 'srt://h:9000', streamId: '', passphrase: 'srt-pass-keep', latencyMs: 200 },
    extras: [
      { id: 'x1', enabled: true, protocol: 'tcp', url: 'tcp://h2:9711', key: 'k2', passphrase: 'old-x-pass' },
      { id: 'x2', enabled: true, protocol: 'srt', url: 'srt://h3:1', streamId: 's', passphrase: 'srt-x-keep' },
    ],
  },
  streamingestarr: { tcpTls: { enabled: 'true', caFile: '  /tmp/ca.pem ', extra: 1 } },
  encoder: { width: 1280, height: 720, extractSubtitles: false },
  normalizer: { lookahead: 2, cacheLimitGB: 50 },
  someUnknownBlock: { keep: 'me' },
}, null, 2));
process.env.STREAMERR_CONFIG = file;

const {
  config, saveConfig, normalizeStoredPublish, normalizeStoredEncoder,
  normalizeStoredLeftovers, publishConfig, redact, sanitizeTcpTls, tcpTlsConfig,
  publishDestinations, publishTargetsRedacted,
} = await import('../src/config.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a stored config with dead keys loads without complaint; unknown blocks are kept', () => {
  assert.equal(config.encoder.width, 1280);
  assert.equal(config.encoder.extractSubtitles, false, 'merge keeps what the file holds');
  assert.deepEqual(config.normalizer, { lookahead: 2, cacheLimitGB: 50 });
  assert.deepEqual(config.someUnknownBlock, { keep: 'me' });
  assert.equal('owncast' in config, true, 'nothing is touched before the migration runs');
});

test('legacy owncast.rtmpUrl/streamKey move into publish.rtmp when that slot is empty', () => {
  const note = normalizeStoredPublish();
  assert.match(note, /publish\.rtmp/);
  // The retired TCP passphrase leaves with the same pass — primary slot and
  // tcp extras — while SRT's passphrase (it encrypts the link) stays put.
  assert.match(note, /TCP passphrase/);
  assert.equal('passphrase' in config.publish.tcp, false);
  assert.equal('passphrase' in config.publish.extras[0], false);
  assert.equal(config.publish.srt.passphrase, 'srt-pass-keep');
  assert.equal(config.publish.extras[1].passphrase, 'srt-x-keep');
  assert.equal(config.publish.protocol, 'rtmp');
  assert.deepEqual(config.publish.rtmp, { url: 'rtmp://legacy.example:1935/live', key: 'legacy-key-123', codec: 'h264' });
  assert.equal('owncast' in config, false, 'the legacy block is gone from the live config');
  assert.equal(publishConfig().rtmp.key, 'legacy-key-123');
  // The moved key is still masked wherever ffmpeg output is quoted.
  assert.equal(redact('rtmp://legacy.example:1935/live/legacy-key-123 refused').includes('legacy-key-123'), false);
  // Idempotent: a second run has nothing to do.
  assert.equal(normalizeStoredPublish(), null);
});

test('the next save writes the file without the owncast block', () => {
  saveConfig({ publish: config.publish });
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal('owncast' in stored, false);
  assert.equal(stored.publish.rtmp.url, 'rtmp://legacy.example:1935/live');
  assert.equal(stored.publish.rtmp.key, 'legacy-key-123');
  assert.deepEqual(stored.someUnknownBlock, { keep: 'me' }, 'unknown keys survive a save untouched');
});

test('a filled publish.rtmp slot wins over the legacy block', () => {
  config.owncast = { rtmpUrl: 'rtmp://old/live', streamKey: 'old' };
  const note = normalizeStoredPublish();
  assert.match(note, /dropped/);
  assert.equal(config.publish.rtmp.url, 'rtmp://legacy.example:1935/live');
  assert.equal(config.publish.rtmp.key, 'legacy-key-123');
  assert.equal('owncast' in config, false);
});

test('dead encoder/normalizer keys are dropped and stay dropped after a save', () => {
  const fixed = normalizeStoredEncoder();
  assert.ok(fixed.some((f) => f.startsWith('extractSubtitles=false')), fixed);
  assert.equal('extractSubtitles' in config.encoder, false);
  assert.equal(config.encoder.width, 1280, 'valid values are untouched');
  assert.deepEqual(normalizeStoredLeftovers(), ['normalizer']);
  assert.equal('normalizer' in config, false);
  assert.equal(normalizeStoredLeftovers(), null);
  saveConfig({});
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal('normalizer' in stored, false);
  assert.equal('extractSubtitles' in stored.encoder, false);
});

test('streamingestarr.tcpTls: defaulted, sanitized on read and on save, carried onto every tcp destination', () => {
  // Stored as loose values: coerced, trimmed, unknown keys kept.
  assert.deepEqual(tcpTlsConfig(), { enabled: true, caFile: '/tmp/ca.pem', extra: 1 });
  assert.deepEqual(sanitizeTcpTls(undefined), { enabled: false, caFile: '' });
  assert.deepEqual(sanitizeTcpTls({ enabled: 'yes', caFile: 42 }), { enabled: false, caFile: '42' });
  // Every tcp destination gets the one switch (here the tcp extra; the
  // primary is rtmp), srt never does; the redacted line says (TLS).
  const dests = publishDestinations(config, 'h264');
  const tcp = dests.filter((d) => d.protocol === 'tcp');
  assert.equal(tcp.length, 1);
  assert.deepEqual(tcp[0].creds.tls, { enabled: true, caFile: '/tmp/ca.pem' });
  assert.equal(dests.find((d) => d.protocol === 'srt').creds.tls, undefined);
  assert.equal(config.publish.extras[0].tls, undefined, 'the stored block is not mutated');
  assert.match(publishTargetsRedacted().find((l) => l.startsWith('tcp:')), /tcp:\/\/h2:9711 \(TLS\) \(key=\*+/);
  // Save path: a UI patch with a string/number pair comes out typed.
  saveConfig({ streamingestarr: { tcpTls: { enabled: false, caFile: ' ' } } });
  assert.deepEqual(tcpTlsConfig(), { enabled: false, caFile: '', extra: 1 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).streamingestarr.tcpTls.enabled, false);
  assert.doesNotMatch(publishTargetsRedacted().find((l) => l.startsWith('tcp:')), /TLS/);
  // Defaults for a config that never mentions it.
  assert.deepEqual(sanitizeTcpTls({}), { enabled: false, caFile: '' });
});

test('the codec is bound to every destination slot at load, seeded from the old broadcast codec', async () => {
  const { config, normalizeStoredPublish } = await import('../src/config.js');
  config.encoder.codec = 'hevc';
  config.publish = { protocol: 'srt', srt: { url: 'srt://x:1' }, rtmp: { url: 'rtmp://y/live', key: 'k' },
    extras: [{ id: 'e1', enabled: true, protocol: 'tcp', url: 'tcp://z:2', key: 'k' }, { id: 'e2', enabled: false, protocol: 'rtmp', url: 'rtmp://w/live', key: 'k' }] };
  const note = normalizeStoredPublish();
  assert.match(String(note), /a codec \(HEVC where/);
  assert.equal(config.publish.srt.codec, 'hevc', 'SRT keeps the HEVC it was streaming');
  assert.equal(config.publish.rtmp.codec, 'h264', 'RTMP can only take H.264');
  assert.equal(config.publish.extras[0].codec, 'hevc');
  assert.equal(config.publish.extras[1].codec, 'h264');
  assert.equal(config.encoder.codec, 'hevc', 'the derived codec is what the destinations that are on agree to');
});
