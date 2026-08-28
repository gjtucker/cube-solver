// Quad proposer — guesses the four corners of a cube face in a photo.
//
// Deliberately NOT scan.js. If the corpus were labelled by the detector under
// test, it could only ever contain images that detector already handles, and
// the hard cases — the logo caps and gapless faces we went looking for —
// would quietly filter themselves out. So this is a separate, much more
// permissive finder: colour-class blobs, keep the ones that look like a wall
// of similarly-sized patches, take the extreme points of that cluster. It has
// no evidence gates and no lattice fit, and it is allowed to be wrong: its
// only job is to land close enough that correcting it is a drag, not a
// four-click chore.
//
// Runs in both the browser (annotator) and Node (tests).

// canonical cube hues, degrees
const HUES = [[0, 'R'], [28, 'O'], [55, 'Y'], [130, 'G'], [215, 'B']];

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [(h + 360) % 360, mx ? d / mx : 0, mx];
}

// -> class 0..5 (five hues + white), or -1 for "not a sticker colour"
function classify(r, g, b) {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (v < 0.14) return -1;                       // shadow / black plastic
  if (s < 0.20) return v > 0.55 ? 5 : -1;        // white tile vs grey background
  if (s < 0.28 && v < 0.75) return -1;
  let best = -1, bestD = 1e9;
  for (let i = 0; i < HUES.length; i++) {
    let d = Math.abs(h - HUES[i][0]);
    if (d > 180) d = 360 - d;
    if (d < bestD) { bestD = d; best = i; }
  }
  return bestD <= 26 ? best : -1;
}

function boxDownsample(img, maxW) {
  const { data, width, height } = img;
  const step = Math.max(1, Math.ceil(width / maxW));
  if (step === 1) return { data, width, height, step: 1 };
  const w = Math.floor(width / step), h = Math.floor(height / step);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < step; dy++) {
        for (let dx = 0; dx < step; dx++) {
          const o = ((y * step + dy) * width + (x * step + dx)) * 4;
          r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h, step };
}

