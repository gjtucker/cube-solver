// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

(function(){
// Rubik's Cube engine + layer-by-layer solver
// Facelet model: 54 stickers, faces U,R,F,D,L,B (9 each, row-major).
// Color scheme (solved): U=yellow, D=white, F=green, B=blue, R=orange, L=red.
// Color ids ARE face letters.

const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

const FACE_GEO = {
  U: { n: [0, 1, 0], right: [1, 0, 0], down: [0, 0, 1] },
  D: { n: [0, -1, 0], right: [1, 0, 0], down: [0, 0, -1] },
  F: { n: [0, 0, 1], right: [1, 0, 0], down: [0, -1, 0] },
  B: { n: [0, 0, -1], right: [-1, 0, 0], down: [0, -1, 0] },
  R: { n: [1, 0, 0], right: [0, 0, -1], down: [0, -1, 0] },
  L: { n: [-1, 0, 0], right: [0, 0, 1], down: [0, -1, 0] },
};

function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vcross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
// rotate v around unit axis a by -90 deg (clockwise seen from outside along -a)
function rotCW(v, a) { return vadd(vscale(a, vdot(a, v)), vscale(vcross(a, v), -1)); }
function keyOf(v) { return v.map((x) => Math.round(x * 2)).join(','); }

// Build sticker table: index -> {face, pos, normal}
const STICKERS = [];
for (const f of FACES) {
  const g = FACE_GEO[f];
  for (let i = 0; i < 9; i++) {
    const row = Math.floor(i / 3), col = i % 3;
    const pos = vadd(vadd(vscale(g.n, 1.5), vscale(g.right, col - 1)), vscale(g.down, row - 1));
    STICKERS.push({ face: f, pos, normal: g.n.slice() });
  }
}
const POS_LOOKUP = {};
STICKERS.forEach((s, i) => { POS_LOOKUP[keyOf(s.pos)] = i; });

// Move permutations: MOVE_PERM['R'][src] = dst  (sticker at src goes to dst)
const MOVE_PERM = {};
for (const f of FACES) {
  const axis = FACE_GEO[f].n;
  const perm = STICKERS.map((_, i) => i);
  STICKERS.forEach((s, i) => {
    if (vdot(s.pos, axis) > 0.4) {
      const np = rotCW(s.pos, axis);
      const dst = POS_LOOKUP[keyOf(np)];
      perm[i] = dst;
    }
  });
  MOVE_PERM[f] = perm;
}

function applyMove(state, move) {
  const face = move[0];
  let times = 1;
  if (move.length > 1) times = move[1] === '2' ? 2 : 3;
  let s = state;
  const perm = MOVE_PERM[face];
  for (let t = 0; t < times; t++) {
    const ns = new Array(54);
    for (let i = 0; i < 54; i++) ns[perm[i]] = s[i];
    s = ns;
  }
  return s;
}

function applyAlg(state, alg) {
  const moves = Array.isArray(alg) ? alg : alg.trim().split(/\s+/).filter(Boolean);
  let s = state;
  for (const m of moves) s = applyMove(s, m);
  return s;
}

function solvedState() {
  const s = [];
  for (const f of FACES) for (let i = 0; i < 9; i++) s.push(f);
  return s;
}
function isSolved(state) {
  for (let f = 0; f < 6; f++)
    for (let i = 0; i < 9; i++)
      if (state[f * 9 + i] !== state[f * 9 + 4]) return false;
  return true;
}

// ---- cubie slot tables (generated from geometry) ----
function clampCoord(x) { return Math.max(-1, Math.min(1, Math.round(x))); }
const cubieMap = {}; // key -> [stickerIndex,...]
STICKERS.forEach((s, i) => {
  const k = s.pos.map(clampCoord).join(',');
  (cubieMap[k] = cubieMap[k] || []).push(i);
});
const EDGES = {};   // canonical name (e.g. 'UF') -> {name, stickers:{face:index}}
const CORNERS = {}; // canonical name (e.g. 'UFR') -> same
const EDGE_NAMES = [], CORNER_NAMES = [];
for (const k in cubieMap) {
  const idxs = cubieMap[k];
  if (idxs.length === 2) {
    const faces = idxs.map((i) => STICKERS[i].face).sort().join('');
    const st = {};
    idxs.forEach((i) => { st[STICKERS[i].face] = i; });
    EDGES[faces] = { name: faces, stickers: st };
    EDGE_NAMES.push(faces);
  } else if (idxs.length === 3) {
    const faces = idxs.map((i) => STICKERS[i].face).sort().join('');
    const st = {};
    idxs.forEach((i) => { st[STICKERS[i].face] = i; });
    CORNERS[faces] = { name: faces, stickers: st };
    CORNER_NAMES.push(faces);
  }
}
function edgeKey(f1, f2) { return [f1, f2].sort().join(''); }
function cornerKey(f1, f2, f3) { return [f1, f2, f3].sort().join(''); }

// find edge holding color set {c1,c2}; returns {slot, colorAt: face->color}
function findEdge(state, c1, c2) {
  const want = [c1, c2].sort().join('');
  for (const name of EDGE_NAMES) {
    const e = EDGES[name];
    const cols = Object.values(e.stickers).map((i) => state[i]).sort().join('');
    if (cols === want) {
      const colorAt = {};
      for (const f in e.stickers) colorAt[f] = state[e.stickers[f]];
      return { slot: name, colorAt };
    }
  }
  return null;
}
function findCorner(state, c1, c2, c3) {
  const want = [c1, c2, c3].sort().join('');
  for (const name of CORNER_NAMES) {
    const c = CORNERS[name];
    const cols = Object.values(c.stickers).map((i) => state[i]).sort().join('');
    if (cols === want) {
      const colorAt = {};
      for (const f in c.stickers) colorAt[f] = state[c.stickers[f]];
      return { slot: name, colorAt };
    }
  }
  return null;
}

// ---- move mapping (y-rotation): treat T as if it were F ----
const RIGHT_OF = { F: 'R', R: 'B', B: 'L', L: 'F' };
const MAPS = {
  F: { F: 'F', R: 'R', B: 'B', L: 'L', U: 'U', D: 'D' },
  R: { F: 'R', R: 'B', B: 'L', L: 'F', U: 'U', D: 'D' },
  B: { F: 'B', R: 'L', B: 'F', L: 'R', U: 'U', D: 'D' },
  L: { F: 'L', R: 'F', B: 'R', L: 'B', U: 'U', D: 'D' },
};
function mapAlg(alg, T) {
  const m = MAPS[T];
  return alg.trim().split(/\s+/).map((mv) => m[mv[0]] + mv.slice(1)).join(' ');
}

const INV = (mv) => (mv.length === 1 ? mv + "'" : mv[1] === '2' ? mv : mv[0]);

// ---------------- Solver ----------------
class SolveError extends Error {}

class Solver {
  constructor(state) {
    this.state = state.slice();
    this.moves = [];
    this.stages = [];
  }
  do(alg) {
    const mvs = Array.isArray(alg) ? alg : alg.trim().split(/\s+/).filter(Boolean);
    for (const m of mvs) {
      this.state = applyMove(this.state, m);
      this.moves.push(m);
    }
  }
  stage(name, desc) {
    this.stages.push({ name, desc, start: this.moves.length });
  }
  endStage() {
    if (this.stages.length) this.stages[this.stages.length - 1].end = this.moves.length;
  }

  // ---- Stage 1: white cross (white = 'D') ----
  solveCross() {
    for (const T of ['F', 'R', 'B', 'L']) this.solveCrossEdge(T);
  }
  crossEdgeSolved(T) {
    const e = findEdge(this.state, 'D', T);
    return e.slot === edgeKey('D', T) && e.colorAt.D === 'D';
  }
  solveCrossEdge(T) {
    for (let guard = 0; guard < 12; guard++) {
      if (this.crossEdgeSolved(T)) return;
      const e = findEdge(this.state, 'D', T);
      const slot = e.slot;
      if (slot.includes('U')) {
        // bring above target with U turns
        for (let k = 0; k < 4; k++) {
          const cur = findEdge(this.state, 'D', T);
          if (cur.slot === edgeKey('U', T)) break;
          this.do('U');
        }
        const cur = findEdge(this.state, 'D', T);
        if (cur.slot !== edgeKey('U', T)) throw new SolveError('cross U-align failed');
        if (cur.colorAt.U === 'D') {
          this.do(T + '2');
        } else {
          this.do(mapAlg("U' R' F R", T));
        }
        if (!this.crossEdgeSolved(T)) throw new SolveError('cross insert failed');
        return;
      } else if (slot.includes('D')) {
        const side = slot.replace('D', '');
        this.do(side + '2');
      } else {
        // E-layer: lift to U
        const [A, B] = slot.split('');
        let done = false;
        for (const cand of [A, A + "'", B, B + "'"]) {
          const test = applyMove(this.state, cand);
          const te = findEdge(test, 'D', T);
          if (te.slot.includes('U')) {
            this.do([cand, 'U', INV(cand)]);
            done = true;
            break;
          }
        }
        if (!done) throw new SolveError('cross lift failed');
      }
    }
    throw new SolveError('cross loop exceeded');
  }

  // ---- Stage 2: white corners ----
  cornerPairs = [['F', 'R'], ['R', 'B'], ['B', 'L'], ['L', 'F']];
  cornerSolved(X, Y) {
    const c = findCorner(this.state, 'D', X, Y);
    return c.slot === cornerKey('D', X, Y) && c.colorAt.D === 'D' && c.colorAt[X] === X && c.colorAt[Y] === Y;
  }
  solveCorners() {
    for (const [X, Y] of this.cornerPairs) this.solveCorner(X, Y);
  }
  solveCorner(X, Y) {
    // T such that (X,Y) = (T, right(T))
    const T = RIGHT_OF[X] === Y ? X : Y;
    for (let guard = 0; guard < 12; guard++) {
      if (this.cornerSolved(X, Y)) return;
      const c = findCorner(this.state, 'D', X, Y);
      if (c.slot.includes('D')) {
        // pop to U layer
        const sides = c.slot.replace('D', '').split('');
        let done = false;
        for (const S of sides) {
          for (const cand of [S, S + "'"]) {
            const test = applyAlg(this.state, [cand, 'U', INV(cand)]);
            const tc = findCorner(test, 'D', X, Y);
            if (tc.slot.includes('U')) {
              this.do([cand, 'U', INV(cand)]);
              done = true;
              break;
            }
          }
          if (done) break;
        }
        if (!done) throw new SolveError('corner pop failed');
      } else {
        // in U layer: rotate above target slot
        const above = cornerKey('U', X, Y);
        let ok = false;
        for (let k = 0; k < 4; k++) {
          if (findCorner(this.state, 'D', X, Y).slot === above) { ok = true; break; }
          this.do('U');
        }
        if (!ok && findCorner(this.state, 'D', X, Y).slot === above) ok = true;
        if (!ok) throw new SolveError('corner U-align failed');
        const sexy = mapAlg("R U R' U'", T);
        let solvedNow = false;
        for (let r = 0; r < 7; r++) {
          if (this.cornerSolved(X, Y)) { solvedNow = true; break; }
          this.do(sexy);
        }
        if (!solvedNow && this.cornerSolved(X, Y)) solvedNow = true;
        if (!solvedNow) throw new SolveError('corner insert failed');
        return;
      }
    }
    throw new SolveError('corner loop exceeded');
  }

  // ---- Stage 3: middle edges ----
  middleSolved(A, B) {
    const e = findEdge(this.state, A, B);
    return e.slot === edgeKey(A, B) && e.colorAt[A] === A && e.colorAt[B] === B;
  }
  solveMiddle() {
    const RIGHT_INSERT = "U R U' R' U' F' U F";
    const LEFT_INSERT = "U' L' U L U F U' F'";
    for (const [X, Y] of this.cornerPairs) {
      for (let guard = 0; guard < 8; guard++) {
        if (this.middleSolved(X, Y)) break;
        const e = findEdge(this.state, X, Y);
        if (!e.slot.includes('U')) {
          // stuck in some middle slot: eject by inserting over it
          const [a, b] = e.slot.split('');
          const T = RIGHT_OF[a] === b ? a : b;
          this.do(mapAlg(RIGHT_INSERT, T));
          continue;
        }
        // in U layer: align side sticker with its face
        let aligned = false;
        for (let k = 0; k < 4; k++) {
          const cur = findEdge(this.state, X, Y);
          const sideFace = cur.slot.replace('U', '');
          if (cur.colorAt[sideFace] === sideFace) { aligned = true; break; }
          this.do('U');
        }
        if (!aligned) {
          const cur = findEdge(this.state, X, Y);
          const sideFace = cur.slot.replace('U', '');
          if (cur.colorAt[sideFace] === sideFace) aligned = true;
        }
        if (!aligned) throw new SolveError('middle align failed');
        const cur = findEdge(this.state, X, Y);
        const T = cur.slot.replace('U', '');
        const topColor = cur.colorAt.U;
        if (topColor === RIGHT_OF[T]) this.do(mapAlg(RIGHT_INSERT, T));
        else this.do(mapAlg(LEFT_INSERT, T));
        if (!this.middleSolved(X, Y)) throw new SolveError('middle insert failed');
        break;
      }
      if (!this.middleSolved(X, Y)) throw new SolveError('middle loop exceeded');
    }
  }

  // ---- Stage 4: yellow cross (orient U edges) ----
  uEdgeOriented(slotSide) {
    const e = EDGES[edgeKey('U', slotSide)];
    return this.state[e.stickers.U] === 'U';
  }
  solveYellowCross() {
    const ALG = "F R U R' U' F'";
    for (let guard = 0; guard < 8; guard++) {
      const or = ['F', 'R', 'B', 'L'].filter((s) => this.uEdgeOriented(s));
      if (or.length === 4) return;
      if (or.length === 1 || or.length === 3) throw new SolveError('unsolvable: edge orientation parity');
      if (or.length === 0) { this.do(ALG); continue; }
      // two oriented
      const isOpp = (or.includes('F') && or.includes('B')) || (or.includes('L') && or.includes('R'));
      if (isOpp) {
        // make horizontal line (L & R oriented)
        for (let k = 0; k < 4; k++) {
          if (this.uEdgeOriented('L') && this.uEdgeOriented('R')) break;
          this.do('U');
        }
        this.do(ALG);
      } else {
        // L-shape: put oriented edges at B and L
        for (let k = 0; k < 4; k++) {
          if (this.uEdgeOriented('B') && this.uEdgeOriented('L')) break;
          this.do('U');
        }
        this.do(ALG);
      }
    }
    throw new SolveError('yellow cross loop exceeded');
  }

  // ---- Stage 5: permute U edges ----
  uEdgeMatchCount() {
    let n = 0;
    for (const s of ['F', 'R', 'B', 'L']) {
      const e = EDGES[edgeKey('U', s)];
      if (this.state[e.stickers[s]] === s) n++;
    }
    return n;
  }
  bestURotation() {
    let best = { k: 0, n: -1 };
    let st = this.state;
    for (let k = 0; k < 4; k++) {
      let n = 0;
      for (const s of ['F', 'R', 'B', 'L']) {
        const e = EDGES[edgeKey('U', s)];
        if (st[e.stickers[s]] === s) n++;
      }
      if (n > best.n) best = { k, n };
      st = applyMove(st, 'U');
    }
    return best;
  }
  solveUEdges() {
    // Sune ("R U R' U R U2 R'") fixes UF, 3-cycles UR->UB->UL (verified).
    // SWAP ("R U R' U R U2 R' U") transposes UF <-> UL (verified).
    const SUNE = "R U R' U R U2 R'";
    const SWAP = "R U R' U R U2 R' U";
    const LEFT_OF = { F: 'L', L: 'B', B: 'R', R: 'F' };
    for (let guard = 0; guard < 20; guard++) {
      const best = this.bestURotation();
      for (let k = 0; k < best.k; k++) this.do('U');
      if (best.n === 4) return;
      const solvedSides = [], unsolvedSides = [];
      for (const s of ['F', 'R', 'B', 'L']) {
        const e = EDGES[edgeKey('U', s)];
        (this.state[e.stickers[s]] === s ? solvedSides : unsolvedSides).push(s);
      }
      if (best.n === 2) {
        const [a, b] = unsolvedSides;
        if (LEFT_OF[a] === b) this.do(mapAlg(SWAP, a));       // swap Ua <-> U(left of a)
        else if (LEFT_OF[b] === a) this.do(mapAlg(SWAP, b));
        else this.do(mapAlg(SWAP, a)); // opposite pair: break into a 3-cycle first
      } else if (best.n === 1) {
        this.do(mapAlg(SUNE, solvedSides[0])); // cycle the other three
      } else {
        this.do(SUNE);
      }
    }
    throw new SolveError('unsolvable: edge permutation');
  }

  // ---- Stage 6: permute U corners ----
  uCornerCorrect(slot) {
    // slot like 'FRU' canonical; correct if its colors = its faces (ignoring orientation)
    const c = CORNERS[slot];
    const cols = Object.keys(c.stickers).map((f) => this.state[c.stickers[f]]).sort().join('');
    return cols === slot;
  }
  solveUCorners() {
    const CP = "U R U' L' U R' U' L"; // cycles 3 corners, fixes one (determined in tests)
    const uCornerSlots = CORNER_NAMES.filter((n) => n.includes('U'));
    for (let guard = 0; guard < 10; guard++) {
      const correct = uCornerSlots.filter((s) => this.uCornerCorrect(s));
      if (correct.length === 4) return;
      if (correct.length === 0) { this.do(CP); continue; }
      if (correct.length === 1) {
        // map alg so its fixed slot lands on the correct corner
        const fixedSlot = this.cpFixedSlot; // e.g. 'FRU' when alg unmapped
        const target = correct[0];
        let applied = false;
        for (const T of ['F', 'R', 'B', 'L']) {
          const m = MAPS[T];
          const mapped = fixedSlot.split('').map((f) => m[f] || f).sort().join('');
          if (mapped === target) {
            this.do(mapAlg(CP, T));
            applied = true;
            break;
          }
        }
        if (!applied) throw new SolveError('corner perm mapping failed');
        continue;
      }
      // 2 correct: a lone corner swap breaks permutation parity — the paint is wrong
      if (correct.length === 2) throw new SolveError('unsolvable: corner permutation');
    }
    throw new SolveError('corner permutation loop exceeded');
  }

  // ---- Stage 7: orient U corners ----
  solveUCornerOrientation() {
    const urf = CORNERS[cornerKey('U', 'R', 'F')];
    const uSlots = CORNER_NAMES.filter((n) => n.includes('U'));
    const unoriented = () => uSlots.filter((s) => {
      const c = CORNERS[s];
      return this.state[c.stickers.U] !== 'U';
    });
    for (let guard = 0; guard < 16; guard++) {
      const un = unoriented();
      if (un.length === 0) break;
      // bring an unoriented corner to URF via U turns
      let ok = false;
      for (let k = 0; k < 4; k++) {
        if (this.state[urf.stickers.U] !== 'U') { ok = true; break; }
        this.do('U');
      }
      if (!ok && this.state[urf.stickers.U] !== 'U') ok = true;
      if (!ok) throw new SolveError('corner orient align failed');
      let twisted = false;
      for (let r = 0; r < 3; r++) {
        this.do("R' D' R D R' D' R D");
        if (this.state[urf.stickers.U] === 'U') { twisted = true; break; }
      }
      if (!twisted) throw new SolveError('unsolvable: corner twist');
    }
    if (unoriented().length) throw new SolveError('corner orientation loop exceeded');
    // final AUF
    for (let k = 0; k < 4; k++) {
      if (isSolved(this.state)) return;
      this.do('U');
    }
    if (!isSolved(this.state)) throw new SolveError('final alignment failed');
  }

  run() {
    this.stage('White Cross', 'Make a white cross on the bottom, matching the side centers.');
    this.solveCross();
    this.endStage();
    this.stage('White Corners', 'Place the four white corners to finish the first layer.');
    this.solveCorners();
    this.endStage();
    this.stage('Middle Layer', 'Insert the four middle-layer edges.');
    this.solveMiddle();
    this.endStage();
    this.stage('Yellow Cross', 'Flip the top edges to form a yellow cross.');
    this.solveYellowCross();
    this.endStage();
    this.stage('Yellow Edges', 'Move the yellow edges to their correct sides.');
    this.solveUEdges();
    this.endStage();
    this.stage('Yellow Corners', 'Move the yellow corners into their correct spots.');
    this.solveUCorners();
    this.endStage();
    this.stage('Final Twist', 'Twist the last corners and align the top layer. Done!');
    this.solveUCornerOrientation();
    this.endStage();
    return { moves: this.moves, stages: this.stages };
  }
}
Solver.prototype.cpFixedSlot = 'FRU'; // CP alg fixes the U-R-F corner (verified empirically)

// ---- validation ----
const OPPOSITE = { U: 'D', D: 'U', F: 'B', B: 'F', L: 'R', R: 'L' };
function validate(state) {
  const errs = [];
  const counts = {};
  for (const c of state) counts[c] = (counts[c] || 0) + 1;
  for (const f of FACES) {
    if ((counts[f] || 0) !== 9) errs.push(`needs exactly 9 ${f} stickers (has ${counts[f] || 0})`);
  }
  for (let f = 0; f < 6; f++) {
    if (state[f * 9 + 4] !== FACES[f]) errs.push('centers moved');
  }
  if (errs.length) return errs;
  // piece existence
  const edgeSets = {}, cornerSets = {};
  for (const n of EDGE_NAMES) {
    const e = EDGES[n];
    const cols = Object.values(e.stickers).map((i) => state[i]);
    if (cols[0] === cols[1] || OPPOSITE[cols[0]] === cols[1]) {
      errs.push('an edge piece has an impossible color pair');
      continue;
    }
    const k = cols.slice().sort().join('');
    edgeSets[k] = (edgeSets[k] || 0) + 1;
  }
  for (const n of CORNER_NAMES) {
    const c = CORNERS[n];
    const cols = Object.values(c.stickers).map((i) => state[i]);
    const set = new Set(cols);
    if (set.size !== 3 || cols.some((a) => cols.some((b) => OPPOSITE[a] === b))) {
      errs.push('a corner piece has an impossible color combination');
      continue;
    }
    const k = cols.slice().sort().join('');
    cornerSets[k] = (cornerSets[k] || 0) + 1;
  }
  for (const k in edgeSets) if (edgeSets[k] > 1) errs.push('a duplicate edge piece exists');
  for (const k in cornerSets) if (cornerSets[k] > 1) errs.push('a duplicate corner piece exists');
  return [...new Set(errs)];
}

// ---- cleanup: merge consecutive same-face moves ----
function cleanMoves(moves) {
  const val = (m) => (m.length === 1 ? 1 : m[1] === '2' ? 2 : 3);
  const out = [];
  for (const m of moves) {
    if (out.length && out[out.length - 1][0] === m[0]) {
      const total = (val(out[out.length - 1]) + val(m)) % 4;
      out.pop();
      if (total === 1) out.push(m[0]);
      else if (total === 2) out.push(m[0] + '2');
      else if (total === 3) out.push(m[0] + "'");
    } else out.push(m);
  }
  return out;
}

function solve(state) {
  const errs = validate(state);
  if (errs.length) return { error: errs.join('; ') };
  if (isSolved(state)) return { moves: [], stages: [], alreadySolved: true };
  let raw;
  try {
    const solver = new Solver(state);
    raw = solver.run();
  } catch (e) {
    if (e instanceof SolveError) {
      return { error: 'This cube can’t be solved — a sticker or piece must be painted wrong. ' + '(' + e.message + ')' };
    }
    throw e;
  }
  // clean each stage separately to keep boundaries valid
  const stages = [];
  const moves = [];
  for (const st of raw.stages) {
    const seg = cleanMoves(raw.moves.slice(st.start, st.end));
    stages.push({ name: st.name, desc: st.desc, start: moves.length, end: moves.length + seg.length });
    moves.push(...seg);
  }
  return { moves, stages };
}

function randomScramble(n = 20, rand = Math.random) {
  const faces = FACES;
  const sfx = ['', "'", '2'];
  const out = [];
  let last = null, last2 = null;
  while (out.length < n) {
    const f = faces[Math.floor(rand() * 6)];
    if (f === last) continue;
    if (last2 === f && OPPOSITE[last] === f) continue;
    out.push(f + sfx[Math.floor(rand() * 3)]);
    last2 = last;
    last = f;
  }
  return out;
}

// =====================================================================
// 2x2 (pocket cube) support — uses the same 54-facelet state but only
// corner facelets matter. Solver restricted to U/R/F so the DBL corner
// stays fixed as the reference piece (no centers exist on a 2x2).
// =====================================================================

const AXIS_OF_FACE = { U: 1, D: 1, R: 0, L: 0, F: 2, B: 2 }; // 0=x 1=y 2=z
const SIGN_OF_FACE = { U: 1, D: -1, R: 1, L: -1, F: 1, B: -1 };
const BIG_COLORS = { U: true, R: true, F: true, D: false, L: false, B: false };

function cornerFacelets() {
  const idxs = [];
  for (const n of CORNER_NAMES) for (const f in CORNERS[n].stickers) idxs.push(CORNERS[n].stickers[f]);
  return idxs;
}
const CORNER_IDX = cornerFacelets();

function isSolved2(state) {
  for (let f = 0; f < 6; f++) {
    const c = [0, 2, 6, 8].map((i) => state[f * 9 + i]);
    if (c.some((x) => x !== c[0] || x === 'X')) return false;
  }
  return true;
}

// derive opposite-color pairs from the 8 painted corners (no centers on 2x2)
function deriveOpposites2(state) {
  const colors = [...new Set(CORNER_IDX.map((i) => state[i]))];
  if (colors.length !== 6) return { error: 'a 2×2 needs exactly 6 different colors (found ' + colors.length + ')' };
  const together = {};
  for (const c of colors) together[c] = new Set();
  for (const n of CORNER_NAMES) {
    const cols = Object.values(CORNERS[n].stickers).map((i) => state[i]);
    for (const a of cols) for (const b of cols) if (a !== b) together[a].add(b);
  }
  const opp = {};
  for (const c of colors) {
    const alone = colors.filter((o) => o !== c && !together[c].has(o));
    if (alone.length !== 1) return { error: 'colors don’t pair up into opposite sides — check your painting' };
    opp[c] = alone[0];
  }
  return { opp, colors };
}

function validate2(state) {
  const errs = [];
  const counts = {};
  for (const i of CORNER_IDX) {
    if (state[i] === 'X') return ['unpainted stickers remain'];
    counts[state[i]] = (counts[state[i]] || 0) + 1;
  }
  const der = deriveOpposites2(state);
  if (der.error) return [der.error];
  for (const c of der.colors) if (counts[c] !== 4) errs.push(`each color needs exactly 4 stickers (${c} has ${counts[c]})`);
  if (errs.length) return errs;
  // 8 distinct valid corners
  const seen = {};
  for (const n of CORNER_NAMES) {
    const cols = Object.values(CORNERS[n].stickers).map((i) => state[i]);
    if (new Set(cols).size !== 3 || cols.some((a) => cols.some((b) => der.opp[a] === b))) {
      errs.push('a piece has an impossible color combination');
      continue;
    }
    const k = cols.slice().sort().join('|');
    if (seen[k]) errs.push('two identical pieces exist — check your painting');
    seen[k] = 1;
  }
  return [...new Set(errs)];
}

// recolor an arbitrary valid 2x2 paint into canonical letters, using the
// piece currently at DBL as the fixed reference
function canonicalize2(state) {
  const der = deriveOpposites2(state);
  if (der.error) return { error: der.error };
  const dbl = CORNERS[cornerKey('D', 'B', 'L')];
  const map = {};
  map[state[dbl.stickers.D]] = 'D';
  map[state[dbl.stickers.B]] = 'B';
  map[state[dbl.stickers.L]] = 'L';
  map[der.opp[state[dbl.stickers.D]]] = 'U';
  map[der.opp[state[dbl.stickers.B]]] = 'F';
  map[der.opp[state[dbl.stickers.L]]] = 'R';
  if (Object.keys(map).length !== 6) return { error: 'reference corner colors are inconsistent' };
  const ns = solvedState();
  for (const i of CORNER_IDX) ns[i] = map[state[i]];
  return { state: ns, map };
}

class Solver2 {
  constructor(state) {
    this.state = state.slice(); // canonical colors
    this.moves = [];
    this.stages = [];
  }
  do(alg) {
    const mvs = Array.isArray(alg) ? alg : alg.trim().split(/\s+/).filter(Boolean);
    for (const m of mvs) {
      this.state = applyMove(this.state, m);
      this.moves.push(m);
    }
  }
  stage(name, desc) { this.stages.push({ name, desc, start: this.moves.length }); }
  endStage() { this.stages[this.stages.length - 1].end = this.moves.length; }

  cornerAt(slot) {
    const c = CORNERS[slot];
    const colorAt = {};
    for (const f in c.stickers) colorAt[f] = this.state[c.stickers[f]];
    return colorAt;
  }
  pieceSolved(slot) {
    const ca = this.cornerAt(slot);
    for (const f in ca) if (ca[f] !== f) return false;
    return true;
  }
  findPiece(colors) {
    return findCorner(this.state, colors[0], colors[1], colors[2]);
  }

  solveBottom() {
    const targets = [
      { slot: cornerKey('D', 'F', 'R'), colors: ['D', 'F', 'R'], above: cornerKey('U', 'F', 'R'), sides: ['R', 'F'] },
      { slot: cornerKey('D', 'F', 'L'), colors: ['D', 'F', 'L'], above: cornerKey('U', 'F', 'L'), sides: ['F'] },
      { slot: cornerKey('D', 'B', 'R'), colors: ['D', 'B', 'R'], above: cornerKey('U', 'B', 'R'), sides: ['R'] },
    ];
    const solvedSoFar = [];
    for (const t of targets) {
      for (let guard = 0; guard < 12; guard++) {
        if (this.pieceSolved(t.slot)) break;
        const cur = this.findPiece(t.colors);
        if (cur.slot.includes('D')) {
          // pop to U layer without breaking solved bottom pieces
          let done = false;
          for (const X of ['R', 'F']) {
            for (const seq of [[X, 'U', INV(X)], [X + "'", 'U', X], [X, 'U2', INV(X)], [X + "'", 'U2', X]]) {
              const test = applyAlg(this.state, seq);
              const tc = findCorner(test, ...t.colors);
              if (!tc.slot.includes('U')) continue;
              const safe = solvedSoFar.every((s) => {
                const ca = CORNERS[s];
                return Object.keys(ca.stickers).every((f) => test[ca.stickers[f]] === f);
              }) && Object.keys(CORNERS[cornerKey('D','B','L')].stickers).every(
                (f) => test[CORNERS[cornerKey('D','B','L')].stickers[f]] === f);
              if (safe) { this.do(seq); done = true; break; }
            }
            if (done) break;
          }
          if (!done) throw new SolveError('2x2 pop failed');
        } else {
          // position above slot
          let ok = false;
          for (let k = 0; k < 4; k++) {
            if (this.findPiece(t.colors).slot === t.above) { ok = true; break; }
            this.do('U');
          }
          if (!ok && this.findPiece(t.colors).slot === t.above) ok = true;
          if (!ok) throw new SolveError('2x2 align failed');
          // discover working insertion by simulation
          let committed = false;
          for (const X of t.sides) {
            for (const pat of [[X, 'U', INV(X), "U'"], [INV(X), "U'", X, 'U']]) {
              let test = this.state;
              let reps = 0;
              for (let r = 1; r <= 8; r++) {
                test = applyAlg(test, pat);
                const ca = CORNERS[t.slot];
                const good = Object.keys(ca.stickers).every((f) => test[ca.stickers[f]] === f);
                if (good) { reps = r; break; }
              }
              if (reps) {
                const safe = solvedSoFar.every((s) => {
                  const ca = CORNERS[s];
                  return Object.keys(ca.stickers).every((f) => test[ca.stickers[f]] === f);
                });
                if (safe) {
                  for (let r = 0; r < reps; r++) this.do(pat);
                  committed = true;
                  break;
                }
              }
            }
            if (committed) break;
          }
          if (!committed) throw new SolveError('2x2 insert failed');
        }
      }
      if (!this.pieceSolved(t.slot)) throw new SolveError('2x2 bottom loop exceeded');
      solvedSoFar.push(t.slot);
    }
  }

  solveOrientTop() {
    const uSlots = CORNER_NAMES.filter((n) => n.includes('U'));
    const urf = CORNERS[cornerKey('U', 'R', 'F')];
    const unorientedCount = () => uSlots.filter((s) => this.state[CORNERS[s].stickers.U] !== 'U').length;
    for (let guard = 0; guard < 60; guard++) {
      if (unorientedCount() === 0) break;
      if (this.state[urf.stickers.U] !== 'U') this.do("R' D' R D R' D' R D");
      else this.do('U');
    }
    if (unorientedCount() !== 0) throw new SolveError('unsolvable: a piece is twisted');
    // bottom must have been restored by the method; verify
    for (const s of CORNER_NAMES.filter((n) => n.includes('D'))) {
      const ca = CORNERS[s];
      for (const f in ca.stickers) if (this.state[ca.stickers[f]] !== f) throw new SolveError('unsolvable: twist parity');
    }
  }

  solvePermuteTop() {
    const ADJ = "R U R' U' R' F R2 U' R' U' R U R' F'";
    const DIAG = "F R U' R' U' R U R' F' R U R' U' R' F R F'";
    for (let guard = 0; guard < 8; guard++) {
      if (isSolved2(this.state)) return;
      let bestPlan = null;
      const U_TURNS = [[], ['U'], ['U2'], ["U'"]];
      outer:
      for (const pre of U_TURNS) {
        for (const alg of [[], ADJ.split(' '), DIAG.split(' ')]) {
          const mid = applyAlg(this.state, pre.concat(alg));
          for (const post of U_TURNS) {
            if (isSolved2(applyAlg(mid, post))) {
              bestPlan = pre.concat(alg, post);
              break outer;
            }
          }
        }
      }
      if (bestPlan) { this.do(bestPlan); return; }
      this.do(ADJ); // reshuffle (3-cycle cases), then retry
    }
    throw new SolveError('unsolvable: piece positions');
  }

  run(names) {
    const N = names || {
      bottom: ['Bottom Layer', 'Solve the bottom four pieces (the back-bottom-left piece stays put as your anchor).'],
      orient: ['Top Color Up', 'Twist the top pieces so the whole top face matches.'],
      permute: ['Final Positions', 'Slide the top pieces around into their right spots. Done!'],
    };
    this.stage(N.bottom[0], N.bottom[1]);
    this.solveBottom();
    this.endStage();
    this.stage(N.orient[0], N.orient[1]);
    this.solveOrientTop();
    this.endStage();
    this.stage(N.permute[0], N.permute[1]);
    this.solvePermuteTop();
    this.endStage();
    return { moves: this.moves, stages: this.stages };
  }
}

function solve2(state, stageNames) {
  const errs = validate2(state);
  if (errs.length) return { error: errs.join('; ') };
  if (isSolved2(state)) return { moves: [], stages: [], alreadySolved: true };
  const canon = canonicalize2(state);
  if (canon.error) return { error: canon.error };
  let raw;
  try {
    raw = new Solver2(canon.state).run(stageNames);
  } catch (e) {
    if (e instanceof SolveError) {
      return { error: 'This cube can’t be solved — something must be painted wrong. (' + e.message + ')' };
    }
    throw e;
  }
  const stages = [], moves = [];
  for (const st of raw.stages) {
    const seg = cleanMoves(raw.moves.slice(st.start, st.end));
    stages.push({ name: st.name, desc: st.desc, start: moves.length, end: moves.length + seg.length });
    moves.push(...seg);
  }
  return { moves, stages };
}

function randomScramble2(n = 15, rand = Math.random) {
  const faces = ['U', 'R', 'F'];
  const sfx = ['', "'", '2'];
  const out = [];
  let last = null;
  while (out.length < n) {
    const f = faces[Math.floor(rand() * 3)];
    if (f === last) continue;
    out.push(f + sfx[Math.floor(rand() * 3)]);
    last = f;
  }
  return out;
}

// =====================================================================
// Mirror 2x2: pieces are identified by size, not color. Uniform cut
// offset on every axis => each piece dim is Small or Big per axis.
// Virtual color mapping: big-y='U', small-y='D', big-x='R', small-x='L',
// big-z='F', small-z='B' (a facet's color = the piece's size class along
// that facet's normal).
// =====================================================================

// all 24 proper rotations as 3x3 signed permutation matrices
const ROTATIONS = (() => {
  const perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const out = [];
  for (const p of perms) for (let s = 0; s < 8; s++) {
    const signs = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
    // matrix M: M[row]=world axis, value from source axis p[row] with sign
    const M = [[0,0,0],[0,0,0],[0,0,0]];
    for (let r = 0; r < 3; r++) M[r][p[r]] = signs[r];
    const d =
      M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1]) -
      M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0]) +
      M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
    if (d === 1) out.push(M);
  }
  return out;
})();
function matVec(M, v) {
  return [
    M[0][0]*v[0]+M[0][1]*v[1]+M[0][2]*v[2],
    M[1][0]*v[0]+M[1][1]*v[1]+M[1][2]*v[2],
    M[2][0]*v[0]+M[2][1]*v[1]+M[2][2]*v[2],
  ];
}

