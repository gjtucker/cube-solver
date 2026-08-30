#!/usr/bin/env node
// Headless acceptance harness for the camera cube detector.
//
// Loads the SCAN module (scan.js), renders synthetic camera frame
// sequences (a cube face at varying scale / tilt / position / lighting /
// glare / noise over varying backgrounds, fresh sensor noise every frame) and
// runs them through the live pipeline — registerRect clamped to the fixed
// guide square + the quality lock — exactly what the scanner ships. Measures
// how often it ends up LOCKED on the face, how accurately the lock reports
// centre/size/angle, and the false-lock rate on cube-free sequences.
//
//   node tests/scan-harness.mjs            # human-readable report
//   node tests/scan-harness.mjs --json     # machine-readable summary
//   node tests/scan-harness.mjs --seed 7   # different scenario set
//   node tests/scan-harness.mjs --frames 9 # shorter sequences (faster, default 12)
//   node tests/scan-harness.mjs --corpus  # real photographed faces, not synthetic
//
// --corpus swaps the synthetic face for a rectified PHOTOGRAPH of a real cube
// from corpus/ (see tools/cube-corpus/), keeping the scene geometry — and so
// the ground truth — exactly as above. It is a separate report with its own
// targets, and it also scores the COLOUR READ, because a logo printed on a
// centre cap breaks the read long before it breaks the fit. Build the corpus
// with tools/cube-corpus/{search,fetch,serve}.mjs; without one this mode
// explains how to make it and exits 0 rather than failing the suite.
//
// A detection counts as a HIT when the reported square matches ground truth:
//   centre error < 15% of the true size, size within ±20%, angle within 7°
// (angle compared modulo 90°, since a square lattice repeats every quarter
// turn). Anything else returned by the detector is a MISS with a bad fit.
//
// Acceptance targets (the "done" bar agreed for the scanner):
//   - lock rate ≥ 90% on realistic frames (cube inside the aiming allowance:
//     size within ±10% of the guide, tilt under ~10°, roughly centred — clean
//     or irregular-clutter backgrounds; the adversarial "mosaic" background —
//     a perfect wall of sticker-sized squares — is reported separately, where
//     returning null is acceptable behaviour)
//   - bad-fit rate ≤ 2% on ALL cube frames (a confident box in the wrong
//     place is worse than no box: it captures wrong colours)
//   - false-lock rate ≤ 2% on realistic cube-free frames (false locks on the
//     mosaic wall — which genuinely contains cube-like lattices — are
//     reported separately as adversarial-informational)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = createRequire(import.meta.url)(join(root, 'scan.js'));
import { loadCorpus, makeCorpusScenarios, renderCorpusFrame, scoreColors } from './corpus-scenes.mjs';

// ---------- tiny seeded PRNG (mulberry32) so runs are reproducible ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- synthetic frame renderer ----------
// Frames are rendered at the size the live pipeline hands to detectFace:
// the sample canvas is ≤720 px wide and detectFace runs on a 2× downsample,
// so a 1280×720 camera ends up as a 360×202 detector frame.
const W = 360, H = 202;

const STICKER_RGB = {
  U: [255, 213, 0], D: [244, 244, 244], F: [0, 166, 81],
  B: [17, 99, 216], R: [255, 122, 0], L: [224, 36, 74],
};
const LETTERS = Object.keys(STICKER_RGB);

const BACKGROUNDS = {
  gray: () => [96, 96, 96],
  dark: () => [38, 38, 40],
  wood: (x, y) => {
    const t = 0.5 + 0.5 * Math.sin(x * 0.11 + Math.sin(y * 0.023) * 3);
    return [138 + t * 40, 96 + t * 26, 58 + t * 14];
  },
  tilewall: (x, y) => {
    // ADVERSARIAL: wall-to-wall rows of sticker-sized colour blocks with
    // per-row offsets (a shelf of spines, a dense tile wall). Like the
    // mosaic, missing the cube here is acceptable; a confident wrong box is
    // what the adversarial bad-fit cap limits.
    const row = Math.floor(y / (14 + (Math.imul(Math.floor(y / 31), 2654435761) >>> 28)));
    const shift = (Math.imul(row, 2246822519) >>> 24) & 63;
    const bw = 9 + ((Math.imul(row, 3266489917) >>> 26) & 31);
    const colIdx = Math.floor((x + shift) / bw);
    const h = (Math.imul(colIdx * 374761393 + row * 668265263, 1103515245) >>> 8) & 255;
    return [40 + (h % 160), 40 + ((h * 7) % 160), 40 + ((h * 13) % 160)];
  },
  mosaic: (x, y) => {
    // ADVERSARIAL: a perfect grid of sticker-sized colour squares (tiled wall,
    // app icons). A lattice detector can legitimately fail to find the cube
    // here — what it must not do is confidently lock a wrong square.
    const h = (Math.imul((x >> 4) * 374761393 + (y >> 4) * 668265263, 1103515245) >>> 8) & 255;
    return [40 + (h % 160), 40 + ((h * 7) % 160), 40 + ((h * 13) % 160)];
  },
};

