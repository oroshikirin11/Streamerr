/**
 * Naming a render node from its libva driver string.
 *
 * This is what tells an operator that "renderD128" is the discrete card and
 * not the CPU's integrated graphics — a distinction the path itself cannot
 * make, because the numbering is enumeration order. Getting it wrong is not
 * dangerous, but it is actively misleading, which is worse than silence.
 *
 * The strings below are verbatim from real drivers.
 *
 * Run: node test/gpuinfo.test.mjs
 */
import { parseDriverString, parseDriverFamily } from '../src/ffmpeg/gpuinfo.js';

let failures = 0;
const check = (name, actual, expected) => {
  if (actual === expected) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
};

console.log('\nreal driver strings');
const mesaDgpu = 'Mesa Gallium driver 26.2.1-arch3.1 for AMD Radeon RX 6900 XT '
  + '(radeonsi, navi21, ACO, DRM 3.64, 7.2.0-1-cachyos).';
const mesaIgpu = 'Mesa Gallium driver 26.2.1-arch3.1 for AMD Ryzen 7 7800X3D 8-Core '
  + 'Processor (radeonsi, raphael_mendocino, ACO, DRM 3.64, 7.2.0-1-cachyos).';
const intel = 'Intel iHD driver for Intel(R) Gen Graphics - 24.1.0';

check('discrete AMD card', parseDriverString(mesaDgpu), 'AMD Radeon RX 6900 XT');
// The iGPU reports the CPU's name, which is exactly the confusion this solves.
check('AMD integrated reports the CPU', parseDriverString(mesaIgpu),
  'AMD Ryzen 7 7800X3D 8-Core Processor');
check('Intel, with its (R) and version suffix', parseDriverString(intel),
  'Intel(R) Gen Graphics');

console.log('\ndriver family');
check('mesa', parseDriverFamily(mesaDgpu), 'Mesa');
check('iHD', parseDriverFamily(intel), 'Intel iHD');
check('i965', parseDriverFamily('Intel i965 driver for Intel(R) HD Graphics'), 'Intel i965');
check('unknown stays null', parseDriverFamily('some future driver'), null);

console.log('\ndegenerate input must not throw or invent');
check('empty', parseDriverString(''), null);
check('undefined', parseDriverString(), null);
check('no "for" clause', parseDriverString('Mystery driver 1.0'), 'Mystery driver 1.0');
check('family of empty', parseDriverFamily(''), null);
check('family of undefined', parseDriverFamily(), null);

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