function slotVec(name) {
  const v = [0, 0, 0];
  for (const f of name) v[AXIS_OF_FACE[f]] = SIGN_OF_FACE[f];
  return v;
}

// placements[pieceName][slotName] = array of axis->color maps (length 3)
const PLACEMENTS = (() => {
  const table = {};
  for (const piece of CORNER_NAMES) {
    table[piece] = {};
    const homeVec = slotVec(piece);
    const homeAxisColor = {};
    for (const f of piece) homeAxisColor[AXIS_OF_FACE[f]] = f;
    for (const M of ROTATIONS) {
      const v = matVec(M, homeVec);
      const slotName = CORNER_NAMES.find((n) => {
        const sv = slotVec(n);
        return sv[0] === v[0] && sv[1] === v[1] && sv[2] === v[2];
      });
      // world axis a gets color from home axis a0 where M maps a0 -> a
      const axisColor = {};
      for (let a = 0; a < 3; a++) {
        for (let a0 = 0; a0 < 3; a0++) if (M[a][a0] !== 0) axisColor[a] = homeAxisColor[a0];
      }
      const list = (table[piece][slotName] = table[piece][slotName] || []);
      const key = axisColor[0] + axisColor[1] + axisColor[2];
      if (!list.some((m) => m[0] + m[1] + m[2] === key)) list.push(axisColor);
    }
  }
  return table;
})();