// realistic desk clutter: scattered objects of varied size and colour over a
// wooden surface. Module-level so the --corpus scenes stand on exactly the
// same backgrounds as the synthetic ones, and only the face differs.
function clutterRects(rand) {
  const rects = [];
  for (let k = 0; k < 14; k++) {
    rects.push({
      x: rand() * 340 - 20, y: rand() * 190 - 10,
      w: 10 + rand() * 70, h: 8 + rand() * 55,
      c: [30 + rand() * 190, 30 + rand() * 190, 30 + rand() * 190],
    });
  }
  return rects;
}

// background colour under a scene pixel, clutter included
export function sampleBackground(x, y, sc) {
  if (sc.background === 'cluttered') {
    let rgbv = BACKGROUNDS.wood(x, y);
    for (const r of sc.clutterRects) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) rgbv = r.c;
    }
    return rgbv;
  }
  return (BACKGROUNDS[sc.background] || (() => [96, 96, 96]))(x, y);
}

// ground truth + scene description -> RGBA frame
function renderFrame(sc) {
  const d = new Uint8ClampedArray(W * H * 4);
  const ca = Math.cos(sc.angle), sa = Math.sin(sc.angle);
  const n = sc.n, size = sc.size, cell = size / n;
  const stickerHalf = (cell * sc.stickerFrac) / 2;
  const half = size / 2;
  // colour of the face at face-local coords, or null outside the face
  const faceColor = (u, v) => {
    if (Math.abs(u) > half || Math.abs(v) > half) return null;
    const col = Math.min(n - 1, Math.floor((u + half) / cell));
    const row = Math.min(n - 1, Math.floor((v + half) / cell));
    if (sc.style === 'gapless') {
      // gapless stickerless cube: tiles touch directly (no seams at all —
      // same-colour neighbours are indistinguishable), but the rounded
      // tile corners expose a dark notch at every 4-tile junction
      const gu = Math.round((u + half) / cell), gv = Math.round((v + half) / cell);
      if (gu >= 1 && gu <= n - 1 && gv >= 1 && gv <= n - 1) {
        const du = (u + half) - gu * cell, dv = (v + half) - gv * cell;
        const notchR = cell * 0.14;
        if (du * du + dv * dv < notchR * notchR) return [25, 25, 28];
      }
      return STICKER_RGB[sc.face[row * n + col]];
    }
    // stickered: plastic shows between the sticker patches
    const cu = u + half - (col + 0.5) * cell, cv = v + half - (row + 0.5) * cell;
    return Math.abs(cu) <= stickerHalf && Math.abs(cv) <= stickerHalf
      ? STICKER_RGB[sc.face[row * n + col]] : sc.plastic;
  };
  const st = sc.sticky;
  const stc = st ? Math.cos(st.tilt) : 1, sts = st ? Math.sin(st.tilt) : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgbv = null;
      // rotate into face-local coords
      const dx = x - sc.cx, dy = y - sc.cy;
      const u = ca * dx + sa * dy, v = -sa * dx + ca * dy;
      if (sc.hasCube) {
        if (st) {
          // sticky cube: one middle band sits a few degrees skew from the
          // rest of the face (rotated about the face centre). The band is
          // drawn in its own rotated frame on top; where it has swung away
          // from its slot, the slot shows dark inner plastic.
          const ub0 = stc * u + sts * v, vb0 = -sts * u + stc * v;
          const ub = st.axis === 'col' ? ub0 : ub0 - (st.shift || 0);
          const vb = st.axis === 'col' ? vb0 - (st.shift || 0) : vb0;
          const bandU = st.axis === 'col' ? ub : vb, bandV = st.axis === 'col' ? vb : ub;
          const slotU = st.axis === 'col' ? u : v;
          if (bandU >= st.range[0] && bandU <= st.range[1] && Math.abs(bandV) <= half) {
            rgbv = faceColor(ub, vb);
          } else if (slotU >= st.range[0] && slotU <= st.range[1] && Math.abs(u) <= half && Math.abs(v) <= half) {
            rgbv = [22, 22, 25];   // exposed inner plastic under the shifted band
          } else {
            rgbv = faceColor(u, v);
          }
        } else {
          rgbv = faceColor(u, v);
        }
      }
      if (!rgbv) rgbv = sampleBackground(x, y, sc);
      // lighting: global level + a left-right gradient
      const lum = sc.light * (1 + sc.gradient * ((x / W) - 0.5));
      let r = rgbv[0] * lum, g = rgbv[1] * lum, b = rgbv[2] * lum;
      // glare: additive white ellipse
      if (sc.glare) {
        const gx = (x - sc.glare.x) / sc.glare.rx, gy = (y - sc.glare.y) / sc.glare.ry;
        const q = gx * gx + gy * gy;
        if (q < 1) { const a = sc.glare.amp * (1 - q); r += a; g += a; b += a; }
      }
      // white-balance cast: phone cameras routinely shift the whole frame
      // (field-measured: yellow tiles at hue 81-95 under a warm-light AWB
      // overcorrection) — the classifier has to survive it
      if (sc.cast) { r *= sc.cast[0]; g *= sc.cast[1]; b *= sc.cast[2]; }
      // sensor noise
      const o = (y * W + x) * 4;
      d[o] = r + (sc.rand() - 0.5) * sc.noise;
      d[o + 1] = g + (sc.rand() - 0.5) * sc.noise;
      d[o + 2] = b + (sc.rand() - 0.5) * sc.noise;
      d[o + 3] = 255;
    }
  }
  return { data: d, width: W, height: H };
}

