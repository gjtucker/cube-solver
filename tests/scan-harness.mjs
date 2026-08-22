#!/usr/bin/env node
// Headless acceptance harness for the camera cube detector.
//
// Extracts the SCAN module out of index.html, renders synthetic camera frame
// sequences (a cube face at varying scale / tilt / position / lighting /
// glare / noise over varying backgrounds, fresh sensor noise every frame) and
// runs them through detectFace + the temporal tracker — the same pipeline the
// live scanner uses. Measures how often the tracker ends up LOCKED on the
// face, how accurately the lock reports centre/size/angle, and the false-lock
// rate on sequences with no cube in them.
//
//   node tests/scan-harness.mjs            # human-readable report
//   node tests/scan-harness.mjs --json     # machine-readable summary
//   node tests/scan-harness.mjs --seed 7   # different scenario set
//   node tests/scan-harness.mjs --frames 4 # shorter sequences (faster, default 8)
//
// A detection counts as a HIT when the reported square matches ground truth:
//   centre error < 15% of the true size, size within ±20%, angle within 7°
// (angle compared modulo 90°, since a square lattice repeats every quarter
// turn). Anything else returned by the detector is a MISS with a bad fit.
//
// Acceptance targets (the "done" bar agreed for the scanner):
//   - lock rate ≥ 90% on realistic frames (12–70% scale, ±30° tilt, clean or
//     irregular-clutter backgrounds; the adversarial "mosaic" background — a
//     perfect wall of sticker-sized squares — is reported separately, where
//     returning null is acceptable behaviour)
//   - bad-fit rate ≤ 2% on ALL cube frames (a confident box in the wrong
//     place is worse than no box: it captures wrong colours)
//   - false-lock rate ≤ 2% on realistic cube-free frames (false locks on the
//     mosaic wall — which genuinely contains cube-like lattices — are
//     reported separately as adversarial-informational)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- load SCAN out of index.html ----------
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('const SCAN = (() => {');
const endMark = "if (typeof module !== 'undefined') module.exports = SCAN;";
const end = html.indexOf(endMark);
if (start < 0 || end < 0) {
  console.error('could not find the SCAN module inside index.html');
  process.exit(2);
}
const src = html.slice(start, end);
const SCAN = new Function('performance', `${src}; return SCAN;`)(
  { now: () => Date.now() },
);

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
  cluttered: (x, y) => {
    // realistic desk clutter: irregular blocks of varied size, rows offset so
    // no global lattice emerges (papers, books, keyboards, shelves)
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

// ground truth + scene description -> RGBA frame
function renderFrame(sc) {
  const d = new Uint8ClampedArray(W * H * 4);
  const ca = Math.cos(sc.angle), sa = Math.sin(sc.angle);
  const n = sc.n, size = sc.size, cell = size / n;
  const stickerHalf = (cell * sc.stickerFrac) / 2;
  const half = size / 2;
  const bg = BACKGROUNDS[sc.background];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgbv;
      // rotate into face-local coords
      const dx = x - sc.cx, dy = y - sc.cy;
      const u = ca * dx + sa * dy, v = -sa * dx + ca * dy;
      if (sc.hasCube && Math.abs(u) <= half && Math.abs(v) <= half) {
        // inside the (square) face: plastic, unless within a sticker patch
        const col = Math.min(n - 1, Math.floor((u + half) / cell));
        const row = Math.min(n - 1, Math.floor((v + half) / cell));
        const cu = u + half - (col + 0.5) * cell, cv = v + half - (row + 0.5) * cell;
        if (Math.abs(cu) <= stickerHalf && Math.abs(cv) <= stickerHalf) {
          rgbv = STICKER_RGB[sc.face[row * n + col]];
        } else {
          rgbv = sc.plastic;
        }
      } else {
        rgbv = bg(x, y);
      }
      // lighting: global level + a left-right gradient
      const lum = sc.light * (1 + sc.gradient * ((x / W) - 0.5));
      let r = rgbv[0] * lum, g = rgbv[1] * lum, b = rgbv[2] * lum;
      // glare: additive white ellipse
      if (sc.glare) {
        const gx = (x - sc.glare.x) / sc.glare.rx, gy = (y - sc.glare.y) / sc.glare.ry;
        const q = gx * gx + gy * gy;
        if (q < 1) { const a = sc.glare.amp * (1 - q); r += a; g += a; b += a; }
      }
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
  } else {
    for (let i = 0; i < n * n; i++) face.push(LETTERS[Math.floor(rand() * 6)]);
  }
  return face;
}