const SLOT_WORDS = {};
for (const n of CORNER_NAMES) {
  const w = [];
  if (n.includes('U')) w.push('top'); else w.push('bottom');
  if (n.includes('F')) w.push('front'); else w.push('back');
  if (n.includes('R')) w.push('right'); else w.push('left');
  SLOT_WORDS[n] = w.join('-');
}

// shapes: array of 54, corner facelets hold 0..3 (bit0 = big along face-right,
// bit1 = big along face-down) or 'X' if unpainted
function shapesToDims(shapes) {
  const dims = {}; // slot -> [xClass, yClass, zClass] where true=Big
  const reports = {}; // slot -> axis -> Set of booleans
  for (const n of CORNER_NAMES) reports[n] = [new Set(), new Set(), new Set()];
  for (const n of CORNER_NAMES) {
    for (const f in CORNERS[n].stickers) {
      const idx = CORNERS[n].stickers[f];
      const v = shapes[idx];
      if (v === 'X' || v === undefined) return { error: 'unpainted' };
      const g = FACE_GEO[f];
      const rightAxis = g.right.findIndex((x) => x !== 0);
      const downAxis = g.down.findIndex((x) => x !== 0);
      reports[n][rightAxis].add(!!(v & 1));
      reports[n][downAxis].add(!!(v & 2));
    }
  }
  for (const n of CORNER_NAMES) {
    const d = [];
    for (let a = 0; a < 3; a++) {
      if (reports[n][a].size !== 1) {
        const dir = ['left-right', 'up-down', 'front-back'][a];
        return { error: `the ${SLOT_WORDS[n]} piece has conflicting sizes in the ${dir} direction — its stickers disagree` };
      }
      d.push([...reports[n][a]][0]);
    }
    dims[n] = d;
  }
  return { dims };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    for (const rest of permutations(arr.filter((_, j) => j !== i))) out.push([x, ...rest]);
  });
  return out;
}