function randomFace(n, rand, solved) {
  const face = [];
  if (solved) {
    const l = LETTERS[Math.floor(rand() * 6)];
    for (let i = 0; i < n * n; i++) face.push(l);
  } else if (rand() < 0.15 && n >= 3) {
    // half-and-half face: two colours split down the middle (common on partial
    // scrambles). On a gapless cube every tile merges into two big blocks and
    // there are NO clean single tiles to seed a lattice from.
    const a = Math.floor(rand() * 6);
    const b = (a + 1 + Math.floor(rand() * 5)) % 6;
    const vertical = rand() < 0.5;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const k = vertical ? col : row;
        face.push(LETTERS[k < n / 2 ? a : b]);
      }
    }
  } else if (rand() < 0.12 && n >= 3) {
    // near-solved face: one stray tile on an otherwise solid face
    const dom = LETTERS[Math.floor(rand() * 6)];
    for (let i = 0; i < n * n; i++) face.push(dom);
    face[Math.floor(rand() * n * n)] = LETTERS[Math.floor(rand() * 6)];
  } else if (rand() < 0.4 && n >= 3) {
    // colour-heavy face: one colour dominates (5-7 of 9 on a 3×3) — common on
    // real scrambles and the hard case for gapless cubes, where same-colour
    // neighbouring tiles merge into one big blob
    const dom = LETTERS[Math.floor(rand() * 6)];
    const k = n * n - 2 - Math.floor(rand() * 3);
    for (let i = 0; i < n * n; i++) face.push(dom);
    let placed = 0;
    while (placed < n * n - k) {
      const i = Math.floor(rand() * n * n);
      if (face[i] === dom) { face[i] = LETTERS[Math.floor(rand() * 6)]; placed++; }
    }
  } else {
    for (let i = 0; i < n * n; i++) face.push(LETTERS[Math.floor(rand() * 6)]);
  }
  return face;
}

