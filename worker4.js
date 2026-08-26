// Solver worker for the 4×4 fast path: holds the phased-reduction tables and
// runs one portfolio search config (or the finishing 3×3 stage) off the main
// thread. Several workers run different configs in parallel; the shortest
// reduction wins.
importScripts('cube.js', 'cube4.js', 'tpr4.js');

const C4 = globalThis.Cube4;
const TPR4 = globalThis.TPR4;

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.t === 'tables') {
      const map = {};
      for (const k in m.tables) map[k] = new Uint8Array(m.tables[k]);
      TPR4.importTables(map);
      postMessage({ id: m.id, ok: true });
    } else if (m.t === 'deepinit') {
      // prewarm: build this worker's deep pruning tables (~3s) ahead of the
      // first solve, so entering 4×4 mode hides the cost behind scanning
      TPR4.deepInit();
      postMessage({ id: m.id, ok: true });
    } else if (m.t === 'reduce') {
      // tables not shipped? buildAll runs here, off the main thread
      const probe = new C4.Solver4(m.state);
      probe.deriveScheme();
      const red = TPR4.phasedReduce(m.state, probe.scheme, m.cfg);
      postMessage({ id: m.id, red });
    } else if (m.t === 'deep') {
      // exact-phase-3 deep reduction; builds this worker's big pruning tables
      // on first use (~2-4s) and keeps them for the session. cfg.rotate picks
      // which color axis plays U/D during reduction (0..2).
      const probe = new C4.Solver4(m.state);
      probe.deriveScheme();
      const scheme = TPR4.rotateScheme(probe.scheme, (m.cfg && m.cfg.rotate) || 0);
      const reds = TPR4.deepReduce(m.state, scheme, m.cfg || {});
      postMessage({ id: m.id, reds });
    } else if (m.t === 'finish') {
      postMessage({ id: m.id, res: C4.solve4(m.state, 'fast', { reduction: m.red, budget3: m.budget3 }) });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