// ---------- scenario generation ----------
function makeScenarios(seed) {
  const rand = rng(seed);
  const out = [];
  const minDim = Math.min(W, H);
  const scales = [0.12, 0.18, 0.25, 0.35, 0.5, 0.7];
  const angles = [0, 8, 15, 22, 30];
  const backgrounds = Object.keys(BACKGROUNDS);
  for (const n of [3, 2]) {
    for (const scale of scales) {
      for (const angleDeg of angles) {
        for (const background of backgrounds) {
          for (let variant = 0; variant < 3; variant++) {
            const size = scale * minDim;
            const solved = variant === 2 && rand() < 0.5;
            // keep the whole rotated face inside the central ~70% of the frame
            const reach = (size * Math.SQRT2) / 2;
            const mx = Math.max(1, W * 0.35 - reach), my = Math.max(1, H * 0.35 - reach);
            const glareOn = variant >= 1 && rand() < 0.5;
            const cx = W / 2 + (rand() * 2 - 1) * mx;
            const cy = H / 2 + (rand() * 2 - 1) * my;
            out.push({
              n, scale, angleDeg, background, solved, hasCube: true,
              cx, cy, size,
              angle: (angleDeg * Math.PI / 180) * (rand() < 0.5 ? -1 : 1),
              face: randomFace(n, rand, solved),
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
  // cube-free frames for the false-lock rate
  for (const background of backgrounds) {
    for (let i = 0; i < 25; i++) {
      out.push({
        n: 3, background, hasCube: false, cx: 0, cy: 0, size: 0, angle: 0,
        face: [], stickerFrac: 0, plastic: [0, 0, 0],
        light: 0.55 + rand() * 0.6, gradient: (rand() - 0.5) * 0.5,
        glare: null, noise: 2 + rand() * 10, rand,
      });
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
// noise, run through detectFace + the temporal tracker — exactly the pipeline
// the live scanner uses. What is scored is the LOCK the user would see at the
// end of the sequence, not a single-frame detection: a lock must confirm
// itself over consecutive frames, which is also what gates auto-capture.
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? +args[seedArg + 1] : 1;
const framesArg = args.indexOf('--frames');
const FRAMES = framesArg >= 0 ? +args[framesArg + 1] : 8;

const scenarios = makeScenarios(seed);
const cubeScen = scenarios.filter((s) => s.hasCube);
const emptyScen = scenarios.filter((s) => !s.hasCube);

const results = [];
const t0 = Date.now();
for (const sc of scenarios) {
  const tracker = SCAN.createTracker();
  let track = null;
  for (let f = 0; f < FRAMES; f++) {
    const frame = renderFrame(sc);
    const prefer = track ? { x: track.cx, y: track.cy } : { x: W / 2, y: H / 2 };
    const det = SCAN.detectFace(frame, sc.n, { prefer });
    track = tracker.update(det, f * 66);
  }
  results.push({ sc, det: track, s: sc.hasCube ? score(sc, track) : null });
}
const elapsed = Date.now() - t0;

const cubeRes = results.filter((r) => r.sc.hasCube);
const realRes = cubeRes.filter((r) => r.sc.background !== 'mosaic');
const mosaicRes = cubeRes.filter((r) => r.sc.background === 'mosaic');
const emptyRes = results.filter((r) => !r.sc.hasCube);
const emptyReal = emptyRes.filter((r) => r.sc.background !== 'mosaic');
const emptyMosaic = emptyRes.filter((r) => r.sc.background === 'mosaic');
const hits = realRes.filter((r) => r.s.hit);
const badFits = cubeRes.filter((r) => r.s.detected && !r.s.hit);
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

const summary = {
  seed,
  frames: scenarios.length,
  lockRate: hits.length / realRes.length,
  mosaicLockRate: mosaicRes.filter((r) => r.s.hit).length / mosaicRes.length,
  badFitRate: badFits.length / cubeRes.length,
  falseLockRate: falseLocks.length / emptyReal.length,
  mosaicFalseLockRate: mosaicFalseLocks.length / emptyMosaic.length,
  medianCenterErr: hits.map((r) => r.s.centerErr).sort((a, b) => a - b)[hits.length >> 1] ?? null,
  medianAngleErr: hits.map((r) => r.s.angleErr).sort((a, b) => a - b)[hits.length >> 1] ?? null,
  frames_per_scenario: FRAMES,
  msPerFrame: +(elapsed / (scenarios.length * FRAMES)).toFixed(1),
  pass: null,
};
summary.pass = summary.lockRate >= 0.9 && summary.badFitRate <= 0.02 && summary.falseLockRate <= 0.02;

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log(`cube frames: ${cubeScen.length} (${realRes.length} realistic, ${mosaicRes.length} adversarial-mosaic)   cube-free frames: ${emptyScen.length}   (${summary.msPerFrame} ms/frame)`);
  console.log(`LOCK RATE:   ${pct(summary.lockRate)} realistic (target ≥ 90%) · ${pct(summary.mosaicLockRate)} on adversarial mosaic (informational)`);
  console.log(`BAD FITS:    ${pct(summary.badFitRate)} (${badFits.length}/${cubeRes.length}, target ≤ 2%)`);
  const flBg = new Map();
  for (const r of falseLocks) flBg.set(r.sc.background, (flBg.get(r.sc.background) || 0) + 1);
  const flDetail = flBg.size ? `  [${[...flBg.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('  ')}]` : '';
  console.log(`FALSE LOCKS: ${pct(summary.falseLockRate)} realistic (${falseLocks.length}/${emptyReal.length}, target ≤ 2%)${flDetail}`
    + ` · ${pct(summary.mosaicFalseLockRate)} on adversarial mosaic (informational)`);
  if (summary.medianCenterErr !== null) {
    console.log(`median centre error ${pct(summary.medianCenterErr)} of size · median angle error ${summary.medianAngleErr.toFixed(1)}°`);
  }
  const dims = [
    ['by scale', (s) => s.scale],
    ['by tilt', (s) => s.angleDeg + '°'],
    ['by background', (s) => s.background],
    ['by cube size', (s) => s.n + 'x' + s.n],
    ['solved faces', (s) => (s.solved ? 'solved' : 'mixed')],
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
    const badTally = new Map();
    for (const r of badFits) badTally.set(r.sc.background, (badTally.get(r.sc.background) || 0) + 1);
    console.log(`  bad-fit by bg  ${[...badTally.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('   ')}`);
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