const CASTS = { warm: [1.18, 1.0, 0.72], cool: [0.8, 1.05, 1.25], lime: [0.82, 1.18, 0.85] };
// ---------- scenario generation ----------
function makeScenarios(seed) {
  const rand = rng(seed);
  const out = [];
  const minDim = Math.min(W, H);
  // the live registration accepts a cube within ±10% of the guide's size
  // and near its centre. The should-lock scenarios stay inside that; a
  // separate out-of-allowance set below verifies everything else is refused
  // (not capturable) rather than force-fitted. The sweep's bottom edge sits
  // at −4% rather than −10% of the guide: on a stickered cube the plastic
  // outline can vanish into the background, and the measurable square — the
  // sticker lattice — is 5–10% smaller than the plastic (worst on 2×2s).
  // A plastic square at the raw −10% boundary therefore measures below the
  // allowance and is rightly refused; the live "a little closer" hint steers
  // the user off that edge, so the sweep tests where guided aiming settles.
  const scales = [0.53, 0.545, 0.56, 0.58, 0.6];
  const angles = [0, 3, 5, 7, 9];
  const backgrounds = ['gray', 'dark', 'wood', 'cluttered', 'mosaic', 'tilewall'];
  const clutterScene = () => clutterRects(rand);
  for (const n of [3, 4, 2]) {
    for (const scale of scales) {
      for (const angleDeg of angles) {
        for (const background of backgrounds) {
          for (let variant = 0; variant < 3; variant++) {
            const size = scale * minDim;
            const solved = variant === 2 && rand() < 0.5;
            // inside the acquisition allowance: within ~0.08·minDim of the
            // guide-square centre (liveLimits allows ~0.10) and fully in frame
            const reach = (size * Math.SQRT2) / 2;
            const maxOff = Math.max(1, Math.min(minDim * 0.08, W * 0.45 - reach, H * 0.45 - reach));
            const glareOn = variant >= 1 && rand() < 0.5;
            const offR = rand() * maxOff, offT = rand() * Math.PI * 2;
            const cx = W / 2 + Math.cos(offT) * offR;
            const cy = H / 2 + Math.sin(offT) * offR;
            out.push({
              n, scale, angleDeg, background, solved, hasCube: true,
              clutterRects: background === 'cluttered' ? clutterScene() : null,
              style: variant === 1 ? 'gapless' : 'stickered',
              cx, cy, size,
              angle: (angleDeg * Math.PI / 180) * (rand() < 0.5 ? -1 : 1),
              face: randomFace(n, rand, solved),
              cast: variant >= 1 && rand() < 0.5 ? Object.values(CASTS)[Math.floor(rand() * 3)] : null,
              stickerFrac: 0.80 + rand() * 0.08,
              plastic: rand() < 0.85 ? [16, 16, 16] : [235, 235, 235], // black or white plastic
              light: 0.55 + rand() * 0.6,
              gradient: (rand() - 0.5) * 0.5,
              glare: glareOn
                ? { x: cx + (rand() - 0.5) * size, y: cy + (rand() - 0.5) * size,
                    rx: size * (0.15 + rand() * 0.25), ry: size * (0.1 + rand() * 0.2),
                    amp: 90 + rand() * 90 }
                : null,
              noise: 2 + rand() * 10,
              rand,
            });
          }
        }
      }
    }
  }
  // sticky-cube frames: one middle band of the face sits a few degrees skew
  // from the rest (field report: a sticky cube whose layers don't square up
  // perfectly). To the user this is still an aligned cube filling the guide,
  // so these are realistic frames that must lock like any other.
  for (const n of [3, 4, 2]) {
    for (const scale of [0.55, 0.58]) {
      for (const angleDeg of [0, 5, 9]) {
        for (const background of ['gray', 'dark', 'wood', 'cluttered']) {
          for (let variant = 0; variant < 2; variant++) {
            const size = scale * minDim;
            const cell = size / n;
            const bandIdx = n === 3 ? 1 : n === 4 ? 1 + Math.floor(rand() * 2) : Math.floor(rand() * 2);
            const lo = -size / 2 + bandIdx * cell;
            const tilt = ((1.5 + rand() * 2.5) * Math.PI / 180) * (rand() < 0.5 ? -1 : 1);
            // half the scenes also SHIFT the band along its axis — the layer
            // protruding out of the silhouette is the mode that actually
            // breaks a straight-line edge fit (a rotated band barely does)
            const shift = rand() < 0.5 ? 0 : (3 + rand() * 5) * (rand() < 0.5 ? -1 : 1);
            const offR = rand() * Math.min(minDim * 0.06, 20), offT = rand() * Math.PI * 2;
            out.push({
              n, scale, angleDeg, background, solved: false, hasCube: true,
              clutterRects: background === 'cluttered' ? clutterScene() : null,
              style: variant === 1 ? 'gapless' : 'stickered',
              cx: W / 2 + Math.cos(offT) * offR, cy: H / 2 + Math.sin(offT) * offR, size,
              angle: (angleDeg * Math.PI / 180) * (rand() < 0.5 ? -1 : 1),
              face: randomFace(n, rand, false),
              sticky: { axis: rand() < 0.5 ? 'col' : 'row', range: [lo, lo + cell], tilt, shift },
              stickerFrac: 0.80 + rand() * 0.08,
              plastic: [16, 16, 16],
              light: 0.6 + rand() * 0.5,
              gradient: (rand() - 0.5) * 0.4,
              glare: null,
              noise: 2 + rand() * 8,
              rand,
            });
          }
        }
      }
    }
  }
  // cube-free frames for the false-lock rate
  for (const background of backgrounds) {
    for (let i = 0; i < 25; i++) {
      out.push({
        n: 3, background, hasCube: false, cx: 0, cy: 0, size: 0, angle: 0,
        clutterRects: background === 'cluttered' ? clutterScene() : null,
        face: [], stickerFrac: 0, plastic: [0, 0, 0],
        light: 0.55 + rand() * 0.6, gradient: (rand() - 0.5) * 0.5,
        glare: null, noise: 2 + rand() * 10, rand,
      });
    }
  }
  // out-of-allowance: perfectly real cubes that violate the acquisition
  // allowance — too small or too big for the guide, off-centre, or tilted
  // past the limit. The scanner must refuse these (the UI asks the user to
  // centre/resize/straighten) rather than snap a box onto them.
  for (const kind of ['small', 'big', 'far', 'tilted']) {
    for (const background of ['gray', 'wood', 'cluttered']) {
      for (let i = 0; i < 6; i++) {
        const scale = kind === 'small' ? 0.45 : kind === 'big' ? 0.66 : 0.55;
        const size = scale * minDim;
        const angleDeg = kind === 'tilted' ? 26 + rand() * 8 : rand() * 6;
        const cx = kind === 'far'
          ? W / 2 + (rand() < 0.5 ? -1 : 1) * minDim * (0.17 + rand() * 0.15)
          : W / 2 + (rand() - 0.5) * 24;
        const cy = H / 2 + (rand() - 0.5) * 20;
        out.push({
          n: 3, scale, angleDeg, background, solved: false, hasCube: true, oob: kind,
          clutterRects: background === 'cluttered' ? clutterScene() : null,
          style: rand() < 0.5 ? 'gapless' : 'stickered',
          cx, cy, size,
          angle: ((angleDeg * Math.PI) / 180) * (rand() < 0.5 ? -1 : 1),
          face: randomFace(3, rand, false),
          stickerFrac: 0.84, plastic: [16, 16, 16],
          light: 0.7 + rand() * 0.4, gradient: (rand() - 0.5) * 0.3, glare: null,
          noise: 2 + rand() * 8, rand,
        });
      }
    }
  }
  return out;
}

// ---------- scoring ----------
const wrap90 = (a) => {
  const q = Math.PI / 2;
  return ((((a + q / 2) % q) + q) % q) - q / 2;
};
function score(sc, det) {
  if (!det) return { hit: false, detected: false };
  const centerErr = Math.hypot(det.cx - sc.cx, det.cy - sc.cy) / sc.size;
  const sizeRatio = det.size / sc.size;
  const angleErr = Math.abs(wrap90((det.angle || 0) - sc.angle)) * 180 / Math.PI;
  const hit = centerErr < 0.15 && sizeRatio > 0.8 && sizeRatio < 1.2 && angleErr < 7;
  return { hit, detected: true, centerErr, sizeRatio, angleErr };
}

// ---------- run ----------
// Each scenario is simulated as a short sequence of frames with fresh sensor
// noise, run through the registration + quality-lock pipeline — exactly what
// the live scanner uses. What is scored is the LOCK the user would see at the
// end of the sequence, not a single-frame detection: a lock must confirm
// itself over consecutive frames, which is also what gates auto-capture.
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? +args[seedArg + 1] : 1;
const framesArg = args.indexOf('--frames');
const FRAMES = framesArg >= 0 ? +args[framesArg + 1] : 32; // ~1s of aiming at 30fps

