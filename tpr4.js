// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

(function(){
// Phased-reduction solver for the 4x4: a chain of nested move-set
// restrictions (Thistlethwaite's idea) so later phases structurally cannot
// undo earlier ones.
//
//   Phase 1 (all 36 moves):        U/D-axis center pieces onto the U∪D faces.
//                                  Exact distance table over C(24,8)=735,471.
//   Phase 2 (28-move set):         L/R-axis centers onto L∪R (⇒ F/B done too).
//                                  Exact table over C(16,8)=12,870.
//   Phase 3 (24-move set: outer +  Finish: sort centers exactly AND pair all
//            double slices only):  edges. Two engines: the original beam
//                                  search scored by exact sub-tables (fast to
//                                  build, ~8-10 moves off optimal), and the
//                                  exact IDA* "deep engine" further down.
//
// ATTRIBUTION. Phases 1-2 and the beam phase 3 are this project's own design.
// The deep engine follows the algorithm of Chen Shuang's TPR-4x4x4-Solver
// (https://github.com/cs0x7f/TPR-4x4x4-Solver), itself built on Charles
// Tsai's 8-step method. TPR is GPL-licensed Java; none of its source is used
// here. This is an independent JavaScript implementation written from a prose
// description of the algorithm, and it diverges from TPR in table encoding,
// phase-2 goal, 3x3 finisher and orientation handling — see the README's
// "On the 4x4 deep engine and TPR" for the specifics.
//
// Tables ship pre-built (tables/tpr4-v1.bin.gz, ~228 KB gzipped; regenerate
// with tools/gen-tables.mjs) and are fetched at page load; generating them
// on-device (~10 s) remains the fallback when the download is unavailable.
// The deep engine's edge table is always built on-device (57 MB) and staged:
// a depth-8 horizon is ready in ~1.5 s and is enough to solve with, then the
// horizon is pushed to depth 9 (~3x fewer search nodes) a chunk at a time in
// the background. The app prewarms it on entering 4x4 mode.

const C4t = typeof module !== 'undefined' ? require('./cube4.js') : globalThis.Cube4;

const TPR4 = (() => {
  const C4 = C4t;
  const MOVES36 = C4.ALL_MOVES;

  // ---- move permutations on center positions and wing positions ----
  const NC = 24, NW = 24;
  const centerPerm = [], wingPerm = [];
  {
    const centerIdxOf = {}, wingIdxOf = {};
    C4.CENTERS.forEach((c, i) => { centerIdxOf[c.idx] = i; });
    C4.WINGS.forEach((w, i) => { for (const f in w.stickers) wingIdxOf[w.stickers[f]] = i; });
    for (const m of MOVES36) {
      const perm = C4.MOVE_PERM[m[0]];
      const times = m.length > 1 ? (m[1] === '2' ? 2 : 3) : 1;
      let total = perm.map((_, i) => i);
      for (let t = 0; t < times; t++) total = total.map((x) => perm[x]);
      centerPerm.push(C4.CENTERS.map((c) => centerIdxOf[total[c.idx]]));
      wingPerm.push(C4.WINGS.map((w) => wingIdxOf[total[Object.values(w.stickers)[0]]]));
    }
  }
  const MOVE_INDEX = {};
  MOVES36.forEach((m, i) => { MOVE_INDEX[m] = i; });

  // ---- phase move sets (indices into MOVES36) ----
  const OUTER18 = MOVES36.map((m, i) => i).filter((i) => MOVES36[i][0] === MOVES36[i][0].toUpperCase());
  const SET36 = MOVES36.map((_, i) => i);
  const SET28 = MOVES36.map((m, i) => i).filter((i) => {
    const m = MOVES36[i];
    const f = m[0];
    if (f === f.toUpperCase()) return true;              // all outer
    if (f === 'u' || f === 'd') return true;             // horizontal slices, any turn
    return m[1] === '2';                                 // vertical slices: doubles only
  });
  const SET24 = MOVES36.map((m, i) => i).filter((i) => {
    const m = MOVES36[i];
    const f = m[0];
    if (f === f.toUpperCase()) return true;              // all outer
    return m[1] === '2';                                 // all slices: doubles only
  });

  // ---- 24-bit mask machinery with per-move byte lookup tables ----
  // maskMove[m][b0/b1/b2][byte] -> permuted 24-bit contribution
  function buildMaskTables(perms) {
    return perms.map((perm) => {
      const T = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      for (let seg = 0; seg < 3; seg++) {
        for (let byte = 0; byte < 256; byte++) {
          let out = 0;
          for (let bit = 0; bit < 8; bit++) {
            if (byte & (1 << bit)) out |= 1 << perm[seg * 8 + bit];
          }
          T[seg][byte] = out;
        }
      }
      return T;
    });
  }
  const centerMask = buildMaskTables(centerPerm);
  function applyMask(T, m) {
    return T[0][m & 255] | T[1][(m >> 8) & 255] | T[2][m >> 16];
  }

  // ---- combinadic ranking ----
  const CNK = [];
  for (let n = 0; n <= 24; n++) {
    CNK[n] = [1];
    for (let k = 1; k <= 12; k++) CNK[n][k] = n === 0 ? 0 : (CNK[n - 1][k] || 0) + (CNK[n - 1][k - 1] || 0);
  }
  function rankMask(mask, nBits, k) {
    let r = 0, seen = 0;
    for (let i = 0; i < nBits; i++) {
      if (mask & (1 << i)) { seen++; r += CNK[i][seen]; }
    }
    return r;
  }

  // ================= Phase 1: UD-class centers -> U∪D faces =================
  const N1 = CNK[24][8]; // 735471
  let dist1 = null;
  const UD_GOAL_MASK = (() => {
    let m = 0;
    C4.CENTERS.forEach((c, i) => { if (c.face === 'U' || c.face === 'D') m |= 1 << i; });
    return m;
  })();

  function buildPhase1() {
    dist1 = new Uint8Array(N1).fill(255);
    const goalRank = rankMask(UD_GOAL_MASK, 24, 8);
    dist1[goalRank] = 0;
    let frontier = [UD_GOAL_MASK];
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const mask of frontier) {
        for (const mi of SET36) {
          const nm = applyMask(centerMask[mi], mask);
          const r = rankMask(nm, 24, 8);
          if (dist1[r] === 255) { dist1[r] = d + 1; next.push(nm); }
        }
      }
      frontier = next;
      d++;
    }
  }

  // ================= Phase 2: LR-class -> L∪R (within the 16 side slots) ====
  // side slot list: center positions on F,B,L,R
  const SIDE_POS = [];
  C4.CENTERS.forEach((c, i) => { if (c.face !== 'U' && c.face !== 'D') SIDE_POS.push(i); });
  const SIDE_INDEX = {}; // global center pos -> 0..15
  SIDE_POS.forEach((p, i) => { SIDE_INDEX[p] = i; });
  const N2 = CNK[16][8]; // 12870
  let dist2 = null;
  const LR_GOAL_MASK16 = (() => {
    let m = 0;
    SIDE_POS.forEach((p, i) => {
      const f = C4.CENTERS[p].face;
      if (f === 'L' || f === 'R') m |= 1 << i;
    });
    return m;
  })();
  // 16-slot permutations for the 28-move set
  const sidePerm = {};
  for (const mi of SET28) {
    const perm = centerPerm[mi];
    const p16 = new Array(16);
    let valid = true;
    SIDE_POS.forEach((p, i) => {
      const np = perm[p];
      if (SIDE_INDEX[np] === undefined) valid = false;
      else p16[i] = SIDE_INDEX[np];
    });
    if (!valid) throw new Error('phase-2 move leaks side centers: ' + MOVES36[mi]);
    sidePerm[mi] = p16;
  }
  // 64K lookup (128 KB). rank16 runs on every node of the joint phase-2 head
  // search, where the generic rankMask loop costs sixteen CNK indirections.
  const RANK16_T = new Uint16Array(65536);
  for (let m = 0; m < 65536; m++) RANK16_T[m] = rankMask(m, 16, 8);
  function rank16(mask) { return RANK16_T[mask]; }
  // byte-wise transition tables for the 16-slot side mask, replacing a
  // 16-iteration bit loop with two lookups
  const sideMaskT = {};
  for (const mi of SET28) {
    const perm = sidePerm[mi];
    const lo = new Uint16Array(256), hi = new Uint16Array(256);
    for (let b = 0; b < 256; b++) {
      let a = 0, c = 0;
      for (let i = 0; i < 8; i++) {
        if (b & (1 << i)) { a |= 1 << perm[i]; c |= 1 << perm[i + 8]; }
      }
      lo[b] = a; hi[b] = c;
    }
    sideMaskT[mi] = [lo, hi];
  }
  const applySide16 = (mi, m16) => {
    const T = sideMaskT[mi];
    return T[0][m16 & 255] | T[1][m16 >> 8];
  };
  // wing-permutation parity flips exactly on single-slice quarter turns
  const MOVE_ODD = MOVES36.map((m) => (m[0] >= 'a' && m[0] <= 'z' && m[1] !== '2') ? 1 : 0);
  function buildPhase2() {
    // states: (LR-mask over 16 side slots) x (wing permutation parity)
    dist2 = new Uint8Array(N2 * 2).fill(255);
    const goal = rank16(LR_GOAL_MASK16) * 2; // parity 0 = no flip parity downstream
    dist2[goal] = 0;
    let frontier = [[LR_GOAL_MASK16, 0]];
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const [mask, par] of frontier) {
        for (const mi of SET28) {
          const perm = sidePerm[mi];
          let nm = 0;
          for (let i = 0; i < 16; i++) if (mask & (1 << i)) nm |= 1 << perm[i];
          const np = par ^ MOVE_ODD[mi];
          const r = rank16(nm) * 2 + np;
          if (dist2[r] === 255) { dist2[r] = d + 1; next.push([nm, np]); }
        }
      }
      frontier = next;
      d++;
    }
  }

  // ================= Phase 3 heuristic tables (24-move set) ==================
  // (a) center sort: per axis, which 4 of its 8 slots hold the "positive" color.
  // Axis slot lists (global center positions): UD = U,D faces; LR = L,R; FB = F,B.
  const AXIS_POS = { UD: [], LR: [], FB: [] };
  C4.CENTERS.forEach((c, i) => {
    if (c.face === 'U' || c.face === 'D') AXIS_POS.UD.push(i);
    else if (c.face === 'L' || c.face === 'R') AXIS_POS.LR.push(i);
    else AXIS_POS.FB.push(i);
  });
  const AXIS_INDEX = {};
  for (const ax of ['UD', 'LR', 'FB']) {
    AXIS_INDEX[ax] = {};
    AXIS_POS[ax].forEach((p, i) => { AXIS_INDEX[ax][p] = i; });
  }
  // goal masks: positive color = the first face of the axis name (U, L, F)
  const AXIS_GOAL = {};
  for (const ax of ['UD', 'LR', 'FB']) {
    let m = 0;
    AXIS_POS[ax].forEach((p, i) => { if (C4.CENTERS[p].face === ax[0]) m |= 1 << i; });
    AXIS_GOAL[ax] = m;
  }
  // per-move 8-slot permutations (moves in SET24 keep classes on their axes)
  const axisPerm = { UD: {}, LR: {}, FB: {} };
  for (const mi of SET24) {
    for (const ax of ['UD', 'LR', 'FB']) {
      const perm = centerPerm[mi];
      const p8 = new Array(8);
      AXIS_POS[ax].forEach((p, i) => {
        const np = perm[p];
        if (AXIS_INDEX[ax][np] === undefined) throw new Error('phase-3 axis leak: ' + MOVES36[mi]);
        p8[i] = AXIS_INDEX[ax][np];
      });
      axisPerm[ax][mi] = p8;
    }
  }
  const N70 = CNK[8][4]; // 70
  // 256-entry lookup. The generic rankMask loop chases CNK's array-of-arrays
  // eight times per call (~34 ns measured); the phase-3 inner loop needs three
  // of those per node, which made it the single most expensive thing there.
  const RANK8_T = new Int16Array(256);
  for (let m = 0; m < 256; m++) RANK8_T[m] = rankMask(m, 8, 4);
  function rank8(mask) { return RANK8_T[mask]; }
  let dist3c = null; // Uint8Array(70*70*70)
  function buildPhase3Centers() {
    const N = N70 * N70 * N70;
    dist3c = new Uint8Array(N).fill(255);
    const goal = (rank8(AXIS_GOAL.UD) * N70 + rank8(AXIS_GOAL.LR)) * N70 + rank8(AXIS_GOAL.FB);
    // BFS over triple of masks
    dist3c[goal] = 0;
    let frontier = [[AXIS_GOAL.UD, AXIS_GOAL.LR, AXIS_GOAL.FB]];
    let d = 0;
    const applyP8 = (mask, p8) => {
      let nm = 0;
      for (let i = 0; i < 8; i++) if (mask & (1 << i)) nm |= 1 << p8[i];
      return nm;
    };
    while (frontier.length) {
      const next = [];
      for (const [a, b, c] of frontier) {
        for (const mi of SET24) {
          const na = applyP8(a, axisPerm.UD[mi]);
          const nb = applyP8(b, axisPerm.LR[mi]);
          const nc = applyP8(c, axisPerm.FB[mi]);
          const r = (rank8(na) * N70 + rank8(nb)) * N70 + rank8(nc);
          if (dist3c[r] === 255) { dist3c[r] = d + 1; next.push([na, nb, nc]); }
        }
      }
      frontier = next;
      d++;
    }
  }

  // (b) two-pair joint table: ordered (a1,a2,b1,b2) distinct wing positions,
  // goal = each pair co-located on a dedge. 24*23*22*21 = 255,024 states.
  const N4W = 24 * 23 * 22 * 21;
  let dist3p = null;
  const WING_DEDGE = new Array(NW);
  C4.DEDGE_KEYS.forEach((k, di) => { for (const wi of C4.DEDGES[k]) WING_DEDGE[wi] = di; });

  function rankTuple(p) {
    // ordered distinct 4-tuple -> 0..N4W-1 (Lehmer-style)
    let r = 0;
    const used = [];
    const bases = [23 * 22 * 21, 22 * 21, 21, 1];
    for (let i = 0; i < 4; i++) {
      let x = p[i];
      let smallerUsed = 0;
      for (const u of used) if (u < p[i]) smallerUsed++;
      x -= smallerUsed;
      r += x * bases[i];
      used.push(p[i]);
    }
    return r;
  }
  function buildPhase3Pairs() {
    dist3p = new Uint8Array(N4W).fill(255);
    // multi-source goal states: pair A on dedge i (both orders), pair B on dedge j != i
    let frontier = [];
    for (let i = 0; i < 12; i++) {
      const [x1, y1] = C4.DEDGES[C4.DEDGE_KEYS[i]];
      for (let j = 0; j < 12; j++) {
        if (j === i) continue;
        const [x2, y2] = C4.DEDGES[C4.DEDGE_KEYS[j]];
        for (const A of [[x1, y1], [y1, x1]]) {
          for (const B of [[x2, y2], [y2, x2]]) {
            const t = [A[0], A[1], B[0], B[1]];
            const r = rankTuple(t);
            if (dist3p[r] === 255) { dist3p[r] = 0; frontier.push(t); }
          }
        }
      }
    }
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const t of frontier) {
        for (const mi of SET24) {
          const wp = wingPerm[mi];
          const nt = [wp[t[0]], wp[t[1]], wp[t[2]], wp[t[3]]];
          const r = rankTuple(nt);
          if (dist3p[r] === 255) { dist3p[r] = d + 1; next.push(nt); }
        }
      }
      frontier = next;
      d++;
    }
  }

  // (c) single-pair table under SET24 (for a cheap sum heuristic)
  let dist3s = null;
  function rank2o(a, b) { return a * 23 + (b > a ? b - 1 : b); } // ordered distinct pair
  function buildPhase3Singles() {
    dist3s = new Uint8Array(24 * 23).fill(255);
    let frontier = [];
    for (let i = 0; i < 12; i++) {
      const [x, y] = C4.DEDGES[C4.DEDGE_KEYS[i]];
      for (const t of [[x, y], [y, x]]) {
        dist3s[rank2o(t[0], t[1])] = 0;
        frontier.push(t);
      }
    }
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const t of frontier) {
        for (const mi of SET24) {
          const wp = wingPerm[mi];
          const nt = [wp[t[0]], wp[t[1]]];
          const r = rank2o(nt[0], nt[1]);
          if (dist3s[r] === 255) { dist3s[r] = d + 1; next.push(nt); }
        }
      }
      frontier = next;
      d++;
    }
  }

  // ---- wing identification from facelet arrangements ----
  // WING_ID[slot][arrangementKey] = wingId (home slot index), built by a
  // seeded tracking walk; arrangements use canonical letters.
  let WING_ID = null;
  let ARR_OF = null; // ARR_OF[slot][wingId] = arrangement key (letters)
  function buildWingId() {
    WING_ID = Array.from({ length: NW }, () => ({}));
    ARR_OF = Array.from({ length: NW }, () => new Array(NW));
    let st = C4.solvedState();
    let perm = Array.from({ length: NW }, (_, i) => i);
    let s = 13579;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    let filled = 0;
    for (let step = 0; step < 60000 && filled < NW * NW; step++) {
      const mi = Math.floor(rnd() * 36);
      st = C4.applyMove(st, MOVES36[mi]);
      const wp = wingPerm[mi];
      const np = new Array(NW);
      for (let i = 0; i < NW; i++) np[wp[i]] = perm[i];
      perm = np;
      for (let slot = 0; slot < NW; slot++) {
        const arr = arrKeyOf(st, slot);
        if (WING_ID[slot][arr] === undefined) {
          WING_ID[slot][arr] = perm[slot];
          ARR_OF[slot][perm[slot]] = arr;
          filled++;
        }
      }
    }
    if (filled < NW * NW) throw new Error('wing id table incomplete: ' + filled);
  }
  function arrKeyOf(state, slot) {
    const stks = C4.WINGS[slot].stickers;
    let k = '';
    for (const f of ['U', 'R', 'F', 'D', 'L', 'B']) {
      if (stks[f] !== undefined) k += f + state[stks[f]];
    }
    return k;
  }
  // wing permutation of an arbitrary state (colors mapped through the scheme)
  function wingPermOf(state, scheme) {
    const toLetter = {};
    for (const f of C4.FACES) toLetter[scheme[f]] = f;
    const perm = new Array(NW);
    for (let slot = 0; slot < NW; slot++) {
      const stks = C4.WINGS[slot].stickers;
      let k = '';
      for (const f of ['U', 'R', 'F', 'D', 'L', 'B']) {
        if (stks[f] !== undefined) k += f + toLetter[state[stks[f]]];
      }
      const id = WING_ID[slot][k];
      if (id === undefined) return null;
      perm[slot] = id;
    }
    return perm;
  }
  function wingParityOf(state, scheme) {
    const p = wingPermOf(state, scheme);
    if (!p) return null;
    let inv = 0;
    for (let i = 0; i < NW; i++) for (let j = i + 1; j < NW; j++) if (p[i] > p[j]) inv++;
    return inv % 2;
  }

  // ---- identity-aware pairing tables (chirality-correct) ----
  // WING_ID8[slot][codeKey] = wingId, where codeKey = code(sticker0)*6+code(sticker1)
  let WING_ID8 = null;
  // PAIRS[i] = [wingA, wingB] home wings of dedge i (A = lower index)
  const PAIRS = C4.DEDGE_KEYS.map((k) => {
    const [a, b] = C4.DEDGES[k];
    return a < b ? [a, b] : [b, a];
  });
  const PAIR_OF_WING = new Array(24);
  PAIRS.forEach((p, i) => { PAIR_OF_WING[p[0]] = i; PAIR_OF_WING[p[1]] = i; });
  let distTrue = null; // Uint8Array(12 * 552): true paired distance under SET24
  function buildTruePairTables() {
    const FACE_CODE_L = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
    WING_ID8 = Array.from({ length: NW }, () => new Int8Array(36).fill(-1));
    for (let slot = 0; slot < NW; slot++) {
      const faces = Object.keys(C4.WINGS[slot].stickers);
      for (const arr in WING_ID[slot]) {
        // arr like 'FxUy' pairs of face+letter sorted by face; decode per this slot's sticker order
        const m = {};
        for (let i = 0; i < arr.length; i += 2) m[arr[i]] = arr[i + 1];
        const key = FACE_CODE_L[m[faces[0]]] * 6 + FACE_CODE_L[m[faces[1]]];
        WING_ID8[slot][key] = WING_ID[slot][arr];
      }
    }
    // goal set per pair: orderings (posA, posB) at each dedge that are TRULY paired
    // (face-wise matching colors, chirality included)
    distTrue = new Uint8Array(12 * 552).fill(255);
    for (let pi = 0; pi < 12; pi++) {
      const [wA, wB] = PAIRS[pi];
      const frontier = [];
      for (let d = 0; d < 12; d++) {
        const [a, b] = C4.DEDGES[C4.DEDGE_KEYS[d]];
        for (const [pa, pb] of [[a, b], [b, a]]) {
          // arrangement of wA at pa and wB at pb: colors must match per face
          const arrA = ARR_OF[pa][wA], arrB = ARR_OF[pb][wB];
          const mA = {}, mB = {};
          for (let i = 0; i < arrA.length; i += 2) mA[arrA[i]] = arrA[i + 1];
          for (let i = 0; i < arrB.length; i += 2) mB[arrB[i]] = arrB[i + 1];
          const facesA = Object.keys(C4.WINGS[pa].stickers);
          let ok = true;
          for (const f of facesA) if (mA[f] !== mB[f]) ok = false;
          if (ok) {
            const r = pi * 552 + rank2o(pa, pb);
            if (distTrue[r] === 255) { distTrue[r] = 0; frontier.push([pa, pb]); }
          }
        }
      }
      let d = 0;
      let front = frontier;
      while (front.length) {
        const next = [];
        for (const [pa, pb] of front) {
          for (const mi of SET24) {
            const wp = wingPerm[mi];
            const na = wp[pa], nb = wp[pb];
            const r = pi * 552 + rank2o(na, nb);
            if (distTrue[r] === 255) { distTrue[r] = d + 1; next.push([na, nb]); }
          }
        }
        front = next;
        d++;
      }
    }
  }

  // ---- joint interlock tables: (axis center-sort) x (one pair, identity-aware) ----
  // J[axis][pair] : Uint8Array(70*552), exact SET24 distance to
  // "this axis sorted AND this pair truly paired". These price the
  // center/pair interlock that individual tables cannot see.
  let distJ = null;
  function buildJointTables() {
    distJ = [];
    const axisGoalRank = ['UD', 'LR', 'FB'].map((ax) => rank8(AXIS_GOAL[ax]));
    for (let a = 0; a < 3; a++) {
      const ax = ['UD', 'LR', 'FB'][a];
      const perms = {};
      for (const mi of SET24) perms[mi] = axisPerm[ax][mi];
      distJ.push([]);
      for (let pi = 0; pi < 12; pi++) {
        const D = new Uint8Array(70 * 552).fill(255);
        let frontier = [];
        // goals: axis at its sorted mask, pair in any truly-paired arrangement
        const goalMask = AXIS_GOAL[ax];
        for (let pa = 0; pa < 24; pa++) {
          for (let pb = 0; pb < 24; pb++) {
            if (pa === pb) continue;
            const r2 = rank2o(pa, pb);
            if (distTrue[pi * 552 + r2] === 0) {
              const idx = axisGoalRank[a] * 552 + r2;
              if (D[idx] === 255) { D[idx] = 0; frontier.push([goalMask, pa, pb]); }
            }
          }
        }
        let d = 0;
        while (frontier.length) {
          const next = [];
          for (const [mask, pa, pb] of frontier) {
            for (const mi of SET24) {
              const p8 = perms[mi];
              let nm = 0;
              for (let i = 0; i < 8; i++) if (mask & (1 << i)) nm |= 1 << p8[i];
              const wp = wingPerm[mi];
              const na = wp[pa], nb = wp[pb];
              const idx = rank8(nm) * 552 + rank2o(na, nb);
              if (D[idx] === 255) { D[idx] = d + 1; next.push([nm, na, nb]); }
            }
          }
          frontier = next;
          d++;
        }
        distJ[a].push(D);
      }
    }
  }

  let built = false;
  function buildAll(progress) {
    if (built) return;
    const t0 = Date.now();
    buildPhase1(); if (progress) progress('phase 1 table', Date.now() - t0);
    buildPhase2(); if (progress) progress('phase 2 table', Date.now() - t0);
    buildPhase3Centers(); if (progress) progress('phase 3 center table', Date.now() - t0);
    buildPhase3Pairs(); if (progress) progress('phase 3 pair table', Date.now() - t0);
    buildPhase3Singles();
    buildWingId();
    buildTruePairTables();
    buildJointTables(); if (progress) progress('joint tables', Date.now() - t0);
    built = true;
  }

  // ---- shipped tables ----
  // The slow BFS fills above (~10s on-device) can instead be loaded from a
  // pre-generated bundle; the cheap structural tables are always rebuilt.
  const TABLES_VERSION = 1;
  function exportTables() {
    buildAll();
    const out = { dist1, dist2, dist3c, dist3p };
    for (let a = 0; a < 3; a++) for (let pi = 0; pi < 12; pi++) out[`distJ${a}_${pi}`] = distJ[a][pi];
    return out;
  }
  function importTables(map) {
    if (built) return false;
    // exact length checks: a truncated or corrupt bundle must fall back to
    // building rather than feed the solver garbage distances
    const want = { dist1: N1, dist2: N2 * 2, dist3c: 70 * 70 * 70, dist3p: N4W };
    for (const k in want) if (!map[k] || map[k].length !== want[k]) return false;
    for (let a = 0; a < 3; a++) for (let pi = 0; pi < 12; pi++) {
      const t = map[`distJ${a}_${pi}`];
      if (!t || t.length !== 70 * 552) return false;
    }
    dist1 = map.dist1; dist2 = map.dist2; dist3c = map.dist3c; dist3p = map.dist3p;
    distJ = [];
    for (let a = 0; a < 3; a++) {
      distJ.push([]);
      for (let pi = 0; pi < 12; pi++) distJ[a].push(map[`distJ${a}_${pi}`]);
    }
    buildPhase3Singles();
    buildWingId();
    buildTruePairTables();
    built = true;
    return true;
  }

  // =============================== solvers ===============================
  const CENTER_STICKER = C4.CENTERS.map((c) => c.idx);
  const CENTER_FACE = C4.CENTERS.map((c) => c.face);

  function classMask24(state, scheme) {
    // 24-bit mask of positions holding UD-class colors
    let m = 0;
    for (let i = 0; i < NC; i++) {
      const col = state[CENTER_STICKER[i]];
      if (col === scheme.U || col === scheme.D) m |= 1 << i;
    }
    return m;
  }
  function lrMask16(state, scheme) {
    let m = 0;
    for (let i = 0; i < 16; i++) {
      const col = state[CENTER_STICKER[SIDE_POS[i]]];
      if (col === scheme.L || col === scheme.R) m |= 1 << i;
    }
    return m;
  }
  function axisMasks(state, scheme, out) {
    // per axis: mask of positive-color positions within the axis' 8 slots
    out = out || [0, 0, 0];
    out[0] = 0; out[1] = 0; out[2] = 0;
    const axes = ['UD', 'LR', 'FB'];
    for (let a = 0; a < 3; a++) {
      const pos = AXIS_POS[axes[a]];
      const positive = scheme[axes[a][0]];
      for (let i = 0; i < 8; i++) {
        if (state[CENTER_STICKER[pos[i]]] === positive) out[a] |= 1 << i;
      }
    }
    return out;
  }
  function centersExact(state, scheme) {
    for (let i = 0; i < NC; i++) if (state[CENTER_STICKER[i]] !== scheme[CENTER_FACE[i]]) return false;
    return true;
  }

  // greedy exact descent for phases 1 & 2 (phase 2 includes the parity bit)
  function walkPhase(state, scheme, phase) {
    const moves = [];
    let par = 0;
    if (phase === 2) {
      par = wingParityOf(state, scheme);
      if (par === null) return null;
    }
    for (let guard = 0; guard < 24; guard++) {
      let d, mask;
      if (phase === 1) { mask = classMask24(state, scheme); d = dist1[rankMask(mask, 24, 8)]; }
      else { mask = lrMask16(state, scheme); d = dist2[rank16(mask) * 2 + par]; }
      if (d === 0) return { moves, state };
      if (d === undefined || d === 255) return null;
      let advanced = false;
      const set = phase === 1 ? SET36 : SET28;
      for (const mi of set) {
        let nd, npar = par;
        if (phase === 1) {
          const nm = applyMask(centerMask[mi], mask);
          nd = dist1[rankMask(nm, 24, 8)];
        } else {
          const perm = sidePerm[mi];
          let nm = 0;
          for (let i = 0; i < 16; i++) if (mask & (1 << i)) nm |= 1 << perm[i];
          npar = par ^ MOVE_ODD[mi];
          nd = dist2[rank16(nm) * 2 + npar];
        }
        if (nd === d - 1) {
          state = C4.applyMove(state, MOVES36[mi]);
          moves.push(MOVES36[mi]);
          par = npar;
          advanced = true;
          break;
        }
      }
      if (!advanced) return null;
    }
    return null;
  }

  // enumerate several phase-1 walks within `slack` of optimal (paths bounded
  // by g+h <= optimal+slack), deduped by end state, so phase 2 and phase 3
  // get a choice of starting points — slightly longer phase-1 walks often
  // land in far friendlier phase-3 basins
  function phase1Options(state, scheme, cap, slack) {
    const out = [];
    const seenEnd = new Set();
    const m0 = classMask24(state, scheme);
    const budget = dist1[rankMask(m0, 24, 8)] + (slack || 0);
    const rec = (st, mask, moves) => {
      if (out.length >= cap) return;
      const d = dist1[rankMask(mask, 24, 8)];
      if (d === 0) {
        const key = st.join('');
        if (!seenEnd.has(key)) { seenEnd.add(key); out.push({ moves: moves.slice(), state: st }); }
        return;
      }
      for (const mi of SET36) {
        if (out.length >= cap) return;
        const nm = applyMask(centerMask[mi], mask);
        const nd = dist1[rankMask(nm, 24, 8)];
        if (moves.length + 1 + nd <= budget) {
          rec(C4.applyMove(st, MOVES36[mi]), nm, moves.concat(MOVES36[mi]));
        }
      }
    };
    rec(state, m0, []);
    return out;
  }

  // enumerate optimal-within-slack phase-2 walks (parity bit included)
  function phase2Options(state, scheme, cap, slack) {
    const par0 = wingParityOf(state, scheme);
    if (par0 === null) return [];
    const m0 = lrMask16(state, scheme);
    const d0 = dist2[rank16(m0) * 2 + par0];
    if (d0 === undefined || d0 === 255) return [];
    const budget = d0 + (slack || 0);
    const out = [];
    const seenEnd = new Set();
    const rec = (st, mask, par, moves) => {
      if (out.length >= cap) return;
      const d = dist2[rank16(mask) * 2 + par];
      if (d === 0) {
        const key = st.join('');
        if (!seenEnd.has(key)) { seenEnd.add(key); out.push({ moves: moves.slice(), state: st }); }
        return;
      }
      for (const mi of SET28) {
        if (out.length >= cap) return;
        const perm = sidePerm[mi];
        let nm = 0;
        for (let i = 0; i < 16; i++) if (mask & (1 << i)) nm |= 1 << perm[i];
        const np = par ^ MOVE_ODD[mi];
        const nd = dist2[rank16(nm) * 2 + np];
        if (nd !== 255 && moves.length + 1 + nd <= budget) {
          rec(C4.applyMove(st, MOVES36[mi]), nm, np, moves.concat(MOVES36[mi]));
        }
      }
    };
    rec(state, m0, par0, []);
    return out;
  }

  // ---------- phase 3 in Uint8 code-space (colors as face indices 0..5) ----------
  const C3 = typeof module !== 'undefined' ? require('./cube.js') : globalThis.Cube;
  const M3 = { 0: 0, 1: 1, 2: 3 };
  const FACE_CODE = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
  const CENTER_STICKER8 = Uint16Array.from(C4.CENTERS.map((c) => c.idx));
  const CENTER_FACECODE = Uint8Array.from(C4.CENTERS.map((c) => FACE_CODE[c.face]));
  // per-axis center slot lists and positive codes
  const AXIS_LIST = ['UD', 'LR', 'FB'].map((ax) => ({
    pos: AXIS_POS[ax],
    positive: FACE_CODE[ax[0]],
  }));
  // wing sticker index pairs + dedge paired index quads
  const WING_STK8 = C4.WINGS.map((w) => Object.values(w.stickers));
  const DEDGE_QUAD = C4.DEDGE_KEYS.map((k) => {
    const [a, b] = C4.DEDGES[k];
    const fa = C4.WINGS[a].stickers, fb = C4.WINGS[b].stickers;
    const quad = [];
    for (const f in fa) quad.push(fa[f], fb[f]);
    return quad; // [a1,b1,a2,b2]
  });
  const MOVE_PERM8 = {}; // token -> Uint8Array composed permutation
  for (const m of MOVES36) {
    const perm = C4.MOVE_PERM[m[0]];
    const times = m.length > 1 ? (m[1] === '2' ? 2 : 3) : 1;
    let total = perm.map((_, i) => i);
    for (let t = 0; t < times; t++) total = total.map((x) => perm[x]);
    MOVE_PERM8[m] = Uint8Array.from(total);
  }
  function encode96(state, scheme) {
    const toCode = {};
    for (const f of C4.FACES) toCode[scheme[f]] = FACE_CODE[f];
    const out = new Uint8Array(96);
    for (let i = 0; i < 96; i++) out[i] = toCode[state[i]];
    return out;
  }
  function apply8(s, token) {
    const perm = MOVE_PERM8[token];
    const ns = new Uint8Array(96);
    for (let i = 0; i < 96; i++) ns[perm[i]] = s[i];
    return ns;
  }
  function hash8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < 96; i++) { h ^= s[i]; h = (h * 0x01000193) >>> 0; }
    return h;
  }
  function centersExact8(s) {
    for (let i = 0; i < NC; i++) if (s[CENTER_STICKER8[i]] !== CENTER_FACECODE[i]) return false;
    return true;
  }
  function allPaired8(s) {
    for (let d = 0; d < 12; d++) {
      const q = DEDGE_QUAD[d];
      if (s[q[0]] !== s[q[1]] || s[q[2]] !== s[q[3]]) return false;
    }
    return true;
  }
  const tmpPairsIdx = new Int8Array(36); // pairKey -> pair index this pass
  const pairA = new Uint8Array(12), pairB = new Uint8Array(12);
  // lite mode drops heuristic terms that measured as near-constant on random
  // phase-3 states (their max plateaus ~7, adding lookups but almost no
  // ordering signal): lite>=1 skips the pairwise dist3p sweep (~130 lookups),
  // lite=2 also skips the 36 distJ interlock lookups
  function score8(s, lite) {
    // centers
    let a0 = 0, a1 = 0, a2 = 0;
    {
      const L = AXIS_LIST[0];
      for (let i = 0; i < 8; i++) if (s[CENTER_STICKER8[L.pos[i]]] === L.positive) a0 |= 1 << i;
    }
    {
      const L = AXIS_LIST[1];
      for (let i = 0; i < 8; i++) if (s[CENTER_STICKER8[L.pos[i]]] === L.positive) a1 |= 1 << i;
    }
    {
      const L = AXIS_LIST[2];
      for (let i = 0; i < 8; i++) if (s[CENTER_STICKER8[L.pos[i]]] === L.positive) a2 |= 1 << i;
    }
    const r0 = rank8(a0), r1 = rank8(a1), r2c = rank8(a2);
    const hC = dist3c[(r0 * N70 + r1) * N70 + r2c];
    const axisRanks = [r0, r1, r2c];
    // wings by pair key
    tmpPairsIdx.fill(-1);
    let np = 0;
    for (let i = 0; i < NW; i++) {
      const stk = WING_STK8[i];
      const x = s[stk[0]], y = s[stk[1]];
      const key = x < y ? x * 6 + y : y * 6 + x;
      if (tmpPairsIdx[key] < 0) { tmpPairsIdx[key] = np; pairA[np] = i; np++; }
      else pairB[tmpPairsIdx[key]] = i;
    }
    let hP = 0, sumP = 0;
    const singles = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      // identify which physical wing sits at each of the two positions
      const pa = pairA[i], pb = pairB[i];
      const ka = s[WING_STK8[pa][0]] * 6 + s[WING_STK8[pa][1]];
      const wa = WING_ID8[pa][ka];
      const pi = PAIR_OF_WING[wa];
      // ordered by identity: position of the pair's A-wing, then B-wing
      const posA = wa === PAIRS[pi][0] ? pa : pb;
      const posB = wa === PAIRS[pi][0] ? pb : pa;
      const rp = rank2o(posA, posB);
      const sd = distTrue[pi * 552 + rp];
      singles[i] = sd;
      sumP += sd;
      if (sd > hP) hP = sd;
      // joint interlock lookups: this pair vs each axis's sort state
      if (lite !== 2) {
        for (let a = 0; a < 3; a++) {
          const dj = distJ[a][pi][axisRanks[a] * 552 + rp];
          if (dj > hP) hP = dj;
        }
      }
    }
    // joint co-location table still adds pruning power for far-apart pairs
    if (!lite) {
      for (let i = 0; i < 12; i++) {
        if (singles[i] === 0) continue;
        const ai = pairA[i], bi = pairB[i];
        for (let j = 0; j < 12; j++) {
          if (j === i) continue;
          const d = dist3p[rankTuple([ai, bi, pairA[j], pairB[j]])];
          if (d > hP) hP = d;
        }
      }
    }
    return { hC, hP, sumP };
  }

  function phase3Beam8(s0, opts = {}) {
    const W = opts.width || 250;
    const rounds = opts.rounds || 45;
    const w1 = opts.w1 === undefined ? 1.2 : opts.w1;
    const w2 = opts.w2 === undefined ? 0.35 : opts.w2;
    const stallLimit = opts.stallLimit || 14;
    const NPOOL = opts.pool || 5;
    const lite = opts.lite || 0;
    const done8 = (s) => centersExact8(s) && allPaired8(s);
    if (done8(s0)) return { moves: [], done: true };
    let beam = [{ s: s0, moves: [], last: '' }];
    const seen = new Set([hash8(s0)]);
    let bestV = Infinity, stall = 0;
    const pool = [];
    for (let round = 0; round < rounds; round++) {
      const cand = [];
      for (const node of beam) {
        for (const mi of SET24) {
          const mv = MOVES36[mi];
          if (mv[0] === node.last) continue;
          const ns = apply8(node.s, mv);
          const h = hash8(ns);
          if (seen.has(h)) continue;
          seen.add(h);
          if (done8(ns)) return { moves: node.moves.concat(mv), done: true };
          const { hC, hP, sumP } = score8(ns, lite);
          const g = node.moves.length + 1;
          const rec = { s: ns, moves: node.moves.concat(mv), last: mv[0], v: g + w1 * Math.max(hC, hP) + w2 * sumP };
          const potential = g + 2.5 * hC + 2.2 * sumP;
          if (pool.length < NPOOL || potential < pool[pool.length - 1].potential) {
            pool.push({ s: ns, moves: rec.moves, potential });
            pool.sort((x, y) => x.potential - y.potential);
            if (pool.length > NPOOL) pool.pop();
          }
          cand.push(rec);
        }
      }
      if (!cand.length) break;
      cand.sort((a, b) => a.v - b.v);
      beam = cand.slice(0, W);
      if (beam[0].v < bestV - 1e-9) { bestV = beam[0].v; stall = 0; }
      else if (++stall >= stallLimit) break;
    }
    return pool.length ? { pool, done: false } : null;
  }

  function wingParity8(s) {
    let inv = 0;
    const ids = new Array(NW);
    for (let i = 0; i < NW; i++) {
      const k = s[WING_STK8[i][0]] * 6 + s[WING_STK8[i][1]];
      ids[i] = WING_ID8[i][k];
      if (ids[i] < 0) return -1;
    }
    for (let i = 0; i < NW; i++) for (let j = i + 1; j < NW; j++) if (ids[i] > ids[j]) inv++;
    return inv % 2;
  }

  function pllParity8(s) {
    // projection is already in canonical codes; convert to letters for C3
    const LETTERS = ['U', 'R', 'F', 'D', 'L', 'B'];
    const s3 = [];
    for (let f = 0; f < 6; f++) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        s3.push(LETTERS[s[f * 16 + M3[r] * 4 + M3[c]]]);
      }
    }
    const cub = C3.stateToCubies(s3);
    if (!cub) return 0;
    const parity = (p) => {
      let inv = 0;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inv++;
      return inv % 2;
    };
    return parity(cub.ep) === parity(cub.cp) ? 0 : 1;
  }

  function endgameBeam8(s0, opts = {}) {
    const W = opts.width || 1200;
    const rounds = opts.rounds || 18;
    const w1 = 1.4, w2 = 0.45;
    const lite = opts.lite || 0;
    const done8 = (s) => centersExact8(s) && allPaired8(s);
    if (done8(s0)) return { moves: [] };
    const hits = [];
    let graceEnd = -1;
    let beam = [{ s: s0, moves: [], last: '' }];
    const seen = new Set([hash8(s0)]);
    for (let round = 0; round < rounds; round++) {
      const cand = [];
      for (const node of beam) {
        for (const mi of SET24) {
          const mv = MOVES36[mi];
          if (mv[0] === node.last) continue;
          const ns = apply8(node.s, mv);
          const h = hash8(ns);
          if (seen.has(h)) continue;
          seen.add(h);
          const moves = node.moves.concat(mv);
          if (done8(ns)) {
            hits.push({ moves, pll: pllParity8(ns) });
            if (graceEnd < 0) graceEnd = Math.min(rounds, round + 3);
            continue;
          }
          const { hC, hP, sumP } = score8(ns, lite);
          cand.push({ s: ns, moves, last: mv[0], v: moves.length + w1 * Math.max(hC, hP) + w2 * sumP });
        }
      }
      if (graceEnd >= 0 && round + 1 >= graceEnd) break;
      if (!cand.length) break;
      cand.sort((a, b) => a.v - b.v);
      beam = cand.slice(0, W);
    }
    if (!hits.length) return null;
    hits.sort((a, b) => (a.moves.length + 7 * a.pll) - (b.moves.length + 7 * b.pll));
    return { moves: hits[0].moves };
  }

  // IDA* endgame: exact optimal closure using the admissible max-heuristic.
  function idaStar8(s0, opts = {}) {
    const budget = opts.nodes || 4000000;
    const maxDepth = opts.maxDepth || 24;
    const done8 = (s) => centersExact8(s) && allPaired8(s);
    if (done8(s0)) return [];
    let nodes = 0;
    const h0 = (() => { const sc = score8(s0); return Math.max(sc.hC, sc.hP); })();
    const path = [];
    function dfs(s, g, bound, last) {
      if (nodes++ > budget) return -2; // out of budget
      const sc = score8(s);
      const h = Math.max(sc.hC, sc.hP);
      const f = g + h;
      if (f > bound) return f;
      if (h === 0 && done8(s)) return -1; // found
      let min = Infinity;
      for (const mi of SET24) {
        const mv = MOVES36[mi];
        if (mv[0] === last) continue;
        const ns = apply8(s, mv);
        path.push(mv);
        const r = dfs(ns, g + 1, bound, mv[0]);
        if (r === -1) return -1;
        if (r === -2) return -2;
        path.pop();
        if (r < min) min = r;
      }
      return min;
    }
    let bound = h0;
    while (bound <= maxDepth) {
      path.length = 0;
      const r = dfs(s0, 0, bound, '');
      if (r === -1) return path.slice();
      if (r === -2) return null; // budget blown
      if (!isFinite(r)) return null;
      bound = r;
    }
    return null;
  }

  // The search portfolio: diverse beam configs whose minima complement each
  // other (beam basins vary wildly with the scoring weights — on the same
  // scramble one config may find 30 moves where another finds 70). Run
  // sequentially via {restarts: PORTFOLIO} or spread across parallel workers.
  const mkCfg = (w1, w2, headIdx) => ({
    lite: 1, width: 470, w1, w2, pool: 8, stallLimit: 17, headIdx: headIdx || 0,
    endgameTries: 1, greedyTries: 2, endgame: { lite: 1, width: 800, rounds: 14 },
  });
  const PORTFOLIO = [mkCfg(1.2, 0.35, 0), mkCfg(0.9, 0.5, 0), mkCfg(1.5, 0.25, 0)];
  // "Search harder" portfolio: more weight diversity, wider beams, richer
  // closers, and each config starting phase 3 from a different phase-1/2 head.
  const dCfg = (w1, w2, width, headIdx) => ({
    lite: 1, width, w1, w2, pool: 10, stallLimit: 24, headIdx: headIdx || 0,
    p1slack: 1, headCap: 10,
    endgameTries: 3, greedyTries: 3, endgame: { lite: 1, width: 2000, rounds: 18 },
  });
  // head assignment is a pyramid: config diversity on the best head is the
  // dominant variance-killer, so most configs stay on head 0 and the longer
  // heads get a thinner spread as a bonus lottery ticket
  const PORTFOLIO_DEEP = [
    dCfg(1.2, 0.35, 800, 0), dCfg(0.9, 0.5, 800, 0), dCfg(1.5, 0.25, 800, 1), dCfg(1.05, 0.42, 800, 1),
    dCfg(1.2, 0.35, 1600, 0), dCfg(0.9, 0.5, 1600, 2), dCfg(1.5, 0.25, 1600, 3), dCfg(1.35, 0.3, 1600, 2),
    // extreme weightings: rarely best, but they rescue the stubborn scrambles
    // every mainstream config wanders on
    dCfg(0.75, 0.6, 1600, 0), dCfg(1.8, 0.15, 1600, 1),
  ];

  // heads = phase-1 x phase-2 walk combinations, seam-cleaned, deduped by end
  // state, sorted by length. Different heads land phase 3 in different basins,
  // so portfolio configs each start from their own head (cfg.headIdx).
  function phaseHeads(state, scheme, opts = {}) {
    const p1s = phase1Options(state, scheme, opts.p1cap || 24, opts.p1slack || 0);
    const heads = [];
    const byEnd = new Map(); // end-state key -> index in heads (shortest kept)
    for (const p1 of p1s) {
      const p2s = phase2Options(p1.state, scheme, opts.p2cap || 3, opts.p2slack || 0);
      for (const p2 of p2s) {
        const key = p2.state.join('');
        const moves = C4.cleanAlg4(p1.moves.concat(p2.moves));
        const at = byEnd.get(key);
        if (at === undefined) {
          byEnd.set(key, heads.length);
          heads.push({ moves, state: p2.state, len: moves.length });
        } else if (moves.length < heads[at].len) {
          heads[at] = { moves, state: p2.state, len: moves.length };
        }
      }
    }
    heads.sort((a, b) => a.len - b.len);
    return heads.slice(0, opts.headCap || 8);
  }

  // full phased reduction: returns move list or null.
  function phasedReduce(state, scheme, opts = {}) {
    if (!built) buildAll(opts.progress);
    const heads = phaseHeads(state, scheme, opts);
    if (!heads.length) return null;
    // one full phase-3 + closer attempt under one search config. Beam search
    // basins vary wildly with the scoring weights, so phasedReduce can run a
    // small portfolio of configs (opts.restarts) and keep the cheapest —
    // cost prices the downstream parity fixes (flip ~15, swap ~7) so a
    // slightly longer parity-free reduction wins over a shorter parity one.
    const attempt = (o) => {
      const headPick = heads[Math.min(o.headIdx || 0, heads.length - 1)];
      const head = headPick.moves;
      const s0 = encode96(headPick.state, scheme);
      let best = null; // {moves, cost}
      const consider = (moves, endState8) => {
        const cleaned = C4.cleanAlg4(moves);
        const par = wingParity8(endState8);
        const pll = pllParity8(endState8);
        const cost = cleaned.length + (par ? 15 : 0) + (pll ? 7 : 0);
        if (!best || cost < best.cost) best = { moves: cleaned, cost };
      };
      // main beam (code-space) collects hand-off candidates
      const p3 = phase3Beam8(s0, o);
      if (!p3) return null;
      if (p3.done) {
        let es = s0;
        for (const mv of p3.moves) es = apply8(es, mv);
        consider(head.concat(p3.moves), es);
        return best;
      }
      for (const cand of p3.pool.slice(0, o.endgameTries || 2)) {
        const eg = endgameBeam8(cand.s, o.endgame || {});
        if (eg) {
          const moves = head.concat(cand.moves, eg.moves);
          let es = cand.s;
          for (const mv of eg.moves) es = apply8(es, mv);
          consider(moves, es);
        }
      }
      for (const cand of p3.pool.slice(0, o.greedyTries || 4)) {
        const midState = C4.applyAlg(headPick.state, cand.moves);
        const tail = C4.finishReduction(midState, scheme);
        if (!tail) continue;
        consider(head.concat(cand.moves, tail.moves), encode96(tail.state, scheme));
      }
      return best;
    };
    const configs = opts.restarts && opts.restarts.length ? opts.restarts : [opts];
    let out = null;
    for (const o of configs) {
      const m = attempt(o);
      if (m && (!out || m.cost < out.cost)) out = m;
    }
    return out ? out.moves : null;
  }

  // parity fixes still owed by a reduction (for cost-aware candidate ranking
  // by orchestrators: true cost ≈ length + 15*par + 7*pll)
  function reductionMeta(state, scheme, red) {
    const s8 = encode96(C4.applyAlg(state, red), scheme);
    return { par: wingParity8(s8), pll: pllParity8(s8) };
  }

  // ======================= deep engine (exact phase 3) =======================
  // Replaces beam search with IDA* over two admissible tables, following the
  // algorithm of Chen Shuang's TPR-4x4x4-Solver (see the attribution note at
  // the top of this file: independent implementation, no TPR source used):
  //
  //  - G3 = SET24 minus the four R/L outer quarter turns (20 moves). Under G3
  //    the 24 wing positions split into two invariant 12-position halves, one
  //    position of each dedge per half. With A = (dedge of the wing on each
  //    A-half position) and B likewise, rel = B⁻¹∘A ∈ S12 is conjugated by
  //    every G3 move and rel = identity ⇔ every edge is paired. Only the even
  //    half of S12 is reachable; a BFS to depth 8 (~3.4M states) gives an
  //    admissible edge-pairing heuristic ("≥9" beyond).
  //  - centers carry a parity bit (corner parity XOR parity(A)) that equals
  //    the eventual PLL parity of the reduction and flips on exactly the six
  //    slice doubles; the center+parity table is the exact G3 distance over
  //    70³×2, so phase 3 lands parity-free reductions by construction.
  //  - phase-1/2 heads almost never satisfy the half-split, so a short
  //    "bridge" (avg ~4 moves, IDDFS over SET24 which preserves the phase-1/2
  //    invariants) makes them G3-feasible first.
  const RL_QUARTERS = ['R', "R'", 'L', "L'"].map((t) => MOVE_INDEX[t]);
  const G3 = SET24.filter((mi) => !RL_QUARTERS.includes(mi));
  const AXIS_OF_FACE = { U: 0, u: 0, d: 0, D: 0, R: 1, r: 1, l: 1, L: 1, F: 2, f: 2, b: 2, B: 2 };
  const LAYER_OF_FACE = { U: 0, u: 1, d: 2, D: 3, R: 0, r: 1, l: 2, L: 3, F: 0, f: 1, b: 2, B: 3 };
  // same facts indexed by move number: the search loops used to pull
  // MOVES36[mi][0] and hash it through the objects above on every node
  const MOVE_AXIS = new Uint8Array(36), MOVE_LAYER = new Uint8Array(36), MOVE_FACE_ID = new Uint8Array(36);
  {
    const faceIds = {};
    let next = 0;
    MOVES36.forEach((m, i) => {
      MOVE_AXIS[i] = AXIS_OF_FACE[m[0]];
      MOVE_LAYER[i] = LAYER_OF_FACE[m[0]];
      if (faceIds[m[0]] === undefined) faceIds[m[0]] = next++;
      MOVE_FACE_ID[i] = faceIds[m[0]];
    });
  }

  const POPC12 = new Uint8Array(4096);
  for (let i = 1; i < 4096; i++) POPC12[i] = POPC12[i >> 1] + (i & 1);

  function permParity(p) {
    let inv = 0;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inv++;
    return inv & 1;
  }
  // parity of a 12-permutation by cycle decomposition: ~12 steps instead of
  // the 66 comparisons of the generic inversion count, and this runs on every
  // node of the head and bridge searches
  function permParity12(p) {
    let seen = 0, par = 0;
    for (let i = 0; i < 12; i++) {
      if (seen & (1 << i)) continue;
      let j = i, len = 0;
      while (!(seen & (1 << j))) { seen |= 1 << j; j = p[j]; len++; }
      par ^= (len - 1) & 1;
    }
    return par;
  }
  // scratch reused by the feasibility test (never reentrant)
  const FF_A = new Uint8Array(12), FF_BINV = new Uint8Array(12), FF_REL = new Uint8Array(12);
  // S12 Lehmer rank; consecutive ranks {2k,2k+1} differ by one transposition,
  // so rank>>1 is a perfect index for the even half.
  function rankPerm12(p) {
    let used = 0, r = 0;
    for (let i = 0; i < 11; i++) {
      const v = p[i];
      r = r * (12 - i) + (v - POPC12[used & ((1 << v) - 1)]);
      used |= 1 << v;
    }
    return r;
  }
  function unrankPerm12(r, out) {
    const digits = new Array(11);
    for (let i = 10; i >= 0; i--) { const radix = 12 - i; digits[i] = r % radix; r = (r - digits[i]) / radix; }
    const avail = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (let i = 0; i < 11; i++) out[i] = avail.splice(digits[i], 1)[0];
    out[11] = avail[0];
    return out;
  }

  // ---- static structure (independent of tables): half-split + move actions ----
  let DEEP = null; // built lazily by deepStructure()
  function deepStructure() {
    if (DEEP) return DEEP;
    // orbit of position 0 under G3 = the A half
    const isA = new Array(NW).fill(false);
    {
      const stack = [0];
      isA[0] = true;
      while (stack.length) {
        const p = stack.pop();
        for (const mi of G3) {
          const q = wingPerm[mi][p];
          if (!isA[q]) { isA[q] = true; stack.push(q); }
        }
      }
    }
    const posA = new Int8Array(12).fill(-1), posB = new Int8Array(12).fill(-1);
    let sizeA = 0;
    for (let p = 0; p < NW; p++) {
      const d = WING_DEDGE[p];
      if (isA[p]) { sizeA++; if (posA[d] >= 0) throw new Error('deep: dedge doubled in A half'); posA[d] = p; }
      else { if (posB[d] >= 0) throw new Error('deep: dedge doubled in B half'); posB[d] = p; }
    }
    if (sizeA !== 12) throw new Error('deep: half-split orbit size ' + sizeA);
    // per-G3-move action on the halves in dedge space: rel' = tau ∘ rel ∘ sigma⁻¹
    const sigmaInv = {}, tau = {};
    for (const mi of G3) {
      const s = new Uint8Array(12), t = new Uint8Array(12), si = new Uint8Array(12);
      for (let d = 0; d < 12; d++) {
        const npA = wingPerm[mi][posA[d]];
        const npB = wingPerm[mi][posB[d]];
        if (!isA[npA] || isA[npB]) throw new Error('deep: half leak under ' + MOVES36[mi]);
        s[d] = WING_DEDGE[npA];
        t[d] = WING_DEDGE[npB];
      }
      for (let d = 0; d < 12; d++) si[s[d]] = d;
      sigmaInv[mi] = si; tau[mi] = t;
    }
    // per-SET24-move axis-mask transition tables (256-entry, per axis) and
    // corner/parity flip flags (bridge search uses all of SET24; G3 ⊂ SET24)
    const maskT = {};
    for (const mi of SET24) {
      const T = [];
      for (const ax of ['UD', 'LR', 'FB']) {
        const p8 = axisPerm[ax][mi];
        const tab = new Uint8Array(256);
        for (let m = 0; m < 256; m++) {
          let nm = 0;
          for (let i = 0; i < 8; i++) if (m & (1 << i)) nm |= 1 << p8[i];
          tab[m] = nm;
        }
        T.push(tab);
      }
      maskT[mi] = T;
    }
    const sliceDouble = {}, cparFlip = {};
    for (const mi of SET36) {
      const m = MOVES36[mi];
      sliceDouble[mi] = (m[0] >= 'a' && m[0] <= 'z' && m[1] === '2') ? 1 : 0;
      cparFlip[mi] = (m[0] === m[0].toUpperCase() && m[1] !== '2') ? 1 : 0;
    }
    // corner identification (for the parity bit): color-set mask -> corner id
    const cornerStk = C4.CORNERS.map((c) => Object.values(c.stickers));
    const cornerByMask = {};
    {
      const solved8 = encode96(C4.solvedState(), { U: 'U', R: 'R', F: 'F', D: 'D', L: 'L', B: 'B' });
      cornerStk.forEach((stk, i) => {
        let mask = 0;
        for (const s of stk) mask |= 1 << solved8[s];
        cornerByMask[mask] = i;
      });
    }
    DEEP = { isA, posA, posB, sigmaInv, tau, maskT, sliceDouble, cparFlip, cornerStk, cornerByMask };
    return DEEP;
  }

  function cornerParity8(s8) {
    const { cornerStk, cornerByMask } = deepStructure();
    const perm = new Array(8);
    for (let i = 0; i < 8; i++) {
      let mask = 0;
      for (const s of cornerStk[i]) mask |= 1 << s8[s];
      const id = cornerByMask[mask];
      if (id === undefined) return -1;
      perm[i] = id;
    }
    return permParity(perm);
  }

  function axisMasks8(s8, out) {
    out = out || [0, 0, 0];
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let a = 0; a < 3; a++) {
      const L = AXIS_LIST[a];
      for (let i = 0; i < 8; i++) if (s8[CENTER_STICKER8[L.pos[i]]] === L.positive) out[a] |= 1 << i;
    }
    return out;
  }

  // ---- deep pruning tables (built lazily, then cached in the worker) ----
  // Edge pruning table: 2-bit direct-indexed, distance mod 3.
  // The even-permutation rank IS the index, so there is no hashing, no probing
  // and no stored keys -- 239.5M entries at 2 bits = 57 MB flat, which is what
  // makes a depth-9 horizon affordable at all (a keyed hash that deep would
  // need ~4x the memory).
  //
  // Values 0/1/2 are the exact distance mod 3 for states inside the horizon;
  // 3 means "beyond it". Two bits suffice because one move changes the true
  // distance by exactly -1, 0 or +1, and those three are distinct mod 3 -- so
  // given the parent's distance, the child's follows from its two bits. That
  // is the incremental step edgeStep() below, and it replaces a full distance
  // lookup with a single shift-and-mask on every node.
  const N_EVEN = 239500800;      // 12!/2 -- every even permutation of S12
  let EDGE_DEPTH = 8;            // initial horizon; upgradeEdgeStep pushes it to 9
  let edgeBits = null;           // Uint8Array(N_EVEN/4)

  function edgeRead(evenRank) {
    return (edgeBits[evenRank >> 2] >> ((evenRank & 3) << 1)) & 3;
  }
  // child distance from the parent's reported distance and the child's 2 bits
  function edgeStep(evenRank, parentDist) {
    const v = (edgeBits[evenRank >> 2] >> ((evenRank & 3) << 1)) & 3;
    if (v === 3) return EDGE_DEPTH + 1;      // outside the horizon
    if (parentDist > EDGE_DEPTH) return EDGE_DEPTH;
    // inside: the true distance is one of parent-1, parent, parent+1
    if (v === (parentDist + 2) % 3) return parentDist - 1;
    if (v === parentDist % 3) return parentDist;
    return parentDist + 1;
  }
  // exact distance for a search root, where no parent value is available:
  // the residue narrows it to every third value, and a greedy descent along
  // strictly decreasing distances confirms the right one (a descent always
  // exists from the true distance, and never from one that is too small).
  function edgeExact(evenRank) {
    const v = edgeRead(evenRank);
    if (v === 3) return EDGE_DEPTH + 1;
    if (v === 0 && evenRank === EDGE_GOAL_RANK) return 0;
    const { mSi, mTau, nM } = searchTables();
    const cur = new Uint8Array(12), nxt = new Uint8Array(12), tmp = new Uint8Array(12);
    for (let d0 = v === 0 ? 3 : v; d0 <= EDGE_DEPTH; d0 += 3) {
      unrankPerm12(evenRank * 2, cur);
      if (permParity(cur) !== 0) unrankPerm12(evenRank * 2 + 1, cur);
      let dist = d0, ok = true;
      while (dist > 0) {
        let stepped = false;
        for (let k = 0; k < nM && !stepped; k++) {
          const si = mSi[k], t = mTau[k];
          for (let x = 0; x < 12; x++) nxt[x] = t[cur[si[x]]];
          const r = rankPerm12(nxt) >>> 1;
          // among a state's neighbours only those one step closer carry this
          // residue, so any match is a genuine descent
          if (edgeRead(r) === (dist + 2) % 3) { tmp.set(nxt); cur.set(tmp); dist--; stepped = true; }
        }
        if (!stepped) { ok = false; break; }
      }
      // the guess is only confirmed if the descent lands on the identity: a
      // guess that is too small also descends happily, it just stops short
      if (ok && (rankPerm12(cur) >>> 1) === EDGE_GOAL_RANK) return d0;
    }
    return EDGE_DEPTH + 1;
  }

  let EDGE_GOAL_RANK = 0;
  function buildEdgeTable(progress) {
    const { sigmaInv, tau } = deepStructure();
    edgeBits = new Uint8Array(N_EVEN / 4).fill(0xff);   // all "beyond horizon"
    const id = new Uint8Array(12);
    for (let i = 0; i < 12; i++) id[i] = i;
    const goal = rankPerm12(id);
    EDGE_GOAL_RANK = goal >>> 1;
    const write = (r, val) => {
      const sh = (r & 3) << 1;
      edgeBits[r >> 2] = (edgeBits[r >> 2] & ~(3 << sh)) | (val << sh);
    };
    write(EDGE_GOAL_RANK, 0);
    let frontier = new Uint32Array([goal]);
    for (let d = 0; d < EDGE_DEPTH; d++) {
      // the deepest level's frontier is kept too, so the horizon can later be
      // pushed one level further without redoing the BFS
      const next = new Uint32Array(Math.max(64, frontier.length * 12));
      let n = 0, found = 0;
      const val = (d + 1) % 3;
      const p = new Uint8Array(12), q = new Uint8Array(12);
      for (let fi = 0; fi < frontier.length; fi++) {
        unrankPerm12(frontier[fi], p);
        for (const mi of G3) {
          const si = sigmaInv[mi], t = tau[mi];
          for (let x = 0; x < 12; x++) q[x] = t[p[si[x]]];
          const nr = rankPerm12(q);
          const er = nr >>> 1;
          if (((edgeBits[er >> 2] >> ((er & 3) << 1)) & 3) === 3) {
            write(er, val);
            found++;
            next[n++] = nr;
          }
        }
      }
      frontier = next.subarray(0, n);
      if (progress) progress('edge table depth ' + (d + 1), found);
      if (!found) break;
    }
    edgeFrontier = frontier;   // states at exactly EDGE_DEPTH
  }

  // Push the horizon one level deeper, a slice of the frontier at a time, so a
  // worker can still serve solves in between chunks. A half-written level is
  // safe: an unmarked state still reports the current horizon + 1, which stays
  // a valid lower bound, and EDGE_DEPTH only advances once the level is whole.
  let edgeFrontier = null, upgradeAt = 0;
  function upgradeEdgeStep(budget) {
    if (!edgeFrontier) return true;
    const { sigmaInv, tau } = deepStructure();
    const val = (EDGE_DEPTH + 1) % 3;
    const p = new Uint8Array(12), q = new Uint8Array(12);
    const end = Math.min(edgeFrontier.length, upgradeAt + (budget || 30000));
    for (let fi = upgradeAt; fi < end; fi++) {
      unrankPerm12(edgeFrontier[fi], p);
      for (const mi of G3) {
        const si = sigmaInv[mi], t = tau[mi];
        for (let x = 0; x < 12; x++) q[x] = t[p[si[x]]];
        const er = rankPerm12(q) >>> 1;
        const sh = (er & 3) << 1;
        if (((edgeBits[er >> 2] >> sh) & 3) === 3) {
          edgeBits[er >> 2] = (edgeBits[er >> 2] & ~(3 << sh)) | (val << sh);
        }
      }
    }
    upgradeAt = end;
    if (upgradeAt >= edgeFrontier.length) {
      EDGE_DEPTH++;             // now consistent: the level is fully marked
      edgeFrontier = null;
      upgradeAt = 0;
      return true;
    }
    return false;
  }
  function edgeUpgradePending() { return edgeFrontier !== null; }

  let cpDist = null; // Uint8Array(70*70*70*2): exact G3 center+parity distances
  function buildCpTable() {
    const { maskT, sliceDouble } = deepStructure();
    cpDist = new Uint8Array(70 * 70 * 70 * 2).fill(255);
    const cpIdx = (a, b, c, bit) => ((rank8(a) * N70 + rank8(b)) * N70 + rank8(c)) * 2 + bit;
    const g = [AXIS_GOAL.UD, AXIS_GOAL.LR, AXIS_GOAL.FB, 0];
    cpDist[cpIdx(g[0], g[1], g[2], 0)] = 0;
    let frontier = [g];
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const [a, b, c, bit] of frontier) {
        for (const mi of G3) {
          const T = maskT[mi];
          const na = T[0][a], nb = T[1][b], nc = T[2][c], nbit = bit ^ sliceDouble[mi];
          const idx = cpIdx(na, nb, nc, nbit);
          if (cpDist[idx] === 255) { cpDist[idx] = d + 1; next.push([na, nb, nc, nbit]); }
        }
      }
      frontier = next;
      d++;
    }
    return cpDist;
  }
  // horizon is a build-time trade: depth 9 searches ~3x fewer nodes, depth 8
  // builds several times faster. Must be set before deepInit.
  function setEdgeDepth(d) {
    if (deepTablesBuilt) return false;
    EDGE_DEPTH = d;
    return true;
  }
  let deepTablesBuilt = false;
  function deepInit(progress) {
    if (deepTablesBuilt) return;
    if (!built) buildAll(progress);
    deepStructure();
    const t0 = Date.now();
    buildCpTable();
    if (progress) progress('center+parity table', Date.now() - t0);
    buildEdgeTable(progress);
    if (progress) progress('edge pairing table', Date.now() - t0);
    deepTablesBuilt = true;
  }

  const cpIndexOf = (a, b, c, bit) => ((rank8(a) * N70 + rank8(b)) * N70 + rank8(c)) * 2 + bit;

  // relative pairing permutation of a state; null when the half-split
  // bijection fails (some dedge has both wings in one half)
  function relOf8(s8, out) {
    const { posA, posB } = deepStructure();
    const A = new Uint8Array(12), Binv = new Uint8Array(12);
    let maskA = 0, maskB = 0;
    for (let d = 0; d < 12; d++) {
      const kA = s8[WING_STK8[posA[d]][0]] * 6 + s8[WING_STK8[posA[d]][1]];
      const kB = s8[WING_STK8[posB[d]][0]] * 6 + s8[WING_STK8[posB[d]][1]];
      const wA = WING_ID8[posA[d]][kA], wB = WING_ID8[posB[d]][kB];
      if (wA < 0 || wB < 0) return null;
      const dA = PAIR_OF_WING[wA], dB = PAIR_OF_WING[wB];
      A[d] = dA;
      Binv[dB] = d;
      maskA |= 1 << dA; maskB |= 1 << dB;
    }
    if (maskA !== 0xfff || maskB !== 0xfff) return null;
    const rel = out || new Uint8Array(12);
    for (let d = 0; d < 12; d++) rel[d] = Binv[A[d]];
    return { rel, aParity: permParity(A) };
  }

  // G3-feasibility of a state: half-split bijection, even rel, and
  // centers+parity inside the G3-reachable coset
  function deepFeasible8(s8) {
    const r = relOf8(s8);
    if (!r || permParity(r.rel) !== 0) return null;
    const m = axisMasks8(s8);
    const bit = cornerParity8(s8) ^ r.aParity;
    if (cpDist[cpIndexOf(m[0], m[1], m[2], bit)] === 255) return null;
    return { rel: r.rel, masks: m, bit };
  }

  // admissible lower bound on the moves still needed to clear half-split
  // defects: only R/L outer quarters and u/d slice quarters move wings across
  // the halves, at most 4 positions each, so >= ceil(defects/4) such moves
  // remain while any dedge has both wings in one half
  function defectBound(w) {
    const posA = (DEEP || deepStructure()).posA;
    let cnt = 0, seen = 0;
    for (let d = 0; d < 12; d++) {
      const dd = WING_DEDGE[w[posA[d]]];
      if (seen & (1 << dd)) cnt++;
      else seen |= 1 << dd;
    }
    return (cnt + 3) >> 2;
  }

  // G3-feasibility from incremental coordinates: wing permutation over the
  // 24 positions, the three axis masks, corner parity
  function feasibleFast(w, a0, a1, a2, cpar) {
    const D = DEEP || deepStructure();
    const posA = D.posA, posB = D.posB;
    const A = FF_A, Binv = FF_BINV, rel = FF_REL;
    let maskA = 0;
    for (let d = 0; d < 12; d++) {
      const dA = WING_DEDGE[w[posA[d]]];
      A[d] = dA;
      maskA |= 1 << dA;
      Binv[WING_DEDGE[w[posB[d]]]] = d;
    }
    if (maskA !== 0xfff) return false;
    for (let d = 0; d < 12; d++) rel[d] = Binv[A[d]];
    if (permParity12(rel) !== 0) return false;
    const bit = cpar ^ permParity12(A);
    return cpDist[cpIndexOf(a0, a1, a2, bit)] !== 255;
  }

  // shortest SET24 sequence making a head G3-feasible ("bridge"): IDDFS on
  // incremental coordinates (wing perm over positions, axis masks, corner
  // parity). Callers sweep exact depths so cross-head minima come first.
  function bridgeAtDepth(pre, depth, budget) {
    const { maskT, cparFlip } = deepStructure();
    const feasible = feasibleFast;
    if (depth === 0) return feasible(pre.w0, pre.m0[0], pre.m0[1], pre.m0[2], pre.cpar0) ? [] : null;
    const wStack = pre.wStack || (pre.wStack = Array.from({ length: 8 }, () => new Uint8Array(NW)));
    wStack[0].set(pre.w0);
    const pathIdx = [];
    const dfs = (g, a0, a1, a2, cpar, togo, lastLayer) => {
      const w = wStack[g], nw = wStack[g + 1];
      for (const mi of SET24) {
        if (budget && --budget.n < 0) return false;
        if (MOVE_FACE_ID[mi] === lastLayer) continue;
        const wp = wingPerm[mi], T = maskT[mi];
        for (let p = 0; p < NW; p++) nw[wp[p]] = w[p];
        const na0 = T[0][a0], na1 = T[1][a1], na2 = T[2][a2], ncp = cpar ^ cparFlip[mi];
        pathIdx.push(mi);
        if (feasible(nw, na0, na1, na2, ncp)) return true;
        if (togo > 1 && dfs(g + 1, na0, na1, na2, ncp, togo - 1, MOVE_FACE_ID[mi])) return true;
        pathIdx.pop();
      }
      return false;
    };
    if (!dfs(0, pre.m0[0], pre.m0[1], pre.m0[2], pre.cpar0, depth, 255)) return null;
    return pathIdx.map((mi) => MOVES36[mi]);
  }

  // ---- joint phase-2 + feasibility search ----------------------------------
  // Phase 2's classic goal (LR-class centers onto L∪R, even wing parity) does
  // not make phase 3 startable. Instead of bolting a bridge after it, search
  // phase 2 and G3-feasibility as ONE exact-depth problem over SET28 — SET24
  // ⊂ SET28, so this strictly dominates phase2-then-bridge; dist2 remains an
  // admissible prune. Centers ride along as 24-bit per-color masks (u/d
  // quarter turns are representable there); at leaves (dist2 == 0) the color
  // classes are separated, so they project exactly onto the three axis masks.
  function deepHeads(state, scheme, opts = {}) {
    const { cparFlip } = deepStructure();
    const p1s = phase1Options(state, scheme, opts.p1cap || 36, opts.p1slack === undefined ? 1 : opts.p1slack);
    if (!p1s.length) return [];
    const CODE_U = 0, CODE_R = 1, CODE_F = 2, CODE_L = 4;
    const preps = [];
    for (const p1 of p1s) {
      const s8 = encode96(p1.state, scheme);
      const w0 = new Uint8Array(NW);
      for (let p = 0; p < NW; p++) w0[p] = WING_ID8[p][s8[WING_STK8[p][0]] * 6 + s8[WING_STK8[p][1]]];
      let mU = 0, mL = 0, mF = 0, mLR = 0;
      for (let i = 0; i < NC; i++) {
        const code = s8[CENTER_STICKER8[i]];
        if (code === CODE_U) mU |= 1 << i;
        if (code === CODE_L) mL |= 1 << i;
        if (code === CODE_F) mF |= 1 << i;
        if (code === CODE_L || code === CODE_R) mLR |= 1 << i;
      }
      let m16 = 0;
      for (let i = 0; i < 16; i++) if (mLR & (1 << SIDE_POS[i])) m16 |= 1 << i;
      const wpar = permParity(w0);
      const d2 = dist2[rank16(m16) * 2 + wpar];
      if (d2 === 255) continue;
      preps.push({
        moves: p1.moves, len: p1.moves.length, s8, w0, cpar0: cornerParity8(s8),
        mU, mL, mF, m16, wpar, d2, lb0: Math.max(d2, defectBound(w0)),
      });
    }
    if (!preps.length) return [];
    const projAxis = (m24, axisName) => {
      const pos = AXIS_POS[axisName];
      let r = 0;
      for (let i = 0; i < 8; i++) if (m24 & (1 << pos[i])) r |= 1 << i;
      return r;
    };
    const headCap = opts.headCap || 8;
    const perPrepCap = opts.perPrepCap || 3;
    const out = [];
    const seenEnd = new Set();
    const wStack = Array.from({ length: 14 }, () => new Uint8Array(NW));
    const pathMi = [];
    let nodes = 0;
    const nodeCap = opts.headsNodeCap || 3e6;
    const collectFrom = (prep) => {
      const s8b = new Uint8Array(prep.s8);
      let cur = s8b;
      for (const mi of pathMi) cur = apply8(cur, MOVES36[mi]);
      const key = cur.join(',');
      if (seenEnd.has(key)) return;
      seenEnd.add(key);
      const moves = C4.cleanAlg4(prep.moves.concat(pathMi.map((mi) => MOVES36[mi])));
      const feas = deepFeasible8(cur);
      if (!feas) return; // defensive; the incremental test said feasible
      const lb = Math.max(edgeExact(rankPerm12(feas.rel) >>> 1),
        cpDist[cpIndexOf(feas.masks[0], feas.masks[1], feas.masks[2], feas.bit)]);
      out.push({ moves, s8: cur, total: moves.length, lb });
    };
    const search = (prep, depth) => {
      let found = 0;
      wStack[0].set(prep.w0);
      const dfs = (g, mU, mL, mF, m16, wpar, cpar, togo, lastAxis, lastLayer) => {
        const w = wStack[g], nw = wStack[g + 1];
        for (const mi of SET28) {
          if (nodes > nodeCap || found >= perPrepCap || out.length >= headCap * 2) return;
          const ax = MOVE_AXIS[mi], ly = MOVE_LAYER[mi];
          if (ax === lastAxis && ly <= lastLayer) continue; // canonical order
          nodes++;
          const nm16 = applySide16(mi, m16);
          const npar = wpar ^ MOVE_ODD[mi];
          const nd = dist2[rank16(nm16) * 2 + npar];
          if (nd > togo - 1) continue;
          const T = centerMask[mi];
          const nmU = applyMask(T, mU), nmL = applyMask(T, mL), nmF = applyMask(T, mF);
          const wp = wingPerm[mi];
          for (let p = 0; p < NW; p++) nw[wp[p]] = w[p];
          if (togo > 1 && defectBound(nw) > togo - 1) continue;
          const ncpar = cpar ^ cparFlip[mi];
          pathMi.push(mi);
          if (togo === 1) {
            const a0 = projAxis(nmU, 'UD'), a1 = projAxis(nmL, 'LR'), a2 = projAxis(nmF, 'FB');
            if (feasibleFast(nw, a0, a1, a2, ncpar)) { collectFrom(prep); found++; }
          } else {
            dfs(g + 1, nmU, nmL, nmF, nm16, npar, ncpar, togo - 1, ax, ly);
          }
          pathMi.pop();
        }
      };
      if (depth === 0) {
        const a0 = projAxis(prep.mU, 'UD'), a1 = projAxis(prep.mL, 'LR'), a2 = projAxis(prep.mF, 'FB');
        if (prep.d2 === 0 && feasibleFast(prep.w0, a0, a1, a2, prep.cpar0)) collectFrom(prep);
        return;
      }
      dfs(0, prep.mU, prep.mL, prep.mF, prep.m16, prep.wpar, prep.cpar0, depth, -1, 9);
    };
    // sweep total length ascending across all phase-1 options so globally
    // cheapest feasible heads surface first
    const tBase = Math.min(...preps.map((p) => p.len + p.lb0));
    let bestTotal = Infinity;
    for (let t = tBase; t <= tBase + (opts.tExtra === undefined ? 5 : opts.tExtra); t++) {
      for (const prep of preps) {
        const d = t - prep.len;
        if (d < prep.lb0 || d > prep.d2 + 8) continue;
        pathMi.length = 0;
        search(prep, d);
      }
      if (out.length) bestTotal = Math.min(bestTotal, ...out.map((o) => o.total));
      if (out.length >= headCap || nodes > nodeCap) break;
      if (out.length && t >= bestTotal + (opts.slackKeep === undefined ? 1 : opts.slackKeep)) break;
    }
    out.sort((a, b) => (a.total + a.lb) - (b.total + b.lb));
    return out.slice(0, headCap);
  }

  // IDA* over (rel, axis masks, parity bit); h = max(edge table, cp table) is
  // admissible and h == 0 ⇔ fully reduced with zero parity debt.
  // Flattened per-move search tables, built once and reused across every
  // deepSolve3 call: sigma-inverse/tau for the rel permutation, axis
  // transitions in RANK space (so the inner loop never calls rank8), the
  // parity flip, and axis/layer ids for canonical move ordering.
  let SEARCH_T = null;
  function searchTables() {
    if (SEARCH_T) return SEARCH_T;
    const { sigmaInv, tau, maskT, sliceDouble } = deepStructure();
    const nM = G3.length;
    const mSi = [], mTau = [], mRank = [], mTok = [];
    const mFlip = new Uint8Array(nM), mAxis = new Uint8Array(nM), mLayer = new Uint8Array(nM);
    for (let k = 0; k < nM; k++) {
      const mi = G3[k];
      mSi.push(sigmaInv[mi]); mTau.push(tau[mi]);
      // maskT maps mask->mask; walk every 4-of-8 mask once to get rank->rank
      const R = new Int16Array(3 * N70);
      for (let ax = 0; ax < 3; ax++) {
        const tab = maskT[mi][ax];
        for (let m = 0; m < 256; m++) {
          if (POPC12[m] !== 4) continue;
          R[ax * N70 + RANK8_T[m]] = RANK8_T[tab[m]];
        }
      }
      mRank.push(R);
      mFlip[k] = sliceDouble[mi];
      mAxis[k] = AXIS_OF_FACE[MOVES36[mi][0]];
      mLayer[k] = LAYER_OF_FACE[MOVES36[mi][0]];
      mTok.push(MOVES36[mi]);
    }
    SEARCH_T = { nM, mSi, mTau, mRank, mFlip, mAxis, mLayer, mTok };
    return SEARCH_T;
  }

  function deepSolve3(s8, opts = {}) {
    const nodeCap = opts.nodeCap || 30e6;
    const feas = deepFeasible8(s8);
    if (!feas) return { error: 'infeasible' };
    const { nM, mSi, mTau, mRank, mFlip, mAxis, mLayer, mTok } = searchTables();
    const MAXD = 24;
    const relStack = Array.from({ length: MAXD + 2 }, () => new Uint8Array(12));
    relStack[0].set(feas.rel);
    const path = new Int8Array(MAXD + 1);
    // centers ride as per-axis ranks (0..69), so the cp index is arithmetic
    const q0 = RANK8_T[feas.masks[0]], q1 = RANK8_T[feas.masks[1]], q2 = RANK8_T[feas.masks[2]];
    // the root has no parent value, so pay once for an exact lookup; every
    // node below it rides the incremental mod-3 step instead
    const he0 = edgeExact(rankPerm12(relStack[0]) >>> 1);
    const hc0 = cpDist[((q0 * N70 + q1) * N70 + q2) * 2 + feas.bit];
    const h0 = he0 > hc0 ? he0 : hc0;
    if (h0 === 0) return { solutions: [[]], nodes: 0 };
    // collect up to opts.solutions distinct optimal-length solutions: their
    // end states differ (dedge permutation is free), which feeds the 3x3
    // finish a diversity lottery at almost no extra search cost
    const wantSols = opts.solutions || 1;
    const extraNodes = opts.extraNodes || 2e6; // budget for solutions beyond the first
    const deadline = opts.timeCapMs ? Date.now() + opts.timeCapMs : Infinity;
    const solutions = [];
    let nodes = 0, aborted = false, nodesAtFirst = -1;
    const dfs = (g, a, b, c, bit, he, bound, prevAxis, prevLayer) => {
      const rel = relStack[g], nrel = relStack[g + 1];
      for (let k = 0; k < nM; k++) {
        const ax = mAxis[k], ly = mLayer[k];
        if (ax === prevAxis && ly <= prevLayer) continue; // canonical same-axis order
        if (++nodes > nodeCap) { aborted = true; return true; }
        if ((nodes & 0xfffff) === 0 && Date.now() > deadline) { aborted = true; return true; }
        if (nodesAtFirst >= 0 && nodes > nodesAtFirst + extraNodes) return true;
        const si = mSi[k], t = mTau[k];
        for (let x = 0; x < 12; x++) nrel[x] = t[rel[si[x]]];
        const R = mRank[k];
        const na = R[a], nb = R[N70 + b], nc = R[140 + c], nbit = bit ^ mFlip[k];
        const er = rankPerm12(nrel) >>> 1;
        const nhe = edgeStep(er, he);
        const hc = cpDist[((na * N70 + nb) * N70 + nc) * 2 + nbit];
        let h = nhe > hc ? nhe : hc;
        // goal is tested against the coordinates themselves, never inferred
        // from h reaching 0 (cpDist is exact, so hc === 0 really is solved)
        if (er === EDGE_GOAL_RANK && hc === 0) {
          path[g] = k;
          const moves = [];
          for (let i = 0; i <= g; i++) moves.push(mTok[path[i]]);
          solutions.push(moves);
          if (nodesAtFirst < 0) nodesAtFirst = nodes;
          if (solutions.length >= wantSols) return true;
          continue;
        }
        if (h === 0) h = 1;   // not solved, so at least one move remains
        if (g + 1 + h <= bound) {
          path[g] = k;
          if (dfs(g + 1, na, nb, nc, nbit, nhe, bound, ax, ly)) return true;
        }
      }
      return false;
    };
    for (let bound = h0; bound <= (opts.maxDepth || 20); bound++) {
      dfs(0, q0, q1, q2, feas.bit, he0, bound, -1, 9);
      if (solutions.length) return { solutions, nodes };
      if (aborted) return { error: 'nodes', nodes };
    }
    return { error: 'maxDepth', nodes };
  }

  // proper whole-cube rotations of a scheme: which color pair plays U/D
  // during reduction (the 3x3 finish reads the reduced cube's own centers,
  // so any rotation yields a valid solve)
  const ROT_FACES = [
    null,
    { U: 'F', F: 'D', D: 'B', B: 'U', L: 'L', R: 'R' },   // x
    { U: 'L', L: 'D', D: 'R', R: 'U', F: 'F', B: 'B' },   // z
  ];
  function rotateScheme(scheme, r) {
    if (!r) return scheme;
    const map = ROT_FACES[r];
    const out = {};
    for (const f of C4.FACES) out[f] = scheme[map[f]];
    return out;
  }

  // full deep reduction: heads -> bridge sweep -> exact phase 3.
  // Returns up to opts.results complete parity-free reductions, shortest
  // first, or null when no head can be bridged (caller falls back to beams).
  function deepReduce(state, scheme, opts = {}) {
    deepInit(opts.progress);
    // two head pipelines feed one candidate pool: the joint phase-2 +
    // feasibility search (shortest when it lands within its node budget) and
    // the classic heads + bridge sweep (cheap, and rescues the scrambles the
    // joint search prices too high)
    const cands = (opts.skipJointHeads ? [] : deepHeads(state, scheme, opts))
      .map((h) => ({ head: h.moves, br: [], s8: h.s8, total: h.total, lb: h.lb }));
    const seenCand = new Set(cands.map((c) => c.s8.join(',')));
    if (!opts.skipBridge) {
      const heads = phaseHeads(state, scheme, {
        p1cap: opts.p1cap || 36, p1slack: opts.p1slack === undefined ? 1 : opts.p1slack,
        p2cap: opts.p2cap || 4, headCap: opts.headCap || 12,
      });
      const pres = heads.map((h) => {
        const s8 = encode96(h.state, scheme);
        const w0 = new Uint8Array(NW);
        for (let p = 0; p < NW; p++) w0[p] = WING_ID8[p][s8[WING_STK8[p][0]] * 6 + s8[WING_STK8[p][1]]];
        return { head: h.moves, s8, w0, m0: axisMasks8(s8), cpar0: cornerParity8(s8) };
      });
      let bestTotal = cands.length ? Math.min(...cands.map((c) => c.total)) : Infinity;
      let found = 0;
      const budget = { n: opts.bridgeNodeCap || 20e6 }; // shared across the whole sweep
      for (let d = 0; d <= (opts.maxBridge || 5) && budget.n > 0; d++) {
        for (const c of pres) {
          if (budget.n <= 0) break;
          if (c.head.length + d >= bestTotal + (opts.slackKeep === undefined ? 1 : opts.slackKeep)) continue;
          const br = bridgeAtDepth(c, d, budget);
          if (!br) continue;
          let s8 = c.s8;
          for (const m of br) s8 = apply8(s8, m);
          const key = s8.join(',');
          if (seenCand.has(key)) continue;
          seenCand.add(key);
          const feas = deepFeasible8(s8);
          if (!feas) continue;
          const lb = Math.max(edgeExact(rankPerm12(feas.rel) >>> 1),
            cpDist[cpIndexOf(feas.masks[0], feas.masks[1], feas.masks[2], feas.bit)]);
          const total = c.head.length + br.length;
          cands.push({ head: c.head, br, s8, total, lb });
          found++;
          if (total < bestTotal) bestTotal = total;
        }
        if (found >= (opts.bridgedCap || 6)) break;
      }
      if (!cands.length) return null;
      cands.sort((a, b) => (a.total + a.lb) - (b.total + b.lb));
    }
    const out = [];
    const seenRed = new Set();
    const t0 = Date.now();
    const softMs = opts.softMs || 6000;
    const tried = Math.min(cands.length, opts.tries || 8);
    let bestLen = Infinity;
    for (let i = 0; i < tried; i++) {
      const cand = cands[i];
      // Branch and bound on the finished length. cands are sorted by
      // total + lb, and lb is an admissible lower bound on this head's
      // phase 3, so once the best solution in hand beats what this head could
      // possibly yield, no later head can win either. The +2 absorbs seam
      // cancellation, which can make a cleaned solution shorter than the sum
      // of its parts.
      if (out.length && cand.total + cand.lb >= bestLen + 2) break;
      if (Date.now() - t0 > softMs && (out.length || opts.bailEmpty)) break;
      const r = deepSolve3(cand.s8, {
        nodeCap: opts.nodeCap || 30e6, solutions: opts.solutions || 3, extraNodes: opts.extraNodes,
        timeCapMs: opts.p3TimeCapMs,
      });
      if (r.error) continue;
      for (const sol of r.solutions) {
        const moves = C4.cleanAlg4(cand.head.concat(cand.br, sol));
        const key = moves.join(' ');
        if (!seenRed.has(key)) {
          seenRed.add(key);
          out.push(moves);
          if (moves.length < bestLen) bestLen = moves.length;
        }
      }
    }
    if (!out.length) return null;
    out.sort((a, b) => a.length - b.length);
    return out.slice(0, opts.results || 3);
  }

  return {
    MOVES36, centerPerm, wingPerm, SET36, SET28, SET24, OUTER18,
    buildAll, exportTables, importTables, TABLES_VERSION, PORTFOLIO, PORTFOLIO_DEEP,
    phasedReduce, walkPhase, phase3Beam8, score8, centersExact, encode96, idaStar8,
    classMask24, lrMask16, axisMasks, wingParityOf, phase1Options, phase2Options, phaseHeads,
    endgameBeam8, pllParity8, reductionMeta,
    deepInit, setEdgeDepth, upgradeEdgeStep, edgeUpgradePending,
    get edgeBits() { return edgeBits; }, get edgeDepth() { return EDGE_DEPTH; },
    deepReduce, deepSolve3, deepFeasible8, deepHeads, bridgeAtDepth, rotateScheme,
    cornerParity8, relOf8, rankPerm12, unrankPerm12, permParity, axisMasks8,
    get deepTablesBuilt() { return deepTablesBuilt; },
    apply8, hash8, centersExact8, allPaired8, wingParity8,
    get built() { return built; },
    get dist1() { return dist1; }, get dist2() { return dist2; },
    get dist3c() { return dist3c; }, get dist3p() { return dist3p; },
    rankMask, rank16, rank8, rankTuple, applyMask, centerMask,
    UD_GOAL_MASK, LR_GOAL_MASK16, SIDE_POS, SIDE_INDEX, AXIS_POS, AXIS_INDEX, AXIS_GOAL,
    N1, N2, N70, N4W, CNK, WING_DEDGE, MOVE_INDEX,
  };
})();

// register as the fast-path reducer for cube4's solver.
// One retry with different search weights when the first attempt lands long.
// Sequential fallback (no workers): the whole portfolio back to back, with
// richer closers — this path is not racing a wall-clock target the way the
// parallel worker path is, and single configs occasionally wander badly on
// hard scrambles (the diversity is what caps the outliers). Total time lands
// around the old on-device baseline (~12s) with far shorter solutions.
C4t.phasedReducer = (state, scheme) => TPR4.phasedReduce(state, scheme, {
  restarts: TPR4.PORTFOLIO.map((c) => Object.assign({}, c, {
    endgameTries: 2, greedyTries: 3, endgame: { lite: 1, width: 1000, rounds: 16 },
  })),
});

if (typeof module !== 'undefined') module.exports = TPR4;
if (typeof globalThis !== 'undefined') globalThis.TPR4 = TPR4;

})();
