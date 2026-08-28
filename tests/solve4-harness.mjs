#!/usr/bin/env node
// Acceptance harness for the 4x4 fast solver.
//
// Runs seeded random scrambles through C4.solve4('fast') and reports solution
// length (total, reduction part, 3x3 part) and wall time, so any change to
// tables or search parameters is judged by numbers, not vibes.
//
//   node tests/solve4-harness.mjs                 # 20 scrambles, seed 1
//   node tests/solve4-harness.mjs --n 50 --seed 7
//   node tests/solve4-harness.mjs --json
//   node tests/solve4-harness.mjs --strict        # nonzero exit unless targets met
//   node tests/solve4-harness.mjs --no-upgrade    # the depth-8 window, pre-upgrade
//
// Acceptance targets:
//   - fast: average total moves <= 48, average wall time <= 2000ms
//     (beam-era fast path: ~61 moves; pre-shipped-tables baseline: ~87)
//   - hard: average total moves <= 46, average wall time <= 20s
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const C4 = require(join(root, 'cube4.js'));
const TPR4 = require(join(root, 'tpr4.js'));
const TAB = require(join(root, 'tables.js'));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? +args[i + 1] : dflt;
};
const N = opt('n', 20);
const seed = opt('seed', 1);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
// default = the product pipeline: the deep engine (exact phase 3) with fast
// caps, one color-axis rotation per worker, prewarmed pruning tables
// (measured 45.6 moves / 992ms on seed 1, 46.4 / 1038ms on seed 7).
// --beams measures the old beam-portfolio fast path (≤70 / ≤5s);
// --sequential measures the no-worker synchronous fallback;
// --hard measures the "Search harder" mode, which spends its budget on a much
// wider head pool (measured 44.1 moves / ~11.8s on seeds 1 and 7).
const sequential = args.includes('--sequential');
const hard = args.includes('--hard');
const useBeams = args.includes('--beams');
// --no-upgrade measures the window right after prewarm, before the background
// depth-9 upgrade lands (i.e. the worst case a user can actually hit)
const noUpgrade = args.includes('--no-upgrade');

const bundlePath = join(root, 'tables', `tpr4-v${TPR4.TABLES_VERSION}.bin.gz`);
const tBuild0 = Date.now();
if (existsSync(bundlePath)) TPR4.importTables(TAB.readBundle(bundlePath).tables);
else TPR4.buildAll();
const buildMs = Date.now() - tBuild0;

