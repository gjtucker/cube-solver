// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

(function(){
// Camera cube scanner — pure pipeline (DOM-free; the UI layer lives in the page).
//
// Design:
//  - Each captured face stores RAW mean RGB per cell, normalized per capture
//    by gray-world white balance (divide by the capture's mean channel).
//  - Live feedback uses a lenient hue-prior classifier (good enough to judge
//    stability); FINAL colors are decided globally across all 6 faces:
//      3x3: the six scanned face centers are the six reference colors
//           (protocol fixes which is which), and all 54 stickers are matched
//           to references under an exactly-9-per-color capacity constraint.
//      2x2/4x4: capacity-constrained k-means (exactly 4/16 per class),
//           seeded by hue buckets; letters are arbitrary for these cubes
//           since the solvers derive the color scheme themselves.
//  - Scan protocol (same physical motions for every cube size):
//      1..4: front, then keep turning the whole cube LEFT (top stays up)
//      5:    from the start position, tilt BACK  (top faces the camera)
//      6:    from the start position, tilt FORWARD (bottom faces the camera)
//    With this protocol every grid cell maps to its facelet directly.

const SCAN = (() => {
  // ---------- color math ----------
  function rgbToHsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d > 0) {
      if (mx === r) h = ((g - b) / d + 6) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
  }
  // feature space where euclidean distance behaves: chroma disk + value axis
  function featOf(rgb) {
    const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    const a = (h * Math.PI) / 180;
    return [s * Math.cos(a), s * Math.sin(a), v * 0.55];
  }
  function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  }

  // lenient hue-prior classifier (live feedback only)
  // returns one of U(yellow) D(white) F(green) B(blue) R(orange) L(red)
  // Bands are set for real cameras, not ideal colours: phone white balance
  // routinely drags yellow toward lime (field-measured yellow tiles at hue
  // 81–95 under warm indoor light), so yellow runs to 100 — true cube
  // greens sit at 110+ even under a cast. A warm cast also lifts white's
  // saturation, so the white cutoff is 0.34, above what warm-cast white
  // reaches (~0.31) but below any real sticker colour.
  function hueClass(rgb) {
    const { h, s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    if (v < 0.15) return null;             // too dark: probably not a sticker
    if (s < 0.34) return 'D';              // white
    if (h < 14 || h >= 335) return 'L';    // red
    if (h < 42) return 'R';                // orange
    if (h < 100) return 'U';               // yellow (incl. lime-shifted)
    if (h < 175) return 'F';               // green
    if (h < 275) return 'B';               // blue
    return 'L';                            // magenta-ish -> red
  }

  // gray-world normalization of one capture's samples (list of [r,g,b])
  function normalizeCapture(samples) {
    let mr = 0, mg = 0, mb = 0;
    for (const s of samples) { mr += s[0]; mg += s[1]; mb += s[2]; }
    const n = samples.length;
    mr /= n; mg /= n; mb /= n;
    const m = (mr + mg + mb) / 3;
    const gr = m / Math.max(1e-3, mr), gg = m / Math.max(1e-3, mg), gb = m / Math.max(1e-3, mb);
    // damp the correction (full gray-world overcorrects colorful scenes)
    const damp = (x) => 1 + (x - 1) * 0.55;
    const fr = damp(gr), fg = damp(gg), fb = damp(gb);
    return samples.map((s) => [
      Math.min(255, s[0] * fr), Math.min(255, s[1] * fg), Math.min(255, s[2] * fb),
    ]);
  }

  // gray-world normalisation across ALL captures at once: a whole cube has the
  // same number of stickers of every colour, so the pooled mean is a true gray
  // reference — unlike a single face, which may be mostly one colour.
  function normalizeAll(captures) {
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (const cap of captures) for (const s of cap) { mr += s[0]; mg += s[1]; mb += s[2]; n++; }
    if (!n) return captures;
    mr /= n; mg /= n; mb /= n;
    const m = (mr + mg + mb) / 3;
    const damp = (x) => 1 + (x - 1) * 0.55;
    const fr = damp(m / Math.max(1e-3, mr)), fg = damp(m / Math.max(1e-3, mg)), fb = damp(m / Math.max(1e-3, mb));
    return captures.map((cap) => cap.map((s) => [
      Math.min(255, s[0] * fr), Math.min(255, s[1] * fg), Math.min(255, s[2] * fb),
    ]));
  }

  // ---------- sampling a grid from raw pixel data ----------
  // px: {data: Uint8ClampedArray RGBA, width, height}
  // rect: {x, y, size, angle?} in px coords — a square whose top-left corner is
  //       (x, y) when angle is 0; `angle` (radians) rotates it about its centre.
  // returns { cells: [[r,g,b] x n*n], cellVar: [...], borderDarkRatio }
  function sampleGrid(px, rect, n) {
    const cells = [], cellVar = [];
    const cs = rect.size / n;
    const ang = rect.angle || 0, ca = Math.cos(ang), sa = Math.sin(ang);
    const ccx = rect.x + rect.size / 2, ccy = rect.y + rect.size / 2;
    // local square coords (0..size, unrotated) -> image coords
    const at = (lx, ly) => {
      const dx = lx - rect.size / 2, dy = ly - rect.size / 2;
      return [ccx + ca * dx - sa * dy, ccy + sa * dx + ca * dy];
    };
    const readPatch = (cx, cy, half) => {
      let r = 0, g = 0, b = 0, cnt = 0, lum2 = 0, lum1 = 0;
      const step = Math.max(1, Math.floor(half / 3));
      for (let dy = -half; dy <= half; dy += step) {
        for (let dx = -half; dx <= half; dx += step) {
          const X = Math.round(cx + dx), Y = Math.round(cy + dy);
          if (X < 0 || Y < 0 || X >= px.width || Y >= px.height) continue;
          const o = (Y * px.width + X) * 4;
          const R = px.data[o], G = px.data[o + 1], B = px.data[o + 2];
          r += R; g += G; b += B; cnt++;
          const l = (R + G + B) / 3;
          lum1 += l; lum2 += l * l;
        }
      }
      if (!cnt) return { rgb: [0, 0, 0], varr: 0, lum: 0 };
      const lm = lum1 / cnt;
      return { rgb: [r / cnt, g / cnt, b / cnt], varr: lum2 / cnt - lm * lm, lum: lm };
    };
    let cellLumSum = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const [cx, cy] = at((col + 0.5) * cs, (row + 0.5) * cs);
        const p = readPatch(cx, cy, cs * 0.22);
        cells.push(p.rgb);
        cellVar.push(p.varr);
        cellLumSum += p.lum;
      }
    }
    const cellLumAvg = cellLumSum / (n * n);
    // border darkness: sample midpoints of internal grid lines
    let darker = 0, checks = 0;
    for (let i = 1; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (const [cx, cy] of [
          at(i * cs, (j + 0.5) * cs),   // vertical line
          at((j + 0.5) * cs, i * cs),   // horizontal line
        ]) {
          const p = readPatch(cx, cy, cs * 0.06);
          checks++;
          if (p.lum < cellLumAvg * 0.82) darker++;
        }
      }
    }
    return { cells, cellVar, borderDarkRatio: checks ? darker / checks : 0 };
  }

  // 2×2 box downsample of an RGBA frame (the detector runs on a small frame)
  function downsample2(px) {
    const W = px.width >> 1, H = px.height >> 1, src = px.data;
    const out = new Uint8ClampedArray(W * H * 4);
    const rowBytes = px.width * 4;
    for (let y = 0; y < H; y++) {
      const r0 = 2 * y * rowBytes, r1 = r0 + rowBytes;
      for (let x = 0; x < W; x++) {
        const a = r0 + x * 8, b = r1 + x * 8, o = (y * W + x) * 4;
        out[o] = (src[a] + src[a + 4] + src[b] + src[b + 4]) >> 2;
        out[o + 1] = (src[a + 1] + src[a + 5] + src[b + 1] + src[b + 5]) >> 2;
        out[o + 2] = (src[a + 2] + src[a + 6] + src[b + 2] + src[b + 6]) >> 2;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: H };
  }

  // ---------- automatic face detection ----------
  // Finds the cube face in a small frame (~300–400 px wide works well).
  // Stickers show up as bright, evenly coloured blobs: bright pixels are
  // grouped into connected regions, splitting at the dark plastic gaps AND at
  // sharp colour edges (so stickerless cubes work too). Sticker-sized blobs
  // are then fitted with an n×n lattice (position, pitch, rotation). Same-
  // coloured neighbours that merged are split back into cells from their
  // shape. Falls back to one solid square (a solved face / single colour).
  // Returns {cx, cy, x, y, size, angle, count, total, single?} in px coords
  // (angle in radians about the square's centre, within ±45°), or null.
  function detectFace(px, n, opts) {
    opts = opts || {};
    const T0 = opts.debug ? performance.now() : 0;
    const W = px.width, H = px.height, N = W * H, d = px.data;
    const minDim = Math.min(W, H);
    // brightness = max channel: keeps darker stickers (blue, green, red) well above black plastic
    const V = new Uint8Array(N);
    for (let i = 0, o = 0; i < N; i++, o += 4) {
      const r = d[o], g = d[o + 1], b = d[o + 2];
      V[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
    }
    // local mean brightness via an integral image -> adaptive "bright" mask
    const IW = W + 1;
    const integ = new Float64Array(IW * (H + 1));
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x < W; x++) {
        run += V[y * W + x];
        integ[(y + 1) * IW + x + 1] = integ[y * IW + x + 1] + run;
      }
    }
    const half = Math.max(5, Math.round(minDim / 12));
    const mask = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(H, y + half + 1);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(W, x + half + 1);
        const sum = integ[y1 * IW + x1] - integ[y0 * IW + x1] - integ[y1 * IW + x0] + integ[y0 * IW + x0];
        const v = V[y * W + x];
        mask[y * W + x] = v > 35 && v * (y1 - y0) * (x1 - x0) > sum * 0.5 ? 1 : 0;
      }
    }
    // connected components of bright pixels (4-neighbour flood fill that does
    // not cross sharp colour edges) with shape moments
    const EDGE_T = 45;   // max |Δr|+|Δg|+|Δb| between neighbours of one region
    const label = new Int32Array(N);
    const stack = new Int32Array(N);
    const blobs = [];
    const minArea = Math.pow(minDim * 0.025, 2), maxArea = Math.pow(minDim * 0.75, 2);
    let nextId = 1;
    for (let start = 0; start < N; start++) {
      if (!mask[start] || label[start]) continue;
      const id = nextId++;
      let sp = 0;
      stack[sp++] = start; label[start] = id;
      let area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      let minx = W, maxx = -1, miny = H, maxy = -1, sr = 0, sg = 0, sb = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        const o = p * 4, pr = d[o], pg = d[o + 1], pb = d[o + 2];
        sr += pr; sg += pg; sb += pb;
        let q, qo;
        if (x > 0 && mask[q = p - 1] && !label[q] && (qo = q * 4, Math.abs(d[qo] - pr) + Math.abs(d[qo + 1] - pg) + Math.abs(d[qo + 2] - pb) <= EDGE_T)) { label[q] = id; stack[sp++] = q; }
        if (x < W - 1 && mask[q = p + 1] && !label[q] && (qo = q * 4, Math.abs(d[qo] - pr) + Math.abs(d[qo + 1] - pg) + Math.abs(d[qo + 2] - pb) <= EDGE_T)) { label[q] = id; stack[sp++] = q; }
        if (y > 0 && mask[q = p - W] && !label[q] && (qo = q * 4, Math.abs(d[qo] - pr) + Math.abs(d[qo + 1] - pg) + Math.abs(d[qo + 2] - pb) <= EDGE_T)) { label[q] = id; stack[sp++] = q; }
        if (y < H - 1 && mask[q = p + W] && !label[q] && (qo = q * 4, Math.abs(d[qo] - pr) + Math.abs(d[qo + 1] - pg) + Math.abs(d[qo + 2] - pb) <= EDGE_T)) { label[q] = id; stack[sp++] = q; }
      }
      if (area < minArea || area > maxArea) continue;
      const cx = sx / area, cy = sy / area;
      const cxx = sxx / area - cx * cx, cyy = syy / area - cy * cy, cxy = sxy / area - cx * cy;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = Math.max(1e-6, tr / 2 + disc), l2 = Math.max(1e-6, tr / 2 - disc);
      blobs.push({
        id, area, cx, cy, l1, l2,
        side: Math.sqrt(area),
        elong: Math.sqrt(l1 / l2),                      // 1 for a square, k for a k:1 rectangle
        phi: 0.5 * Math.atan2(2 * cxy, cxx - cyy),      // direction of the long axis
        compact: area / (12 * Math.sqrt(l1 * l2)),      // 1 for a solid rectangle
        fill: area / ((maxx - minx + 1) * (maxy - miny + 1)),
        minx, miny, maxx, maxy,
        edge: minx === 0 || miny === 0 || maxx === W - 1 || maxy === H - 1,
        rgb: [sr / area, sg / area, sb / area],
      });
    }

    // rotation of a square lattice from its points: circular mean of 4·angle
    // over neighbouring pairs (a square lattice repeats every 90°)
    function latticeAngle(pts, pitch) {
      let C = 0, S = 0, pairs = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
          const dd = Math.hypot(dx, dy);
          if (dd < pitch * 0.75 || dd > pitch * 1.25) continue;
          const th = Math.atan2(dy, dx);
          C += Math.cos(4 * th); S += Math.sin(4 * th); pairs++;
        }
      }
      return pairs ? Math.atan2(S, C) / 4 : null;
    }
    // fit an n×n lattice to a set of candidate sticker centres; seedPt is a
    // trusted sticker centre the lattice is anchored to, so points from a
    // second lattice in the scene (tiled backgrounds) cannot drag the phase
    function fitLattice(pts, pitch0, seedPt) {
      const m = pts.length;
      // nearest-neighbour distances -> pitch (grid neighbours sit one pitch apart)
      const nn = [];
      for (let i = 0; i < m; i++) {
        let bd = Infinity;
        for (let j = 0; j < m; j++) {
          if (j === i) continue;
          const dd = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
          if (dd < bd) bd = dd;
        }
        nn.push(bd);
      }
      nn.sort((a, b) => a - b);
      const nnPitch = nn[m >> 1];
      // two independent pitch estimates: the median neighbour distance (can be
      // outvoted by a lattice-like background) and the seed sticker's own size
      // (background-proof). When they disagree, try both — scoring arbitrates.
      const tries = [];
      if (nnPitch > pitch0 * 0.6 && nnPitch < pitch0 * 1.7) tries.push(nnPitch);
      if (!tries.some((p) => Math.abs(p - pitch0) < pitch0 * 0.12)) tries.push(pitch0);
      if (!tries.length) return null;
      let mx = 0, my = 0;
      for (const p of pts) { mx += p[0]; my += p[1]; }
      mx /= m; my /= m;
      const allFits = [];
      for (const startPitch of tries) {
        let pitch = startPitch;
        let angle = latticeAngle(pts, pitch);
        if (angle === null) continue;
        let ca, sa, rot, rs;
        const setAngle = (a) => {
          angle = a; ca = Math.cos(a); sa = Math.sin(a);
          rot = pts.map(([x, y]) => {
            const dx = x - mx, dy = y - my;
            return [ca * dx + sa * dy, -sa * dx + ca * dy];
          });
          rs = [
            ca * (seedPt[0] - mx) + sa * (seedPt[1] - my),
            -sa * (seedPt[0] - mx) + ca * (seedPt[1] - my),
          ];
        };
        setAngle(angle);
        // cell indices relative to the seed sticker (the lattice phase is
        // anchored there, so a second lattice in the scene cannot shift it)
        const reproject = () => {
          cells = rot.map((r) => [(r[0] - rs[0]) / pitch, (r[1] - rs[1]) / pitch]);
          inl = cells.map((c) => Math.abs(c[0] - Math.round(c[0])) < 0.3 && Math.abs(c[1] - Math.round(c[1])) < 0.3);
        };
        let cells = null, inl = null;
        for (let iter = 0; iter < 3; iter++) {
          reproject();
          // refine the pitch: least-squares slope of rotated coords vs integer cells, both axes
          let num = 0, den = 0;
          for (let k = 0; k < 2; k++) {
            let sA = 0, sB = 0, sAA = 0, sAB = 0, cnt = 0;
            cells.forEach((c, i) => {
              if (!inl[i]) return;
              const a = Math.round(c[k]), b = rot[i][k];
              sA += a; sB += b; sAA += a * a; sAB += a * b; cnt++;
            });
            if (cnt < 2) continue;
            num += sAB - (sA * sB) / cnt;
            den += sAA - (sA * sA) / cnt;
          }
          if (den > 1e-6) {
            const p2 = num / den;
            if (p2 > pitch * 0.7 && p2 < pitch * 1.3) pitch = p2;
          }
          // re-estimate the angle from inliers only, so points of a foreign
          // lattice (tiled backgrounds) cannot twist the fit
          const inPts = pts.filter((_, i) => inl[i]);
          if (inPts.length >= 3) {
            const a2 = latticeAngle(inPts, pitch);
            if (a2 !== null) setAngle(a2);
          }
        }
        reproject();
        const ints = cells.map((c) => [Math.round(c[0]), Math.round(c[1])]);
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        ints.forEach((c, i) => {
          if (!inl[i]) return;
          minU = Math.min(minU, c[0]); maxU = Math.max(maxU, c[0]);
          minV = Math.min(minV, c[1]); maxV = Math.max(maxV, c[1]);
        });
        if (!isFinite(minU)) continue;
        // enumerate the n×n windows over the stickers; when several hold nearly
        // as many stickers as the best one (a lattice-like background continues
        // past the face), all of them are returned and the caller arbitrates by
        // seam quality — position alone cannot tell them apart
        const aLo = Math.min(minU, maxU - (n - 1)), aHi = Math.max(minU, maxU - (n - 1));
        const bLo = Math.min(minV, maxV - (n - 1)), bHi = Math.max(minV, maxV - (n - 1));
        const wins = [];
        for (let a = aLo; a <= aHi; a++) {
          for (let b = bLo; b <= bHi; b++) {
            let cnt = 0;
            ints.forEach((c, i) => {
              if (inl[i] && c[0] >= a && c[0] < a + n && c[1] >= b && c[1] < b + n) cnt++;
            });
            const off = Math.abs(a - (aLo + aHi) / 2) + Math.abs(b - (bLo + bHi) / 2);
            wins.push({ a, b, cnt, off });
          }
        }
        wins.sort((p, q) => q.cnt - p.cnt || p.off - q.off);
        // lattice origin in rotated coords = mean residual of the inliers
        let ox = 0, oy = 0, cnt = 0;
        ints.forEach((c, i) => {
          if (!inl[i]) return;
          ox += rot[i][0] - c[0] * pitch; oy += rot[i][1] - c[1] * pitch; cnt++;
        });
        ox /= cnt; oy /= cnt;
        const size = n * pitch;
        for (const win of wins.filter((w, i) => i < 8 && w.cnt >= wins[0].cnt * 0.7)) {
          const rx = ox + (win.a + (n - 1) / 2) * pitch, ry = oy + (win.b + (n - 1) / 2) * pitch;
          const cx = mx + ca * rx - sa * ry, cy = my + sa * rx + ca * ry;
          allFits.push({ cx, cy, x: cx - size / 2, y: cy - size / 2, size, angle, count: win.cnt, total: n * n });
        }
      }
      return allFits;
    }

    if (opts.debug) opts.debug.tBlobs = performance.now() - T0;
    const pref = opts.prefer || { x: W / 2, y: H / 2 };
    // hard acquisition limits (opts.limits): in live scanning the cube is
    // roughly centred on the guide square, roughly upright, and reasonably
    // big — a candidate far away, tiny, or heavily tilted is background, and
    // refusing it outright beats letting a lattice-like wall win a fit.
    // {maxDist} is measured from `prefer`, which is the current track while
    // locked, so a cube may drift once acquired without losing the lock.
    const lim = opts.limits || null;
    const okLimits = (cx, cy, size, angle) => {
      if (!lim) return true;
      if (lim.maxDist && Math.hypot(cx - pref.x, cy - pref.y) > lim.maxDist) return false;
      if (lim.minSize && size < lim.minSize) return false;
      if (lim.maxSize && size > lim.maxSize) return false;
      if (lim.maxTilt !== undefined && Math.abs(angle || 0) > lim.maxTilt) return false;
      return true;
    };
    const solid = blobs.filter((b) => b.compact > 0.72 && b.compact < 1.3 && b.fill > 0.4);
    const singles = solid.filter((b) => b.elong <= 1.45);
    // cube-coloured blobs bigger than one sticker may be several merged cells
    const mergedAll = blobs.filter((b) => b.compact > 0.55 && b.compact < 1.3 && b.fill > 0.3 && hueClass(b.rgb) !== null);
    const minCount = Math.ceil(n * n * 0.55);
    if (opts.debug) Object.assign(opts.debug, { blobs, solid, fits: [] });
    // Split a merged blob into lattice cells, given the lattice angle and the
    // side of one clean sticker. The blob must span a whole number of cells
    // along both lattice axes and every cell must be either full or empty —
    // otherwise it isn't a block of stickers and null is returned.
    function splitBlob(b, ang, side) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      const pix = [];
      for (let y = b.miny; y <= b.maxy; y++) {
        for (let x = b.minx; x <= b.maxx; x++) {
          if (label[y * W + x] !== b.id) continue;
          const u = ca * x + sa * y, v = -sa * x + ca * y;
          if (u < u0) u0 = u;
          if (u > u1) u1 = u;
          if (v < v0) v0 = v;
          if (v > v1) v1 = v;
          pix.push(u, v);
        }
      }
      const eu = u1 - u0 + 1, ev = v1 - v0 + 1;
      const ku = Math.round(eu / side), kv = Math.round(ev / side);
      if (ku < 1 || kv < 1 || ku > n || kv > n || ku * kv < 2) return null;
      if (Math.abs(eu / side - ku) > 0.25 + 0.1 * ku || Math.abs(ev / side - kv) > 0.25 + 0.1 * kv) return null;
      const pu = eu / ku, pv = ev / kv;
      const counts = new Float64Array(ku * kv);
      for (let i = 0; i < pix.length; i += 2) {
        const iu = Math.min(ku - 1, Math.floor((pix[i] - u0) / pu));
        const iv = Math.min(kv - 1, Math.floor((pix[i + 1] - v0) / pv));
        counts[iu * kv + iv]++;
      }
      let mx = 0;
      for (const c of counts) if (c > mx) mx = c;
      const out = [];
      for (let iu = 0; iu < ku; iu++) {
        for (let iv = 0; iv < kv; iv++) {
          const c = counts[iu * kv + iv];
          if (c > mx * 0.3 && c < mx * 0.75) return null;   // half-covered cell: not a sticker block
          if (c < mx * 0.75) continue;
          const u = u0 + (iu + 0.5) * pu, v = v0 + (iv + 0.5) * pv;
          out.push([ca * u - sa * v, sa * u + ca * v]);
        }
      }
      return out;
    }
    // A real cube face shows a seam between neighbouring stickers: the plastic
    // gap (black on standard cubes, bright on white-plastic ones, a darker
    // crease on stickerless). A lattice hallucinated from a mosaic of touching
    // colour patches (posters, shelves, tiled screens) has no seams — every
    // boundary pixel belongs to one of its two neighbours. So a pair of
    // adjacent cells counts as seamed when the pixels between them differ in
    // colour from BOTH cells; a fit whose pairs are mostly seamless is not a
    // cube face.
    function rgbPatch(x, y, r) {
      const x0 = Math.max(0, Math.round(x - r)), x1 = Math.min(W - 1, Math.round(x + r));
      const y0 = Math.max(0, Math.round(y - r)), y1 = Math.min(H - 1, Math.round(y + r));
      if (x0 > x1 || y0 > y1) return null;
      let sr = 0, sg = 0, sb = 0, cnt = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const o = (yy * W + xx) * 4;
          sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; cnt++;
        }
      }
      return [sr / cnt, sg / cnt, sb / cnt];
    }
    function faceStats(fit) {
      const pitch = fit.size / n;
      const ca = Math.cos(fit.angle), sa = Math.sin(fit.angle);
      const at = (u, v) => [fit.cx + ca * u - sa * v, fit.cy + sa * u + ca * v];
      const cellR = Math.max(1, pitch * 0.18);
      const off = (k) => (k - (n - 1) / 2) * pitch;
      const l1 = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
      const cells = [], feats = [];
      let cubeLike = 0, cellCnt = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const p = at(off(i), off(j));
          const c = rgbPatch(p[0], p[1], cellR);
          cells.push(c);
          if (!c) continue;
          cellCnt++;
          feats.push(featOf(c));
          // stickers are saturated cube colours or clean white; background
          // clutter is mostly mid-saturation muddy colour
          const { s, v } = rgbToHsv(c[0], c[1], c[2]);
          if (v >= 0.12 && s >= 0.55) cubeLike++;
          else if (v >= 0.5 && s <= 0.32) cubeLike++;
          else if (v >= 0.12 && s < 0.55 && s > 0.32) cubeLike += 0.5;
        }
      }
      // a face draws its cells from at most 6 cube colours, so repeats are
      // guaranteed on a 3×3; a window over random surroundings reads mostly
      // distinct colours — count colour clusters (transitive linking)
      const cl = new Array(feats.length).fill(-1);
      let clusters = 0;
      for (let i = 0; i < feats.length; i++) {
        if (cl[i] !== -1) continue;
        cl[i] = clusters;
        for (let j = i + 1; j < feats.length; j++) {
          if (cl[j] === -1 && dist2(feats[i], feats[j]) < 0.25 * 0.25) cl[j] = cl[i];
        }
        clusters++;
      }
      let seamed = 0, checked = 0;
      const gapCols = [];
      for (let axis = 0; axis < 2; axis++) {
        for (let i = 0; i + 1 < n; i++) {
          for (let j = 0; j < n; j++) {
            const a = axis ? cells[j * n + i] : cells[i * n + j];
            const b = axis ? cells[j * n + i + 1] : cells[(i + 1) * n + j];
            if (!a || !b) continue;
            checked++;
            // 3 single-pixel probes along the seam line between the two cells
            let gappy = 0;
            for (const t of [-0.25, 0, 0.25]) {
              const mp = axis
                ? at(off(j) + t * pitch, off(i) + pitch / 2)
                : at(off(i) + pitch / 2, off(j) + t * pitch);
              const s = rgbPatch(mp[0], mp[1], 0);
              if (s && Math.min(l1(s, a), l1(s, b)) > 55) { gappy++; gapCols.push(s); }
            }
            if (gappy >= 2) seamed++;
          }
        }
      }
      // real seams are the cube's plastic, so they look alike face-wide: all
      // dark (black plastic, stickerless creases) or all clustered on one
      // colour (white plastic). Random third colours peeking between cells of
      // a cluttered background are neither.
      let meanCellMax = 0, mc = 0;
      for (const c of cells) if (c) { meanCellMax += Math.max(c[0], c[1], c[2]); mc++; }
      meanCellMax /= Math.max(1, mc);
      let seamConsistent = true;
      if (gapCols.length >= 4) {
        const dark = gapCols.filter((g) => Math.max(g[0], g[1], g[2]) < meanCellMax * 0.45).length;
        const med = [0, 1, 2].map((k) => gapCols.map((g) => g[k]).sort((x, y) => x - y)[gapCols.length >> 1]);
        const near = gapCols.filter((g) => l1(g, med) < 60).length;
        // plastic is unsaturated (black or white): a saturated "seam" colour
        // is some background showing between scattered objects, not a cube
        const mx = Math.max(med[0], med[1], med[2]), mn = Math.min(med[0], med[1], med[2]);
        const plasticLike = mx < meanCellMax * 0.45 || (mx > 0 && (mx - mn) / mx <= 0.45);
        seamConsistent = dark >= gapCols.length * 0.6 || (near >= gapCols.length * 0.6 && plasticLike);
      }
      // gapless stickerless cubes have no seams at all — same-colour tiles
      // touch invisibly — but their rounded tile corners expose a notch of
      // dark inner plastic at every interior 4-tile junction that matches
      // none of the four tiles. A flat mosaic background has flush square
      // corners: every junction pixel belongs to one of its tiles.
      let notched = 0, junctions = 0;
      const notchCols = [], notchRel = [];
      for (let i = 0; i + 1 < n; i++) {
        for (let j = 0; j + 1 < n; j++) {
          const c00 = cells[i * n + j], c10 = cells[(i + 1) * n + j];
          const c01 = cells[i * n + j + 1], c11 = cells[(i + 1) * n + j + 1];
          if (!c00 || !c10 || !c01 || !c11) continue;
          junctions++;
          const jp = at(off(i) + pitch / 2, off(j) + pitch / 2);
          // a real junction is where four tiles actually meet: its patch must
          // contain BOTH an alien notch pixel AND pixels matching at least
          // two distinct adjacent tiles. A patch buried inside some third
          // background block is all-alien and matches nothing.
          let worst = 0, wp = null, m00 = 0, m10 = 0, m01 = 0, m11 = 0;
          // the patch must span past the notch into the surrounding tiles,
          // whatever the scale — the notch itself grows with the pitch
          const pr = Math.max(1, Math.round(pitch * 0.22));
          const x0 = Math.max(0, Math.round(jp[0]) - pr), x1 = Math.min(W - 1, Math.round(jp[0]) + pr);
          const y0 = Math.max(0, Math.round(jp[1]) - pr), y1 = Math.min(H - 1, Math.round(jp[1]) + pr);
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              const o = (yy * W + xx) * 4;
              const p = [d[o], d[o + 1], d[o + 2]];
              const d00 = l1(p, c00), d10 = l1(p, c10), d01 = l1(p, c01), d11 = l1(p, c11);
              if (d00 < 55) m00 = 1;
              if (d10 < 55) m10 = 1;
              if (d01 < 55) m01 = 1;
              if (d11 < 55) m11 = 1;
              const m = Math.min(d00, d10, d01, d11);
              if (m > worst) { worst = m; wp = p; }
            }
          }
          if (worst > 65 && m00 + m10 + m01 + m11 >= 2) {
            notched++;
            notchCols.push(wp);
            // darkness relative to this junction's own four tiles — glare and
            // lighting gradients shift absolute brightness across the face,
            // but a plastic notch stays darker than its local surroundings
            const lm = (Math.max(c00[0], c00[1], c00[2]) + Math.max(c10[0], c10[1], c10[2])
              + Math.max(c01[0], c01[1], c01[2]) + Math.max(c11[0], c11[1], c11[2])) / 4;
            notchRel.push(Math.max(wp[0], wp[1], wp[2]) / Math.max(1, lm));
          }
        }
      }
      // real notches are the cube's inner plastic: all locally dark, or at
      // least all one colour. A random third tile of a cluttered background
      // peeking through a junction is neither.
      let cornerConsistent = true;
      if (notchCols.length >= 2) {
        const dark = notchRel.filter((r) => r < 0.6).length;
        const med = [0, 1, 2].map((k) => notchCols.map((g) => g[k]).sort((x, y) => x - y)[notchCols.length >> 1]);
        const near = notchCols.filter((g) => l1(g, med) < 60).length;
        cornerConsistent = dark >= notchCols.length * 0.75 || near >= notchCols.length * 0.75;
      } else if (notchCols.length === 1) {
        // a lone junction (2×2) can't vote on consistency — accept only the
        // classic dark-plastic notch, not an arbitrary alien colour
        cornerConsistent = notchRel[0] < 0.6;
      }
      return {
        seam: checked ? seamed / checked : 0,
        seamConsistent,
        corner: junctions ? notched / junctions : 0,
        cornerConsistent,
        cubeFrac: cellCnt ? cubeLike / cellCnt : 0,
        repeats: Math.max(0, cellCnt - clusters),
      };
    }
    // orientation of a blob made of grid-aligned tiles: the rotation that
    // minimises its bounding box. Colour-heavy faces on gapless cubes merge
    // most tiles into one polyomino, leaving too few clean singles for a
    // pair-based angle — but the polyomino's own box is lattice-aligned.
    function blobAngle(b) {
      const boundary = [];
      for (let y = b.miny; y <= b.maxy; y++) {
        for (let x = b.minx; x <= b.maxx; x++) {
          if (label[y * W + x] !== b.id) continue;
          if (x === 0 || y === 0 || x === W - 1 || y === H - 1
            || label[y * W + x - 1] !== b.id || label[y * W + x + 1] !== b.id
            || label[(y - 1) * W + x] !== b.id || label[(y + 1) * W + x] !== b.id) boundary.push([x, y]);
        }
      }
      if (boundary.length < 8) return null;
      let bestA = null, bestArea = Infinity;
      for (let deg = -45; deg < 45; deg += 1.5) {
        const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of boundary) {
          const u = c * x + s * y, v = -s * x + c * y;
          if (u < x0) x0 = u;
          if (u > x1) x1 = u;
          if (v < y0) y0 = v;
          if (v > y1) y1 = v;
        }
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        if (area < bestArea) { bestArea = area; bestA = a; }
      }
      return bestA;
    }
    let best = null;
    const accepted = [];         // every fit that survived the checks, for the ambiguity guard
    const covered = new Map();   // single -> unit area of the seed that already grouped it
    for (const seed of singles) {
      const unit = seed.area, side = seed.side;
      // a sticker already grouped by a seed of about the same size would just repeat that group
      const cov = covered.get(seed);
      if (cov && unit > cov * 0.7 && unit < cov * 1.4) continue;
      const pitch0 = side / 0.84;                       // sticker ≈ 84 % of the cell
      const R = pitch0 * ((n - 1) * 1.25 + 0.75);       // reach of one face from this sticker
      const near = (b) => Math.hypot(b.cx - seed.cx, b.cy - seed.cy) <= R;
      const pts = [], grouped = [];
      for (const b of singles) {
        const ratio = b.area / unit;
        if (ratio >= 0.5 && ratio <= 2 && near(b)) { pts.push([b.cx, b.cy]); grouped.push(b); }
      }
      const clean = pts.length;
      const merged = mergedAll.filter((b) => {
        const ratio = b.area / unit;
        return ratio > 1.5 && ratio < n * n * 1.3 && near(b);
      });
      if (merged.length) {
        // lattice angle from the clean stickers; when a colour-heavy face has
        // merged most tiles into one block, read the angle off that block's
        // own lattice-aligned bounding box instead
        let ang = clean >= 2 ? latticeAngle(pts, pitch0) : null;
        if (ang === null) {
          const big = merged.reduce((m, x) => (x.area > m.area ? x : m), merged[0]);
          ang = blobAngle(big);
        }
        if (ang !== null) {
          for (const b of merged) {
            const cells = splitBlob(b, ang, side);
            if (!cells) continue;
            for (const p of cells) {
              if (pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < side * 0.5)) continue;
              pts.push(p);
            }
          }
        }
      }
      if (pts.length < minCount) continue;
      if (n === 2 && clean < 2 && pts.length !== 4) continue;   // a lone 2×2 needs the full square
      const fits = fitLattice(pts, pitch0, [seed.cx, seed.cy]) || [];
      if (opts.debug) opts.debug.fits.push({ seed: [seed.cx, seed.cy, seed.area], pts, fit: fits[0] || null });
      let acceptedAny = false;
      for (const fit of fits) {
        if (fit.count < minCount) continue;
        if (clean < 2 && fit.count < 4) continue;
        if (!okLimits(fit.cx, fit.cy, fit.size, fit.angle)) continue;
        const st = faceStats(fit);
        // physical lattice evidence: sticker seams in one consistent plastic
        // colour (stickered cubes), OR corner notches at the tile junctions
        // (gapless stickerless cubes, which have no seams at all)
        const seamsOK = st.seam >= 0.5 && st.seamConsistent;
        const cornersOK = st.corner >= 0.5 && st.cornerConsistent;
        if (!seamsOK && !cornersOK) continue;      // no physical cube evidence
        if (n >= 3 && st.repeats < 2) continue;    // n² cells of ≤6 colours must repeat
        const evidence = Math.max(seamsOK ? st.seam : 0, st.corner);
        // more stickers, stronger evidence, cube-palette cells and repeated
        // colours win (a window shifted onto lattice-like background keeps
        // its count but loses seams/notches, palette and repeats); ties go
        // to the face nearest the preferred point
        const score = fit.count * (0.25 + evidence) * (0.4 + 0.6 * st.cubeFrac)
          * (0.7 + 0.075 * Math.min(4, st.repeats))
          - Math.hypot(fit.cx - pref.x, fit.cy - pref.y) / (4 * minDim);
        if (opts.debug) fit.st = st;
        accepted.push(Object.assign(fit, { score, evidence }));
        acceptedAny = true;
        if (!best || score > best.score) best = fit;
      }
      // only a seed that produced a plausible face claims its group — a failed
      // grouping must not stop those same stickers from seeding their own fit
      if (acceptedAny) for (const b of grouped) if (!covered.has(b)) covered.set(b, unit);
    }
    if (opts.debug) { opts.debug.tSeeds = performance.now() - T0; opts.debug.accepted = accepted; }
    if (best) {
      // ambiguity guard: on a background that itself looks like sticker
      // lattices (tiled walls, mosaics) several incompatible fits score about
      // the same — a confident box in the wrong place captures wrong colours,
      // so prefer "not found" over a coin flip
      // a strong-evidence best only yields to genuine near-ties; a shaky best
      // (weak evidence — think lattice-like backgrounds) yields to any solid
      // rival, because picking between them would be a coin flip
      const rivalThr = best.evidence >= 0.75 ? 0.88 : 0.7;
      for (const f of accepted) {
        if (f === best || f.score < best.score * rivalThr) continue;
        if (f.evidence < best.evidence - 0.15) continue;
        const apart = Math.hypot(f.cx - best.cx, f.cy - best.cy) > best.size * 0.3
          || f.size < best.size * 0.8 || f.size > best.size * 1.25;
        if (apart) return null;
      }
      delete best.score;
      delete best.evidence;
      return best;
    }

    // A face with NO clean single tiles never enters the seed loop at all —
    // e.g. a 4×4 gapless face that is half one colour, half another: every
    // tile merges into two big blocks and there is nothing to seed from.
    // Build a candidate from the union of the cube-coloured merged blocks:
    // orient by the largest block's lattice-aligned bounding box, take the
    // union's rotated bounding square, and demand the same physical evidence
    // (seams or corner notches, repeated colours) as any seeded fit.
    function rotBounds(b, ca, sa) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let y = b.miny; y <= b.maxy; y++) {
        for (let x = b.minx; x <= b.maxx; x++) {
          if (label[y * W + x] !== b.id) continue;
          const u = ca * x + sa * y, v = -sa * x + ca * y;
          if (u < u0) u0 = u;
          if (u > u1) u1 = u;
          if (v < v0) v0 = v;
          if (v > v1) v1 = v;
        }
      }
      return [u0, u1, v0, v1];
    }
    const bigMerged = mergedAll.filter((b) => !b.edge && b.side > minDim * 0.08);
    const unionLog = opts.debug ? (opts.debug.unionTries = []) : null;
    let uBest = null;
    for (const anchor of bigMerged.slice().sort((a, b) => b.area - a.area).slice(0, 8)) {
      const ang = blobAngle(anchor);
      if (ang === null) continue;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const bounds = new Map();
      const boundsOf = (b) => {
        let r = bounds.get(b);
        if (!r) { r = rotBounds(b, ca, sa); bounds.set(b, r); }
        return r;
      };
      // grow the union by adjacency: a face's blocks touch each other, while
      // desk clutter around the cube stands apart (and a mosaic wall chains
      // on forever, blowing the square check below)
      const members = new Set([anchor]);
      let [u0, u1, v0, v1] = boundsOf(anchor);
      let unionArea = anchor.area, grew = true;
      const gapTol = anchor.side * 0.12;
      while (grew) {
        grew = false;
        for (const b of bigMerged) {
          if (members.has(b)) continue;
          const [bu0, bu1, bv0, bv1] = boundsOf(b);
          if (bu0 > u1 + gapTol || bu1 < u0 - gapTol || bv0 > v1 + gapTol || bv1 < v0 - gapTol) continue;
          members.add(b);
          if (bu0 < u0) u0 = bu0;
          if (bu1 > u1) u1 = bu1;
          if (bv0 < v0) v0 = bv0;
          if (bv1 > v1) v1 = bv1;
          unionArea += b.area;
          grew = true;
        }
      }
      const w = u1 - u0 + 1, h = v1 - v0 + 1;
      if (unionLog) unionLog.push({ w, h, ratio: w / h, fill: unionArea / (w * h), ang });
      if (!(w / h > 0.8 && w / h < 1.25 && unionArea / (w * h) > 0.75
        && Math.min(w, h) > minDim * 0.11 && Math.max(w, h) < minDim * 0.95)) continue;
      const size = (w + h) / 2;
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const ucx = ca * cu - sa * cv, ucy = sa * cu + ca * cv;
      if (!okLimits(ucx, ucy, size, ang)) continue;
      const fit = { cx: ucx, cy: ucy, x: ucx - size / 2, y: ucy - size / 2, size, angle: ang, count: 0, total: n * n };
      const st = faceStats(fit);
      if (unionLog) unionLog[unionLog.length - 1].st = st;
      const seamsOK = st.seam >= 0.5 && st.seamConsistent;
      const cornersOK = st.corner >= 0.5 && st.cornerConsistent;
      if ((!seamsOK && !cornersOK) || (n >= 3 && st.repeats < 2)) continue;
      const evidence = Math.max(seamsOK ? st.seam : 0, st.corner);
      const score = (0.25 + evidence) * (0.4 + 0.6 * st.cubeFrac)
        * (0.7 + 0.075 * Math.min(4, st.repeats))
        - Math.hypot(ucx - pref.x, ucy - pref.y) / (4 * minDim);
      if (opts.debug) fit.st = st;
      if (!uBest || score > uBest.score) uBest = Object.assign(fit, { score });
    }
    if (uBest) {
      if (opts.debug) opts.debug.union = uBest;
      delete uBest.score;
      return uBest;
    }

    // fallback: one big, solid, square, cube-coloured blob without a crowd of
    // similar blobs around it (a solved face, or a single-colour face)
    const cand = solid
      .filter((b) => !b.edge && b.elong < 1.25 && b.compact > 0.85 && b.compact < 1.2
        && b.side > minDim * 0.26 && hueClass(b.rgb) !== null
        && solid.filter((o) => o !== b && o.area > b.area * 0.3 && o.area < b.area * 3 && o.elong < 1.3
          && Math.hypot(o.cx - b.cx, o.cy - b.cy) < b.side * 1.6).length < 2)
      .sort((a, b) => Math.hypot(a.cx - pref.x, a.cy - pref.y) - Math.hypot(b.cx - pref.x, b.cy - pref.y))[0];
    if (!cand) return null;
    const boundary = [];
    for (let p = 0; p < N; p++) {
      if (label[p] !== cand.id) continue;
      const x = p % W, y = (p - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1
        || label[p - 1] !== cand.id || label[p + 1] !== cand.id
        || label[p - W] !== cand.id || label[p + W] !== cand.id) boundary.push([x, y]);
    }
    // orientation = the rotation that minimises the blob's bounding box
    let bb = null;
    for (let deg = -45; deg < 45; deg += 1.5) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of boundary) {
        const u = c * x + s * y, v = -s * x + c * y;
        if (u < x0) x0 = u;
        if (u > x1) x1 = u;
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (!bb || w * h < bb.areaBB) bb = { a, w, h, areaBB: w * h, u: (x0 + x1) / 2, v: (y0 + y1) / 2 };
    }
    if (!bb || bb.w / bb.h < 0.8 || bb.w / bb.h > 1.25 || cand.area / bb.areaBB < 0.8) return null;
    const c = Math.cos(bb.a), s = Math.sin(bb.a);
    const cx = c * bb.u - s * bb.v, cy = s * bb.u + c * bb.v;
    const size = (bb.w + bb.h) / 2;
    if (!okLimits(cx, cy, size, bb.a)) return null;
    // even a plain (solved) face shows its lattice: gap lines on stickered
    // cubes, corner notches on gapless ones. A featureless cube-coloured
    // rectangle (a box, a book) shows neither — no lock.
    const st = faceStats({ cx, cy, size, angle: bb.a });
    if (!(st.seam >= 0.5 && st.seamConsistent) && !(st.corner >= 0.5 && st.cornerConsistent)) return null;
    return { cx, cy, x: cx - size / 2, y: cy - size / 2, size, angle: bb.a, count: 0, total: n * n, single: true };
  }

  // ---------- temporal tracker ----------
  const QUARTER = Math.PI / 4, HALF_PI = Math.PI / 2;
  const wrapAngle = (a) => ((((a + QUARTER) % HALF_PI) + HALF_PI) % HALF_PI) - QUARTER;
  // Smooths raw per-frame detections into a stable lock: a detection must
  // confirm itself over a few frames before it becomes the lock (one flaky
  // frame on a busy background must not flash a green box), the lock rides
  // through brief detection dropouts, and a single disagreeing frame can
  // never teleport it.
  function createTracker() {
    let t = null, cand = null;
    const CONFIRM = 3, HOLD_MS = 600, CAND_HOLD_MS = 400, A = 0.4;
    const compat = (tr, det) => Math.hypot(det.cx - tr.cx, det.cy - tr.cy) < tr.size * 0.5
      && det.size > tr.size * 0.7 && det.size < tr.size * 1.4;
    const blend = (tr, det, now) => {
      tr.cx += (det.cx - tr.cx) * A; tr.cy += (det.cy - tr.cy) * A; tr.size += (det.size - tr.size) * A;
      tr.angle = wrapAngle(tr.angle + wrapAngle((det.angle || 0) - tr.angle) * A);   // square: angles repeat every 90°
      tr.seen = now; tr.hits++;
      tr.count = det.count; tr.total = det.total; tr.single = !!det.single;
    };
    return {
      update(det, now) {
        if (det) {
          if (t && compat(t, det)) blend(t, det, now);
          else if (cand && compat(cand, det)) {
            blend(cand, det, now);
            if (cand.hits >= CONFIRM) { t = cand; cand = null; }
          } else {
            cand = {
              cx: det.cx, cy: det.cy, size: det.size, angle: det.angle || 0, seen: now, hits: 1,
              count: det.count, total: det.total, single: !!det.single,
            };
          }
        }
        if (cand && now - cand.seen > CAND_HOLD_MS) cand = null;
        if (t && now - t.seen > HOLD_MS) t = null;
        return t;
      },
      get track() { return t; },
      reset() { t = null; cand = null; },
    };
  }

  // ---------- scan protocol ----------
  // capture order maps to scheme faces; every cell maps to its facelet directly
  const PROTO_FACES = ['F', 'R', 'B', 'L', 'U', 'D'];
  const FACE_OFFSET = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
  function faceletIndex(mode, faceIdx, row, col) {
    const face = PROTO_FACES[faceIdx];
    if (mode === '4') return FACE_OFFSET[face] * 16 + row * 4 + col;
    if (mode === '2') return FACE_OFFSET[face] * 9 + [0, 2, 6, 8][row * 2 + col];
    return FACE_OFFSET[face] * 9 + row * 3 + col;
  }
  function gridN(mode) { return mode === '4' ? 4 : mode === '2' ? 2 : 3; }

  // instructions per capture step: title = which face to show, hint = how to
  // get there. {SIDE} is the side of the preview the next face comes from —
  // RIGHT normally, LEFT when the preview is mirrored (front camera).
  const STEPS3 = [
    { title: 'Green face', hint: 'Point the GREEN center at the camera, with the YELLOW center on top.' },
    { title: 'Orange face', hint: 'Keep yellow on top and give the cube a quarter turn so the face on the {SIDE} of the preview swings round to the front — ORANGE should now face the camera.' },
    { title: 'Blue face', hint: 'Same quarter turn again, yellow still on top — BLUE faces the camera.' },
    { title: 'Red face', hint: 'One more quarter turn the same way — RED faces the camera.' },
    { title: 'Yellow face (top)', hint: 'Go back to GREEN in front, then tip the TOP of the cube down toward the camera: YELLOW faces the camera and green points at the floor.' },
    { title: 'White face (bottom)', hint: 'Back to GREEN in front once more, then tip the BOTTOM of the cube up toward the camera: WHITE faces the camera and green points at the ceiling.' },
  ];
  const STEPS_REL = [
    { title: 'Front face', hint: 'Pick any face as FRONT and point it at the camera. Note which face is on TOP — it stays on top for the next three faces.' },
    { title: 'Right face', hint: 'Keep the same face on top and give the cube a quarter turn so the face on the {SIDE} of the preview swings round to the front.' },
    { title: 'Back face', hint: 'Same quarter turn again, same face on top.' },
    { title: 'Left face', hint: 'One more quarter turn the same way — that’s all four sides.' },
    { title: 'Top face', hint: 'Go back to your FRONT face, then tip the TOP of the cube down toward the camera so the top faces the lens.' },
    { title: 'Bottom face', hint: 'Back to FRONT once more, then tip the BOTTOM of the cube up toward the camera so the bottom faces the lens.' },
  ];
  function stepInfo(mode, i, opts) {
    const s = (mode === '3' ? STEPS3 : STEPS_REL)[i];
    const side = opts && opts.mirror ? 'LEFT' : 'RIGHT';
    return { title: s.title, hint: s.hint.replace('{SIDE}', side) };
  }

  // ---------- final global color assignment ----------
  // captures: array of 6 arrays of [r,g,b] (already normalized), row-major.
  // Returns array of 6 arrays of letters, or {error}.
  function assignColors(mode, captures) {
    const n = gridN(mode);
    const per = n * n;
    const all = [];
    captures.forEach((cap, f) => cap.forEach((rgb, i) => all.push({ f, i, feat: featOf(rgb), rgb })));
    const capacity = per; // exactly one face's worth of each color
    const LETTERS = ['U', 'R', 'F', 'D', 'L', 'B'];
    let refs; // 6 feature refs, index k means LETTERS-class k... resolved below
    let refLetters;
    if (mode === '3') {
      // references = the scanned centers; capture f's center IS scheme color of PROTO_FACES[f]
      const centerCell = 4; // row 1, col 1 of 3x3
      refs = captures.map((cap) => featOf(cap[centerCell]));
      refLetters = PROTO_FACES.slice(); // ref j -> letter PROTO_FACES[j]
    } else {
      // constrained k-means seeded by hue buckets. (Seeding from the canonical
      // palette after an exact palette white-balance was tried and A/B-measured
      // against this — it ties on ordinary casts and loses on extreme blue
      // ones, because data-derived seeds inherit the scan's actual exposure
      // while canonical seeds do not. See tests/assign-harness.mjs.)
      const buckets = { U: [], D: [], F: [], B: [], R: [], L: [] };
      for (const s of all) {
        const c = hueClass(s.rgb) || 'D';
        buckets[c].push(s.feat);
      }
      refs = [];
      refLetters = [];
      for (const c of LETTERS) {
        const arr = buckets[c];
        if (arr.length) {
          const m = [0, 0, 0];
          for (const f of arr) { m[0] += f[0]; m[1] += f[1]; m[2] += f[2]; }
          refs.push([m[0] / arr.length, m[1] / arr.length, m[2] / arr.length]);
        } else {
          refs.push(null); // fill later
        }
        refLetters.push(c);
      }
      // fill empty refs with farthest-point samples
      for (let k = 0; k < 6; k++) {
        if (refs[k]) continue;
        let best = null, bestD = -1;
        for (const s of all) {
          let dmin = Infinity;
          for (const r of refs) if (r) dmin = Math.min(dmin, dist2(s.feat, r));
          if (dmin > bestD) { bestD = dmin; best = s.feat; }
        }
        refs[k] = best.slice();
      }
    }

    const assign = () => {
      // greedy transportation: globally cheapest (sticker, class) first
      const pairs = [];
      all.forEach((s, si) => {
        for (let k = 0; k < 6; k++) pairs.push([dist2(s.feat, refs[k]), si, k]);
      });
      pairs.sort((a, b) => a[0] - b[0]);
      const label = new Array(all.length).fill(-1);
      const count = [0, 0, 0, 0, 0, 0];
      let assigned = 0;
      for (const [, si, k] of pairs) {
        if (label[si] !== -1 || count[k] >= capacity) continue;
        label[si] = k;
        count[k]++;
        assigned++;
        if (assigned === all.length) break;
      }
      return label;
    };

    let label = assign();
    // refine (helps the k-means path; harmless for the centers path)
    for (let iter = 0; iter < (mode === '3' ? 1 : 5); iter++) {
      const sums = refs.map(() => [0, 0, 0, 0]);
      all.forEach((s, si) => {
        const k = label[si];
        sums[k][0] += s.feat[0]; sums[k][1] += s.feat[1]; sums[k][2] += s.feat[2]; sums[k][3]++;
      });
      if (mode !== '3') {
        for (let k = 0; k < 6; k++) {
          if (sums[k][3]) refs[k] = [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]];
        }
      }
      // local improvement: profitable swaps between pairs of stickers
      let improved = true, guard = 0;
      while (improved && guard++ < 40) {
        improved = false;
        for (let a = 0; a < all.length; a++) {
          for (let b = a + 1; b < all.length; b++) {
            const ka = label[a], kb = label[b];
            if (ka === kb) continue;
            const cur = dist2(all[a].feat, refs[ka]) + dist2(all[b].feat, refs[kb]);
            const swp = dist2(all[a].feat, refs[kb]) + dist2(all[b].feat, refs[ka]);
            if (swp + 1e-9 < cur) { label[a] = kb; label[b] = ka; improved = true; }
          }
        }
      }
    }

    // 3x3 sanity: each capture's center must map to its protocol color
    if (mode === '3') {
      for (let f = 0; f < 6; f++) {
        const centerIdx = f * 9 + 4;
        if (refLetters[label[centerIdx]] !== PROTO_FACES[f]) {
          // force it (the review step lets the user correct outliers)
          label[centerIdx] = refLetters.indexOf(PROTO_FACES[f]);
        }
      }
    }

    const out = captures.map(() => new Array(per));
    all.forEach((s, si) => { out[s.f][s.i] = refLetters[label[si]]; });
    return out;
  }

  // write scanned letters into a paint state array
  function applyToPaint(mode, letters, paint) {
    const n = gridN(mode);
    for (let f = 0; f < 6; f++) {
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          paint[faceletIndex(mode, f, row, col)] = letters[f][row * n + col];
        }
      }
    }
    return paint;
  }

  // ---------- scan-order repair ----------
  // The six captures are meant to be F, R, B, L, U, D in that order, each the
  // right way up. If the cube was turned the wrong way round (or the top /
  // bottom tipped the other way), every face is individually right but sits
  // in the wrong slot and/or rotated. Only one arrangement makes a valid cube
  // (up to whole-cube symmetry), so search the arrangements closest to the
  // protocol for a valid one.
  //   letters: 6 grids (row-major) as produced by assignColors.
  //   isValid(paint): engine validity check (pieces + parity).
  // Returns { letters, perm, rots, moved, rotated, found }: perm[f] = slot the
  // f-th capture belongs at, rots[f] = quarter turns clockwise it needs.
  function rotateGrid(g, n, r) {
    let out = g;
    for (let k = 0; k < ((r % 4) + 4) % 4; k++) {
      const nx = new Array(n * n);
      for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) nx[col * n + (n - 1 - row)] = out[row * n + col];
      out = nx;
    }
    return out;
  }
  const PERMS_BY_MOVED = (() => {
    const groups = [[], [], [], [], [], [], []];
    const rec = (arr, used) => {
      if (arr.length === 6) { groups[arr.filter((v, i) => v !== i).length].push(arr.slice()); return; }
      for (let v = 0; v < 6; v++) if (!used[v]) { used[v] = 1; arr.push(v); rec(arr, used); arr.pop(); used[v] = 0; }
    };
    rec([], []);
    return groups;
  })();
  const ROTS_BY_COUNT = (() => {
    const groups = [[], [], [], [], [], [], []];
    for (let code = 0; code < 4096; code++) {
      const rots = [0, 1, 2, 3, 4, 5].map((f) => (code >> (2 * f)) & 3);
      groups[rots.filter((r) => r).length].push(rots);
    }
    return groups;
  })();
  function arrangeLetters(mode, letters, perm, rots) {
    const n = gridN(mode);
    // 3x3 letters are named after the capture that provided the reference
    // centre, so a capture that moves to another slot takes that slot's letter
    const relabel = {};
    if (mode === '3') for (let f = 0; f < 6; f++) relabel[PROTO_FACES[f]] = PROTO_FACES[perm[f]];
    const out = new Array(6);
    for (let f = 0; f < 6; f++) {
      const g = mode === '3' ? letters[f].map((l) => relabel[l]) : letters[f];
      out[perm[f]] = rotateGrid(g, n, rots[f]);
    }
    return out;
  }
  function bitCount(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }
  function repairOrder(mode, letters, isValid, opts) {
    opts = opts || {};
    const budget = opts.budget || 40000, deadline = Date.now() + (opts.timeLimit || 1500);
    const paintSize = mode === '4' ? 96 : 54;
    let evals = 0;
    const check = (perm, rots) => {
      evals++;
      const paint = new Array(paintSize).fill('X');
      applyToPaint(mode, arrangeLetters(mode, letters, perm, rots), paint);
      return isValid(paint);
    };
    // the slips people actually make, tried first in every combination: going
    // round the cube the other way (R and L swapped), tipping the top or the
    // bottom the wrong way (that face upside down), tipping forward before back
    // (U and D swapped). Cubes without fixed centres can have several valid
    // arrangements, so this ordering matters.
    const SLIPS = [
      (perm, rots) => { [perm[1], perm[3]] = [perm[3], perm[1]]; },
      (perm, rots) => { rots[4] = (rots[4] + 2) % 4; },
      (perm, rots) => { rots[5] = (rots[5] + 2) % 4; },
      (perm, rots) => { [perm[4], perm[5]] = [perm[5], perm[4]]; },
    ];
    const subsets = [];
    for (let mask = 0; mask < 1 << SLIPS.length; mask++) subsets.push(mask);
    subsets.sort((a, b) => bitCount(a) - bitCount(b));
    for (const mask of subsets) {
      const perm = [0, 1, 2, 3, 4, 5], rots = [0, 0, 0, 0, 0, 0];
      SLIPS.forEach((slip, i) => { if (mask & (1 << i)) slip(perm, rots); });
      if (check(perm, rots)) {
        const moved = perm.filter((v, i) => v !== i).length, rotated = rots.filter((r) => r).length;
        return { letters: arrangeLetters(mode, letters, perm, rots), perm, rots, moved, rotated, found: true, evals };
      }
    }
    for (let d = 0; d <= 12; d++) {
      for (let m = Math.min(d, 6); m >= 0; m--) {
        const r = d - m;
        if (m === 1 || r > 6) continue;             // a single capture can't move alone
        for (const perm of PERMS_BY_MOVED[m]) {
          for (const rots of ROTS_BY_COUNT[r]) {
            if (evals >= budget || Date.now() > deadline) return { letters, found: false, evals };
            if (check(perm, rots)) {
              return { letters: arrangeLetters(mode, letters, perm, rots), perm, rots, moved: m, rotated: r, found: true, evals };
            }
          }
        }
      }
    }
    return { letters, found: false, evals };
  }
  // Scheme-free corner sanity for cubes without fixed centres: the colours
  // that never share a corner are opposites; two corners sharing two colours
  // must carry them in opposite cyclic order (else a piece is mirrored); and
  // the twists along any axis must sum to a multiple of three.
  const CORNER_CW = ['URF', 'UFL', 'ULB', 'UBR', 'DFR', 'DLF', 'DBL', 'DRB'];
  function cornersConsistent(paint, corners) {
    const trips = [];
    for (const c of corners) {
      const faces = Object.keys(c.stickers);
      const order = CORNER_CW.find((o) => faces.every((f) => o.includes(f)));
      if (!order) return false;
      trips.push(order.split('').map((f) => paint[c.stickers[f]]));
    }
    const colors = [...new Set(trips.flat())];
    if (colors.length !== 6) return false;
    const together = {};
    for (const t of trips) for (const a of t) for (const b of t) together[a + b] = 1;
    const opp = {};
    for (const a of colors) {
      const os = colors.filter((b) => b !== a && !together[a + b]);
      if (os.length !== 1) return false;
      opp[a] = os[0];
    }
    const cyc = (t, a, b) => (t.indexOf(b) - t.indexOf(a) + 3) % 3;
    for (let i = 0; i < trips.length; i++) {
      for (let j = i + 1; j < trips.length; j++) {
        const shared = trips[i].filter((c) => trips[j].includes(c));
        if (shared.length === 2 && cyc(trips[i], shared[0], shared[1]) === cyc(trips[j], shared[0], shared[1])) return false;
      }
    }
    const ax = colors[0], ax2 = opp[ax];
    let twist = 0;
    for (const t of trips) {
      const idx = t.findIndex((c) => c === ax || c === ax2);
      if (idx < 0 || t.filter((c) => c === ax || c === ax2).length !== 1) return false;
      twist += idx;
    }
    return twist % 3 === 0;
  }

  // The live scanner's acquisition allowance. Deliberately tight: the user
  // is shown a guide square, so a legitimate cube is close to its centre,
  // within ±20% of its size, and nearly upright — anything else is
  // background, and refusing it outright beats letting a lattice-like wall
  // win a fit. opts.guideSize is the on-screen guide square mapped into
  // detector coordinates (default ~0.55 of the frame's short side);
  // opts.lockedSize is the current track's size when locked, which widens
  // the size band and tilt so a cube may drift/approach once acquired
  // without losing the lock (position drift is already allowed because
  // {maxDist} is measured from `prefer` = the current track).
  function liveLimits(w, h, opts) {
    const md = Math.min(w, h);
    const nominal = Math.min(md * 0.8, Math.max(md * 0.3, (opts && opts.guideSize) || md * 0.55));
    const locked = opts && opts.lockedSize;
    return {
      maxDist: nominal * 0.25,
      minSize: locked ? Math.min(nominal * 0.8, locked * 0.7) : nominal * 0.8,
      maxSize: locked ? Math.max(nominal * 1.2, locked * 1.3) : nominal * 1.2,
      maxTilt: ((locked ? 20 : 15) * Math.PI) / 180,
    };
  }

  return {
    rgbToHsv, featOf, dist2, hueClass, normalizeCapture, normalizeAll, sampleGrid, downsample2, detectFace,
    createTracker, wrapAngle, liveLimits,
    PROTO_FACES, faceletIndex, gridN, stepInfo, assignColors, applyToPaint,
    rotateGrid, arrangeLetters, repairOrder, cornersConsistent,
  };
})();

if (typeof module !== 'undefined') module.exports = SCAN;
if (typeof globalThis !== 'undefined') globalThis.SCAN = SCAN;

})();
