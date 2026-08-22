(function(){
// 4x4x4 (Rubik's Revenge) engine + reduction solver.
// Facelet model: 96 stickers, faces U,R,F,D,L,B (16 each, row-major 4x4).
// Moves: outer face turns "R" and inner slice turns "r" (the single inner
// layer adjacent to that face), each with '', '2', "'" suffixes.
// Solved scheme is arbitrary (no fixed centers) — derived from the DBL corner.

const C3 = typeof module !== 'undefined' ? require('./cube.js') : window.Cube;

const C4 = (() => {
  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const FACE_GEO = C3.FACE_GEO;

  function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vscale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vcross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function rotCW(v, a) { return vadd(vscale(a, vdot(a, v)), vscale(vcross(a, v), -1)); }
  function keyOf(v) { return v.map((x) => Math.round(x * 2)).join(','); }

  // sticker table: 96 entries
  const STICKERS = [];
  for (const f of FACES) {
    const g = FACE_GEO[f];
    for (let i = 0; i < 16; i++) {
      const row = Math.floor(i / 4), col = i % 4;
      const pos = vadd(vadd(vscale(g.n, 2), vscale(g.right, col - 1.5)), vscale(g.down, row - 1.5));
      STICKERS.push({ face: f, pos, normal: g.n.slice() });
    }
  }
  const POS_LOOKUP = {};
  STICKERS.forEach((s, i) => { POS_LOOKUP[keyOf(s.pos)] = i; });

  // move permutations: outer 'R' rotates dot > 1; inner 'r' rotates 0 < dot < 1
  const MOVE_PERM = {};
  for (const f of FACES) {
    const axis = FACE_GEO[f].n;
    for (const [token, lo, hi] of [[f, 1, 3], [f.toLowerCase(), 0, 1]]) {
      const perm = STICKERS.map((_, i) => i);
      STICKERS.forEach((s, i) => {
        const d = vdot(s.pos, axis);
        if (d > lo && d < hi + 0.01) {
          perm[i] = POS_LOOKUP[keyOf(rotCW(s.pos, axis))];
        }
      });
      MOVE_PERM[token] = perm;
    }
  }

  function applyMove(state, move) {
    const face = move.length > 1 && (move[1] === '2' || move[1] === "'") ? move[0] : move[0];
    let times = 1;
    if (move.length > 1) times = move[1] === '2' ? 2 : 3;
    const perm = MOVE_PERM[face];
    let s = state;
    for (let t = 0; t < times; t++) {
      const ns = new Array(96);
      for (let i = 0; i < 96; i++) ns[perm[i]] = s[i];
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
    for (const f of FACES) for (let i = 0; i < 16; i++) s.push(f);
    return s;
  }
  function isSolved(state) {
    for (let f = 0; f < 6; f++)
      for (let i = 0; i < 16; i++)
        if (state[f * 16 + i] !== state[f * 16] || state[f * 16 + i] === 'X') return false;
    return true;
  }

  // ---- piece tables ----
  function clampC(x) { return Math.max(-1.5, Math.min(1.5, x)); }
  const cubieMap = {};
  STICKERS.forEach((s, i) => {
    const k = s.pos.map(clampC).map((x) => Math.round(x * 2)).join(',');
    (cubieMap[k] = cubieMap[k] || []).push(i);
  });
  const CORNERS = [];   // {stickers: {face: idx}, coords}
  const WINGS = [];     // {stickers: {face: idx}, coords, dedge}
  const CENTERS = [];   // {face, idx, coords}
  for (const k in cubieMap) {
    const idxs = cubieMap[k];
    const coords = k.split(',').map((x) => +x / 2);
    if (idxs.length === 3) {
      const st = {};
      idxs.forEach((i) => { st[STICKERS[i].face] = i; });
      CORNERS.push({ stickers: st, coords, name: Object.keys(st).sort().join('') });
    } else if (idxs.length === 2) {
      const st = {};
      idxs.forEach((i) => { st[STICKERS[i].face] = i; });
      WINGS.push({ stickers: st, coords, faces: Object.keys(st).sort().join('') });
    } else if (idxs.length === 1) {
      CENTERS.push({ face: STICKERS[idxs[0]].face, idx: idxs[0], coords });
    }
  }
  // logical edges (dedges): group the 24 wings into 12 by their two ±1.5 coords
  const DEDGES = {}; // key -> [wingIndexA, wingIndexB]
  WINGS.forEach((w, i) => {
    const key = w.coords.map((x) => (Math.abs(x) > 1 ? x : '_')).join(',');
    (DEDGES[key] = DEDGES[key] || []).push(i);
  });
  const DEDGE_KEYS = Object.keys(DEDGES);

  // ---- convenience queries ----
  function centerCount(state, face, color) {
    let n = 0;
    for (const c of CENTERS) if (c.face === face && state[c.idx] === color) n++;
    return n;
  }
  function centersSolvedTo(state, scheme) {
    for (const c of CENTERS) if (state[c.idx] !== scheme[c.face]) return false;
    return true;
  }
  function dedgePaired(state, key) {
    const [a, b] = DEDGES[key];
    const wa = WINGS[a], wb = WINGS[b];
    for (const f in wa.stickers) {
      if (state[wa.stickers[f]] !== state[wb.stickers[f]]) return false;
    }
    return true;
  }
  function allPaired(state) {
    return DEDGE_KEYS.every((k) => dedgePaired(state, k));
  }
  function pairedCount(state) {
    return DEDGE_KEYS.filter((k) => dedgePaired(state, k)).length;
  }

  const OUTER = [];
  for (const f of FACES) for (const s of ['', '2', "'"]) OUTER.push(f + s);
  const INNER = [];
  for (const f of FACES) for (const s of ['', '2', "'"]) INNER.push(f.toLowerCase() + s);
  const ALL_MOVES = OUTER.concat(INNER);

  function randomScramble(n = 30, rand = Math.random) {
    const out = [];
    let last = null;
    while (out.length < n) {
      const m = ALL_MOVES[Math.floor(rand() * ALL_MOVES.length)];
      if (m[0] === last) continue;
      out.push(m);
      last = m[0];
    }
    return out;
  }

  return {
    FACES, STICKERS, MOVE_PERM, CORNERS, WINGS, CENTERS, DEDGES, DEDGE_KEYS,
    applyMove, applyAlg, solvedState, isSolved, randomScramble,
    centerCount, centersSolvedTo, dedgePaired, allPaired, pairedCount,
    OUTER, INNER, ALL_MOVES,
  };
})();

// =====================================================================
// 4x4 reduction solver: centers -> pair edges -> solve as a 3x3
// (with OLL/PLL parity fixes, both verified by simulation).
// =====================================================================

(() => {
  const OPPOSITE = { U: 'D', D: 'U', F: 'B', B: 'F', L: 'R', R: 'L' };
  const OLL_PARITY = "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2".split(' '); // flips the UF dedge
  const PLL_PARITY = "r2 U2 r2 U2 u2 r2 u2".split(' ');                      // swaps UF <-> UB dedges
  const M3 = { 0: 0, 1: 1, 2: 3 };

  class SolveError4 extends Error {}

  function sameLayer(a, b) { return a[0] === b[0]; }

  // iterative-deepening search: returns move list satisfying testFn, or null
  function iddfs(state, moveSet, maxDepth, testFn) {
    if (testFn(state)) return [];
    const path = [];
    function dfs(st, depth) {
      for (const m of moveSet) {
        if (path.length && sameLayer(path[path.length - 1], m)) continue;
        const ns = C4.applyMove(st, m);
        path.push(m);
        if (depth === 1 ? testFn(ns) : dfs(ns, depth - 1)) return true;
        path.pop();
      }
      return false;
    }
    for (let d = 1; d <= maxDepth; d++) {
      path.length = 0;
      if (dfs(state, d)) return path.slice();
    }
    return null;
  }

  // wing helpers
  const WING_AT = {}; // coordsKey -> wing index
  C4.WINGS.forEach((w, i) => { WING_AT[w.coords.join(',')] = i; });
  const SLOT = {
    FRlo: WING_AT['1.5,-0.5,1.5'], FRup: WING_AT['1.5,0.5,1.5'],
    FLup: WING_AT['-1.5,0.5,1.5'], BRup: WING_AT['1.5,0.5,-1.5'], BLup: WING_AT['-1.5,0.5,-1.5'],
  };
  function wingColors(state, wi) {
    return Object.values(C4.WINGS[wi].stickers).map((i) => state[i]).sort().join('');
  }
  const UF_DEDGE_KEY = C4.DEDGE_KEYS.find((k) => {
    const w = C4.WINGS[C4.DEDGES[k][0]];
    return w.coords[1] === 1.5 && w.coords[2] === 1.5;
  });

  class Solver4 {
    constructor(state) {
      this.state = state.slice();
      this.moves = [];
      this.stages = [];
      this.scheme = null;
    }
    do(alg) {
      const mvs = Array.isArray(alg) ? alg : alg.trim().split(/\s+/).filter(Boolean);
      for (const m of mvs) {
        this.state = C4.applyMove(this.state, m);
        this.moves.push(m);
      }
    }
    stage(name, desc) { this.stages.push({ name, desc, start: this.moves.length }); }
    endStage() { this.stages[this.stages.length - 1].end = this.moves.length; }
    dropEmptyStage() {
      const st = this.stages[this.stages.length - 1];
      if (st.end === st.start) this.stages.pop();
    }

    deriveScheme() {
      // reference corner: the one at (-1.5,-1.5,-1.5) = DBL
      const dbl = C4.CORNERS.find((c) => c.coords.every((x) => x === -1.5));
      // opposites from corner co-occurrence
      const colors = [...new Set(C4.CORNERS.flatMap((c) => Object.values(c.stickers).map((i) => this.state[i])))];
      if (colors.length !== 6) throw new SolveError4('needs exactly 6 colors on the corners');
      const together = {};
      for (const c of colors) together[c] = new Set();
      for (const c of C4.CORNERS) {
        const cols = Object.values(c.stickers).map((i) => this.state[i]);
        for (const a of cols) for (const b of cols) if (a !== b) together[a].add(b);
      }
      const opp = {};
      for (const c of colors) {
        const alone = colors.filter((o) => o !== c && !together[c].has(o));
        if (alone.length !== 1) throw new SolveError4('corner colors don’t pair into opposite sides');
        opp[c] = alone[0];
      }
      const scheme = {};
      scheme.D = this.state[dbl.stickers.D];
      scheme.B = this.state[dbl.stickers.B];
      scheme.L = this.state[dbl.stickers.L];
      scheme.U = opp[scheme.D];
      scheme.F = opp[scheme.B];
      scheme.R = opp[scheme.L];
      this.scheme = scheme;
    }

    // ---------- centers ----------
    centerOK(face) { return C4.centerCount(this.state, face, this.scheme[face]) === 4; }
    solveCenters() {
      const S = this.scheme;
      // face order: D, B, L, R, then F & U as the "last two"
      // safe "kicks" reshuffle centers without touching a stage's protected faces,
      // rescuing the rare positions the depth-4 search can't reach directly
      const KICKS = {
        D: [['u'], ['d'], ['r'], ['l'], ['f'], ['b']],
        B: [['u'], ['d'], ["u'"], ["d'"], ['u2']],
        L: [['r', 'U', "r'"], ['r', 'U2', "r'"], ['r', "U'", "r'"], ["l'", 'U', 'l'], ["l'", 'U2', 'l']],
        R: [['r', 'U', "r'"], ['r', 'U2', "r'"], ['r', "U'", "r'"], ["l'", 'U', 'l'], ["l'", 'U2', 'l']],
      };
      for (const face of ['D', 'B', 'L', 'R']) {
        const protectedFaces = { D: [], B: ['D'], L: ['D', 'B'], R: ['D', 'B', 'L'] }[face];
        let kickIdx = 0;
        for (let guard = 0; guard < 20; guard++) {
          const have = C4.centerCount(this.state, face, S[face]);
          if (have === 4) break;
          const test = (st) =>
            C4.centerCount(st, face, S[face]) > have &&
            protectedFaces.every((p) => C4.centerCount(st, p, S[p]) === 4);
          const seq = iddfs(this.state, C4.ALL_MOVES, 4, test);
          if (seq) { this.do(seq); continue; }
          const kicks = KICKS[face];
          this.do(kicks[kickIdx % kicks.length]);
          kickIdx++;
        }
        if (!this.centerOK(face)) throw new SolveError4('center face loop exceeded (' + face + ')');
      }
      // last two: F & U via [r U^k r'] / [l' U^k l] exchanges
      const MACROS = [];
      for (const k of ['U', 'U2', "U'"]) {
        MACROS.push(['r', k, "r'"]);
        MACROS.push(["l'", k, 'l']);
      }
      const score = (st) => C4.centerCount(st, 'F', S.F) + C4.centerCount(st, 'U', S.U);
      for (let guard = 0; guard < 30; guard++) {
        if (score(this.state) === 8) break;
        const cur = score(this.state);
        let bestSeq = null, bestScore = cur;
        for (const fa of ['', 'F', 'F2', "F'"]) {
          for (const ub of ['', 'U', 'U2', "U'"]) {
            for (const mac of MACROS) {
              const seq = [...(fa ? [fa] : []), ...(ub ? [ub] : []), ...mac];
              const st = C4.applyAlg(this.state, seq);
              const sc = score(st);
              if (sc > bestScore) { bestScore = sc; bestSeq = seq; }
            }
          }
        }
        if (!bestSeq) {
          // plateau: two-macro lookahead
          outer:
          for (const fa of ['', 'F', 'F2', "F'"]) {
            for (const ub of ['', 'U', 'U2', "U'"]) {
              for (const mac of MACROS) {
                const seq1 = [...(fa ? [fa] : []), ...(ub ? [ub] : []), ...mac];
                const st1 = C4.applyAlg(this.state, seq1);
                for (const ub2 of ['', 'U', 'U2', "U'"]) {
                  for (const mac2 of MACROS) {
                    const seq2 = [...(ub2 ? [ub2] : []), ...mac2];
                    const st2 = C4.applyAlg(st1, seq2);
                    if (score(st2) > cur) { bestSeq = seq1.concat(seq2); break outer; }
                  }
                }
              }
            }
          }
        }
        if (!bestSeq) throw new SolveError4('last-two centers stuck');
        this.do(bestSeq);
      }
      if (score(this.state) !== 8) throw new SolveError4('last-two centers loop exceeded');
    }

    // ---------- edge pairing ----------
    pairedKeys() { return C4.DEDGE_KEYS.filter((k) => C4.dedgePaired(this.state, k)); }
    solveEdges() {
      const centersIntact = (st) => C4.CENTERS.every((c) => st[c.idx] === this.scheme[c.face]);
      for (let guard = 0; guard < 30; guard++) {
        const unpaired = C4.DEDGE_KEYS.filter((k) => !C4.dedgePaired(this.state, k));
        if (unpaired.length === 0) break;
        if (unpaired.length === 1) {
          this.fixFlipped(unpaired[0]);
          break;
        }
        if (unpaired.length === 2) {
          this.lastTwoEdges();
          continue;
        }
        // try each unpaired dedge until one pairs
        let done = false, lastErr = null;
        for (const k of unpaired) {
          try { this.pairOne(k); done = true; break; }
          catch (e) { if (e instanceof SolveError4) lastErr = e; else throw e; }
        }
        if (!done) {
          // fall back to the front-slot algorithm machinery — it needs no
          // spare junk edges and covers flip/parity dead-ends
          this.lastTwoEdges();
        }
      }
      if (!C4.allPaired(this.state)) throw new SolveError4('pairing loop exceeded');
    }
    // endgame: exactly two unpaired dedges and no junk left to swap with —
    // position both at the front and use the classic last-two-edges sequence
    lastTwoEdges() {
      const centersIntact = (s) => C4.CENTERS.every((c) => s[c.idx] === this.scheme[c.face]);
      const MIDS = [
        "R U R' F R' F' R", "R U' R' F R' F' R", "R U2 R' F R' F' R",
        "L' U' L F' L F L'", "L' U L F' L F L'", "L' U2 L F' L F L'",
        "F R' F' R U R U' R'", "F' L F L' U' L' U L",
      ];
      const SLICES = [["u'", 'u'], ['u', "u'"], ['u2', 'u2'], ['d', "d'"], ["d'", 'd'], ['d2', 'd2']];
      const CANDS = [];
      for (const [s, sInv] of SLICES) for (const mid of MIDS) CANDS.push([s, ...mid.split(' '), sInv]);
      const KICKS = [[], ['F2'], ['U2', 'F2'], ["U'", 'F2'], ['U', 'F2'], ['F2', 'U2', 'F2']];
      const seen = new Set();
      let toggles = 0;
      for (let round = 0; round < 12; round++) {
        const before = C4.pairedCount(this.state);
        if (before >= 11) return; // 1 or 0 left: handled by the main loop
        this.pairedNow = this.pairedColorSets(this.state);
        // both unpaired dedges into the FR and FL slots
        const pos = iddfs(this.state, C4.OUTER, 5, (st) =>
          !C4.dedgePaired(st, FR_KEY) && !C4.dedgePaired(st, FL_KEY) && this.pairedPreserved(st));
        if (!pos) throw new SolveError4('last-two positioning failed');
        this.do(pos);
        seen.add(this.state.join(''));
        let progressSeq = null, neutralSeq = null;
        outer:
        for (const kick of KICKS) {
          const base = kick.length ? C4.applyAlg(this.state, kick) : this.state;
          for (const cand of CANDS) {
            const t = C4.applyAlg(base, cand);
            if (!centersIntact(t) || !this.pairedPreserved(t)) continue;
            const cnt = C4.pairedCount(t);
            if (cnt > before) { progressSeq = [...kick, ...cand]; break outer; }
            if (cnt === before && !neutralSeq && !seen.has(t.join(''))) neutralSeq = [...kick, ...cand];
          }
        }
        if (progressSeq) { this.do(progressSeq); continue; }
        // robust fallback ladder
        const unpaired = C4.DEDGE_KEYS.filter((k) => !C4.dedgePaired(this.state, k));
        const flipped = unpaired.find((k) => this.selfFlipped(k));
        if (flipped) { this.fixFlipped(flipped); continue; }
        let colocated = false;
        try { this.colocateOne(unpaired[0]); colocated = true; } catch (e) { if (!(e instanceof SolveError4)) throw e; }
        if (colocated) continue;
        // wing-permutation parity is odd: outer moves are even permutations on
        // wings, so no rearrangement can fix this — toggle parity by flipping a
        // JUNK dedge at UF with the parity alg (nothing paired is sacrificed)
        if (toggles >= 2) throw new SolveError4('last-two parity toggle exhausted');
        toggles++;
        this.pairedNow = this.pairedColorSets(this.state);
        const setup = iddfs(this.state, C4.OUTER, 5, (st) =>
          !C4.dedgePaired(st, UF_DEDGE_KEY) && this.pairedPreserved(st));
        if (!setup) throw new SolveError4('parity toggle setup failed');
        this.do(setup);
        this.do(OLL_PARITY);
      }
      throw new SolveError4('last-two loop exceeded');
    }
    // is this unpaired dedge holding both wings of one pair (just swapped)?
    selfFlipped(key) {
      const [a, b] = C4.DEDGES[key];
      return wingColors(this.state, a) === wingColors(this.state, b);
    }
    // bring a self-flipped dedge to UF and flip it in place with the parity alg
    fixFlipped(key) {
      const want = wingColors(this.state, C4.DEDGES[key][0]);
      const before = C4.pairedCount(this.state);
      this.pairedNow = this.pairedColorSets(this.state);
      const centersIntact = (s) => C4.CENTERS.every((c) => s[c.idx] === this.scheme[c.face]);
      const target = (st) => {
        const [a, b] = C4.DEDGES[UF_DEDGE_KEY];
        return wingColors(st, a) === want && wingColors(st, b) === want && !C4.dedgePaired(st, UF_DEDGE_KEY);
      };
      const setup = iddfs(this.state, C4.OUTER, 5, (st) => target(st) && this.pairedPreserved(st));
      if (!setup) throw new SolveError4('flip setup failed');
      this.do(setup);
      this.do(OLL_PARITY);
      if (C4.pairedCount(this.state) <= before || !centersIntact(this.state)) throw new SolveError4('flip fix failed');
    }
    // merge both wings of a pair onto one dedge slot, ignoring orientation
    colocateOne(key) {
      this.pairedNow = this.pairedColorSets(this.state);
      const pairCols = wingColors(this.state, C4.DEDGES[key][0]);
      const centersIntact = (s) => C4.CENTERS.every((c) => s[c.idx] === this.scheme[c.face]);
      const coLocated = (st) => C4.DEDGE_KEYS.some((k) => {
        const [a, b] = C4.DEDGES[k];
        return wingColors(st, a) === pairCols && wingColors(st, b) === pairCols;
      });
      if (coLocated(this.state)) return;
      const INV = { u: "u'", "u'": 'u', u2: 'u2', d: "d'", "d'": 'd', d2: 'd2' };
      const FAMILIES = [
        { anchor: SLOT.FRlo, merges: ["u'", 'u', 'u2'] },
        { anchor: SLOT.FRup, merges: ['d', "d'", 'd2'] },
      ];
      const saved = { state: this.state, len: this.moves.length };
      for (const fam of FAMILIES) {
        const s1 = iddfs(this.state, C4.OUTER, 5, (st) =>
          wingColors(st, fam.anchor) === pairCols && this.pairedPreserved(st));
        if (!s1) continue;
        this.do(s1);
        const other = fam.anchor === SLOT.FRlo ? SLOT.FRup : SLOT.FRlo;
        const validMerges = (st) => {
          if (wingColors(st, fam.anchor) !== pairCols) return [];
          return fam.merges.filter((m) => {
            const t = C4.applyMove(st, m);
            return wingColors(t, SLOT.FRlo) === pairCols && wingColors(t, SLOT.FRup) === pairCols;
          });
        };
        const s2 = iddfs(this.state, C4.OUTER, 5, (st) =>
          validMerges(st).length > 0 && this.pairedPreserved(st));
        if (!s2) { this.state = saved.state; this.moves.length = saved.len; continue; }
        this.do(s2);
        for (const m of validMerges(this.state)) {
          const mInv = INV[m];
          const afterMerge = C4.applyMove(this.state, m);
          const goal = (st) => {
            const t = C4.applyMove(st, mInv);
            return centersIntact(t) && this.pairedPreserved(t) && coLocated(t);
          };
          const s3 = iddfs(afterMerge, C4.OUTER, 3, goal) || iddfs(afterMerge, C4.OUTER, 4, goal);
          if (s3) { this.do([m, ...s3, mInv]); return; }
        }
        this.state = saved.state; this.moves.length = saved.len;
      }
      throw new SolveError4('co-locate failed');
    }
    pairedColorSets(st) {
      const out = [];
      for (const k of C4.DEDGE_KEYS) {
        if (C4.dedgePaired(st, k)) out.push(wingColors(st, C4.DEDGES[k][0]));
      }
      return out;
    }
    pairedPreserved(st) {
      // every pair that was complete before must still be complete SOMEWHERE
      // (tracking by colors, not slots — pairs are allowed to move around)
      const now = this.pairedColorSets(st);
      return this.pairedNow.every((cols) => now.includes(cols));
    }
    pairOne(key) {
      this.pairedNow = this.pairedColorSets(this.state);
      const pairCols = wingColors(this.state, C4.DEDGES[key][0]);
      const centersIntact = (s) => C4.CENTERS.every((c) => s[c.idx] === this.scheme[c.face]);
      const INV = { u: "u'", "u'": 'u', u2: 'u2', d: "d'", "d'": 'd', d2: 'd2' };
      // two merge families: join at FR via the upper (u) or lower (d) slice
      const FAMILIES = [
        { anchor: SLOT.FRlo, merges: ["u'", 'u', 'u2'] },
        { anchor: SLOT.FRup, merges: ['d', "d'", 'd2'] },
      ];
      const saved = { state: this.state, len: this.moves.length };
      for (const fam of FAMILIES) {
        // step 1: one wing of this pair to the anchor slot
        const s1 = iddfs(this.state, C4.OUTER, 5, (st) =>
          wingColors(st, fam.anchor) === pairCols && this.pairedPreserved(st));
        if (!s1) continue;
        this.do(s1);
        // step 2: other wing positioned so a slice merge pairs FR
        const validMerges = (st) => {
          if (wingColors(st, fam.anchor) !== pairCols) return [];
          return fam.merges.filter((m) => C4.dedgePaired(C4.applyMove(st, m), UF_FR_KEY));
        };
        const s2 = iddfs(this.state, C4.OUTER, 5, (st) =>
          validMerges(st).length > 0 && this.pairedPreserved(st));
        if (!s2) {
          this.state = saved.state; this.moves.length = saved.len;
          continue;
        }
        this.do(s2);
        // step 3: merge, extract the finished pair, restore the slice.
        for (const m of validMerges(this.state)) {
          const mInv = INV[m];
          const afterMerge = C4.applyMove(this.state, m);
          const goal = (st) => {
            const t = C4.applyMove(st, mInv);
            if (!centersIntact(t)) return false;
            if (!this.pairedPreserved(t)) return false;
            for (const k of C4.DEDGE_KEYS) {
              if (C4.dedgePaired(t, k) && wingColors(t, C4.DEDGES[k][0]) === pairCols) return true;
            }
            return false;
          };
          const s3 = iddfs(afterMerge, C4.OUTER, 3, goal) || iddfs(afterMerge, C4.OUTER, 4, goal);
          if (s3) {
            this.do([m, ...s3, mInv]);
            return;
          }
        }
        this.state = saved.state; this.moves.length = saved.len;
      }
      throw new SolveError4('pairing failed');
    }

    // ---------- 3x3 stage ----------
    project() {
      const s3 = [];
      for (let f = 0; f < 6; f++) {
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          s3.push(this.state[f * 16 + M3[r] * 4 + M3[c]]);
        }
      }
      // recolor to canonical letters using center colors
      const map = {};
      for (const f of C4.FACES) map[this.scheme[f]] = f;
      return s3.map((col) => map[col]);
    }
    solve3(method) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const p = this.project();
        const res = method === 'fast'
          ? C3.solve3Fast(p, { timeLimit: 3000, target: 19, minSearch: 900 })
          : C3.solve(p);
        if (!res.error) {
          if (res.alreadySolved) return;
          for (const st of res.stages) {
            this.stage(st.name, st.desc);
            this.do(res.moves.slice(st.start, st.end));
            this.endStage();
          }
          return;
        }
        // parity handling
        if (/edge orientation|edge is flipped|flipped/.test(res.error)) {
          this.stage('Flip Parity', 'A 4×4-only situation: one edge pair is flipped. This special sequence flips it back.');
          this.do(OLL_PARITY);
          this.endStage();
          continue;
        }
        if (/permutation|swapped/.test(res.error)) {
          this.stage('Swap Parity', 'A 4×4-only situation: two edge pairs are swapped. This special sequence swaps them back.');
          this.do(PLL_PARITY);
          this.endStage();
          continue;
        }
        throw new SolveError4('3x3 stage: ' + res.error);
      }
      throw new SolveError4('parity loop exceeded');
    }

    run(method) {
      this.deriveScheme();
      this.stage('Solve the Centers', 'Gather the four center pieces of each color onto their face — the 4×4’s centers move, so this comes first.');
      this.solveCenters();
      this.endStage();
      this.stage('Pair the Edges', 'Join the two matching halves of each edge so the cube behaves like a 3×3.');
      this.solveEdges();
      this.endStage();
      this.solve3(method);
      if (!C4.isSolved(this.state)) throw new SolveError4('final state not solved');
      return { moves: this.moves, stages: this.stages };
    }
  }

  // key of the FR vertical dedge
  const FR_KEY = C4.DEDGE_KEYS.find((k) => {
    const w = C4.WINGS[C4.DEDGES[k][0]];
    return Math.abs(w.coords[1]) === 0.5 && w.coords[0] === 1.5 && w.coords[2] === 1.5;
  });
  const FL_KEY = C4.DEDGE_KEYS.find((k) => {
    const w = C4.WINGS[C4.DEDGES[k][0]];
    return Math.abs(w.coords[1]) === 0.5 && w.coords[0] === -1.5 && w.coords[2] === 1.5;
  });
  const UF_FR_KEY = FR_KEY;
  function keyOfPair(st, cols) {
    for (const k of C4.DEDGE_KEYS) {
      const [x] = C4.DEDGES[k];
      if (wingColors(st, x) === cols) return k;
    }
    return null;
  }

  function validate4(state) {
    const errs = [];
    const colorCount = {};
    for (const c of state) colorCount[c] = (colorCount[c] || 0) + 1;
    if (state.includes('X')) return ['unpainted stickers remain'];
    const colors = Object.keys(colorCount);
    if (colors.length !== 6) return ['a 4×4 needs exactly 6 different colors (found ' + colors.length + ')'];
    for (const c of colors) if (colorCount[c] !== 16) errs.push(`each color needs exactly 16 stickers (${c} has ${colorCount[c]})`);
    if (errs.length) return errs;
    // per-type counts
    const cornerCount = {}, wingCount = {}, centerCountBy = {};
    for (const c of C4.CORNERS) for (const f in c.stickers) cornerCount[state[c.stickers[f]]] = (cornerCount[state[c.stickers[f]]] || 0) + 1;
    for (const w of C4.WINGS) for (const f in w.stickers) wingCount[state[w.stickers[f]]] = (wingCount[state[w.stickers[f]]] || 0) + 1;
    for (const c of C4.CENTERS) centerCountBy[state[c.idx]] = (centerCountBy[state[c.idx]] || 0) + 1;
    for (const c of colors) {
      if ((cornerCount[c] || 0) !== 4) errs.push('corner stickers are off: each color belongs on exactly 4 corner stickers');
      if ((wingCount[c] || 0) !== 8) errs.push('edge stickers are off: each color belongs on exactly 8 edge stickers');
      if ((centerCountBy[c] || 0) !== 4) errs.push('center stickers are off: each color belongs on exactly 4 center stickers');
    }
    if (errs.length) return [...new Set(errs)];
    // corners: 8 distinct valid triples
    const seen = {};
    for (const c of C4.CORNERS) {
      const cols = Object.values(c.stickers).map((i) => state[i]);
      if (new Set(cols).size !== 3) { errs.push('a corner piece has a repeated color'); continue; }
      const k = cols.slice().sort().join('|');
      if (seen[k]) errs.push('two identical corner pieces exist');
      seen[k] = 1;
    }
    // wings: each color pair exactly twice
    const wp = {};
    for (const w of C4.WINGS) {
      const cols = Object.values(w.stickers).map((i) => state[i]);
      if (cols[0] === cols[1]) { errs.push('an edge piece has the same color on both sides'); continue; }
      const k = cols.slice().sort().join('|');
      wp[k] = (wp[k] || 0) + 1;
    }
    for (const k in wp) if (wp[k] !== 2) errs.push('edge pieces don’t come in matching pairs — check your painting');
    return [...new Set(errs)];
  }

  // phased fast path: table-guided phased reduction + two-phase 3x3 finish.
  // C4.phasedReducer is registered by the tpr4 module when it loads.
  function solvePhased(state) {
    if (!C4.phasedReducer) return null;
    const probe = new Solver4(state);
    try { probe.deriveScheme(); } catch (e) { return null; }
    const scheme = probe.scheme;
    const red = C4.phasedReducer(state, scheme);
    if (!red) return null;
    const mid = C4.applyAlg(state, red);
    const rest = finish3x3(mid, scheme, 'fast');
    if (!rest) return null;
    const stages = [{
      name: 'Reduce to a 3×3',
      desc: 'Table-guided phased reduction: centers sorted onto their bands phase by phase, then finished together with edge pairing.',
      start: 0, end: red.length,
    }];
    for (const st of rest.stages) stages.push({ name: st.name, desc: st.desc, start: st.start + red.length, end: st.end + red.length });
    return { moves: red.concat(rest.moves), stages };
  }

  function solve4(state, method) {
    const errs = validate4(state);
    if (errs.length) return { error: errs.join('; ') };
    if (C4.isSolved(state)) return { moves: [], stages: [], alreadySolved: true };
    let raw = null;
    if (method === 'fast') {
      try { raw = solvePhased(state); } catch (e) { raw = null; }
      if (raw && !C4.isSolved(C4.applyAlg(state, raw.moves))) raw = null; // safety net
      if (raw && raw.moves.length > 100) {
        // rare long outlier: let the classic pipeline compete
        try {
          const alt = new Solver4(state).run(method);
          if (alt && alt.moves.length < raw.moves.length) raw = alt;
        } catch (e) { /* keep phased result */ }
      }
    }
    if (!raw) {
      try {
        raw = new Solver4(state).run(method);
      } catch (e) {
        if (e instanceof SolveError4) {
          return { error: 'This cube can’t be solved — something must be painted wrong. (' + e.message + ')' };
        }
        throw e;
      }
    }
    // clean each stage separately
    const stages = [], moves = [];
    for (const st of raw.stages) {
      const seg = C3.cleanMoves(raw.moves.slice(st.start, st.end));
      if (seg.length === 0 && raw.stages.length > 3) continue;
      stages.push({ name: st.name, desc: st.desc, start: moves.length, end: moves.length + seg.length });
      moves.push(...seg);
    }
    return { moves, stages };
  }

  // finish the reduction (centers + pairing) from an arbitrary valid state,
  // with an externally fixed target scheme. Returns {moves, state} or null.
  function finishReduction(state, scheme) {
    const solver = new Solver4(state);
    solver.scheme = scheme;
    try {
      solver.stage('c', '');
      solver.solveCenters();
      solver.endStage();
      solver.stage('p', '');
      solver.solveEdges();
      solver.endStage();
    } catch (e) {
      if (e instanceof SolveError4) return null;
      throw e;
    }
    return { moves: solver.moves, state: solver.state };
  }

  // 3x3 stage (with parity fixes) from a fully reduced state
  function finish3x3(state, scheme, method) {
    const solver = new Solver4(state);
    solver.scheme = scheme;
    try {
      solver.solve3(method);
    } catch (e) {
      if (e instanceof SolveError4) return null;
      throw e;
    }
    return { moves: solver.moves, state: solver.state, stages: solver.stages };
  }

  C4.Solver4 = Solver4;
  C4.solve4 = solve4;
  C4.validate4 = validate4;
  C4.OLL_PARITY = OLL_PARITY;
  C4.PLL_PARITY = PLL_PARITY;
  C4.finishReduction = finishReduction;
  C4.finish3x3 = finish3x3;
})();

if (typeof module !== 'undefined') module.exports = C4;
if (typeof window !== 'undefined') window.Cube4 = C4;

})();