const MIRROR_STAGES = {
  bottom: ['Bottom Layer', 'Build a flat, flush bottom layer (the back-bottom-left piece stays put as your anchor).'],
  orient: ['Level the Top', 'Twist the top pieces so the top of the cube becomes flat.'],
  permute: ['Final Positions', 'Slide the top pieces into the spots where every side comes out flush. Done!'],
};

function solveMirror(shapes) {
  const d = shapesToDims(shapes);
  if (d.error) return { error: d.error };
  const dims = d.dims;
  // class check: exactly 1 piece with 0 big dims, 3 with 1, 3 with 2, 1 with 3
  const byCount = { 0: [], 1: [], 2: [], 3: [] };
  for (const n of CORNER_NAMES) byCount[dims[n].filter(Boolean).length].push(n);
  if (byCount[0].length !== 1 || byCount[1].length !== 3 || byCount[2].length !== 3 || byCount[3].length !== 1) {
    return { error: 'these shapes don’t form a real mirror 2×2 (need exactly one smallest piece, three flat pieces, three chunky pieces and one biggest piece) — double-check the sticker sizes' };
  }
  const ROLES = { 0: [cornerKey('D','B','L')], 3: [cornerKey('U','R','F')],
    1: [cornerKey('U','L','B'), cornerKey('D','R','B'), cornerKey('D','L','F')],
    2: [cornerKey('U','R','B'), cornerKey('U','L','F'), cornerKey('D','R','F')] };

  const tryAssignment = (roleOf) => {
    // per slot: candidate axis->color maps consistent with observed dims
    const perSlot = [];
    for (const slot of CORNER_NAMES) {
      const piece = roleOf[slot];
      const cands = (PLACEMENTS[piece][slot] || []).filter((m) =>
        [0, 1, 2].every((a) => BIG_COLORS[m[a]] === dims[slot][a]));
      if (!cands.length) return null;
      perSlot.push({ slot, cands });
    }
    // cartesian product (small: symmetric pieces give up to 3 options each)
    let combos = [{}];
    for (const ps of perSlot) {
      const next = [];
      for (const partial of combos) for (const m of ps.cands) next.push({ ...partial, [ps.slot]: m });
      combos = next;
      if (combos.length > 400) combos.length = 400;
    }
    for (const combo of combos) {
      const st = solvedState();
      for (const slot of CORNER_NAMES) {
        for (const f in CORNERS[slot].stickers) {
          st[CORNERS[slot].stickers[f]] = combo[slot][AXIS_OF_FACE[f]];
        }
      }
      if (isSolved2(st)) return { moves: [], stages: [], alreadySolved: true, state: st };
      const res = solve2(st, MIRROR_STAGES);
      if (!res.error && !res.alreadySolved) return { ...res, state: st };
      if (res.alreadySolved) return { ...res, state: st };
    }
    return null;
  };

  // fixed assignment first, then permute identical pieces if needed
  const base = {};
  base[byCount[0][0]] = ROLES[0][0];
  base[byCount[3][0]] = ROLES[3][0];
  const perms1 = permutations(ROLES[1]);
  const perms2 = permutations(ROLES[2]);
  for (const p1 of perms1) {
    for (const p2 of perms2) {
      const roleOf = { ...base };
      byCount[1].forEach((slot, i) => { roleOf[slot] = p1[i]; });
      byCount[2].forEach((slot, i) => { roleOf[slot] = p2[i]; });
      const res = tryAssignment(roleOf);
      if (res) return res;
    }
  }
  return { error: 'This mirror cube can’t be solved as painted — at least one sticker size must be wrong. Compare each piece with your real cube again.' };
}

