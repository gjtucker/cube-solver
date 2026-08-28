// Stage 5a — the corpus scene source for tests/scan-harness.mjs --corpus.
//
// The synthetic harness draws a face from flat sticker RGB and ideal gaps.
// This one draws the same scene geometry but fills the face with a RECTIFIED
// PHOTOGRAPH of a real cube — logos, vinyl grain, specular highlights, worn
// edges and all. Because the scene still places the face itself, ground truth
// (centre, size, angle, per-tile colour) stays exact, so every metric the
// synthetic harness reports carries over unchanged; only the texture is real.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../tools/cube-corpus/png.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FACES_JSON = join(ROOT, 'corpus', 'faces.json');

export function loadCorpus() {
  if (!existsSync(FACES_JSON)) return null;
  const manifest = JSON.parse(readFileSync(FACES_JSON, 'utf8'));
  const faces = [];
  for (const rec of manifest.records) {
    if (rec.state !== 'labelled') continue;
    const p = join(ROOT, rec.face);
    if (!existsSync(p)) continue;
    const img = decodePNG(readFileSync(p));
    faces.push({ ...rec, img, mips: buildMips(img) });
  }
  return { generatedAt: manifest.generatedAt, faces };
}

// Successive halvings, so a 192 px crop drawn at 60 px on the detector frame
// is sampled from a ~96 px level instead of point-sampling one pixel in four.
// Without this the corpus would look noisier than the real camera path, and
// we would be measuring aliasing rather than the scanner.
function buildMips(img) {
  const mips = [img];
  let cur = img;
  while (cur.width >= 32 && cur.width % 2 === 0) {
    const w = cur.width >> 1, h = cur.height >> 1;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = (2 * y * cur.width + 2 * x) * 4, b = a + cur.width * 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = (cur.data[a + c] + cur.data[a + 4 + c] + cur.data[b + c] + cur.data[b + 4 + c]) >> 2;
      out[o + 3] = 255;
    }
    cur = { data: out, width: w, height: h };
    mips.push(cur);
  }
  return mips;
}

const pickMip = (mips, targetPx) => {
  let best = mips[0];
  for (const m of mips) if (m.width >= targetPx) best = m;
  return best;
};

// Same scene grammar as the synthetic harness: scale × tilt × background,
// with a couple of variants each for lighting and glare. Every labelled face
// gets the full sweep, so per-face lock rates are comparable across the
// corpus and a logo face can be compared against a plain one directly.
export function makeCorpusScenarios(seed, faces, W, H) {
  const rand = mulberry32(seed);
  const minDim = Math.min(W, H);
  const out = [];
  // stay inside the live acquisition allowance (SCAN.liveLimits):
  // sizes within ±20% of the 0.55·minDim guide, tilt under 15°
  const scales = [0.45, 0.55, 0.65];
  const angles = [0, 7, 13];
  const backgrounds = ['gray', 'dark', 'wood', 'cluttered'];
  for (const face of faces) {
    for (const scale of scales) {
      for (const angleDeg of angles) {
        for (const background of backgrounds) {
          const size = scale * minDim;
          const reach = (size * Math.SQRT2) / 2;
          const maxOff = Math.max(1, Math.min(minDim * 0.12, W * 0.45 - reach, H * 0.45 - reach));
          const offR = rand() * maxOff, offT = rand() * Math.PI * 2;
          const glareOn = rand() < 0.3;
          out.push({
            corpus: face,
            n: face.n, scale, angleDeg, background, hasCube: true,
            style: face.style, tags: face.tags || [],
            clutterNeeded: background === 'cluttered',
            cx: W / 2 + Math.cos(offT) * offR,
            cy: H / 2 + Math.sin(offT) * offR,
            size, angle: (angleDeg * Math.PI) / 180,
            light: 0.75 + rand() * 0.5,
            gradient: (rand() - 0.5) * 0.5,
            noise: 4 + rand() * 10,
            glare: glareOn ? { x: rand() * W, y: rand() * H, rx: 30 + rand() * 60, ry: 25 + rand() * 50, amp: 40 + rand() * 70 } : null,
            rand: mulberry32((seed * 7919 + out.length) >>> 0),
          });
        }
      }
    }
  }
  return out;
}

