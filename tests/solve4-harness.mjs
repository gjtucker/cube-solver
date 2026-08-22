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
//
// Acceptance targets (agreed for the shipped-tables work):
//   - average total moves <= 70        (baseline before shipped tables: ~87)
//   - average solve wall time <= 5000ms (baseline: ~11500ms)
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
// default = the product pipeline: shipped tables + the portfolio spread over
// parallel workers. --sequential measures the no-worker fallback instead;
// --hard measures the "Search harder" mode (deep portfolio + rich 3x3
// finishes, targets ≤58 moves / ≤75s instead of ≤70 / ≤5s; measured 54.6
// on seed 1 and 58.0 on the harder seed 7).
const sequential = args.includes('--sequential');
const hard = args.includes('--hard');

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
async function solveParallel(s) {
  const reds = await Promise.all(getPool().map((w, i) => callOn(w, { state: s, cfg: TPR4.PORTFOLIO[i] })));
  let best = null;
  for (const r of reds) if (r.red && (!best || r.red.length < best.length)) best = r.red;
  return C4.solve4(s, 'fast', best ? { reduction: best } : undefined);
}
// "Search harder": deep portfolio queued over the pool, top distinct
// reductions each finished with a generous 3x3 budget, shortest total wins
async function solveHard(s) {
  const reds = await mapPool(TPR4.PORTFOLIO_DEEP.map((cfg) => ({ state: s, cfg })));
  const good = reds.map((r) => r.red).filter(Boolean).sort((a, b) => a.length - b.length);
  if (!good.length) return C4.solve4(s, 'fast');
  const picks = [];
  for (const r of good) {
    if (!picks.some((p) => p.join(' ') === r.join(' '))) picks.push(r);
    if (picks.length === 3) break;
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
  rows.push({ total: sol.moves.length, red: redLen, three: redLen === null ? null : sol.moves.length - redLen, ms });
}

const nums = (k) => rows.map((r) => r[k]).filter((x) => x !== null).sort((a, b) => a - b);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

const totals = nums('total'), reds = nums('red'), threes = nums('three'), times = nums('ms');
const summary = {
  n: N, seed, buildMs,
  totalAvg: +avg(totals).toFixed(1), totalMedian: pct(totals, 0.5), totalP90: pct(totals, 0.9), totalMax: totals[totals.length - 1],
  reductionAvg: reds.length ? +avg(reds).toFixed(1) : null,
  threeAvg: threes.length ? +avg(threes).toFixed(1) : null,
  msAvg: Math.round(avg(times)), msMax: times[times.length - 1],
  phasedUsed: reds.length,   // scrambles where the phased reducer produced the solution
  pass: null,
};
const targets = hard ? { moves: 58, ms: 75000 } : { moves: 70, ms: 5000 };
summary.mode = hard ? 'hard' : sequential ? 'sequential' : 'parallel';
summary.pass = summary.totalAvg <= targets.moves && summary.msAvg <= targets.ms;

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`table build: ${buildMs}ms · ${N} scrambles (seed ${seed}) · mode ${summary.mode}`);
  console.log(`MOVES:  avg ${summary.totalAvg} (target ≤ ${targets.moves}) · median ${summary.totalMedian} · p90 ${summary.totalP90} · max ${summary.totalMax}`);
  console.log(`        reduction avg ${summary.reductionAvg} · 3x3 finish avg ${summary.threeAvg} · phased path used ${summary.phasedUsed}/${N}`);
  console.log(`TIME:   avg ${summary.msAvg}ms (target ≤ ${targets.ms}ms) · max ${summary.msMax}ms`);
  console.log(summary.pass ? 'PASS' : 'FAIL (baseline before shipped tables: ~87 moves / ~11500ms)');
}
if (pool) for (const w of pool) w.terminate();
process.exit(strict && !summary.pass ? 1 : 0);