// dims of the piece at each slot, straight from a virtual-color state
function mirrorDims(state) {
  const out = {};
  for (const n of CORNER_NAMES) {
    const d = [null, null, null];
    for (const f in CORNERS[n].stickers) {
      d[AXIS_OF_FACE[f]] = !!BIG_COLORS[state[CORNERS[n].stickers[f]]];
    }
    out[n] = d;
  }
  return out;
}

function isMirrorSolved(state) {
  const dims = mirrorDims(state);
  for (let a = 0; a < 3; a++) {
    const plus = new Set(), minus = new Set();
    for (const n of CORNER_NAMES) (slotVec(n)[a] > 0 ? plus : minus).add(dims[n][a]);
    if (plus.size !== 1 || minus.size !== 1 || [...plus][0] === [...minus][0]) return false;
  }
  return true;
}

// convert a virtual-color state to shape codes (for displaying scrambles)
function stateToShapes(state) {
  const dims = mirrorDims(state);
  const shapes = new Array(54).fill('X');
  for (const n of CORNER_NAMES) {
    for (const f in CORNERS[n].stickers) {
      const idx = CORNERS[n].stickers[f];
      const g = FACE_GEO[f];
      const rightAxis = g.right.findIndex((x) => x !== 0);
      const downAxis = g.down.findIndex((x) => x !== 0);
      shapes[idx] = (dims[n][rightAxis] ? 1 : 0) | (dims[n][downAxis] ? 2 : 0);
    }
  }
  return shapes;
}

// =====================================================================
// Cubie-coordinate machinery (shared by the optimal 2x2 solver and the
// two-phase 3x3 solver)
// =====================================================================

function rodrigues(v, a, deg) {
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const av = vcross(a, v), ad = vdot(a, v);
  return [
    v[0] * c + av[0] * s + a[0] * ad * (1 - c),
    v[1] * c + av[1] * s + a[1] * ad * (1 - c),
    v[2] * c + av[2] * s + a[2] * ad * (1 - c),
  ].map((x) => Math.round(x * 1000) / 1000);
}

// ordered faces of each corner slot: [U/D face, then clockwise viewed from outside]
const CORNER_ORDER = {};
for (const slot of CORNER_NAMES) {
  const v = slotVec(slot);
  const u = vscale(v, 1 / Math.sqrt(3));
  const f0 = slot.includes('U') ? 'U' : 'D';
  const n1 = rodrigues(FACE_GEO[f0].n, u, -120);
  const f1 = FACES.find((f) => FACE_GEO[f].n.every((x, i) => Math.abs(x - n1[i]) < 0.01));
  const f2 = slot.split('').find((f) => f !== f0 && f !== f1);
  CORNER_ORDER[slot] = [f0, f1, f2];
}
// ordered faces of each edge slot: [primary (U/D else F/B), other]
const EDGE_ORDER = {};
for (const slot of EDGE_NAMES) {
  const fs = slot.split('');
  const prim = fs.find((f) => f === 'U' || f === 'D') || fs.find((f) => f === 'F' || f === 'B');
  EDGE_ORDER[slot] = [prim, fs.find((f) => f !== prim)];
}

