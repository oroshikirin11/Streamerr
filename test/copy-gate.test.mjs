/**
 * Copying a clip is only viable when the file's keyframes are frequent
 * enough to deliver live.
 *
 * Live packagers start segments on keyframes, so a copied stream's
 * segment length IS the file's keyframe interval — measured against a
 * real receiver, a 3.5s-keyframe source produced 3.5s segments even with
 * the segment target set to 1s. Viewers sit several segments behind
 * live, so a sparse-keyframe file cannot be delivered smoothly however
 * the ingest is configured. This is the bar that sends those to the
 * encoder instead, and it must never fire on a file we could not measure.
 *
 * Run: node test/copy-gate.test.mjs
 */
import { copyKeyframesFitLive } from '../src/ffmpeg/pipeline.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

console.log('\ncopy eligibility by keyframe interval');

check('a 1s keyframe interval copies', copyKeyframesFitLive({ srcGopSeconds: 1 }), true);
check('2s — the common WEB-DL case — copies', copyKeyframesFitLive({ srcGopSeconds: 2 }), true);
check('4s sits exactly on the bar and copies', copyKeyframesFitLive({ srcGopSeconds: 4 }), true);
check('4.5s is too sparse to copy', copyKeyframesFitLive({ srcGopSeconds: 4.5 }), false);
check('10s is far too sparse', copyKeyframesFitLive({ srcGopSeconds: 10 }), false);

check('an unmeasured file is never refused on a guess',
  copyKeyframesFitLive({ srcGopSeconds: null }), true);
check('...nor one whose probe returned nonsense',
  copyKeyframesFitLive({ srcGopSeconds: 0 }), true);
check('...nor a profile that has no such field at all',
  copyKeyframesFitLive({}), true);

check('the operator can raise the bar',
  copyKeyframesFitLive({ srcGopSeconds: 8, copyMaxGopSeconds: 10 }), true);
check('...and lower it',
  copyKeyframesFitLive({ srcGopSeconds: 3, copyMaxGopSeconds: 2 }), false);
check('a nonsense setting falls back to the default bar',
  copyKeyframesFitLive({ srcGopSeconds: 10, copyMaxGopSeconds: 0 }), false);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