// Draws one frame. `bg(x, y)` comes from the harness so both scene sources
// stand on exactly the same backgrounds — only the face differs.
export function renderCorpusFrame(sc, bg, W, H) {
  const d = new Uint8ClampedArray(W * H * 4);
  const ca = Math.cos(sc.angle), sa = Math.sin(sc.angle);
  const half = sc.size / 2;
  const mip = pickMip(sc.corpus.mips, sc.size);
  const { data: td, width: TW, height: TH } = mip;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgbv;
      const dx = x - sc.cx, dy = y - sc.cy;
      const u = ca * dx + sa * dy, v = -sa * dx + ca * dy;
      if (Math.abs(u) <= half && Math.abs(v) <= half) {
        // face-local -> texture, bilinear
        const fx = Math.min(TW - 1.001, Math.max(0, ((u + half) / sc.size) * TW));
        const fy = Math.min(TH - 1.001, Math.max(0, ((v + half) / sc.size) * TH));
        const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
        rgbv = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          const p00 = td[(y0 * TW + x0) * 4 + c], p10 = td[(y0 * TW + x0 + 1) * 4 + c];
          const p01 = td[((y0 + 1) * TW + x0) * 4 + c], p11 = td[((y0 + 1) * TW + x0 + 1) * 4 + c];
          rgbv[c] = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
        }
      } else {
        rgbv = bg(x, y, sc);
      }
      const lum = sc.light * (1 + sc.gradient * ((x / W) - 0.5));
      let r = rgbv[0] * lum, g = rgbv[1] * lum, b = rgbv[2] * lum;
      if (sc.glare) {
        const gx = (x - sc.glare.x) / sc.glare.rx, gy = (y - sc.glare.y) / sc.glare.ry;
        const q = gx * gx + gy * gy;
        if (q < 1) { const a = sc.glare.amp * (1 - q); r += a; g += a; b += a; }
      }
      const o = (y * W + x) * 4;
      d[o] = r + (sc.rand() - 0.5) * sc.noise;
      d[o + 1] = g + (sc.rand() - 0.5) * sc.noise;
      d[o + 2] = b + (sc.rand() - 0.5) * sc.noise;
      d[o + 3] = 255;
    }
  }
  return { data: d, width: W, height: H };
}

// ---- colour-read scoring -------------------------------------------------
// Geometry is only half of what a logo breaks. A perfectly located face can
// still be read wrong when a printed logo, a specular blob or worn vinyl
// drags a tile off its colour, so the corpus scores the read as well.
//
//  tileAccuracy — per-tile agreement with SCAN.hueClass, the classifier the
//    live scanner shows as immediate feedback. Unknown ('?') tiles, which the
//    annotator marks where even a human cannot name a colour, are excluded.
//  separability — smallest between-colour distance over largest within-colour
//    distance in the scanner's own feature space. Above 1 the face's colours
//    are cleanly separable and the six-face assignment will land; at or below
//    1 two different colours sit closer than one colour sits to itself, and
//    no thresholding can recover it. Threshold-free on purpose.
export function scoreColors(SCAN, frame, det, sc) {
  const truth = sc.corpus.colors;
  const n = sc.n;
  if (!det || !truth || truth.length !== n * n) return null;
  const grid = SCAN.sampleGrid(frame, {
    x: det.cx - det.size / 2, y: det.cy - det.size / 2, size: det.size, angle: det.angle || 0,
  }, n);

  let known = 0, correct = 0;
  for (let i = 0; i < n * n; i++) {
    if (truth[i] === '?') continue;
    known++;
    if (SCAN.hueClass(grid.cells[i]) === truth[i]) correct++;
  }

  const feats = grid.cells.map((c) => SCAN.featOf(c));
  let within = 0, between = Infinity, pairs = 0;
  for (let i = 0; i < n * n; i++) {
    if (truth[i] === '?') continue;
    for (let j = i + 1; j < n * n; j++) {
      if (truth[j] === '?') continue;
      const d = Math.sqrt(SCAN.dist2(feats[i], feats[j]));
      pairs++;
      if (truth[i] === truth[j]) within = Math.max(within, d);
      else between = Math.min(between, d);
    }
  }
  return {
    known,
    correct,
    tileAccuracy: known ? correct / known : null,
    separability: pairs && within > 0 && Number.isFinite(between) ? between / within : null,
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
