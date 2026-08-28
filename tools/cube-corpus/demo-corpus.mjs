#!/usr/bin/env node
// Smoke-test fixture for the corpus path — NOT a substitute for real photos.
//
// Writes a handful of drawn "rectified faces" into corpus/demo-faces/ and a
// corpus/faces.json pointing at them, so `scan-harness.mjs --corpus` can be
// run (and the report shape seen) before anything has been downloaded. The
// faces exercise the properties real photos bring that the synthetic harness
// has no way to express: a logo printed over a centre tile, a specular blob,
// worn and desaturated vinyl, a gapless body with no seams.
//
//   node tools/cube-corpus/demo-corpus.mjs          # write the demo corpus
//   node tools/cube-corpus/demo-corpus.mjs --clean  # remove it again
//
// Every record is marked `demo: true`; the harness says so in its report, so
// a demo run can never be mistaken for a measurement on real cubes.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, FACES_JSON } from './paths.mjs';
import { encodePNG } from './png.mjs';

const DEMO = join(CORPUS, 'demo-faces');

if (process.argv.includes('--clean')) {
  rmSync(DEMO, { recursive: true, force: true });
  if (existsSync(FACES_JSON)) {
    const m = JSON.parse(readFileSync(FACES_JSON, 'utf8'));
    m.records = m.records.filter((r) => !r.demo);
    writeFileSync(FACES_JSON, JSON.stringify(m, null, 2));
  }
  console.log('demo corpus removed');
  process.exit(0);
}

const RGB = { U: [255, 213, 0], D: [244, 244, 244], F: [0, 166, 81], B: [17, 99, 216], R: [255, 122, 0], L: [224, 36, 74] };
const S = 144;

function drawFace(n, colors, opts) {
  const d = new Uint8ClampedArray(S * S * 4);
  const cell = S / n;
  const plastic = opts.plastic || [22, 22, 26];
  const gap = opts.gapless ? 0 : cell * 0.09;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const col = Math.min(n - 1, Math.floor(x / cell)), row = Math.min(n - 1, Math.floor(y / cell));
      const cu = x - (col + 0.5) * cell, cv = y - (row + 0.5) * cell;
      let c;
      if (Math.abs(cu) <= cell / 2 - gap && Math.abs(cv) <= cell / 2 - gap) {
        c = RGB[colors[row * n + col]].slice();
        if (opts.worn) { const k = 0.55; c = c.map((v) => v * k + 150 * (1 - k)); }
      } else if (opts.gapless) {
        // rounded-corner notch at every 4-tile junction, like a real stickerless cube
        const gu = Math.round(x / cell), gv = Math.round(y / cell);
        c = RGB[colors[row * n + col]].slice();
        if (gu >= 1 && gu <= n - 1 && gv >= 1 && gv <= n - 1) {
          const du = x - gu * cell, dv = y - gv * cell;
          if (du * du + dv * dv < (cell * 0.14) ** 2) c = [25, 25, 28];
        }
      } else c = plastic.slice();

      // a printed logo over the centre tile: light ring + dark wordmark strokes
      if (opts.logo) {
        const lc = Math.floor(n / 2);
        const lx = x - (lc + 0.5) * cell, ly = y - (lc + 0.5) * cell;
        const rr = Math.hypot(lx, ly);
        if (rr < cell * 0.34) c = c.map((v) => v * 0.25 + 235 * 0.75);
        if (rr < cell * 0.30 && Math.abs(((ly + cell) % (cell * 0.16))) < cell * 0.05) c = [30, 30, 34];
      }
      // specular highlight across a glossy face
      if (opts.glossy) {
        const q = ((x - S * 0.32) ** 2) / (S * 0.30) ** 2 + ((y - S * 0.28) ** 2) / (S * 0.16) ** 2;
        if (q < 1) { const a = 130 * (1 - q); c = c.map((v) => v + a); }
      }
      const o = (y * S + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
  }
  return { data: d, width: S, height: S };
}

const F = (s) => s.split('');
const SPECS = [
  { id: 'demo:plain-3', n: 3, colors: F('UDFBRLUDF'), opts: {}, style: 'stickered', tags: [], notes: 'baseline: plain stickered 3x3' },
  { id: 'demo:logo-3', n: 3, colors: F('UDFBRLUDF'), opts: { logo: true }, style: 'stickered', tags: ['logo'], notes: 'brand logo printed over the centre tile' },
  { id: 'demo:logo-glossy-3', n: 3, colors: F('FFUBRLUDF'), opts: { logo: true, glossy: true }, style: 'stickered', tags: ['logo', 'glossy'], notes: 'logo plus a specular sweep' },
  { id: 'demo:worn-3', n: 3, colors: F('URFBLDUFB'), opts: { worn: true }, style: 'stickered', tags: ['worn'], notes: 'faded, desaturated vinyl' },
  { id: 'demo:gapless-3', n: 3, colors: F('UUFBRLDDF'), opts: { gapless: true }, style: 'gapless', tags: [], notes: 'stickerless, no seams' },
  { id: 'demo:gapless-logo-3', n: 3, colors: F('UUFBRLDDF'), opts: { gapless: true, logo: true }, style: 'gapless', tags: ['logo'], notes: 'stickerless with a logo cap' },
  { id: 'demo:white-body-3', n: 3, colors: F('DUFBRLDUF'), opts: { plastic: [236, 236, 236] }, style: 'stickered', tags: [], notes: 'white body: white tiles merge into the plastic' },
  { id: 'demo:plain-4', n: 4, colors: F('UDFBRLUDFBRLUDFB'), opts: {}, style: 'stickered', tags: [], notes: 'baseline 4x4' },
  { id: 'demo:logo-4', n: 4, colors: F('UDFBRLUDFBRLUDFB'), opts: { logo: true }, style: 'stickered', tags: ['logo'], notes: '4x4 with a logo tile' },
  { id: 'demo:plain-2', n: 2, colors: F('UDFB'), opts: {}, style: 'stickered', tags: [], notes: 'baseline 2x2' },
];

mkdirSync(DEMO, { recursive: true });
const records = SPECS.map((s) => {
  const slug = s.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  writeFileSync(join(DEMO, slug + '.png'), encodePNG(drawFace(s.n, s.colors, s.opts)));
  return {
    id: s.id, state: 'labelled', demo: true,
    face: `corpus/demo-faces/${slug}.png`,
    source: 'generated', license: 'n/a (generated)', creator: 'demo-corpus.mjs', pageUrl: null, commit: true,
    n: s.n, style: s.style, tags: s.tags,
    corners: null, colors: s.colors, notes: s.notes,
    annotatedAt: new Date().toISOString(),
  };
});

const existing = existsSync(FACES_JSON) ? JSON.parse(readFileSync(FACES_JSON, 'utf8')) : { records: [] };
existing.records = existing.records.filter((r) => !r.demo).concat(records);
existing.generatedAt = new Date().toISOString();
mkdirSync(CORPUS, { recursive: true });
writeFileSync(FACES_JSON, JSON.stringify(existing, null, 2));

console.log(`wrote ${records.length} demo faces to corpus/demo-faces/ and merged into corpus/faces.json`);
console.log('run: node tests/scan-harness.mjs --corpus       (remove later with --clean)');
