/**
 * Artwork ids must survive a library rebuild.
 *
 * The Jellyfin provider mints `/api/library/image/<id>-<type>-<tag>` urls
 * and remembers the remote address in an in-memory map. That map is born
 * empty every time the library client is rebuilt (any settings save, and
 * the scheduled rescan), while the ids are baked into engine queue items
 * for hours — a marathon broadcast crossing a rescan 404'd every poster
 * from then on, and the Streamingestarr push cached the miss for the rest
 * of the process. imagePath therefore reconstructs the url from the id
 * itself when the map has nothing; these tests pin that contract.
 *
 * Run: node test/jellyfin-art.test.mjs
 */
import { JellyfinLibrary } from '../src/library/jellyfin.js';

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
};

const ITEM = '61d6c2ca0a94d056e827171c6d489cfa';
const TAG = 'a4ba330452c801a36b223e2b2469cea4';

console.log('\njellyfin artwork ids');

{
  const lib = new JellyfinLibrary({ url: 'http://jf:8096', apiKey: 'k' });
  check('a minted id resolves through the map',
    (() => { const u = lib.imageUrl(ITEM, 'Primary', TAG); return [u, lib.imagePath(`${ITEM}-Primary-${TAG}`)]; })(),
    [`/api/library/image/${ITEM}-Primary-${TAG}?v=${TAG}`,
      `http://jf:8096/Items/${ITEM}/Images/Primary?tag=${TAG}&maxHeight=450`]);
}

{
  // A FRESH instance — the rebuilt-library case — has an empty map but must
  // still answer for ids minted by its predecessor.
  const lib = new JellyfinLibrary({ url: 'http://jf:8096', apiKey: 'k' });
  check('an unregistered id is reconstructed, not refused',
    lib.imagePath(`${ITEM}-Primary-${TAG}`),
    `http://jf:8096/Items/${ITEM}/Images/Primary?tag=${TAG}&maxHeight=450`);
  check('other image types reconstruct too',
    lib.imagePath(`${ITEM}-Backdrop-${TAG}`),
    `http://jf:8096/Items/${ITEM}/Images/Backdrop?tag=${TAG}&maxHeight=450`);
}

{
  const lib = new JellyfinLibrary({ url: 'http://jf:8096', apiKey: 'k' });
  check('junk that is not an art id stays a miss', lib.imagePath('poster.jpg'), null);
  check('a short id is not mistaken for an item guid',
    lib.imagePath('abc-Primary-def'), null);
  check('nothing injects into the url',
    lib.imagePath(`${ITEM}-Primary-../../secret`), null);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
