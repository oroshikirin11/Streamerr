/**
 * The classic (unpiped) source commands, pinned byte for byte.
 *
 * The fixture was captured from the revision BEFORE the overlay pipe was
 * added, across every graph shape a real broadcast has used: JJK's 16:9
 * canvas, Berserk's three pillarbox composites, Backrooms' subtitle-free
 * fast path, Lain's moving picture. If any of these change, a refactor has
 * altered behaviour it promised not to touch.
 *
 * Regenerating the fixture (test/fixtures/capture-source-args.mjs) is a
 * DELIBERATE act for intended changes — never part of fixing a red test.
 *
 * Run: node test/source-args-golden.test.mjs
 */
import { readFileSync } from 'fs';
import { buildSourceArgs } from '../src/ffmpeg/pipeline.js';
import { cases } from './fixtures/source-args-cases.mjs';

const golden = JSON.parse(readFileSync(
  new URL('./fixtures/source-args-golden.json', import.meta.url), 'utf8'));

let failures = 0;
for (const [name, params] of Object.entries(cases)) {
  const now = buildSourceArgs(params);
  const want = golden[name];
  if (JSON.stringify(now) === JSON.stringify(want)) {
    console.log(`  ok    ${name}`);
    continue;
  }
  failures += 1;
  const i = now.findIndex((v, k) => v !== want?.[k]);
  console.log(`  FAIL  ${name}\n          first diff at arg ${i}:`
    + `\n          golden ${JSON.stringify(want?.[i])}`
    + `\n          now    ${JSON.stringify(now[i])}`);
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
