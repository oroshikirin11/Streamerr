/**
 * The stale-catalogue resolver, pinned.
 *
 * Sonarr quality-upgrades files; Jellyfin reports the deleted names until
 * its next scan. A unique same-episode (SxxEyy) file in the same directory
 * is the same media in better clothes; a movie directory with exactly one
 * video file is equally unambiguous. Anything ambiguous still refuses.
 *
 * Run: node test/stale-path.test.mjs
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FilesystemLibrary } from '../src/library/index.js';

const lib = new FilesystemLibrary({ roots: [] });
let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
};

const d1 = mkdtempSync(join(tmpdir(), 'bzk-'));
writeFileSync(join(d1, 'Berserk - S01E01 - The Black Swordsman Bluray-1080p.mkv'), 'x');
writeFileSync(join(d1, 'Berserk - S01E02 - Band of the Hawk Bluray-1080p.mkv'), 'x');
const got = lib.resolveMapped(join(d1, 'Berserk - S01E01 - The Black Swordsman HDTV-1080p.mkv'));
check('episode upgrade resolves to the new file',
  got.endsWith('S01E01 - The Black Swordsman Bluray-1080p.mkv'));
check('existing file passes through untouched', lib.resolveMapped(got) === got);

const d2 = mkdtempSync(join(tmpdir(), 'mov-'));
writeFileSync(join(d2, 'Apocalypto 2006 2160p Remux.mkv'), 'x');
check('movie single-file fallback',
  lib.resolveMapped(join(d2, 'Apocalypto 2006 1080p WEB.mkv')).endsWith('Remux.mkv'));

const d3 = mkdtempSync(join(tmpdir(), 'amb-'));
writeFileSync(join(d3, 'A - S01E01 v1.mkv'), 'x');
writeFileSync(join(d3, 'A - S01E01 v2.mkv'), 'x');
let threw = false;
try { lib.resolveMapped(join(d3, 'A - S01E01 v3.mkv')); } catch { threw = true; }
check('two candidates -> still refuses', threw);

let threw2 = false;
try { lib.resolveMapped(join(d1, 'Berserk - S01E09 - Missing.mkv')); } catch { threw2 = true; }
check('no candidate -> refuses', threw2);

// The proper route: substitution notifies, the paired catalogue rescans.
{
  const { PairedLibrary } = await import('../src/library/paired.js');
  let rescans = 0;
  const catalogue = { requestRescan: () => { rescans += 1; }, configured: true };
  const paired = new PairedLibrary(catalogue, lib, []);
  void paired;
  lib.resolveMapped(join(d1, 'Berserk - S01E02 - Band of the Hawk HDTV-1080p.mkv'));
  check('stale substitution asks the catalogue to rescan', rescans === 1);
  lib.resolveMapped(got);
  check('a healthy open does not', rescans === 1);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