// worker pool mirroring the browser's worker4.js (reduce per config, best wins)
const WORKER_SRC = `
  const { parentPort, workerData } = require('node:worker_threads');
  const C4 = require(workerData.root + '/cube4.js');
  const TPR4 = require(workerData.root + '/tpr4.js');
  const TAB = require(workerData.root + '/tables.js');
  if (workerData.bundle) TPR4.importTables(TAB.readBundle(workerData.bundle).tables);
  parentPort.on('message', (m) => {
    if (m.t === 'finish') {
      parentPort.postMessage({ res: C4.solve4(m.state, 'fast', { reduction: m.red, budget3: m.budget3 }) });
    } else if (m.t === 'deepinit') {
      TPR4.deepInit();
      parentPort.postMessage({ ok: true });
    } else if (m.t === 'deepupgrade') {
      // drive the background horizon upgrade to completion so the measured
      // numbers are the steady state a user reaches, not a half-built one
      while (!TPR4.upgradeEdgeStep(30000));
      parentPort.postMessage({ ok: true, depth: TPR4.edgeDepth });
    } else if (m.t === 'deep') {
      const probe = new C4.Solver4(m.state);
      probe.deriveScheme();
      const scheme = TPR4.rotateScheme(probe.scheme, (m.cfg && m.cfg.rotate) || 0);
      parentPort.postMessage({ reds: TPR4.deepReduce(m.state, scheme, m.cfg || {}) });
    } else {
      const probe = new C4.Solver4(m.state);
      probe.deriveScheme();
      parentPort.postMessage({ red: TPR4.phasedReduce(m.state, probe.scheme, m.cfg) });
    }
  });
`;
let pool = null;
function getPool() {
  if (!pool) {
    pool = TPR4.PORTFOLIO.map(() => new Worker(WORKER_SRC, {
      eval: true,
      workerData: { root, bundle: existsSync(bundlePath) ? bundlePath : null },
    }));
  }
  return pool;
}
function callOn(w, msg) {
  return new Promise((resolve) => {
    w.once('message', resolve);
    w.postMessage(msg);
  });
}
// each worker pulls the next task when free (tasks have uneven cost)
async function mapPool(msgs) {
  const workers = getPool();
  let next = 0;
  const out = new Array(msgs.length);
  await Promise.all(workers.map(async (w) => {
    while (next < msgs.length) {
      const i = next++;
      out[i] = await callOn(w, msgs[i]);
    }
  }));
  return out;
}
// fast mode = the deep engine with tight caps: one rotation per worker,
// quick parallel 3x3 finishes on the best few reductions (mirrors app.js's
// solveFast); --beams measures the old beam-portfolio fast path instead
const FAST_DEEP_CFG = (rotate) => ({
  rotate, tries: 2, solutions: 2, results: 2,
  softMs: 1200, bailEmpty: true, p3TimeCapMs: 700, headsNodeCap: 1.2e6,
  nodeCap: 12e6, extraNodes: 6e5, bridgedCap: 3, bridgeNodeCap: 6e5,
});
// "Search harder" spends its budget on a much wider head pool: enumerating
// far more phase-1/2 heads and branch-and-bounding over them is worth ~2 moves
// on the reduction, which is where the remaining slack lives now that phase 3
// is exact.
const HARD_DEEP_CFG = (rotate) => ({
  rotate, tries: 40, solutions: 4, results: 4, softMs: 25000,
  headCap: 40, p1cap: 60, p1slack: 2, p2cap: 6, perPrepCap: 6, tExtra: 7,
  headsNodeCap: 30e6, nodeCap: 40e6, bridgedCap: 12, bridgeNodeCap: 20e6,
});
// rescue round for the rare scramble the capped configs give up on: bigger
// budgets beat falling back to the ~60-move beam path
const RESCUE_DEEP_CFG = (rotate) => ({
  rotate, tries: 3, solutions: 2, results: 2, softMs: 8000,
});
async function solveParallel(s) {
  if (useBeams) return solveParallelBeams(s);
  const pool = getPool();
  const rots = [0, 1, 2].slice(0, pool.length);
  const deepRes = await Promise.all(rots.map((rotate, i) =>
    callOn(pool[i], { t: 'deep', state: s, cfg: FAST_DEEP_CFG(rotate) })));
  const cands = [];
  for (const r of deepRes) if (r.reds) for (const red of r.reds) cands.push(red);
  if (!cands.length) {
    const rescue = await Promise.all(rots.map((rotate, i) =>
      callOn(pool[i], { t: 'deep', state: s, cfg: RESCUE_DEEP_CFG(rotate) })));
    for (const r of rescue) if (r.reds) for (const red of r.reds) cands.push(red);
  }
  if (!cands.length) return solveParallelBeams(s);
  cands.sort((a, b) => a.length - b.length);
  const picks = [];
  for (const red of cands) {
    if (!picks.some((p) => p.join(' ') === red.join(' '))) picks.push(red);
    if (picks.length === 3) break;
  }
  const budget3 = { timeLimit: 600, target: 20, minSearch: 200 };
  const fins = await mapPool(picks.map((red) => ({ t: 'finish', state: s, red, budget3 })));
  let best = null;
  for (const f of fins) {
    if (f.res && !f.res.error && f.res.moves && (!best || f.res.moves.length < best.moves.length)) best = f.res;
  }
  return best || C4.solve4(s, 'fast');
}
async function solveParallelBeams(s) {
  const reds = await Promise.all(getPool().map((w, i) => callOn(w, { state: s, cfg: TPR4.PORTFOLIO[i] })));
  const probe = new C4.Solver4(s);
  probe.deriveScheme();
  let best = null, bestCost = Infinity;
  for (const r of reds) {
    if (!r.red) continue;
    const meta = TPR4.reductionMeta(s, probe.scheme, r.red);
    const cost = r.red.length + (meta.par ? 15 : 0) + (meta.pll ? 7 : 0);
    if (cost < bestCost) { best = r.red; bestCost = cost; }
  }
  return C4.solve4(s, 'fast', best ? { reduction: best } : undefined);
}
// "Search harder": exact-phase-3 deep reductions across the three color-axis
// rotations, then the top distinct reductions each finished with a generous
// 3x3 budget; shortest total wins. Beam portfolio remains the fallback.
async function solveHard(s) {
  const deepRes = await mapPool([0, 1, 2].map((rotate) =>
    ({ t: 'deep', state: s, cfg: HARD_DEEP_CFG(rotate) })));
  const cands = [];
  for (const r of deepRes) if (r.reds) for (const red of r.reds) cands.push(red);
  if (!cands.length) return solveHardBeams(s);
  cands.sort((a, b) => a.length - b.length);
  const picks = [];
  for (const red of cands) {
    if (!picks.some((p) => p.join(' ') === red.join(' '))) picks.push(red);
    if (picks.length === 6) break;
  }
  const budget3 = { timeLimit: 5000, target: 17, minSearch: 1500 };
  const fins = await mapPool(picks.map((red) => ({ t: 'finish', state: s, red, budget3 })));
  let best = null;
  for (const f of fins) {
    if (f.res && !f.res.error && f.res.moves && (!best || f.res.moves.length < best.moves.length)) best = f.res;
  }
  return best || C4.solve4(s, 'fast');
}
// previous deep mode: beam-search portfolio (kept as the fallback path)
async function solveHardBeams(s) {
  const reds = await mapPool(TPR4.PORTFOLIO_DEEP.map((cfg) => ({ state: s, cfg })));
  const probe = new C4.Solver4(s);
  probe.deriveScheme();
  const good = reds.map((r) => r.red).filter(Boolean)
    .map((red) => {
      const meta = TPR4.reductionMeta(s, probe.scheme, red);
      return { red, cost: red.length + (meta.par ? 15 : 0) + (meta.pll ? 7 : 0) };
    })
    .sort((a, b) => a.cost - b.cost);
  if (!good.length) return C4.solve4(s, 'fast');
  const picks = [];
  for (const { red } of good) {
    if (!picks.some((p) => p.join(' ') === red.join(' '))) picks.push(red);
    if (picks.length === 4) break;
  }
  const budget3 = { timeLimit: 4000, target: 18, minSearch: 1500 };
  const fins = await mapPool(picks.map((red) => ({ t: 'finish', state: s, red, budget3 })));
  let best = null;
  for (const f of fins) {
    if (f.res && !f.res.error && f.res.moves && (!best || f.res.moves.length < best.moves.length)) best = f.res;
  }
  return best || C4.solve4(s, 'fast');
}

