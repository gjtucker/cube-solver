// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

// Colour-assignment harness: the joint scan-finish pipeline
// (normalizeAll + assignColors) against synthesized COMPLETE scans under
// colour casts stronger than any single face could reveal.
//
// A complete cube carries every colour on the same number of stickers, so
// the pipeline white-balances the pooled scan and clusters jointly with
// exact per-colour capacities — this harness measures how much that buys
// over classifying each sticker on its own (per-cell hueClass, reported as
// the baseline; ~15-25% errors under these casts vs <1% joint).
//
// (An exact palette white-balance with canonical-colour seeds was
// A/B-measured against this pipeline before settling on it: it ties on
// ordinary casts and loses on extreme blue-shade ones, so the data-derived
// seeding stays.)
//
//   node tests/assign-harness.mjs            # default seed
//   node tests/assign-harness.mjs --seed 7
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = createRequire(import.meta.url)(join(root, 'scan.js'));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CANON = {
  U: [255, 213, 0], D: [244, 244, 244], F: [0, 166, 81],
  B: [17, 99, 216], R: [255, 122, 0], L: [224, 36, 74],
};
const LETTERS = ['U', 'R', 'F', 'D', 'L', 'B'];
// casts stronger than the frame-level ones in scan-harness — the point of
// the joint pipeline is surviving what per-cell classification cannot
const CASTS = {
  none: [1, 1, 1],
  warm: [1.22, 1.0, 0.68],
  strongWarm: [1.35, 1.06, 0.55],
  cool: [0.75, 1.02, 1.3],
  lime: [0.8, 1.2, 0.82],
  dim: [0.55, 0.55, 0.58], // underexposed evening room
};

// one synthetic complete scan: 6 captures of n×n raw cell colours + truth
function makeScan(mode, rand, cast) {
  const n = SCAN.gridN(mode);
  const per = n * n;
  // deal letters: exactly one face's worth of each colour across the scan.
  // On the 3×3 the protocol fixes each capture's centre colour, so the
  // centres are placed first and the deck deals the remaining cells.
  const deck = [];
  const centered = mode === '3';
  for (const c of LETTERS) for (let i = 0; i < per - (centered ? 1 : 0); i++) deck.push(c);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const truth = [], captures = [];
  for (let f = 0; f < 6; f++) {
    let cells;
    if (centered) {
      cells = deck.slice(f * (per - 1), (f + 1) * (per - 1));
      cells.splice((per - 1) / 2, 0, SCAN.PROTO_FACES[f]);
    } else {
      cells = deck.slice(f * per, (f + 1) * per);
    }
    const light = 0.6 + rand() * 0.55;              // per-face exposure
    const grad = (rand() - 0.5) * 0.25;             // within-face gradient
    truth.push(cells);
    captures.push(cells.map((c, i) => {
      const row = Math.floor(i / n);
      const l = light * (1 + grad * (row / (n - 1) - 0.5));
      return CANON[c].map((v, k) => {
        const noisy = v * l * cast[k] + (rand() - 0.5) * 24;
        return Math.max(0, Math.min(255, noisy));
      });
    }));
  }
  return { captures, truth };
}

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? +args[seedArg + 1] : 1;
const rand = rng(seed * 2654435761);

const SCANS_PER_CELL = 20;
// per-mode gates: a 2×2 scan carries only 24 cells (4 per colour), so one
// hard scan moves its rate far more than on the bigger grids
const GATE = { 3: 0.01, 4: 0.01, 2: 0.04 };
let fail = false;
const rows = [];
for (const mode of ['3', '4', '2']) {
  for (const [castName, cast] of Object.entries(CASTS)) {
    let cells = 0, errs = 0, baseErrs = 0, scansWrong = 0;
    for (let s = 0; s < SCANS_PER_CELL; s++) {
      const { captures, truth } = makeScan(mode, rand, cast);
      const letters = SCAN.assignColors(mode, SCAN.normalizeAll(captures));
      let wrong = 0;
      for (let f = 0; f < 6; f++) {
        for (let i = 0; i < truth[f].length; i++) {
          cells++;
          if (letters[f][i] !== truth[f][i]) { errs++; wrong++; }
          if ((SCAN.hueClass(captures[f][i]) || 'D') !== truth[f][i]) baseErrs++;
        }
      }
      if (wrong) scansWrong++;
    }
    rows.push({ mode, cast: castName, cells, errRate: errs / cells, baseRate: baseErrs / cells, scansWrong, scans: SCANS_PER_CELL });
  }
}

console.log('joint pipeline (normalizeAll + assignColors) vs per-cell hueClass baseline');
for (const r of rows) {
  const gate = GATE[r.mode];
  const over = r.errRate > gate;
  if (over) fail = true;
  console.log(
    `  ${r.mode}x  ${r.cast.padEnd(10)} joint ${(r.errRate * 100).toFixed(2)}%` +
    `  (baseline ${(r.baseRate * 100).toFixed(1)}%)  bad scans ${r.scansWrong}/${r.scans}` +
    (over ? `  <-- OVER ${gate * 100}%` : ''));
}
console.log('gates: 3x/4x ≤ 1% · 2x ≤ 4%');
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