if (args.includes('--corpus')) {
  runCorpus();
} else {

const scenarios = makeScenarios(seed);
const cubeScen = scenarios.filter((s) => s.hasCube && !s.oob);
const emptyScen = scenarios.filter((s) => !s.hasCube);

// handheld jiggle: nobody holds a phone still, so every frame the cube's
// pose wobbles around the base scenario — ±2% of size in position and
// scale, ±1.2° in angle, fresh each frame. The tracker smooths through it;
// the colour read below then has to cope with a LAST frame that has moved
// away from the smoothed pose, exactly like a live hand.
function jiggled(sc) {
  if (!sc.hasCube) return sc;
  const r = sc.rand;
  return {
    ...sc,
    cx: sc.cx + (r() - 0.5) * sc.size * 0.04,
    cy: sc.cy + (r() - 0.5) * sc.size * 0.04,
    size: sc.size * (1 + (r() - 0.5) * 0.04),
    angle: sc.angle + ((r() - 0.5) * 2.4 * Math.PI) / 180,
  };
}

// ---------- the live pipeline ----------
// Mirrors app.js scanFrame: registerRect each frame, clamped to the fixed
// centred guide square, median-of-3 filtered; the quality lock rises while
// the edges are strong and every cell classifies. Kept deliberately tiny so
// the duplication with app.js stays reviewable.
const GS = Math.min(W, H) * 0.55;
const GUIDE = { x: W / 2 - GS / 2, y: H / 2 - GS / 2, size: GS };
function runLive(renderer, n) {
  let reg = null, q = 0, locked = false, lastFrame = null, calmLast = false, knownLast = false;
  const hist = [];
  for (let f = 0; f < FRAMES; f++) {
    lastFrame = renderer();
    const raw = SCAN.registerRect(lastFrame, GUIDE, reg);
    const cl = (v, c, d) => Math.min(c + d, Math.max(c - d, v));
    // forced-clamp refusal, relative tolerance — mirrors app.js updateReg
    const forced = GUIDE.size * 0.035;
    if (Math.abs(raw.size - cl(raw.size, GUIDE.size, GUIDE.size * 0.1)) > forced) raw.strength = 0;
    raw.size = cl(raw.size, GUIDE.size, GUIDE.size * 0.1);
    const cx = cl(raw.x + raw.size / 2, GUIDE.x + GUIDE.size / 2, GUIDE.size * 0.15);
    const cy = cl(raw.y + raw.size / 2, GUIDE.y + GUIDE.size / 2, GUIDE.size * 0.15);
    if (Math.abs(cx - (raw.x + raw.size / 2)) > forced || Math.abs(cy - (raw.y + raw.size / 2)) > forced) raw.strength = 0;
    raw.x = cx - raw.size / 2;
    raw.y = cy - raw.size / 2;
    raw.angle = cl(raw.angle, 0, 0.35);
    hist.push(raw);
    if (hist.length > 3) hist.shift();
    const med = (k) => hist.map((r) => r[k]).sort((a, b) => a - b)[hist.length >> 1];
    reg = { x: med('x'), y: med('y'), size: med('size'), angle: med('angle'), strength: med('strength') };
    const res = SCAN.sampleGrid(lastFrame, reg, n);
    const allKnown = res.cells.every((c) => SCAN.hueClass(c) !== null);
    const aligned = reg.strength >= 14 && allKnown;
    q = aligned ? Math.min(1, q + 0.15) : Math.max(0, q - 0.1);
    locked = q >= (locked ? 0.45 : 0.8);
    calmLast = res.cellVar.filter((x) => x < 1100).length >= n * n - 1;
    knownLast = allKnown;
  }
  return { reg, locked, lastFrame, capturable: locked && calmLast && knownLast };
}

const results = [];
const t0 = Date.now();
for (const sc of scenarios) {
  let lastSc = sc;
  const out = runLive(() => renderFrame(sc.hasCube ? (lastSc = jiggled(sc)) : sc), sc.n);
  const capturable = out.capturable;
  const det = out.locked
    ? { cx: out.reg.x + out.reg.size / 2, cy: out.reg.y + out.reg.size / 2, size: out.reg.size, angle: out.reg.angle, reg: out.reg }
    : null;
  if (process.env.DUMP_OOB && sc.oob && capturable) {
    console.error('OOB-CAP', JSON.stringify({ kind: sc.oob, cx: +sc.cx.toFixed(0), cy: +sc.cy.toFixed(0), size: +sc.size.toFixed(0), bg: sc.background,
      fit: { cx: +(out.reg.x + out.reg.size / 2).toFixed(0), cy: +(out.reg.y + out.reg.size / 2).toFixed(0), size: +out.reg.size.toFixed(0), st: Math.round(out.reg.strength) } }));
  }
  results.push({ sc, lastSc, det, capturable, s: sc.hasCube ? score(sc, det) : null });
}
const elapsed = Date.now() - t0;

const ADVERSARIAL = new Set(['mosaic', 'tilewall']);
const cubeRes = results.filter((r) => r.sc.hasCube && !r.sc.oob);
const oobRes = results.filter((r) => r.sc.oob);
const realRes = cubeRes.filter((r) => !ADVERSARIAL.has(r.sc.background));
const mosaicRes = cubeRes.filter((r) => ADVERSARIAL.has(r.sc.background));
const emptyRes = results.filter((r) => !r.sc.hasCube);
const emptyReal = emptyRes.filter((r) => !ADVERSARIAL.has(r.sc.background));
const emptyMosaic = emptyRes.filter((r) => ADVERSARIAL.has(r.sc.background));
const hits = realRes.filter((r) => r.s.hit);
const badFitsReal = realRes.filter((r) => r.s.detected && !r.s.hit);
const badFitsAdv = mosaicRes.filter((r) => r.s.detected && !r.s.hit);
const badFits = badFitsReal.concat(badFitsAdv);
const falseLocks = emptyReal.filter((r) => r.det);
const mosaicFalseLocks = emptyMosaic.filter((r) => r.det);

function bucket(keyFn) {
  const m = new Map();
  for (const r of realRes) {
    const k = keyFn(r.sc);
    if (!m.has(k)) m.set(k, { total: 0, hit: 0 });
    const b = m.get(k);
    b.total++;
    if (r.s.hit) b.hit++;
  }
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
}

// colour-label accuracy on the locks the user would act on: a jiggled final
// frame (the hand has moved since the tracker's smoothed pose), the sampling
// rect snapped to it exactly as the app does, hueClass vs the ground truth
let labelOk = 0, labelAll = 0;
for (const r of results) {
  if (!r.sc.hasCube || r.sc.oob || !r.s || !r.s.hit) continue;
  const frame = renderFrame(r.lastSc);
  const rect = r.det.reg;
  const res = SCAN.sampleGrid(frame, rect, r.sc.n);
  res.cells.forEach((c, i) => { labelAll++; if (SCAN.hueClass(c) === r.sc.face[i]) labelOk++; });
}

const summary = {
  seed,
  frames: scenarios.length,
  lockRate: hits.length / realRes.length,
  mosaicLockRate: mosaicRes.filter((r) => r.s.hit).length / mosaicRes.length,
  badFitRate: badFitsReal.length / realRes.length,
  badFitRateAdv: badFitsAdv.length / mosaicRes.length,
  falseLockRate: falseLocks.length / emptyReal.length,
  mosaicFalseLockRate: mosaicFalseLocks.length / emptyMosaic.length,
  oobLockRate: oobRes.filter((r) => r.capturable).length / oobRes.length,
  labelErrRate: labelAll ? 1 - labelOk / labelAll : 0,
  medianCenterErr: hits.map((r) => r.s.centerErr).sort((a, b) => a - b)[hits.length >> 1] ?? null,
  medianAngleErr: hits.map((r) => r.s.angleErr).sort((a, b) => a - b)[hits.length >> 1] ?? null,
  frames_per_scenario: FRAMES,
  msPerFrame: +(elapsed / (scenarios.length * FRAMES)).toFixed(1),
  pass: null,
};
// The adversarial cap is looser: on a wall of cube-like tiles a wrong box is
// recoverable (tracker confirm, capture gates and final solve validation all
// still stand behind it), while on realistic scenes it stays hard-capped.
summary.pass = summary.lockRate >= 0.9 && summary.badFitRate <= 0.02 && summary.badFitRateAdv <= 0.1 && summary.falseLockRate <= 0.02 && summary.oobLockRate <= 0.05 && summary.labelErrRate <= 0.03;

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log(`cube frames: ${cubeScen.length} (${realRes.length} realistic, ${mosaicRes.length} adversarial-mosaic)   cube-free frames: ${emptyScen.length}   (${summary.msPerFrame} ms/frame)`);
  console.log(`LOCK RATE:   ${pct(summary.lockRate)} realistic (target ≥ 90%) · ${pct(summary.mosaicLockRate)} on adversarial mosaic (informational)`);
  console.log(`BAD FITS:    ${pct(summary.badFitRate)} realistic (${badFitsReal.length}/${realRes.length}, target ≤ 2%) · ${pct(summary.badFitRateAdv)} adversarial (target ≤ 10%)`);
  const flBg = new Map();
  for (const r of falseLocks) flBg.set(r.sc.background, (flBg.get(r.sc.background) || 0) + 1);
  const flDetail = flBg.size ? `  [${[...flBg.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('  ')}]` : '';
  console.log(`FALSE LOCKS: ${pct(summary.falseLockRate)} realistic (${falseLocks.length}/${emptyReal.length}, target ≤ 2%)${flDetail}`
    + ` · ${pct(summary.mosaicFalseLockRate)} on adversarial mosaic (informational)`);
  const oobKinds = new Map();
  for (const r of oobRes.filter((x) => x.capturable)) oobKinds.set(r.sc.oob, (oobKinds.get(r.sc.oob) || 0) + 1);
  const oobDetail = oobKinds.size ? '  [' + [...oobKinds].map(([k, v]) => `${k}: ${v}`).join(', ') + ']' : '';
  console.log(`OUT-OF-ALLOWANCE: ${pct(summary.oobLockRate)} capturable (${oobRes.filter((r) => r.capturable).length}/${oobRes.length} tiny/far/tilted cubes, target ≤ 5%)${oobDetail}`);
  console.log(`COLOUR LABELS: ${pct(summary.labelErrRate)} misread on locked grids (${labelAll - labelOk}/${labelAll} cells, target ≤ 3%) — incl. white-balance casts`);
  if (summary.medianCenterErr !== null) {
    console.log(`median centre error ${pct(summary.medianCenterErr)} of size · median angle error ${summary.medianAngleErr.toFixed(1)}°`);
  }
  const dims = [
    ['by scale', (s) => s.scale],
    ['by tilt', (s) => s.angleDeg + '°'],
    ['by background', (s) => s.background],
    ['by cube size', (s) => s.n + 'x' + s.n],
    ['by cube style', (s) => s.style],
    ['by face mix', (s) => {
      if (s.solved) return 'solved';
      const c = {};
      let m = 0;
      for (const l of s.face) { c[l] = (c[l] || 0) + 1; if (c[l] > m) m = c[l]; }
      if (Object.keys(c).length === 2 && m === s.n * s.n / 2) return s.style + ':half';
      return m >= s.n * s.n * 0.55 ? s.style + ':heavy' : s.style + ':mixed';
    }],
    ['solved faces', (s) => (s.solved ? 'solved' : 'mixed')],
    ['layer align', (s) => (s.sticky ? 'sticky' : 'square')],
  ];
  for (const [name, fn] of dims) {
    const line = bucket(fn).map(([k, b]) => `${k}: ${pct(b.hit / b.total)}`).join('   ');
    console.log(`  ${name.padEnd(14)} ${line}`);
  }
  if (args.includes('--misses')) {
    const misses = cubeRes.filter((r) => !r.s.hit);
    const tally = (name, fn) => {
      const m = new Map();
      for (const r of misses) {
        const k = fn(r);
        m.set(k, (m.get(k) || 0) + 1);
      }
      console.log(`  miss ${name.padEnd(10)} ${[...m.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('   ')}`);
    };
    console.log(`misses: ${misses.length}`);
    tally('kind', (r) => (!r.s.detected ? 'no-detect' : 'bad-fit'));
    tally('plastic', (r) => (r.sc.plastic[0] < 128 ? 'black' : 'white'));
    tally('glare', (r) => (r.sc.glare ? 'glare' : 'clean'));
    tally('scale', (r) => r.sc.scale);
    tally('bg', (r) => r.sc.background);
    tally('style', (r) => r.sc.style);
    tally('style/bg', (r) => r.sc.style + ':' + r.sc.background);
    tally('style/scal', (r) => r.sc.style + ':' + r.sc.scale);
    const badTally = new Map();
    for (const r of badFits) badTally.set(r.sc.background, (badTally.get(r.sc.background) || 0) + 1);
    console.log(`  bad-fit by bg  ${[...badTally.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('   ')}`);
    // why do cluttered no-detects fail: nothing accepted, or guard-nulled?
    let guardNulled = 0, noAccepted = 0;
    for (const r of misses.filter((x) => !x.s.detected && x.sc.background === 'cluttered').slice(0, 25)) {
      const dbg = {};
      SCAN.detectFace(renderFrame(r.sc), r.sc.n, { debug: dbg });
      if ((dbg.accepted || []).length) guardNulled++;
      else noAccepted++;
    }
    console.log(`  cluttered no-detect sample: guard-nulled ${guardNulled} · nothing accepted ${noAccepted}`);
    for (const r of misses.filter((x) => x.s.detected).slice(0, 8)) {
      const { sc, det, s } = r;
      // re-run with debug to see the candidate pool the detector chose from
      const dbg = {};
      SCAN.detectFace(renderFrame(sc), sc.n, { debug: dbg });
      const cerrOf = (f) => Math.hypot(f.cx - sc.cx, f.cy - sc.cy) / sc.size;
      const cand = (dbg.accepted || []).map((f) => `${cerrOf(f).toFixed(2)}@${f.score?.toFixed(1) ?? 'won'}`).join(' ');
      console.log(`   bad-fit n=${sc.n} scale=${sc.scale} bg=${sc.background} plastic=${sc.plastic[0] < 128 ? 'blk' : 'wht'} `
        + `cerr=${s.centerErr.toFixed(2)} sratio=${s.sizeRatio.toFixed(2)} aerr=${s.angleErr.toFixed(1)} single=${!!det.single}`
        + `\n     candidates(cerr@score): ${cand}`);
    }
  }
  console.log(summary.pass ? 'PASS' : 'FAIL');
}
process.exit(summary.pass ? 0 : 1);
}

