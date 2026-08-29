/**
 * Tests for the catalogue/media matcher.
 *
 * This decides which file on disk a catalogue entry plays, so a wrong answer
 * does not throw — it broadcasts the wrong episode. The cases below are
 * mostly about NOT matching: ambiguity, near-misses and hostile input matter
 * more than the happy path.
 *
 * Run: node test/match.test.mjs
 */
import { deriveMapping, describeMatch } from '../src/library/match.js';

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
}
const sum = (r) => ({ rules: r.rules, matched: r.matched, total: r.total });

const jf = [
  '/extHdd/media/tv/Berserk/Season 1/Berserk - S01E01.mkv',
  '/extHdd/media/tv/Berserk/Season 1/Berserk - S01E02.mkv',
  '/extHdd/media/tv/NGE/Season 1/NGE - S01E01.mkv',
];
const mine = jf.map((p) => p.replace('/extHdd/media', '/mnt/media'));

console.log('\nthe ordinary cases');
check('one prefix difference', sum(deriveMapping(jf, mine)),
  { rules: [{ from: '/extHdd', to: '/mnt' }], matched: 3, total: 3 });
check('paths already agree', sum(deriveMapping(jf, jf)),
  { rules: [], matched: 3, total: 3 });
check('some files missing locally', sum(deriveMapping(jf, mine.slice(0, 2))),
  { rules: [{ from: '/extHdd', to: '/mnt' }], matched: 2, total: 3 });
check('a different library entirely', sum(deriveMapping(jf, ['/data/movies/Other.mkv'])),
  { rules: [], matched: 0, total: 3 });

console.log('\nsplit libraries');
check('two mounts, both found', sum(deriveMapping(jf,
  [mine[0], mine[1], '/media2/tv/NGE/Season 1/NGE - S01E01.mkv'])),
{ rules: [{ from: '/extHdd/media', to: '/media2' }, { from: '/extHdd', to: '/mnt' }],
  matched: 3, total: 3 });

console.log('\nambiguity — these must NOT guess');
const ambigRep = ['/a/tv/ShowA/Season 1/S01E01.mkv', '/a/tv/ShowB/Season 1/S01E01.mkv'];
const ambigLoc = ['/b/tv/ShowA/Season 1/S01E01.mkv', '/b/tv/ShowB/Season 1/S01E01.mkv'];
check('same filename in two shows resolves by depth', sum(deriveMapping(ambigRep, ambigLoc)),
  { rules: [{ from: '/a', to: '/b' }], matched: 2, total: 2 });
// Genuinely undecidable: identical tails, two equally good homes.
check('a true tie casts no vote',
  deriveMapping(['/a/Season 1/S01E01.mkv'],
    ['/x/Season 1/S01E01.mkv', '/y/Season 1/S01E01.mkv']).rules, []);
check('filename-only agreement is not enough',
  deriveMapping(['/a/tv/Show/Season 1/ep.mkv'], ['/totally/elsewhere/ep.mkv']).rules, []);

console.log('\nhostile and degenerate input');
check('empty both', sum(deriveMapping([], [])), { rules: [], matched: 0, total: 0 });
check('empty catalogue', sum(deriveMapping([], mine)), { rules: [], matched: 0, total: 0 });
check('empty media', sum(deriveMapping(jf, [])), { rules: [], matched: 0, total: 3 });
check('undefined args', sum(deriveMapping()), { rules: [], matched: 0, total: 0 });
check('nulls and blanks are dropped',
  sum(deriveMapping([null, '', '   ', ...jf], [undefined, ...mine])),
  { rules: [{ from: '/extHdd', to: '/mnt' }], matched: 3, total: 3 });
check('non-strings are dropped', sum(deriveMapping([1, {}, true, ...jf], mine)),
  { rules: [{ from: '/extHdd', to: '/mnt' }], matched: 3, total: 3 });
check('duplicates collapse', sum(deriveMapping([...jf, ...jf], [...mine, ...mine])),
  { rules: [{ from: '/extHdd', to: '/mnt' }], matched: 3, total: 3 });
check('windows separators normalise',
  deriveMapping(['C:\\media\\tv\\Show\\Season 1\\ep.mkv'],
    ['/mnt/tv/Show/Season 1/ep.mkv']).matched, 1);
check('case differs in the tail',
  deriveMapping(['/a/tv/Show/Season 1/EP.MKV'], ['/b/tv/Show/Season 1/ep.mkv']).matched, 1);
check('duplicate slashes normalise',
  deriveMapping(['/a//tv/Show/Season 1/ep.mkv'], ['/b/tv/Show/Season 1/ep.mkv']).matched, 1);

console.log('\nsafety — a rule must never invent a path');
const res = deriveMapping(jf, mine);
for (const rule of res.rules) {
  check(`rule target exists in the media list (${rule.to})`,
    mine.some((m) => m.startsWith(rule.to)), true);
}
check('unmatched are reported, not hidden',
  deriveMapping(jf, mine.slice(0, 1)).unmatched.length, 2);
// A prefix rule must not escape upward into unrelated directories.
check('no rule maps outside the media it was derived from',
  deriveMapping(['/a/tv/Show/Season 1/ep.mkv'], ['/b/tv/Show/Season 1/ep.mkv']).rules,
  [{ from: '/a', to: '/b' }]);

console.log('\nscale');
const bigRep = [];
const bigLoc = [];
for (let s = 0; s < 60; s += 1) {
  for (let e = 1; e <= 24; e += 1) {
    bigRep.push(`/extHdd/media/tv/Show ${s}/Season 1/Show ${s} - S01E${String(e).padStart(2, '0')}.mkv`);
    bigLoc.push(`/mnt/media/tv/Show ${s}/Season 1/Show ${s} - S01E${String(e).padStart(2, '0')}.mkv`);
  }
}
const t0 = Date.now();
const big = deriveMapping(bigRep, bigLoc);
const ms = Date.now() - t0;
check(`1440 files match (${ms}ms)`, { rules: big.rules, matched: big.matched }, {
  rules: [{ from: '/extHdd', to: '/mnt' }], matched: 1440,
});
check('runs in well under a second', ms < 1000, true);

console.log('\nwording');
check('nothing to match', describeMatch({ total: 0 }), 'Nothing to match yet.');
check('no matches', describeMatch({ total: 5, matched: 0 }),
  'No files matched — this looks like a different library.');
check('agrees already', describeMatch({ total: 3, matched: 3, rules: [] }),
  'Matched 3 of 3 files. The paths already agree.');
check('describes the rule', describeMatch(deriveMapping(jf, mine)),
  'Matched 3 of 3 files. Jellyfin sees /extHdd, you have /mnt.');
check('survives a junk argument', typeof describeMatch(), 'string');

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
