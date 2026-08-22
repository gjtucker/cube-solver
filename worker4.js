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
    } else if (m.t === 'reduce') {
      // tables not shipped? buildAll runs here, off the main thread
      const probe = new C4.Solver4(m.state);
      probe.deriveScheme();
      const red = TPR4.phasedReduce(m.state, probe.scheme, m.cfg);
      postMessage({ id: m.id, red });
    } else if (m.t === 'finish') {
      postMessage({ id: m.id, res: C4.solve4(m.state, 'fast', { reduction: m.red }) });
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