// read cubie arrays from a canonical-colored facelet state
// corners: perm[slotIndex] = pieceIndex, ori in 0..2
// edges: perm[slotIndex] = pieceIndex, ori in 0..1
const CORNER_SLOTS = CORNER_NAMES.slice(); // fixed order
const EDGE_SLOTS = EDGE_NAMES.slice();
function stateToCubies(state) {
  const cp = [], co = [], ep = [], eo = [];
  for (const slot of CORNER_SLOTS) {
    const ord = CORNER_ORDER[slot];
    const cols = ord.map((f) => state[CORNERS[slot].stickers[f]]);
    const home = cols.slice().sort().join('');
    const pi = CORNER_SLOTS.indexOf(home);
    const primary = CORNER_ORDER[home][0]; // the piece's U/D color
    const ori = cols.indexOf(primary);
    if (pi < 0 || ori < 0) return null;
    cp.push(pi); co.push(ori);
  }
  for (const slot of EDGE_SLOTS) {
    const ord = EDGE_ORDER[slot];
    const cols = ord.map((f) => state[EDGES[slot].stickers[f]]);
    const home = cols.slice().sort().join('');
    const pi = EDGE_SLOTS.indexOf(home);
    if (pi < 0) return null;
    const primary = EDGE_ORDER[home][0];
    const ori = cols.indexOf(primary);
    if (ori < 0) return null;
    ep.push(pi); eo.push(ori);
  }
  return { cp, co, ep, eo };
}

// per-move cubie transition tables, derived from single facelet simulations.
// For move m: cSlotMap[a] = b means the piece in corner slot a moves to slot b,
// gaining cOriDelta[a] twist; likewise for edges.
const MOVES18 = [];
for (const f of FACES) for (const sfx of ['', '2', "'"]) MOVES18.push(f + sfx);
const CUBIE_MOVE = {};
for (const m of MOVES18) {
  // trace each slot's piece through the move using a solved cube
  const before = solvedState();
  const after = applyMove(before, m);
  const b = stateToCubies(after);
  // b.cp[slot] = piece that ENDED at slot = home slot it came from
  const cSlotMap = new Array(8), cOriDelta = new Array(8);
  b.cp.forEach((piece, slot) => { cSlotMap[piece] = slot; cOriDelta[piece] = b.co[slot]; });
  const eSlotMap = new Array(12), eFlipDelta = new Array(12);
  b.ep.forEach((piece, slot) => { eSlotMap[piece] = slot; eFlipDelta[piece] = b.eo[slot]; });
  CUBIE_MOVE[m] = { cSlotMap, cOriDelta, eSlotMap, eFlipDelta };
}
function applyCubieMove(c, m) {
  const t = CUBIE_MOVE[m];
  const cp = new Array(8), co = new Array(8), ep = new Array(12), eo = new Array(12);
  for (let a = 0; a < 8; a++) {
    const bSlot = t.cSlotMap[a];
    cp[bSlot] = c.cp[a];
    co[bSlot] = (c.co[a] + t.cOriDelta[a]) % 3;
  }
  for (let a = 0; a < 12; a++) {
    const bSlot = t.eSlotMap[a];
    ep[bSlot] = c.ep[a];
    eo[bSlot] = (c.eo[a] + t.eFlipDelta[a]) % 2;
  }
  return { cp, co, ep, eo };
}

// permutation rank/unrank (Lehmer)
function permRank(p) {
  let r = 0;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    let smaller = 0;
    for (let j = i + 1; j < n; j++) if (p[j] < p[i]) smaller++;
    r = r * (n - i) + smaller;
  }
  return r;
}
function permUnrank(r, n, out) {
  const digits = new Array(n);
  for (let i = n - 1; i >= 0; i--) { digits[i] = r % (n - i); r = Math.floor(r / (n - i)); }
  const avail = [];
  for (let i = 0; i < n; i++) avail.push(i);
  for (let i = 0; i < n; i++) out[i] = avail.splice(digits[i], 1)[0];
  return out;
}

// =====================================================================
// Optimal 2x2 solver: full breadth-first distance table over the
// 7! x 3^6 = 3,674,160 states (DBL corner fixed as reference).
// God's number for the 2x2 is 11, so extracted solutions are <= 11 moves.
// =====================================================================

const P2_MOVES = ['U', 'U2', "U'", 'R', 'R2', "R'", 'F', 'F2', "F'"];
const DBL_IDX = CORNER_SLOTS.indexOf(cornerKey('D', 'B', 'L'));
const P2_SLOTS = CORNER_SLOTS.map((_, i) => i).filter((i) => i !== DBL_IDX); // 7 movable slots

const Pocket = {
  dist: null,
  permMove: null, // Uint16Array 5040 x 9
  oriMove: null,  // Uint16Array 729 x 9

  encodeFromCubies(c) {
    // reject states whose total twist breaks parity — the coordinate drops
    // the 7th corner's twist, so without this check an unsolvable state
    // would silently alias onto a legal one
    let twist = 0;
    for (const s of P2_SLOTS) twist += c.co[s];
    if (twist % 3 !== 0 || c.co[DBL_IDX] !== 0 || c.cp[DBL_IDX] !== DBL_IDX) return -1;
    // perm over the 7 movable slots (piece ids remapped to 0..6)
    const perm = P2_SLOTS.map((s) => P2_SLOTS.indexOf(c.cp[s]));
    if (perm.includes(-1)) return -1;
    const pr = permRank(perm);
    let oc = 0;
    for (let i = 0; i < 6; i++) oc = oc * 3 + c.co[P2_SLOTS[i]];
    return pr * 729 + oc;
  },

  buildCoordTables() {
    // moves as slot maps restricted to the 7 movable slots
    const moves = P2_MOVES.map((m) => {
      const t = CUBIE_MOVE[m];
      return {
        map: P2_SLOTS.map((s) => P2_SLOTS.indexOf(t.cSlotMap[s])),
        delta: P2_SLOTS.map((s) => t.cOriDelta[s]),
      };
    });
    const permMove = new Uint16Array(5040 * 9);
    const p = new Array(7), np = new Array(7);
    for (let r = 0; r < 5040; r++) {
      permUnrank(r, 7, p);
      for (let m = 0; m < 9; m++) {
        for (let a = 0; a < 7; a++) np[moves[m].map[a]] = p[a];
        permMove[r * 9 + m] = permRank(np);
      }
    }
    const oriMove = new Uint16Array(729 * 9);
    const o = new Array(7);
    for (let r = 0; r < 729; r++) {
      let x = r;
      let sum = 0;
      for (let i = 5; i >= 0; i--) { o[i] = x % 3; x = Math.floor(x / 3); }
      for (let i = 0; i < 6; i++) sum += o[i];
      o[6] = (3 - (sum % 3)) % 3;
      for (let m = 0; m < 9; m++) {
        const no = new Array(7);
        for (let a = 0; a < 7; a++) no[moves[m].map[a]] = (o[a] + moves[m].delta[a]) % 3;
        let noc = 0;
        for (let i = 0; i < 6; i++) noc = noc * 3 + no[i];
        oriMove[r * 9 + m] = noc;
      }
    }
    this.permMove = permMove;
    this.oriMove = oriMove;
  },

  init() {
    if (this.dist) return;
    this.buildCoordTables();
    const N = 5040 * 729;
    const dist = new Uint8Array(N).fill(255);
    const solved = this.encodeFromCubies(stateToCubies(solvedState()));
    dist[solved] = 0;
    let frontier = [solved];
    let d = 0;
    const pm = this.permMove, om = this.oriMove;
    while (frontier.length) {
      const next = [];
      for (const idx of frontier) {
        const pr = Math.floor(idx / 729), oc = idx % 729;
        for (let m = 0; m < 9; m++) {
          const ni = pm[pr * 9 + m] * 729 + om[oc * 9 + m];
          if (dist[ni] === 255) { dist[ni] = d + 1; next.push(ni); }
        }
      }
      frontier = next;
      d++;
    }
    this.dist = dist;
  },

  // canonical colored state -> optimal move list (or null if unreachable)
  solveCanonical(state) {
    this.init();
    const c = stateToCubies(state);
    if (!c) return null;
    let idx = this.encodeFromCubies(c);
    if (idx < 0 || this.dist[idx] === 255) return null;
    const moves = [];
    const pm = this.permMove, om = this.oriMove;
    while (this.dist[idx] > 0) {
      const d = this.dist[idx];
      const pr = Math.floor(idx / 729), oc = idx % 729;
      let advanced = false;
      for (let m = 0; m < 9; m++) {
        const ni = pm[pr * 9 + m] * 729 + om[oc * 9 + m];
        if (this.dist[ni] === d - 1) {
          moves.push(P2_MOVES[m]);
          idx = ni;
          advanced = true;
          break;
        }
      }
      if (!advanced) return null;
    }
    return moves;
  },

  distanceOf(state) {
    this.init();
    const c = stateToCubies(state);
    if (!c) return 255;
    const idx = this.encodeFromCubies(c);
    return idx < 0 ? 255 : this.dist[idx];
  },
};

function solve2Optimal(state) {
  const errs = validate2(state);
  if (errs.length) return { error: errs.join('; ') };
  if (isSolved2(state)) return { moves: [], stages: [], alreadySolved: true };
  const canon = canonicalize2(state);
  if (canon.error) return { error: canon.error };
  const moves = Pocket.solveCanonical(canon.state);
  if (!moves) return { error: 'This cube can’t be solved — something must be painted wrong. (unreachable position)' };
  return {
    moves,
    stages: [{
      name: 'Shortest Solution',
      desc: `The mathematically shortest way home — ${moves.length} turn${moves.length === 1 ? '' : 's'}. No 2×2 position ever needs more than 11.`,
      start: 0, end: moves.length,
    }],
  };
}

