/**
 * A spawn never points the subtitles filter at the media file: when an
 * extractable embedded text track is selected and the in-memory cache
 * has no extracted copy yet, the play path extracts first and spawns
 * after (a seek after a switch, a restart with the file on disk).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelinePlayout } from '../src/ffmpeg/pipeline.js';

function engine(subtitle, cached) {
  const e = Object.create(PipelinePlayout.prototype);
  e.cacheDir = '/tmp/cache'; e._subCache = new Map(); e.selection = { subtitle };
  e.current = { item: { srcPath: '/x/a.mkv' } };
  if (cached) e._subCache.set(`/x/a.mkv:${subtitle.typeIndex}`, cached);
  e.emit = () => {}; e._detached = (p) => p; e._extract = () => { e.extracted = true; return Promise.resolve(); };
  e._play = (item, offset) => { e.played = offset; };
  return e;
}

test('an embedded text track without an extracted copy defers the spawn and extracts', async () => {
  const e = engine({ codec: 'subrip', text: true, bitmap: false, external: false, typeIndex: 1 }, null);
  e._playGen = 1;
  assert.equal(e._deferForExtraction({ srcPath: '/x/a.mkv' }, 646, {}, 1), true);
  assert.equal(e.extracted, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(e.played, 646, 'the spawn is re-issued after the extraction');
});

test('with the copy in hand, or a bitmap or external track, the spawn goes ahead', () => {
  const srt = { codec: 'subrip', text: true, bitmap: false, external: false, typeIndex: 1 };
  assert.equal(engine(srt, { path: '/tmp/cache/a.srt' })._deferForExtraction({ srcPath: '/x/a.mkv' }, 1, {}, 1), false);
  assert.equal(engine({ codec: 'hdmv_pgs_subtitle', bitmap: true, external: false, typeIndex: 0 }, null)._deferForExtraction({ srcPath: '/x/a.mkv' }, 1, {}, 1), false);
  assert.equal(engine({ codec: 'subrip', text: true, external: true, path: '/x/a.srt', typeIndex: 0 }, null)._deferForExtraction({ srcPath: '/x/a.mkv' }, 1, {}, 1), false);
});

test('a later play supersedes the deferred one', async () => {
  const e = engine({ codec: 'subrip', text: true, bitmap: false, external: false, typeIndex: 1 }, null);
  e._playGen = 1;
  assert.equal(e._deferForExtraction({ srcPath: '/x/a.mkv' }, 646, {}, 1), true);
  e._playGen = 2; // a seek elsewhere landed meanwhile
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(e.played, undefined, 'the stale spawn is dropped');
});