// ---------- corpus mode ----------
// Same detector, same tracker, same scoring; real photographed faces instead
// of drawn ones. Reported separately from the synthetic run because the two
// answer different questions — synthetic asks whether the geometry is right
// across the whole parameter space, corpus asks whether real cubes, with the
// branding and finishes that ship on them, survive that geometry.
function runCorpus() {
  const corpus = loadCorpus();
  if (!corpus || !corpus.faces.length) {
    console.log('no corpus yet — nothing to measure.\n');
    console.log('Build one (see tools/cube-corpus/README.md):');
    console.log('  node tools/cube-corpus/search.mjs      # find openly-licensed cube photos');
    console.log('  node tools/cube-corpus/fetch.mjs       # download them');
    console.log('  node tools/cube-corpus/serve.mjs       # label faces in the browser');
    console.log('  node tests/scan-harness.mjs --corpus   # then run this again');
    process.exit(0);
  }

  const scen = makeCorpusScenarios(seed, corpus.faces, W, H);
  scen.forEach((sc, i) => { if (sc.clutterNeeded) sc.clutterRects = clutterRects(rng(seed + i)); });

  const res = [];
  const t0 = Date.now();
  for (const sc of scen) {
    const out = runLive(() => renderCorpusFrame(sc, sampleBackground, W, H), sc.n);
    const track = out.locked
      ? { cx: out.reg.x + out.reg.size / 2, cy: out.reg.y + out.reg.size / 2, size: out.reg.size, angle: out.reg.angle }
      : null;
    const g = score(sc, track);
    res.push({ sc, det: track, s: g, col: g.hit ? scoreColors(SCAN, out.lastFrame, track, sc) : null });
  }
  const ms = Date.now() - t0;

  const hits = res.filter((r) => r.s.hit);
  const badFits = res.filter((r) => r.s.detected && !r.s.hit);
  const cols = hits.map((r) => r.col).filter(Boolean);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);
  const summary = {
    mode: 'corpus', seed, faces: corpus.faces.length, demoFaces: corpus.faces.filter((f) => f.demo).length, scenes: scen.length,
    lockRate: hits.length / res.length,
    badFitRate: badFits.length / res.length,
    tileAccuracy: mean(cols.map((c) => c.tileAccuracy).filter((v) => v !== null)),
    medianSeparability: median(cols.map((c) => c.separability).filter((v) => v !== null)),
    unseparableRate: cols.length ? cols.filter((c) => c.separability !== null && c.separability <= 1).length / cols.length : null,
    msPerFrame: +(ms / (scen.length * FRAMES)).toFixed(1),
  };

  if (asJson) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

  const pct = (x) => (x === null ? 'n/a' : (100 * x).toFixed(1) + '%');
  const demo = corpus.faces.filter((f) => f.demo).length;
  if (demo) {
    console.log(`!! ${demo} of ${corpus.faces.length} faces are DRAWN demo fixtures, not photographs.`);
    console.log('   These numbers exercise the pipeline; they do not measure real cubes.');
    console.log('   Build a real corpus with tools/cube-corpus/, then: node tools/cube-corpus/demo-corpus.mjs --clean\n');
  }
  console.log(`CORPUS: ${corpus.faces.length} ${demo ? 'demo' : 'photographed'} faces x ${scen.length / corpus.faces.length} scenes = ${scen.length} sequences  (${summary.msPerFrame} ms/frame)`);
  console.log(`LOCK RATE:   ${pct(summary.lockRate)}   BAD FITS: ${pct(summary.badFitRate)} (${badFits.length}/${res.length})`);
  console.log(`COLOUR READ: ${pct(summary.tileAccuracy)} of tiles read correctly on locked faces`);
  console.log(`             median separability ${summary.medianSeparability === null ? 'n/a' : summary.medianSeparability.toFixed(2)}`
    + ` · ${pct(summary.unseparableRate)} of locks are unseparable (\u2264 1: two colours closer than one colour is to itself)`);

  // The breakdowns are the point of the corpus: they say WHICH real-world
  // property costs the scanner, which a synthetic sweep cannot.
  const buckets = (keyFn) => {
    const m = new Map();
    for (const r of res) {
      for (const k of [].concat(keyFn(r.sc))) {
        if (!m.has(k)) m.set(k, { total: 0, hit: 0, tiles: [] });
        const b = m.get(k);
        b.total++;
        if (r.s.hit) { b.hit++; if (r.col && r.col.tileAccuracy !== null) b.tiles.push(r.col.tileAccuracy); }
      }
    }
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
  };
  const show = (name, keyFn) => {
    const line = buckets(keyFn)
      .map(([k, b]) => `${k}: ${pct(b.hit / b.total)} lock/${pct(mean(b.tiles))} read (n=${b.total})`)
      .join('   ');
    if (line) console.log(`  ${name.padEnd(12)} ${line}`);
  };
  show('by tag', (sc) => (sc.tags.length ? sc.tags : ['(untagged)']));
  show('by style', (sc) => sc.style);
  show('by cube size', (sc) => sc.n + 'x' + sc.n);
  show('by scale', (sc) => sc.scale);
  show('by tilt', (sc) => sc.angleDeg + '\u00b0');
  show('by backgrnd', (sc) => sc.background);

  // Worst faces by name: the shortlist to open and look at.
  const perFace = new Map();
  for (const r of res) {
    const k = r.sc.corpus.id;
    if (!perFace.has(k)) perFace.set(k, { total: 0, hit: 0, rec: r.sc.corpus });
    const b = perFace.get(k);
    b.total++; if (r.s.hit) b.hit++;
  }
  const worst = [...perFace.values()].sort((a, b) => a.hit / a.total - b.hit / b.total).slice(0, 8);
  console.log('  hardest faces:');
  for (const f of worst) {
    console.log(`    ${pct(f.hit / f.total).padStart(6)}  ${f.rec.face}  ${f.rec.style}`
      + `${f.rec.tags?.length ? ' [' + f.rec.tags.join(',') + ']' : ''}${f.rec.notes ? '  \u2014 ' + f.rec.notes : ''}`);
  }
  process.exit(0);
}
