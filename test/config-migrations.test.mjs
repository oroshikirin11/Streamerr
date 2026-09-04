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
  publish: { protocol: 'rtmp', rtmp: { url: '', key: '' } },
  encoder: { width: 1280, height: 720, extractSubtitles: false },
  normalizer: { lookahead: 2, cacheLimitGB: 50 },
  someUnknownBlock: { keep: 'me' },
}, null, 2));
process.env.STREAMERR_CONFIG = file;

const {
  config, saveConfig, normalizeStoredPublish, normalizeStoredEncoder,
  normalizeStoredLeftovers, publishConfig, redact,
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
  assert.equal(config.publish.protocol, 'rtmp');
  assert.deepEqual(config.publish.rtmp, { url: 'rtmp://legacy.example:1935/live', key: 'legacy-key-123' });
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