// mirror optimal: minimum over every physically equivalent reconstruction
function solveMirrorOptimal(shapes) {
  const d = shapesToDims(shapes);
  if (d.error) return { error: d.error };
  const dims = d.dims;
  const byCount = { 0: [], 1: [], 2: [], 3: [] };
  for (const n of CORNER_NAMES) byCount[dims[n].filter(Boolean).length].push(n);
  if (byCount[0].length !== 1 || byCount[1].length !== 3 || byCount[2].length !== 3 || byCount[3].length !== 1) {
    return { error: 'these shapes don’t form a real mirror 2×2 (need exactly one smallest piece, three flat pieces, three chunky pieces and one biggest piece) — double-check the sticker sizes' };
  }
  const ROLES1 = [cornerKey('U','L','B'), cornerKey('D','R','B'), cornerKey('D','L','F')];
  const ROLES2 = [cornerKey('U','R','B'), cornerKey('U','L','F'), cornerKey('D','R','F')];
  Pocket.init();
  let bestDist = 256, bestState = null;
  const consider = (roleOf) => {
    const perSlot = [];
    for (const slot of CORNER_NAMES) {
      const cands = (PLACEMENTS[roleOf[slot]][slot] || []).filter((m) =>
        [0, 1, 2].every((a) => BIG_COLORS[m[a]] === dims[slot][a]));
      if (!cands.length) return;
      perSlot.push({ slot, cands });
    }
    let combos = [{}];
    for (const ps of perSlot) {
      const next = [];
      for (const partial of combos) for (const m of ps.cands) next.push({ ...partial, [ps.slot]: m });
      combos = next;
    }
    for (const combo of combos) {
      const st = solvedState();
      for (const slot of CORNER_NAMES) {
        for (const f in CORNERS[slot].stickers) st[CORNERS[slot].stickers[f]] = combo[slot][AXIS_OF_FACE[f]];
      }
      const canon = canonicalize2(st);
      if (canon.error) continue;
      const dist = Pocket.distanceOf(canon.state);
      if (dist < bestDist) { bestDist = dist; bestState = st; }
    }
  };
  outer:
  for (const p1 of permutations(ROLES1)) {
    for (const p2 of permutations(ROLES2)) {
      const roleOf = {};
      roleOf[byCount[0][0]] = cornerKey('D','B','L');
      roleOf[byCount[3][0]] = cornerKey('U','R','F');
      byCount[1].forEach((slot, i) => { roleOf[slot] = p1[i]; });
      byCount[2].forEach((slot, i) => { roleOf[slot] = p2[i]; });
      consider(roleOf);
      if (bestDist === 0) break outer;
    }
  }
  if (!bestState) return { error: 'This mirror cube can’t be solved as painted — at least one sticker size must be wrong. Compare each piece with your real cube again.' };
  if (bestDist === 0) return { moves: [], stages: [], alreadySolved: true, state: bestState };
  const moves = Pocket.solveCanonical(canonicalize2(bestState).state);
  return {
    moves,
    state: bestState,
    stages: [{
      name: 'Shortest Solution',
      desc: `The mathematically shortest way back to a perfect cube — ${moves.length} turn${moves.length === 1 ? '' : 's'}.`,
      start: 0, end: moves.length,
    }],
  };
}

// =====================================================================
// Two-phase 3x3 solver — short solutions (~20-26 moves). An independent
// implementation of Herbert Kociemba's published two-phase algorithm
// (http://kociemba.org/cube.htm); no third-party source is used here.
// Phase 1: orient all pieces + bring the 4 E-slice edges into the slice
// (coordinates: corner-twist 3^7, edge-flip 2^11, slice-position C(12,4)).
// Phase 2: solve within <U, D, R2, L2, F2, B2>
// (coordinates: corner-perm 8!, U/D-edge-perm 8!, slice-perm 4!).
// =====================================================================