export function proposeQuad(img) {
  const sm = boxDownsample(img, 320);
  const { width: W, height: H, data } = sm;
  const N = W * H;

  const cls = new Int8Array(N);
  for (let i = 0; i < N; i++) cls[i] = classify(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);

  // ---- connected components of equal class (4-connectivity, iterative) ----
  const label = new Int32Array(N).fill(-1);
  const comps = [];
  const stack = new Int32Array(N);
  for (let seed = 0; seed < N; seed++) {
    if (cls[seed] < 0 || label[seed] >= 0) continue;
    const id = comps.length;
    const k = cls[seed];
    let sp = 0, area = 0, sx = 0, sy = 0;
    let minX = W, maxX = -1, minY = H, maxY = -1;
    stack[sp++] = seed; label[seed] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && cls[p - 1] === k && label[p - 1] < 0) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && cls[p + 1] === k && label[p + 1] < 0) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && cls[p - W] === k && label[p - W] < 0) { label[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && cls[p + W] === k && label[p + W] < 0) { label[p + W] = id; stack[sp++] = p + W; }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    comps.push({ id, cls: k, area, cx: sx / area, cy: sy / area, minX, maxX, minY, maxY, bw, bh });
  }

  // ---- keep patch-shaped components ----
  const maxArea = N / 6;
  let cand = comps.filter((c) => {
    if (c.area < 24 || c.area > maxArea) return false;
    if (c.area / (c.bw * c.bh) < 0.45) return false;       // solid, not stringy
    const ar = c.bw / c.bh;
    return ar > 0.35 && ar < 2.85;
  });
  if (cand.length < 4) return null;

  // ---- keep the ones near the median size: a face is a wall of equals ----
  const areas = cand.map((c) => c.area).sort((a, b) => a - b);
  const med = areas[areas.length >> 1];
  cand = cand.filter((c) => c.area >= med * 0.3 && c.area <= med * 3.2);
  if (cand.length < 4) return null;

  // ---- spatial clustering (union-find over near neighbours) ----
  const reach = Math.sqrt(med) * 2.3;
  const parent = cand.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const dx = cand[i].cx - cand[j].cx, dy = cand[i].cy - cand[j].cy;
      if (dx * dx + dy * dy <= reach * reach) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  }
  const groups = new Map();
  cand.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  // biggest by covered area, not by member count: a face of nine big stickers
  // beats a scatter of twenty small background specks.
  let best = null, bestScore = 0;
  for (const g of groups.values()) {
    if (g.length < 4) continue;
    const s = g.reduce((a, c) => a + c.area, 0);
    if (s > bestScore) { bestScore = s; best = g; }
  }
  if (!best) return null;

  // ---- corners from a minimum-area rectangle over patch centroids ----
  // Centroids, not bounding boxes: a sticker's axis-aligned bbox grows with
  // tilt, so a box-based fit drifts outward exactly when the face is rotated.
  // Centroids are tilt-neutral, and the rectangle that hugs them is the face
  // inset by half a cell on every side — which we can measure and add back.
  const P = best.map((c) => [c.cx, c.cy]);

  // convex hull (monotone chain)
  const hull = (() => {
    const pts = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const build = (arr) => {
      const st = [];
      for (const q of arr) {
        while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], q) <= 0) st.pop();
        st.push(q);
      }
      st.pop();
      return st;
    };
    return build(pts).concat(build(pts.slice().reverse()));
  })();
  if (hull.length < 3) return null;

  // rotating calipers: the min-area rectangle is flush with some hull edge
  let bestRect = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ux = ex / len, uy = ey / len;          // edge direction
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of P) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!bestRect || area < bestRect.area) bestRect = { area, ux, uy, u0, u1, v0, v1 };
  }
  if (!bestRect) return null;

  // half a cell, measured as the median nearest-neighbour centroid spacing:
  // that distance IS the lattice pitch, whatever n turns out to be.
  const nn = P.map((p, i) => {
    let d = Infinity;
    for (let j = 0; j < P.length; j++) {
      if (j === i) continue;
      const dx = P[j][0] - p[0], dy = P[j][1] - p[1];
      d = Math.min(d, Math.hypot(dx, dy));
    }
    return d;
  }).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  const cell = nn.length ? nn[nn.length >> 1] : Math.sqrt(med);
  const pad = cell / 2;

  const { ux, uy } = bestRect;
  const u0 = bestRect.u0 - pad, u1 = bestRect.u1 + pad;
  const v0 = bestRect.v0 - pad, v1 = bestRect.v1 + pad;
  const toXY = (u, v) => [u * ux - v * uy, u * uy + v * ux];
  let quad = [toXY(u0, v0), toXY(u1, v0), toXY(u1, v1), toXY(u0, v1)];

  // order TL, TR, BR, BL in image space so downstream stages agree on which
  // corner is which (the caliper frame can start from any hull edge)
  const gx = quad.reduce((a, p) => a + p[0], 0) / 4;
  const gy = quad.reduce((a, p) => a + p[1], 0) / 4;
  quad = quad
    .map((p) => ({ p, a: Math.atan2(p[1] - gy, p[0] - gx) }))
    .sort((A, B) => A.a - B.a)
    .map((e) => e.p);
  let k = 0;
  for (let i = 1; i < 4; i++) {
    if (quad[i][0] + quad[i][1] < quad[k][0] + quad[k][1]) k = i;
  }
  quad = [quad[k], quad[(k + 1) % 4], quad[(k + 2) % 4], quad[(k + 3) % 4]];

  // Confidence, so the annotator can flag the ones worth a careful look
  // rather than making every image feel equally suspect. Two things sink it:
  // too few patches for any plausible n, and patches that do not fill the
  // rectangle they supposedly tile (the white-on-white failure, where white
  // stickers merge into a white body and the survivors huddle in one corner).
  const rectW = u1 - u0, rectH = v1 - v0;
  const cellsAcross = Math.max(1, Math.round(rectW / cell)) * Math.max(1, Math.round(rectH / cell));
  const fill = Math.min(1, best.length / cellsAcross);
  const squareness = Math.min(rectW, rectH) / Math.max(rectW, rectH);
  const confidence = Math.max(0, Math.min(1, fill * squareness * (best.length >= 4 ? 1 : 0.4)));

  const s = sm.step;
  return {
    corners: quad.map(([x, y]) => [x * s, y * s]),
    patches: best.length,
    cell: cell * s,
    confidence,
    coverage: bestScore / N,
  };
}

// 8-DOF homography mapping the unit-ish dst square onto the src quad, so a
// rectifier can walk destination pixels and pull from the source.
export function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [X, Y] = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export { classify as classifyStickerColor, rgbToHsv as hsv };
