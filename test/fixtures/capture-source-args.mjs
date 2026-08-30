/**
 * Captures buildSourceArgs output across a representative matrix and writes
 * it to source-args-golden.json.
 *
 * Run ONCE against a known-good revision, commit the JSON, and never run it
 * casually again: the fixture's whole value is that it predates the change
 * being tested. Regenerating it after a refactor would make the golden test
 * assert that the code equals itself.
 *
 *   node test/fixtures/capture-source-args.mjs
 */
import { writeFileSync } from 'fs';
import { buildSourceArgs } from '../../src/ffmpeg/pipeline.js';
import { cases } from './source-args-cases.mjs';

const out = {};
for (const [name, params] of Object.entries(cases)) {
  out[name] = buildSourceArgs(params);
}
const dest = new URL('./source-args-golden.json', import.meta.url);
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`captured ${Object.keys(out).length} cases -> ${dest.pathname}`);
