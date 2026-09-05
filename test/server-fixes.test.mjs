/**
 * Server-side fixes from the schedule/server review that live outside the
 * schedule store: secret redaction across every publish destination, the
 * Room override in the redacted publish block, and lineup artwork for films.
 *
 * Run: node test/server-fixes.test.mjs (also pulled in by schedules.test.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { redactSecrets, publishSecrets, redactPublish, publishDefaults, destinations, codecOf, protocolCodecs, agreedCodec, applyCodecToPublish } from '../src/publish.js';
import { FilesystemLibrary } from '../src/library/filesystem.js';

const publish = {
  ...publishDefaults(),
  protocol: 'rtmp',
  channel: 'late-night',
  rtmp: { url: 'rtmp://h/live', key: 'SECRETKEY123' },
  rtmps: { url: 'rtmps://h2/app', key: 'tls-key-9' },
  srt: { url: 'srt://h3:9000', streamId: 'live/room#abc', passphrase: 'longpassphrase99', latencyMs: 200 },
  tcp: { url: 'tcp://h4:19741', key: 'tcpkey-777' },
  extras: [
    { id: 'e1', protocol: 'rtmp', url: 'rtmp://mirror/live', key: 'MIRRORKEY', enabled: true },
    { id: 'e2', protocol: 'srt', url: 'srt://x:1', streamId: 'sid-2', passphrase: 'extra-phrase-12', enabled: false },
  ],
};

test('redactSecrets masks every publish secret in ffmpeg output, not just the chosen protocol', () => {
  const stderr = '[flv @ 0x1] Cannot open connection tcp://h:1935\n'
    + 'rtmp://h/live/SECRETKEY123: Connection refused\n'
    + 'srt://h3:9000?mode=caller&streamid=live/room#abc&passphrase=longpassphrase99\n'
    + 'mirror rtmp://mirror/live/MIRRORKEY, tcp key tcpkey-777, disabled extra-phrase-12, tls-key-9';
  const out = redactSecrets(stderr, publish);
  for (const s of ['SECRETKEY123', 'longpassphrase99', 'live/room#abc', 'MIRRORKEY', 'tcpkey-777', 'extra-phrase-12', 'tls-key-9']) {
    assert.equal(out.includes(s), false, `${s} leaked`);
  }
  assert.match(out, /rtmp:\/\/h\/live\/\*{8}: Connection refused/);
  assert.match(out, /Cannot open connection tcp:\/\/h:1935/, 'non-secret text survives');
  // Legacy owncast key handed in as an extra, and a URL-encoded stream id.
  assert.equal(redactSecrets('key=OLDKEY99 sid=live%2Froom%23abc', publish, ['OLDKEY99']).includes('OLDKEY99'), false);
  assert.equal(redactSecrets('sid=live%2Froom%23abc', publish).includes('room'), false);
  // Empty / short / sentinel values never shred text.
  assert.equal(redactSecrets('abc __SET__ ok', { ...publishDefaults(), rtmp: { url: 'rtmp://h', key: 'ab' } }, ['__SET__']), 'abc __SET__ ok');
  assert.equal(redactSecrets('', publish), '');
  assert.equal(redactSecrets(null, publish), null);
  assert.deepEqual(publishSecrets(publishDefaults()), []);
});

test('redactPublish carries the Room override, with every secret masked', () => {
  const r = redactPublish(publish);
  assert.equal(r.channel, 'late-night');
  assert.equal(redactPublish(null).channel, '');
  assert.equal(r.rtmp.key, '__SET__');
  assert.equal(r.srt.passphrase, '__SET__');
  assert.equal(r.extras[0].key, '__SET__');
  assert.equal(JSON.stringify(r).includes('SECRETKEY123'), false);
});

test('a film in its own folder carries the poster the grid shows, by the same image id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'streamerr-art-'));
  try {
    mkdirSync(join(root, 'Solo Film (2019)'));
    writeFileSync(join(root, 'Solo Film (2019)', 'Solo Film (2019).mkv'), 'x');
    writeFileSync(join(root, 'Solo Film (2019)', 'poster.jpg'), 'x');
    mkdirSync(join(root, 'Bare Film (2020)'));
    writeFileSync(join(root, 'Bare Film (2020)', 'film.mkv'), 'x');
    mkdirSync(join(root, 'Show (2021)', 'Season 01'), { recursive: true });
    writeFileSync(join(root, 'Show (2021)', 'poster.jpg'), 'x');
    writeFileSync(join(root, 'Show (2021)', 'Season 01', 'Show S01E01.mkv'), 'x');

    const lib = new FilesystemLibrary({ roots: [root], stills: true });
    const [l] = await lib.libraries();
    const { items } = await lib.items(l.id);
    const grid = items.find((i) => i.title.startsWith('Solo Film'));
    assert.equal(grid.type, 'Movie');
    assert.match(grid.image, /^\/api\/library\/image\//);
    const item = await lib.item(grid.id);
    assert.equal(item.image, grid.image, 'the lineup gets the same artwork url as the grid');
    assert.equal(item.image.includes(grid.id), false, 'not a frame of the video itself');
    const imgId = /\/image\/([^?]+)/.exec(item.image)[1];
    assert.equal(await lib.resolveImage(imgId), join(root, 'Solo Film (2019)', 'poster.jpg'));
    // A lineup saved before the fix still asks for the film's own id: same poster.
    assert.equal(await lib.resolveImage(grid.id), join(root, 'Solo Film (2019)', 'poster.jpg'));

    // No poster: the old behaviour (a frame of the file, once the sweeper made one).
    const bare = await lib.item(items.find((i) => i.title.startsWith('Bare Film')).id);
    assert.equal(bare.image.includes(items.find((i) => i.title.startsWith('Bare Film')).id), true);

    // Episodes are untouched: no show poster, a frame of the episode.
    const eps = await lib.episodes(items.find((i) => i.type === 'Series').id);
    const ep = await lib.item(eps[0].id);
    assert.equal(ep.type, 'Episode');
    assert.equal(ep.image.includes(eps[0].id), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a switched-off primary hands the anchor role to the first enabled extra', () => {
  const pub = { ...publishDefaults(), protocol: 'tcp', enabled: false, tcp: { url: 'tcp://a:1', key: 'k', codec: 'hevc' },
    extras: [
      { id: 'x1', enabled: false, protocol: 'srt', url: 'srt://b:2', streamId: '', passphrase: '', latencyMs: 200, codec: 'hevc' },
      { id: 'x2', enabled: true, protocol: 'rtmp', url: 'rtmp://c/live', key: 'k2', name: 'Relay' },
      { id: 'x3', enabled: true, protocol: 'tcp', url: 'tcp://d:4', key: 'k3', codec: 'h264', name: 'Cinema' },
    ] };
  const d = destinations(pub);
  assert.deepEqual(d.map((x) => [x.id ?? 'primary', x.primary]), [['x2', true], ['x3', false]]);
  assert.equal(d.codec, 'h264', 'the destinations that are on agree on H.264');
  // Nothing on at all is refused with a sentence, not an empty tee.
  assert.throws(() => destinations({ ...pub, extras: [] }), /No destination is switched on/);
  // The primary back on with HEVC disagrees with the H.264 extras: refused by name.
  assert.throws(() => destinations({ ...pub, enabled: true }), /Primary is H\.265 but Relay is H\.264/);
  // Alone, the HEVC primary leads and the codec is its own.
  const p = destinations({ ...pub, enabled: true, extras: [] });
  assert.equal(p[0].primary, true); assert.equal(p[0].id, undefined); assert.equal(p.codec, 'hevc');
  // An RTMP slot carries H.264 whatever it says; SRT/TCP keep theirs.
  assert.equal(codecOf('rtmp', { codec: 'hevc' }), 'h264');
  assert.equal(codecOf('srt', { codec: 'av1' }), 'av1');
  assert.deepEqual(protocolCodecs('rtmps'), ['h264']);
  // agreedCodec never throws; applyCodecToPublish binds one codec to every destination that is on, or names the one that cannot.
  assert.deepEqual(agreedCodec({ ...pub, enabled: true }).codec, null);
  assert.match(agreedCodec({ ...pub, enabled: true }).conflict, /share one codec/);
  assert.throws(() => applyCodecToPublish(JSON.parse(JSON.stringify(pub)), 'hevc'), /Relay \(RTMP\) cannot carry H\.265/);
  const off = JSON.parse(JSON.stringify(pub)); off.extras[1].enabled = false;
  applyCodecToPublish(off, 'hevc');
  assert.equal(off.extras[2].codec, 'hevc');
  assert.equal(destinations(off).codec, 'hevc');
  assert.equal(redactPublish(pub).enabled, false);
});
