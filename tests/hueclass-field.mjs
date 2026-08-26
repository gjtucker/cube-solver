// Field-measured colour regression: RGB values sampled from a real iPhone
// screenshot (warm indoor light over a wood table, gapless cube) where the
// camera's white balance dragged yellow tiles to hue 81–95 — lime territory —
// and the classifier called them green. These exact values must classify
// correctly forever.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = createRequire(import.meta.url)(join(root, 'scan.js'));

const CASES = [
  // yellow tiles under a green-shifted white balance (the reported bug)
  [[170, 236, 124], 'U'], [[182, 227, 132], 'U'], [[192, 233, 118], 'U'], [[185, 234, 114], 'U'],
  // orange tiles from the same frame (read correctly then; must stay correct)
  [[231, 135, 79], 'R'], [[230, 140, 79], 'R'],
  // canonical sticker colours
  [[255, 213, 0], 'U'], [[0, 166, 81], 'F'], [[17, 99, 216], 'B'],
  [[255, 122, 0], 'R'], [[224, 36, 74], 'L'], [[244, 244, 244], 'D'],
  // warm-cast white must stay white, not become yellow
  [[255, 244, 175], 'D'],
];

let fail = 0;
for (const [rgb, want] of CASES) {
  const got = SCAN.hueClass(rgb);
  if (got !== want) {
    console.error(`FAIL rgb(${rgb.join(',')}) -> ${got}, want ${want}`);
    fail++;
  }
}
console.log(fail ? `${fail}/${CASES.length} FAILED` : `all ${CASES.length} colour cases PASS`);
process.exit(fail ? 1 : 0);
