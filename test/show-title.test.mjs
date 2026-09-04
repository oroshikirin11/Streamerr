import test from 'node:test';
import assert from 'node:assert/strict';
import { showTitle, movieTitle } from '../src/library/filesystem.js';

test('release-group folder names read as titles; real titles are untouched', () => {
  assert.equal(showTitle('Life.in.Colour.with.David.S01.1080p.WEBRip.x265-MRCS[TGx]'), 'Life in Colour with David');
  assert.equal(showTitle('Some.Show.2019.S02.720p.HDTV.x264-GRP'), 'Some Show 2019');
  assert.equal(showTitle('Show.Name.S01E03.1080p.WEB-DL.H.264'), 'Show Name');
  assert.equal(showTitle('Mr. Robot'), 'Mr. Robot');
  assert.equal(showTitle('Neon Harbor'), 'Neon Harbor');
  assert.equal(showTitle('New Folder'), 'New Folder');
  assert.equal(showTitle('Anime.With.Dots'), 'Anime.With.Dots', 'dots alone are not a release name');
  assert.equal(movieTitle('TEST.Video.2019.1080p.BluRay.x264-OnTheSpot'), 'TEST Video 2019');
});