const K = (() => {
  const SLICE_IDX = EDGE_SLOTS.map((n, i) => i).filter((i) => !/[UD]/.test(EDGE_SLOTS[i]));
  const NONSLICE_IDX = EDGE_SLOTS.map((n, i) => i).filter((i) => /[UD]/.test(EDGE_SLOTS[i]));
  const P2_MOVESET = ['U', 'U2', "U'", 'D', 'D2', "D'", 'R2', 'L2', 'F2', 'B2'];
  const P2_SET = new Set(P2_MOVESET);
  const AXIS = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
  // Move-pair legality as a table instead of string work inside the search.
  // SKIPF[lastFace * 6 + face] is 1 when a move on `face` may not follow one on
  // `lastFace`: same face, or same axis in the non-canonical order. Face 6
  // means "no previous move". This test used to run two String.includes calls
  // on every node of both phases.
  const FACE_CHARS = MOVES18.filter((_, i) => i % 3 === 0).map((m) => m[0]);
  const SKIPF = new Uint8Array(7 * 6);
  for (let lf = 0; lf < 6; lf++) {
    for (let f = 0; f < 6; f++) {
      const L = FACE_CHARS[lf], F = FACE_CHARS[f];
      SKIPF[lf * 6 + f] = (F === L || (AXIS[F] === AXIS[L] && 'DLB'.includes(L) && 'URF'.includes(F))) ? 1 : 0;
    }
  }
  const FACE_OF_M1 = Uint8Array.from(MOVES18.map((_, m) => (m / 3) | 0));

  // C(n,k) table
  const CNK = [];
  for (let n = 0; n <= 12; n++) {
    CNK[n] = [];
    for (let k = 0; k <= 4; k++) {
      CNK[n][k] = k === 0 ? 1 : n === 0 ? 0 : (CNK[n - 1][k] || 0) + (CNK[n - 1][k - 1] || 0);
    }
  }
  // rank a sorted 4-subset of 0..11: sum over chosen positions
  function comboRank(set) {
    let r = 0;
    let k = 0;
    for (let i = 0; i < 12; i++) {
      if (set.includes(i)) { r += CNK[i][++k]; }
    }
    return r;
  }
  function comboUnrank(r) {
    const set = [];
    let k = 4;
    for (let i = 11; i >= 0; i--) {
      if (r >= CNK[i][k]) { r -= CNK[i][k]; set.push(i); k--; }
    }
    return set.sort((a, b) => a - b);
  }

  // cubie-array helpers on plain slot arrays
  const cornerMoveOf = {}, edgeMoveOf = {};
  for (const m of MOVES18) {
    cornerMoveOf[m] = { map: CUBIE_MOVE[m].cSlotMap, delta: CUBIE_MOVE[m].cOriDelta };
    edgeMoveOf[m] = { map: CUBIE_MOVE[m].eSlotMap, delta: CUBIE_MOVE[m].eFlipDelta };
  }

  // ---- coordinate encoders ----
  function coOf(co) { let x = 0; for (let i = 0; i < 7; i++) x = x * 3 + co[i]; return x; }
  function eoOf(eo) { let x = 0; for (let i = 0; i < 11; i++) x = x * 2 + eo[i]; return x; }
  function sliceOf(ep) {
    const set = [];
    for (let i = 0; i < 12; i++) if (SLICE_IDX.includes(ep[i])) set.push(i);
    return comboRank(set);
  }
  function cpOf(cp) { return permRank(cp); }
  function ep8Of(ep) {
    const p = NONSLICE_IDX.map((slot) => NONSLICE_IDX.indexOf(ep[slot]));
    return permRank(p);
  }
  function epsOf(ep) {
    const p = SLICE_IDX.map((slot) => SLICE_IDX.indexOf(ep[slot]));
    return permRank(p);
  }
  const SLICE_HOME = (() => comboRank(SLICE_IDX.slice()))();

  // ---- move tables ----
  let coMove, eoMove, sliceMove, cpMove, ep8Move, epsMove;
  let prunCoSlice, prunEoSlice, prunCpEps, prunEp8Eps;
  let ready = false;

  function buildMoveTables() {
    coMove = new Uint16Array(2187 * 18);
    {
      const o = new Array(8);
      for (let x = 0; x < 2187; x++) {
        let t = x, sum = 0;
        for (let i = 6; i >= 0; i--) { o[i] = t % 3; t = Math.floor(t / 3); }
        for (let i = 0; i < 7; i++) sum += o[i];
        o[7] = (3 - (sum % 3)) % 3;
        for (let m = 0; m < 18; m++) {
          const mv = cornerMoveOf[MOVES18[m]];
          const no = new Array(8);
          for (let a = 0; a < 8; a++) no[mv.map[a]] = (o[a] + mv.delta[a]) % 3;
          coMove[x * 18 + m] = coOf(no);
        }
      }
    }
    eoMove = new Uint16Array(2048 * 18);
    {
      const o = new Array(12);
      for (let x = 0; x < 2048; x++) {
        let t = x, sum = 0;
        for (let i = 10; i >= 0; i--) { o[i] = t % 2; t = Math.floor(t / 2); }
        for (let i = 0; i < 11; i++) sum += o[i];
        o[11] = sum % 2;
        for (let m = 0; m < 18; m++) {
          const mv = edgeMoveOf[MOVES18[m]];
          const no = new Array(12);
          for (let a = 0; a < 12; a++) no[mv.map[a]] = (o[a] + mv.delta[a]) % 2;
          eoMove[x * 18 + m] = eoOf(no);
        }
      }
    }
    sliceMove = new Uint16Array(495 * 18);
    for (let x = 0; x < 495; x++) {
      const set = comboUnrank(x);
      for (let m = 0; m < 18; m++) {
        const mv = edgeMoveOf[MOVES18[m]];
        const nset = set.map((slot) => mv.map[slot]).sort((a, b) => a - b);
        sliceMove[x * 18 + m] = comboRank(nset);
      }
    }
    // phase 2 tables (10 moves)
    cpMove = new Uint16Array(40320 * 10);
    {
      const p = new Array(8), np = new Array(8);
      for (let x = 0; x < 40320; x++) {
        permUnrank(x, 8, p);
        for (let m = 0; m < 10; m++) {
          const mv = cornerMoveOf[P2_MOVESET[m]];
          for (let a = 0; a < 8; a++) np[mv.map[a]] = p[a];
          cpMove[x * 10 + m] = permRank(np);
        }
      }
    }
    ep8Move = new Uint16Array(40320 * 10);
    {
      const p = new Array(8);
      for (let x = 0; x < 40320; x++) {
        permUnrank(x, 8, p);
        for (let m = 0; m < 10; m++) {
          const mv = edgeMoveOf[P2_MOVESET[m]];
          const np = new Array(8);
          for (let a = 0; a < 8; a++) {
            const fromSlot = NONSLICE_IDX[a];
            const toSlot = mv.map[fromSlot];
            np[NONSLICE_IDX.indexOf(toSlot)] = p[a];
          }
          ep8Move[x * 10 + m] = permRank(np);
        }
      }
    }
    epsMove = new Uint16Array(24 * 10);
    {
      const p = new Array(4);
      for (let x = 0; x < 24; x++) {
        permUnrank(x, 4, p);
        for (let m = 0; m < 10; m++) {
          const mv = edgeMoveOf[P2_MOVESET[m]];
          const np = new Array(4);
          for (let a = 0; a < 4; a++) {
            const fromSlot = SLICE_IDX[a];
            const toSlot = mv.map[fromSlot];
            np[SLICE_IDX.indexOf(toSlot)] = p[a];
          }
          epsMove[x * 10 + m] = permRank(np);
        }
      }
    }
  }

  function bfsPrune(sizeA, sizeB, moveA, moveB, nMoves, startA, startB) {
    const N = sizeA * sizeB;
    const dist = new Uint8Array(N).fill(255);
    let frontier = [startA * sizeB + startB];
    dist[frontier[0]] = 0;
    let d = 0;
    while (frontier.length) {
      const next = [];
      for (const idx of frontier) {
        const a = Math.floor(idx / sizeB), b = idx % sizeB;
        for (let m = 0; m < nMoves; m++) {
          const ni = moveA[a * nMoves + m] * sizeB + moveB[b * nMoves + m];
          if (dist[ni] === 255) { dist[ni] = d + 1; next.push(ni); }
        }
      }
      frontier = next;
      d++;
    }
    return dist;
  }

  function init() {
    if (ready) return;
    buildMoveTables();
    prunCoSlice = bfsPrune(2187, 495, coMove, sliceMove, 18, 0, SLICE_HOME);
    prunEoSlice = bfsPrune(2048, 495, eoMove, sliceMove, 18, 0, SLICE_HOME);
    prunCpEps = bfsPrune(40320, 24, cpMove, epsMove, 10, 0, 0);
    prunEp8Eps = bfsPrune(40320, 24, ep8Move, epsMove, 10, 0, 0);
    ready = true;
  }

  // solvability parity checks (beyond facelet validation)
  function parityErrors(c) {
    let twist = 0, flip = 0;
    for (const x of c.co) twist += x;
    for (const x of c.eo) flip += x;
    if (twist % 3 !== 0) return 'a corner is twisted';
    if (flip % 2 !== 0) return 'an edge is flipped';
    const parity = (p) => {
      let inv = 0;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inv++;
      return inv % 2;
    };
    if (parity(c.cp) !== parity(c.ep)) return 'two pieces are swapped';
    return null;
  }

  function solve(state, opts = {}) {
    const timeLimit = opts.timeLimit || 1200;
    const target = opts.target || 23;
    const minSearch = opts.minSearch === undefined ? 150 : opts.minSearch;
    init();
    const c0 = stateToCubies(state);
    if (!c0) return { error: 'invalid state' };
    const perr = parityErrors(c0);
    if (perr) return { error: perr };

    const start = Date.now();
    /** @type {string[]|null} */ let best = null;

    // phase-1 start coordinates
    const co0 = coOf(c0.co), eo0 = eoOf(c0.eo), sl0 = sliceOf(c0.ep);

    const p1moves = [];
    const FACE_OF_M2 = Uint8Array.from(P2_MOVESET.map((mv) => FACE_CHARS.indexOf(mv[0])));
    let probe = 0;   // clock is sampled every 1024 nodes, not every node
    const outOfTime = () => (++probe & 1023) === 0 && Date.now() - start > timeLimit;

    const runPhase2 = (cubies, lastF) => {
      const cp0 = cpOf(cubies.cp), ep80 = ep8Of(cubies.ep), eps0 = epsOf(cubies.ep);
      const maxD2 = Math.min(17, (best ? best.length : 30) - p1moves.length - 1);
      const h0 = Math.max(prunCpEps[cp0 * 24 + eps0], prunEp8Eps[ep80 * 24 + eps0]);
      if (h0 > maxD2) return;
      const p2moves = [];
      const dfs2 = (cp, ep8, eps, togo, lastFace) => {
        if (togo === 0) {
          if (cp === 0 && ep8 === 0 && eps === 0) {
            best = p1moves.concat(p2moves);
            return true;
          }
          return false;
        }
        for (let m = 0; m < 10; m++) {
          const f = FACE_OF_M2[m];
          if (SKIPF[lastFace * 6 + f]) continue;
          const ncp = cpMove[cp * 10 + m], nep8 = ep8Move[ep8 * 10 + m], neps = epsMove[eps * 10 + m];
          const h = Math.max(prunCpEps[ncp * 24 + neps], prunEp8Eps[nep8 * 24 + neps]);
          if (h >= togo) continue;
          p2moves.push(P2_MOVESET[m]);
          if (dfs2(ncp, nep8, neps, togo - 1, f)) return true;
          p2moves.pop();
        }
        return false;
      };
      for (let d2 = h0; d2 <= maxD2; d2++) {
        if (Date.now() - start > timeLimit && best) return;
        if (dfs2(cp0, ep80, eps0, d2, lastF)) return;
      }
    };

    // phase-1 IDA. Cubies are NOT threaded through the search: rebuilding them
    // from p1moves at a leaf costs a dozen applyCubieMove calls, where carrying
    // them allocated four arrays and an object on every single node.
    const dfs1 = (co, eo, sl, togo, lastFace) => {
      if (best && p1moves.length + togo >= best.length) return false;
      if (outOfTime() && best) return true; // abort
      if (togo === 0) {
        if (co === 0 && eo === 0 && sl === SLICE_HOME) {
          // standard: last move of a non-trivial phase 1 must not be a phase-2 move
          const last = p1moves[p1moves.length - 1];
          if (p1moves.length && last && P2_SET.has(last)) return false;
          let cub = c0;
          for (let i = 0; i < p1moves.length; i++) cub = applyCubieMove(cub, p1moves[i]);
          runPhase2(cub, last ? FACE_CHARS.indexOf(last[0]) : 6);
          // keep improving for a short while even after hitting the target,
          // so trivial scrambles come back with their trivial solutions
          if (best && best.length <= target && Date.now() - start >= minSearch) return true;
        }
        return false;
      }
      for (let m = 0; m < 18; m++) {
        const f = FACE_OF_M1[m];
        if (SKIPF[lastFace * 6 + f]) continue;
        const nco = coMove[co * 18 + m], neo = eoMove[eo * 18 + m], nsl = sliceMove[sl * 18 + m];
        const h = Math.max(prunCoSlice[nco * 495 + nsl], prunEoSlice[neo * 495 + nsl]);
        if (h >= togo) continue;
        p1moves.push(MOVES18[m]);
        if (dfs1(nco, neo, nsl, togo - 1, f)) return true;
        p1moves.pop();
      }
      return false;
    };

    const h1 = Math.max(prunCoSlice[co0 * 495 + sl0], prunEoSlice[eo0 * 495 + sl0]);
    for (let d1 = h1; d1 <= 12; d1++) {
      p1moves.length = 0;
      if (dfs1(co0, eo0, sl0, d1, 6)) break;
      if (best && (Date.now() - start > timeLimit || d1 >= best.length)) break;
    }
    if (!best) return { error: 'search failed' };
    return { moves: cleanMoves(best) };
  }

  return { init, solve, get ready() { return ready; } };
})();

function solve3Fast(state, opts) {
  const errs = validate(state);
  if (errs.length) return { error: errs.join('; ') };
  if (isSolved(state)) return { moves: [], stages: [], alreadySolved: true };
  const res = K.solve(state, opts);
  if (res.error) {
    return { error: 'This cube can’t be solved — a sticker or piece must be painted wrong. (' + res.error + ')' };
  }
  return {
    moves: res.moves,
    stages: [{
      name: 'Short Solution',
      desc: `A computer-style two-phase solution — just ${res.moves.length} moves, no stages to learn. Follow it move by move.`,
      start: 0, end: res.moves.length,
    }],
  };
}

const api = {
  FACES, FACE_GEO, STICKERS, EDGES, CORNERS, EDGE_NAMES, CORNER_NAMES,
  applyMove, applyAlg, solvedState, isSolved, validate, solve, randomScramble,
  cleanMoves, Solver, findEdge, findCorner, MOVE_PERM,
  // 2x2 + mirror
  isSolved2, validate2, solve2, randomScramble2, Solver2, canonicalize2,
  solveMirror, stateToShapes, mirrorDims, isMirrorSolved, shapesToDims,
  AXIS_OF_FACE, SIGN_OF_FACE, BIG_COLORS, SLOT_WORDS, slotVec, CORNER_IDX,
  // optimal / fast solvers
  Pocket, solve2Optimal, solveMirrorOptimal, stateToCubies, applyCubieMove,
  CUBIE_MOVE, CORNER_ORDER, EDGE_ORDER, CORNER_SLOTS, EDGE_SLOTS, permRank, permUnrank,
  K, solve3Fast,
};
if (typeof module !== 'undefined') module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.Cube = api;

})();
