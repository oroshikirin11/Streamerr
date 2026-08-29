/**
 * PairedLibrary has to satisfy the whole library interface.
 *
 * It wraps a catalogue and a media provider and forwards nearly everything.
 * A method it forgets is not a graceful degradation: CompositeLibrary calls
 * it, gets undefined, and the route answers 400 with an empty library behind
 * it — which reads like a configuration problem and is not. That happened
 * with items(), so the requirement is asserted here rather than remembered.
 *
 * Run: node test/paired.test.mjs
 */
import { readFileSync } from 'fs';
import { PairedLibrary } from '../src/library/paired.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

console.log('\ninterface');
/**
 * Read the requirement from the composite itself rather than a hand-kept
 * list, so adding a call there fails here instead of in production.
 */
const composite = readFileSync(new URL('../src/library/composite.js', import.meta.url), 'utf8');
const required = [...new Set(
  [...composite.matchAll(/\.lib[?.]*\.([a-zA-Z]+)/g)].map((m) => m[1]),
)].sort();
console.log(`  composite calls: ${required.join(' ')}`);

const proto = PairedLibrary.prototype;
const has = (n) => n in proto || Boolean(Object.getOwnPropertyDescriptor(proto, n));
check('every method the composite calls is implemented',
  required.filter((n) => !has(n)), []);

console.log('\ndelegation');
const calls = [];
const catalogue = new Proxy({}, {
  get: (_, k) => (...a) => { calls.push(`catalogue.${String(k)}`); return a; },
});
const media = { configured: true, bridgeToken: 'tok-1', resolveMapped: (p) => `served:${p}` };
const lib = new PairedLibrary(catalogue, media, [{ from: '/cat', to: '/media' }]);

for (const m of ['libraries', 'items', 'seasons', 'episodes', 'item', 'nextEpisode', 'imagePath']) {
  lib[m]('x');
}
check('listing goes to the catalogue', calls, [
  'catalogue.libraries', 'catalogue.items', 'catalogue.seasons', 'catalogue.episodes',
  'catalogue.item', 'catalogue.nextEpisode', 'catalogue.imagePath',
]);

console.log('\nresolution');
check('reported path is mapped, then served by the media half',
  lib.resolvePath({ sourcePath: '/cat/tv/Show/ep.mkv' }), 'served:/media/tv/Show/ep.mkv');
check('an unmapped path still reaches the media half',
  lib.resolvePath({ sourcePath: '/elsewhere/ep.mkv' }), 'served:/elsewhere/ep.mkv');
try {
  lib.resolvePath({ title: 'no path' });
  check('a missing path throws', 'did not throw', 'throws');
} catch (err) {
  check('a missing path throws by name', /no path/.test(err.message), true);
}

console.log('\nthe bridge token belongs to the media half');
check('read proxies to media', lib.bridgeToken, 'tok-1');
lib.bridgeToken = 'tok-2';
check('write reaches the provider that checks it', media.bridgeToken, 'tok-2');

console.log('\nstreaming is a media capability');
const withStream = new PairedLibrary({}, { stream: () => 'bytes' }, []);
const noStream = new PairedLibrary({}, { configured: true }, []);
check('a share advertises it', typeof withStream.stream, 'function');
check('and it reaches the media half', withStream.stream(), 'bytes');
check('a folder does not advertise it', typeof noStream.stream, 'undefined');

console.log('\nconfigured means BOTH halves');
const cfgd = (c, m) => new PairedLibrary({ configured: c }, { configured: m }).configured;
check('both', cfgd(true, true), true);
check('catalogue only', cfgd(true, false), false);
check('media only', cfgd(false, true), false);
check('neither', cfgd(false, false), false);

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