const rand = rng(seed);
// mirror the app: deep tables are prewarmed while the user scans/paints, so
// they are not part of any solve's wall time (reported separately)
let warmMs = 0, upgradeMs = 0;
if (!useBeams && !sequential) {
  const t0 = Date.now();
  await Promise.all(getPool().map((w) => callOn(w, { t: 'deepinit' })));
  warmMs = Date.now() - t0;
  if (!noUpgrade) {
    const t1 = Date.now();
    await Promise.all(getPool().map((w) => callOn(w, { t: 'deepupgrade' })));
    upgradeMs = Date.now() - t1;
  }
}
const rows = [];
for (let i = 0; i < N; i++) {
  let s = C4.solvedState();
  s = C4.applyAlg(s, C4.randomScramble(30, rand).join(' '));
  const t0 = Date.now();
  const sol = hard ? await solveHard(s) : sequential ? C4.solve4(s, 'fast') : await solveParallel(s);
  const ms = Date.now() - t0;
  if (sol.error || !C4.isSolved(C4.applyAlg(s, sol.moves))) {
    console.error(`scramble ${i}: SOLVE FAILED (${sol.error || 'not solved'})`);
    process.exit(2);
  }
  const red = sol.stages.find((st) => st.name.startsWith('Reduce'));
  const redLen = red ? red.end - red.start : null;
  // OBTM (outer block turn metric): outer moves count 1, single-slice moves 2
  const obtm = sol.moves.reduce((acc, m) => acc + (m[0] === m[0].toUpperCase() ? 1 : 2), 0);
  rows.push({ total: sol.moves.length, obtm, red: redLen, three: redLen === null ? null : sol.moves.length - redLen, ms });
}

const nums = (k) => rows.map((r) => r[k]).filter((x) => x !== null).sort((a, b) => a - b);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

const totals = nums('total'), obtms = nums('obtm'), reds = nums('red'), threes = nums('three'), times = nums('ms');
const summary = {
  n: N, seed, buildMs,
  totalAvg: +avg(totals).toFixed(1), totalMedian: pct(totals, 0.5), totalP90: pct(totals, 0.9), totalMax: totals[totals.length - 1],
  obtmAvg: +avg(obtms).toFixed(1),
  reductionAvg: reds.length ? +avg(reds).toFixed(1) : null,
  threeAvg: threes.length ? +avg(threes).toFixed(1) : null,
  msAvg: Math.round(avg(times)), msMax: times[times.length - 1],
  phasedUsed: reds.length,   // scrambles where the phased reducer produced the solution
  pass: null,
};
const targets = hard ? { moves: 46, ms: 20000 } : useBeams ? { moves: 70, ms: 5000 } : { moves: 48, ms: 2000 };
summary.mode = hard ? 'hard' : sequential ? 'sequential' : 'parallel';
summary.pass = summary.totalAvg <= targets.moves && summary.msAvg <= targets.ms;

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`table build: ${buildMs}ms · deep ready: ${warmMs}ms (+${upgradeMs}ms background upgrade) · ${N} scrambles (seed ${seed}) · mode ${summary.mode}`);
  console.log(`MOVES:  avg ${summary.totalAvg} (target ≤ ${targets.moves}) · median ${summary.totalMedian} · p90 ${summary.totalP90} · max ${summary.totalMax} · OBTM avg ${summary.obtmAvg}`);
  console.log(`        reduction avg ${summary.reductionAvg} · 3x3 finish avg ${summary.threeAvg} · phased path used ${summary.phasedUsed}/${N}`);
  console.log(`TIME:   avg ${summary.msAvg}ms (target ≤ ${targets.ms}ms) · max ${summary.msMax}ms`);
  console.log(summary.pass ? 'PASS' : 'FAIL (baseline before shipped tables: ~87 moves / ~11500ms)');
}
if (pool) for (const w of pool) w.terminate();
process.exit(strict && !summary.pass ? 1 : 0);
