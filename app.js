(() => {
  const C = window.Cube;
  const C4 = window.Cube4;
  // ---- 4×4 fast solver: shipped tables + parallel search workers ----
  // The table bundle is fetched once in the background (skipping the ~10s
  // on-device build) and shared with a small worker pool; each worker runs
  // one portfolio search config and the shortest reduction wins. Every step
  // degrades gracefully: no DecompressionStream / no Workers / failed fetch
  // all fall back to the synchronous on-device path.
  const solver4 = {
    tablesP: null, pool: null, calls: new Map(), nextId: 1,
    loadTables() {
      if (!this.tablesP) {
        this.tablesP = (window.CubeTables && window.TPR4 && typeof DecompressionStream !== 'undefined')
          ? window.CubeTables.fetchBundle(`tables/tpr4-v${window.TPR4.TABLES_VERSION}.bin.gz`)
            .then((b) => (b.version === window.TPR4.TABLES_VERSION ? b.tables : null))
            .catch(() => null)
          : Promise.resolve(null);
        // the main thread imports them too, for the no-worker fallback path
        this.tablesP.then((t) => { if (t && !window.TPR4.built) window.TPR4.importTables(t); });
      }
      return this.tablesP;
    },
    // every call has a generous watchdog: a worker that died (script failed
    // to load, tab reclaimed it) would otherwise leave the promise pending
    // forever and the solve hung with its button disabled. On timeout or
    // worker error the pool is torn down so the sync fallback takes over and
    // the next solve starts fresh.
    call(worker, msg, timeoutMs) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const t = setTimeout(() => {
          if (this.calls.delete(id)) { this.resetPool(); reject(new Error('worker timeout')); }
        }, timeoutMs || 120000);
        this.calls.set(id, {
          resolve: (v) => { clearTimeout(t); resolve(v); },
          reject: (e) => { clearTimeout(t); reject(e); },
        });
        worker.postMessage(Object.assign({ id }, msg));
      });
    },
    resetPool() {
      if (this.pool) {
        for (const w of this.pool) { try { w.terminate(); } catch (_) {} }
        this.pool = null;
      }
      for (const [id, c] of this.calls) { this.calls.delete(id); c.reject(new Error('worker pool reset')); }
    },
    getPool(n, tables) {
      if (this.pool) return this.pool;
      this.pool = [];
      for (let i = 0; i < n; i++) {
        const w = new Worker('worker4.js');
        w.onmessage = (e) => {
          const c = this.calls.get(e.data.id);
          if (c) { this.calls.delete(e.data.id); c.resolve(e.data); }
        };
        w.onerror = () => this.resetPool();
        if (tables) this.call(w, { t: 'tables', tables }).catch(() => {});
        this.pool.push(w);
      }
      return this.pool;
    },
    // run tasks over the pool, each worker pulling the next when free
    async mapPool(pool, items, makeMsg, onProgress) {
      let next = 0, done = 0;
      const out = new Array(items.length);
      await Promise.all(pool.map(async (w) => {
        while (next < items.length) {
          const i = next++;
          out[i] = await this.call(w, makeMsg(items[i]));
          done++;
          if (onProgress) onProgress(done, items.length);
        }
      }));
      return out;
    },
    // true cost of a reduction = length + the parity fixes it still owes
    // (flip ~15 moves, swap ~7); falls back to bare length when the main
    // thread has no tables to judge parity with
    reductionCost(state, red) {
      try {
        const TPR4 = window.TPR4;
        if (!TPR4.built) return red.length;
        const probe = new C4.Solver4(state);
        probe.deriveScheme();
        const meta = TPR4.reductionMeta(state, probe.scheme, red);
        return red.length + (meta.par ? 15 : 0) + (meta.pll ? 7 : 0);
      } catch (_) { return red.length; }
    },
    // "Search harder": exact-phase-3 deep reductions across the three
    // color-axis rotations (each worker builds its big pruning tables on
    // first use, ~3s, and keeps them), then the top distinct reductions each
    // get their own generous 3×3 finish; shortest total wins. ~10-20s.
    // The beam portfolio remains the fallback. Returns null if workers are
    // unavailable.
    async solveHard(state, onProgress) {
      if (typeof Worker === 'undefined') return null;
      const TPR4 = window.TPR4;
      const tables = await this.loadTables();
      const n = Math.min(TPR4.PORTFOLIO.length, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
      const pool = this.getPool(n, tables);
      const STEPS = 5; // 3 rotations + finish + done
      const deepRes = await this.mapPool(pool, [0, 1, 2],
        (rotate) => ({ t: 'deep', state, cfg: { rotate, tries: 3, solutions: 4, results: 4 } }),
        (done) => onProgress && onProgress(done, STEPS));
      const cands = [];
      for (const r of deepRes) if (r && r.reds) for (const red of r.reds) cands.push(red);
      let picks = [];
      if (cands.length) {
        cands.sort((a, b) => a.length - b.length);
        for (const red of cands) {
          if (!picks.some((p) => p.join(' ') === red.join(' '))) picks.push(red);
          if (picks.length === 6) break;
        }
      } else {
        // fallback: beam-search portfolio, ranked by true cost
        const reds = await this.mapPool(pool, TPR4.PORTFOLIO_DEEP,
          (cfg) => ({ t: 'reduce', state, cfg }),
          (done, total) => onProgress && onProgress(3, STEPS));
        const good = reds.map((r) => r && r.red).filter(Boolean)
          .map((red) => ({ red, cost: this.reductionCost(state, red) }))
          .sort((a, b) => a.cost - b.cost);
        if (!good.length) return null;
        for (const { red } of good) {
          if (!picks.some((p) => p.join(' ') === red.join(' '))) picks.push(red);
          if (picks.length === 4) break;
        }
      }
      if (onProgress) onProgress(4, STEPS);
      const budget3 = { timeLimit: 5000, target: 17, minSearch: 1500 };
      const fins = await this.mapPool(pool, picks, (red) => ({ t: 'finish', state, red, budget3 }));
      if (onProgress) onProgress(STEPS, STEPS);
      let best = null;
      for (const f of fins) {
        if (f && f.res && !f.res.error && f.res.moves && (!best || f.res.moves.length < best.moves.length)) best = f.res;
      }
      return best;
    },
    async solveFast(state) {
      if (typeof Worker === 'undefined') return C4.solve4(state, 'fast');
      try {
        const TPR4 = window.TPR4;
        const tables = await this.loadTables();
        const n = Math.min(TPR4.PORTFOLIO.length, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
        const pool = this.getPool(n, tables);
        const reds = await Promise.all(TPR4.PORTFOLIO.slice(0, pool.length).map((cfg, i) =>
          this.call(pool[i], { t: 'reduce', state, cfg })));
        let best = null, bestCost = Infinity;
        for (const r of reds) {
          if (!r || !r.red) continue;
          const cost = this.reductionCost(state, r.red);
          if (cost < bestCost) { best = r.red; bestCost = cost; }
        }
        if (!best) return C4.solve4(state, 'fast');
        const fin = await this.call(pool[0], { t: 'finish', state, red: best });
        return fin && fin.res ? fin.res : C4.solve4(state, 'fast');
      } catch (_) {
        return C4.solve4(state, 'fast');   // any worker trouble: solve synchronously
      }
    },
  };
  solver4.loadTables();
  const COLORS = { U: 'var(--c-U)', D: 'var(--c-D)', F: 'var(--c-F)', B: 'var(--c-B)', R: 'var(--c-R)', L: 'var(--c-L)', X: 'var(--c-X)' };
  const COLOR_NAMES = { U: 'yellow', D: 'white', F: 'green', B: 'blue', R: 'orange', L: 'red', X: 'eraser' };
  const CORNER_SET = new Set(C.CORNER_IDX);

  // ---------- per-mode data ----------
  const blank2 = () => {
    const s = C.solvedState();
    for (const i of C.CORNER_IDX) s[i] = 'X';
    return s;
  };
  const data = {
    '3': { paint: C.solvedState() },
    '4': { paint: C4.solvedState() },
    '2': { paint: C.solvedState() },
    'm': { paint: C.stateToShapes(C.solvedState()) }, // shape codes
  };
  const HOWTO = {
    '3': 'Hold your cube with the <b>yellow center up</b> <span class="dot" style="background:var(--c-U)"></span> and the <b>green center facing you</b> <span class="dot" style="background:var(--c-F)"></span>, then tap a color and paint every sticker to match. Centers are fixed.',
    '4': 'Hold your 4×4 <b>any way you like</b> and paint all 96 stickers to match — on a 4×4 even the centers move, so the solver works out your color scheme itself.',
    '2': 'Hold your 2×2 <b>any way you like</b> and paint all 24 stickers to match — the solver figures out your color scheme automatically.',
    'm': 'Ignore color — a mirror cube is about <b>size</b>. For every sticker, pick the shape that matches the block you see: <b>small</b>, <b>wide</b>, <b>tall</b> or <b>big</b>. Hold your cube any way you like.',
  };
  const HINT = {
    '3': 'drag to spin · tap a sticker to paint',
    '4': 'drag to spin · tap a sticker to paint',
    '2': 'drag to spin · tap a sticker to paint',
    'm': 'drag to spin · tap a sticker to set its size',
  };
  const ENG = () => (mode === '4' ? C4 : C); // facelet engine for the current mode

  let mode = '3';
  let method = 'beginner'; // beginner | fast
  let selColor = 'U';   // for color modes
  let selShape = 3;     // for mirror mode
  let animating = false;
  let solution = null;
  let baseState = null;   // colored state at solve time (virtual for mirror)
  let pbState = null;     // current colored state during playback/scramble animation
  let mirrorGeo = false;  // mirror: render real geometry (playback/scramble) vs paint boxes
  let moveIndex = 0;
  let playing = false;
  let speedVal = 5;
  let viewMode = '3d';  // '3d' | 'net' — how the cube is shown while painting
  let scrambling = false;  // a scramble or pattern animation owns the cube
  let shareVirgin = false; // a shared cube is on screen but not yet adopted:
                           // nothing persists (so merely viewing a link can
                           // never wipe the saved workspace) until the user
                           // genuinely acts on it — paints, clears, scrambles,
                           // applies a pattern, or solves

  // ---------- persistence: the workspace survives refreshes ----------
  // Saved per browser: every mode's paint, the active tab, solve method,
  // palette selection, speed — and an in-progress solution with its exact
  // playback position, so a refresh mid-follow-through resumes where you were.
  const STORE_KEY = 'cubeSolverState:v1';
  function saveStateNow() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        mode, method, selColor, selShape, speedVal, view: viewMode,
        paints: { 3: data['3'].paint, 4: data['4'].paint, 2: data['2'].paint, m: data.m.paint },
        playback: solution && baseState ? { solution, baseState, moveIndex } : null,
      }));
    } catch (_) { /* storage unavailable (private mode, blocked) — run stateless */ }
  }
  let saveTimer = 0;
  let dirty = false;    // a tab that never changed anything must never flush on
  let booted = false;   // pagehide — a stale background tab would clobber a
                        // fresher tab's save (last-writer-wins store)
  function saveState() {
    if (!booted || shareVirgin) return;
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStateNow, 250);
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!s || !s.paints) return null;
      for (const k of ['3', '4', '2', 'm']) {
        if (Array.isArray(s.paints[k]) && s.paints[k].length === data[k].paint.length) data[k].paint = s.paints[k];
      }
      if (['3', '4', '2', 'm'].includes(s.mode)) mode = s.mode;
      if (s.method === 'fast' || s.method === 'beginner') method = s.method;
      if (typeof s.selColor === 'string') selColor = s.selColor;
      if (typeof s.selShape === 'number' || s.selShape === 'X') selShape = s.selShape;
      if (typeof s.speedVal === 'number' && s.speedVal >= 1 && s.speedVal <= 10) speedVal = s.speedVal;
      if (s.view === 'net' || s.view === '3d') viewMode = s.view;
      return s;
    } catch (_) { return null; }
  }
  const savedState = loadState();
  // a shared-cube link (#c=<base64url JSON>) overrides the saved workspace:
  // whoever opens it should see exactly the cube that was shared
  function parseShareHash() {
    if (!location.hash.startsWith('#c=')) return null;
    try {
      const b64 = location.hash.slice(3).replace(/-/g, '+').replace(/_/g, '/');
      const s = JSON.parse(atob(b64));
      if (!['3', '4', '2', 'm'].includes(s.m)) return null;
      if (!Array.isArray(s.p) || s.p.length !== data[s.m].paint.length) return null;
      if (!s.p.every((v) => typeof v === 'number' || (typeof v === 'string' && v.length <= 2))) return null;
      return s;
    } catch (_) { return null; }
  }
  const sharedCube = parseShareHash();
  if (sharedCube) {
    mode = sharedCube.m;
    data[mode].paint = sharedCube.p;
    shareVirgin = true;
    // drop the hash so a later refresh keeps the user's own edits
    history.replaceState(null, '', location.pathname + location.search);
  }
  window.addEventListener('pagehide', () => { if (dirty) saveStateNow(); });
  document.addEventListener('visibilitychange', () => { if (dirty && document.visibilityState === 'hidden') saveStateNow(); });

  // ---------- 3D construction ----------
  const cubeEl = document.getElementById('cube');
  const viewport = document.getElementById('viewport');
  let S = 60; // base sticker unit (1/3 of cube edge)
  let cubies = {};      // key -> {el, coords(sign or grid), faces: {face: fEl}}
  let stickerEls = {};  // facelet idx -> element

  const CSS_FACE_ROT = {
    F: '', B: 'rotateY(180deg)', R: 'rotateY(90deg)', L: 'rotateY(-90deg)',
    U: 'rotateX(90deg)', D: 'rotateX(-90deg)',
  };

  function computeS() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    S = Math.floor(Math.min(w, h) / 5.4);
  }

  function clearCube() {
    cubeEl.innerHTML = '';
    cubies = {};
    stickerEls = {};
  }

  function buildCube() {
    clearCube();
    computeS();
    // Uniform cubes hide their interior faces at rest (they're occluded
    // anyway): iPad Safari's 3D compositor mis-sorts large plane counts,
    // drawing dark interior wedges over the stickers. The faces reappear
    // while a layer turns, so turns still show the cube's inside. Mirror
    // cubes keep all faces — their varied piece sizes expose body faces.
    cubeEl.classList.toggle('occlude', mode !== 'm');
    if (mode === '3') {
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        makeCubie([x, y, z]);
      }
      C.STICKERS.forEach((s, idx) => {
        const coords = s.pos.map((v) => Math.max(-1, Math.min(1, Math.round(v))));
        attachSticker(idx, coords, s.face);
      });
    } else if (mode === '4') {
      const P = [-1.5, -0.5, 0.5, 1.5];
      for (const x of P) for (const y of P) for (const z of P) {
        if (Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(z) < 1) continue; // interior
        makeCubie([x, y, z]);
      }
      C4.STICKERS.forEach((s, idx) => {
        const coords = s.pos.map((v) => Math.max(-1.5, Math.min(1.5, v)));
        attachSticker(idx, coords, s.face);
      });
    } else {
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) makeCubie([x, y, z]);
      C.STICKERS.forEach((s, idx) => {
        if (!CORNER_SET.has(idx)) return;
        const coords = s.pos.map((v) => (v > 0 ? 1 : -1));
        attachSticker(idx, coords, s.face);
      });
    }
    layoutCube();
  }

  function makeCubie(coords) {
    const el = document.createElement('div');
    el.className = 'cubie';
    cubeEl.appendChild(el);
    const rec = { el, coords, faces: {} };
    for (const f of C.FACES) {
      const fEl = document.createElement('div');
      fEl.className = 'cf';
      fEl.dataset.face = f;
      el.appendChild(fEl);
      rec.faces[f] = fEl;
    }
    cubies[coords.join(',')] = rec;
  }
  function attachSticker(idx, coords, face) {
    const rec = cubies[coords.join(',')];
    const fEl = rec.faces[face];
    fEl.classList.add('sticker');
    fEl.dataset.idx = idx;
    if (mode === '3' && idx % 9 === 4) fEl.classList.add('centerlock');
    stickerEls[idx] = fEl;
  }

  // geometry pass: sizes & positions (uniform grid). Mirror geometry overrides in renderMirrorGeo.
  function layoutCube() {
    const cs = mode === '3' ? S : mode === '4' ? S * 0.75 : S * 1.5; // cubie size
    for (const k in cubies) {
      const { el, coords, faces } = cubies[k];
      const step = mode === '3' ? S : mode === '4' ? S * 0.75 : S * 0.75;
      el.dataset.base = `translate3d(${coords[0] * step}px, ${-coords[1] * step}px, ${coords[2] * step}px)`;
      el.style.transform = el.dataset.base;
      for (const f in faces) {
        const fEl = faces[f];
        fEl.style.width = cs + 'px';
        fEl.style.height = cs + 'px';
        fEl.style.left = -cs / 2 + 'px';
        fEl.style.top = -cs / 2 + 'px';
        fEl.style.transform = `${CSS_FACE_ROT[f]} translateZ(${cs / 2}px)`;
      }
    }
  }

  // ---------- rendering ----------
  // save defaults to true: every state mutation flows through render(). Pass
  // false for redraws that reflect no user change (window resize) — otherwise
  // merely rotating the phone would persist state the user never touched
  // (e.g. adopt a just-opened share link over their saved workspace).
  function render(save = true) {
    if (save) saveState();
    if (mode === 'm') {
      if (mirrorGeo && pbState) renderMirrorGeo(pbState);
      else renderMirrorPaint();
      return;
    }
    const st = (pbState && mode !== 'm') ? pbState : data[mode].paint;
    for (const idx in stickerEls) {
      const el = stickerEls[idx];
      const c = st[idx];
      // backgroundColor, not the shorthand — the shorthand would wipe the
      // .blank class's hatch background-image
      el.style.backgroundColor = COLORS[c] || COLORS.X;
      el.classList.toggle('blank', c === 'X');
      el.classList.remove('gold', 'mirrorbody');
      el.innerHTML = '';
    }
    renderNet();
  }

  // ---------- 2D net view ----------
  // A flat unfolded cross — some people find it much easier to copy a real
  // cube face-by-face onto a net than onto a spinning 3D cube. Playback and
  // move animations always run in 3D; the net is a paint-time view.
  const netEl = document.getElementById('netview');
  const viewSeg = document.getElementById('viewSeg');
  const view3dBtn = document.getElementById('view3dBtn');
  const viewNetBtn = document.getElementById('viewNetBtn');
  const NET_COL = { U: 2, L: 1, F: 2, R: 3, B: 4, D: 2 };
  const NET_ROW = { U: 1, L: 2, F: 2, R: 2, B: 2, D: 3 };
  const NET_OFF = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
  let netCells = {};   // facelet idx -> cell element
  function buildNet() {
    netCells = {};
    netEl.innerHTML = '';
    if (mode === 'm') return;
    const n = mode === '4' ? 4 : mode === '2' ? 2 : 3;
    const per = mode === '4' ? 16 : 9;
    for (const f of ['U', 'L', 'F', 'R', 'B', 'D']) {
      const fEl = document.createElement('div');
      fEl.className = 'netface';
      fEl.style.gridColumn = NET_COL[f];
      fEl.style.gridRow = NET_ROW[f];
      fEl.style.setProperty('--n', n);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const idx = mode === '2'
            ? NET_OFF[f] * 9 + [0, 2, 6, 8][r * 2 + c]
            : NET_OFF[f] * per + r * n + c;
          const cell = document.createElement('div');
          cell.className = 'netcell';
          if (mode === '3' && idx % 9 === 4) cell.classList.add('lock');
          cell.addEventListener('click', () => {
            if (animating || scrambling || solution) return;
            if (mode === '3' && idx % 9 === 4) return;   // centers locked
            shareVirgin = false;
            data[mode].paint[idx] = selColor;
            pbState = null;
            render();
            clearMsg();
          });
          netCells[idx] = cell;
          fEl.appendChild(cell);
        }
      }
      netEl.appendChild(fEl);
    }
  }
  function renderNet() {
    if (mode === 'm' || netEl.style.display === 'none') return;
    const st = pbState || data[mode].paint;
    for (const idx in netCells) {
      const cell = netCells[idx];
      const c = st[idx];
      cell.style.backgroundColor = COLORS[c] || COLORS.X;
      cell.classList.toggle('blank', c === 'X');
    }
  }
  // effective view: mirror mode and playback always show the 3D cube,
  // without forgetting the user's preference
  function syncView() {
    const v = (mode === 'm' || solution) ? '3d' : viewMode;
    viewport.style.display = v === 'net' ? 'none' : '';
    netEl.style.display = v === 'net' ? '' : 'none';
    viewSeg.style.display = (mode === 'm' || solution) ? 'none' : '';
    view3dBtn.classList.toggle('on', v === '3d');
    viewNetBtn.classList.toggle('on', v === 'net');
    hint3d.textContent = v === 'net' ? 'tap a square to paint it' : HINT[mode];
    renderNet();
  }
  function setView(v) {
    viewMode = v;
    syncView();
    saveState();
  }
  // the phone layout pins the playbar right below the cube panel; measure the
  // panel's real height instead of guessing in vh (it varies with the hint
  // line, paddings, and 3D-vs-net view)
  function updateStickyOffsets() {
    const stage = document.querySelector('.stage3d');
    if (stage) document.documentElement.style.setProperty('--stickyTop', (stage.offsetHeight + 10) + 'px');
  }
  // the panel's height shifts with fonts loading, hint wrapping, and the
  // 3D/net views — track it rather than trusting one measurement
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateStickyOffsets).observe(document.querySelector('.stage3d'));
  }
  view3dBtn.addEventListener('click', () => setView('3d'));
  viewNetBtn.addEventListener('click', () => setView('net'));

  function renderMirrorPaint() {
    layoutCube(); // restore uniform boxes
    const shapes = data.m.paint;
    for (const k in cubies) {
      const { faces } = cubies[k];
      for (const f in faces) {
        const fEl = faces[f];
        if (!fEl.classList.contains('sticker')) { fEl.className = 'cf mirrorbody'; continue; }
        fEl.className = 'cf sticker mirrorbody';
        fEl.style.background = '';
        const v = shapes[+fEl.dataset.idx];
        const cs = S * 1.5;
        const r = document.createElement('div');
        if (v === 'X' || v === undefined) {
          r.className = 'shaperect empty';
          r.style.width = 0.5 * cs + 'px';
          r.style.height = 0.5 * cs + 'px';
        } else {
          r.className = 'shaperect';
          r.style.width = ((v & 1) ? 0.86 : 0.48) * cs + 'px';
          r.style.height = ((v & 2) ? 0.86 : 0.48) * cs + 'px';
        }
        fEl.innerHTML = '';
        fEl.appendChild(r);
      }
    }
  }

  // real mirror-block geometry from a virtual colored state.
  // Every block is anchored at the internal CUT corner and grows outward —
  // like a physical offset-cut puzzle. CUT = -0.3 (solved: big side = 1.8
  // reaches the +1.5 face, small side = 1.2 reaches the -1.5 face).
  const SMALL = 1.2, BIG = 1.8, CUT = -0.3; // in units of S (edge total = 3)
  function renderMirrorGeo(st) {
    const dims = C.mirrorDims(st);
    for (const slot of C.CORNER_NAMES) {
      const v = C.slotVec(slot);
      const rec = cubies[v.join(',')];
      const d = dims[slot].map((b) => (b ? BIG : SMALL) * S);
      // box center: anchored at the cut corner, extending outward in slot direction
      const cx = CUT * S + v[0] * d[0] / 2;
      const cy = CUT * S + v[1] * d[1] / 2;
      const cz = CUT * S + v[2] * d[2] / 2;
      rec.el.dataset.base = `translate3d(${cx}px, ${-cy}px, ${cz}px)`;
      rec.el.style.transform = rec.el.dataset.base;
      for (const f in rec.faces) {
        const fEl = rec.faces[f];
        const g = C.FACE_GEO[f];
        const ra = g.right.findIndex((x) => x !== 0);
        const da = g.down.findIndex((x) => x !== 0);
        const na = g.n.findIndex((x) => x !== 0);
        const w = d[ra], h = d[da], depth = d[na];
        fEl.style.width = w + 'px';
        fEl.style.height = h + 'px';
        fEl.style.left = -w / 2 + 'px';
        fEl.style.top = -h / 2 + 'px';
        fEl.style.transform = `${CSS_FACE_ROT[f]} translateZ(${depth / 2}px)`;
        fEl.innerHTML = '';
        const outward = fEl.classList.contains('sticker');
        fEl.className = 'cf' + (outward ? ' sticker gold' : ' mirrorbody');
        fEl.style.background = '';
      }
    }
  }

  // ---------- orbit ----------
  let rx = -28, ry = -34;
  function applyOrbit() { cubeEl.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`; }
  applyOrbit();

  let pDown = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (pDown) return;   // one finger drives the cube; a second is ignored
    pDown = { id: e.pointerId, x: e.clientX, y: e.clientY, rx, ry, moved: false, target: e.target };
    try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    // the release happened where we couldn't hear it (outside the window, or
    // pointer capture failed): a moving mouse with no buttons down ends the drag
    if (e.pointerType === 'mouse' && e.buttons === 0) { pDown = null; return; }
    const dx = e.clientX - pDown.x, dy = e.clientY - pDown.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) pDown.moved = true;
    if (pDown.moved) {
      ry = pDown.ry + dx * 0.45;
      rx = Math.max(-110, Math.min(110, pDown.rx - dy * 0.45));
      applyOrbit();
    }
  });
  viewport.addEventListener('pointerup', (e) => {
    if (!pDown || e.pointerId !== pDown.id) return;
    if (!pDown.moved && !animating && !scrambling && !solution) {
      const t = pDown.target;
      const stickerEl = t.classList && t.classList.contains('sticker') ? t
        : t.classList && t.classList.contains('shaperect') ? t.parentElement : null;
      if (stickerEl && stickerEl.dataset.idx !== undefined) {
        const idx = +stickerEl.dataset.idx;
        if (mode === '3' && idx % 9 === 4) { pDown = null; return; } // centers locked
        shareVirgin = false;
        if (mode === 'm') {
          data.m.paint[idx] = selShape;
          pbState = null;
        } else {
          data[mode].paint[idx] = selColor;
          pbState = null;
        }
        render();
        clearMsg();
      }
    }
    pDown = null;
  });
  viewport.addEventListener('pointercancel', () => { pDown = null; });
  viewport.addEventListener('lostpointercapture', () => { pDown = null; });
  window.addEventListener('blur', () => { pDown = null; });
  // belt-and-braces for engines that don't honor an ancestor's
  // touch-action:none across the 3D-transformed subtree (iOS Safari):
  // a touch that starts on the cube panel must never scroll the page
  document.querySelector('.stage3d').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // ---------- move animation ----------
  function animDuration() { return Math.max(80, 520 - speedVal * 45); }

  function animateMove(move, dur) {
    return new Promise((resolve) => {
      const face = move[0];
      const isInner = face >= 'a' && face <= 'z'; // 4x4 inner slice
      const n = C.FACE_GEO[face.toUpperCase()].n;
      let angle = 90;
      if (move[1] === "'") angle = -90;
      else if (move[1] === '2') angle = 180;
      const axis = [n[0], -n[1], n[2]];
      const affected = [];
      for (const k in cubies) {
        const { el, coords } = cubies[k];
        const d = coords[0] * n[0] + coords[1] * n[1] + coords[2] * n[2];
        const inLayer = mode === '4'
          ? (isInner ? Math.abs(d - 0.5) < 0.01 : d > 1)
          : d >= 1;
        if (inLayer) affected.push(el);
      }
      // mirror-geometry turns pivot on the offset cut axis (through the cut
      // corner), which keeps the two halves on opposite sides of the cut
      // plane for the entire turn — no blocks can ever pass through each other
      const useCut = mode === 'm' && mirrorGeo;
      const px = useCut ? CUT * S : 0, py = useCut ? -CUT * S : 0, pz = useCut ? CUT * S : 0;
      const pivot = useCut
        ? `translate3d(${px}px, ${py}px, ${pz}px) rotate3d(${axis[0]}, ${axis[1]}, ${axis[2]}, ${angle}deg) translate3d(${-px}px, ${-py}px, ${-pz}px) `
        : `rotate3d(${axis[0]}, ${axis[1]}, ${axis[2]}, ${angle}deg) `;
      cubeEl.classList.add('turning');
      affected.forEach((el) => {
        el.style.transition = `transform ${dur}ms cubic-bezier(0.35, 0, 0.25, 1)`;
        el.style.transform = pivot + el.dataset.base;
      });
      setTimeout(() => {
        // a concurrent handler may have torn the playback state down (or an
        // engine hiccup thrown) — the promise must still settle, or animating
        // sticks forever and every await waitIdle() in the app hangs
        try {
          if (pbState) pbState = ENG().applyMove(pbState, move);
          affected.forEach((el) => { el.style.transition = 'none'; });
          render();
          for (const k in cubies) cubies[k].el.style.transform = cubies[k].el.dataset.base;
          void cubeEl.offsetWidth;
          cubeEl.classList.remove('turning');
        } catch (_) {}
        resolve();
      }, dur + 30);
    });
  }

  async function playSequence(moves, durPer) {
    animating = true;
    try {
      for (const m of moves) await animateMove(m, durPer);
    } finally {
      animating = false;
    }
  }

  // ---------- palette ----------
  const paletteEl = document.getElementById('palette');
  const SHAPES = [
    { code: 0, w: 14, h: 14, label: 'small' },
    { code: 1, w: 26, h: 14, label: 'wide' },
    { code: 2, w: 14, h: 26, label: 'tall' },
    { code: 3, w: 26, h: 26, label: 'big' },
    { code: 'X', label: 'eraser' },
  ];
  function buildPalette() {
    paletteEl.innerHTML = '';
    paletteEl.classList.toggle('shapes', mode === 'm');
    if (mode === 'm') {
      for (const sh of SHAPES) {
        const b = document.createElement('div');
        b.className = 'swatch' + (sh.code === selShape ? ' sel' : '');
        b.dataset.shape = sh.code;
        if (sh.code !== 'X') {
          const r = document.createElement('div');
          r.className = 'srect';
          r.style.width = sh.w + 'px';
          r.style.height = sh.h + 'px';
          b.appendChild(r);
        }
        const lab = document.createElement('div');
        lab.className = 'swlabel';
        lab.textContent = sh.label;
        b.appendChild(lab);
        b.addEventListener('click', () => {
          selShape = sh.code;
          document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s === b));
          saveState();
        });
        paletteEl.appendChild(b);
      }
    } else {
      for (const c of ['U', 'D', 'F', 'B', 'R', 'L', 'X']) {
        const b = document.createElement('div');
        b.className = 'swatch' + (c === selColor ? ' sel' : '');
        b.dataset.c = c;
        if (c !== 'X') b.style.background = COLORS[c];
        b.title = COLOR_NAMES[c];
        b.addEventListener('click', () => {
          selColor = c;
          document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s === b));
          saveState();
        });
        paletteEl.appendChild(b);
      }
    }
  }

  // ---------- messages ----------
  const msgEl = document.getElementById('msg');
  function showMsg(text, kind) { msgEl.textContent = text; msgEl.className = 'msg ' + kind; }
  function clearMsg() { msgEl.className = 'msg'; msgEl.textContent = ''; }

  // ---------- mode switching ----------
  const hint3d = document.getElementById('hint3d');
  const howtoEl = document.getElementById('howto');
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', async () => {
      if (t.dataset.mode === mode || scrambling) return;
      await waitIdle();
      exitPlayback();
      mode = t.dataset.mode;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
      howtoEl.innerHTML = HOWTO[mode];
      hint3d.textContent = HINT[mode];
      updateMethodNote();
      updateScanButton();
      pbState = null;
      mirrorGeo = false;
      buildPalette();
      buildCube();
      buildNet();
      buildPatterns();
      syncView();
      render();
      clearMsg();
    });
  });
  howtoEl.innerHTML = HOWTO[mode];
  hint3d.textContent = HINT[mode];

  // ---------- solve method ----------
  const methodNote = document.getElementById('methodNote');
  const METHOD_NOTES = {
    beginner: {
      '3': 'The classic layer-by-layer method in 7 friendly stages — great for learning to solve it yourself.',
      '4': 'The reduction method: solve the centers, pair up the edges, then finish layer-by-layer like a 3×3 (≈280 moves).',
      '2': 'Three friendly stages: bottom layer, orient the top, place the top.',
      'm': 'Three friendly stages: flush bottom, level the top, final positions.',
    },
    fast: {
      '3': 'A two-phase computer method: around 20–25 moves, one straight run with no stages to learn. First use takes a few seconds to warm up.',
      '4': 'Phased reduction guided by pre-built lookup tables (a 228 KB download, cached for offline use), then a two-phase finish — typically 55–70 moves. Solving takes a few seconds.',
      '2': 'The mathematically shortest solution — never more than 11 turns. First use takes a moment to warm up.',
      'm': 'The mathematically shortest way back to a perfect cube — never more than 11 turns. First use takes a moment to warm up.',
    },
  };
  function updateMethodNote() { methodNote.textContent = METHOD_NOTES[method][mode]; }
  document.querySelectorAll('.segbtn').forEach((b) => {
    b.addEventListener('click', async () => {
      if (b.dataset.method === method || scrambling) return;
      await waitIdle();
      exitPlayback();
      method = b.dataset.method;
      document.querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('on', x === b));
      updateMethodNote();
      saveState();
    });
  });

  // ---------- top buttons ----------
  const btnSolve = document.getElementById('btnSolve');
  const btnEdit = document.getElementById('btnEdit');
  const solutionEl = document.getElementById('solution');
  const paintCard = document.getElementById('paintCard');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitIdle() {
    playing = false;
    while (animating) await sleep(40);
  }

  document.getElementById('btnReset').addEventListener('click', async () => {
    if (scrambling) return;
    shareVirgin = false;
    await waitIdle();
    exitPlayback();
    data[mode].paint = mode === 'm' ? C.stateToShapes(C.solvedState()) : ENG().solvedState();
    pbState = null; mirrorGeo = false;
    render(); clearMsg();
  });
  document.getElementById('btnClear').addEventListener('click', async () => {
    if (scrambling) return;
    shareVirgin = false;
    await waitIdle();
    exitPlayback();
    if (mode === '3') {
      data['3'].paint = data['3'].paint.map((_, i) => (i % 9 === 4 ? C.FACES[Math.floor(i / 9)] : 'X'));
    } else if (mode === '4') {
      data['4'].paint = new Array(96).fill('X');
    } else if (mode === '2') {
      data['2'].paint = blank2();
    } else {
      const s = new Array(54).fill('X');
      data.m.paint = s;
    }
    pbState = null; mirrorGeo = false;
    render(); clearMsg();
  });

  document.getElementById('btnScramble').addEventListener('click', async () => {
    if (scrambling) return;
    scrambling = true;
    shareVirgin = false;
    try {
      await waitIdle();
      exitPlayback();
      clearMsg();
      if (viewMode === 'net') setView('3d');   // watch the scramble happen
      if (mode === '3') {
        if (data['3'].paint.includes('X')) data['3'].paint = C.solvedState();
        pbState = data['3'].paint;
        await playSequence(C.randomScramble(20), 90);
        data['3'].paint = pbState;
      } else if (mode === '4') {
        if (data['4'].paint.includes('X')) data['4'].paint = C4.solvedState();
        pbState = data['4'].paint;
        await playSequence(C4.randomScramble(28), 85);
        data['4'].paint = pbState;
      } else if (mode === '2') {
        if (data['2'].paint.includes('X')) data['2'].paint = C.solvedState();
        pbState = data['2'].paint;
        await playSequence(C.randomScramble2(12), 110);
        data['2'].paint = pbState;
      } else {
        // mirror: animate real geometry from solved, then hand back shape-paint view
        pbState = C.solvedState();
        mirrorGeo = true;
        render();
        await sleep(350);
        await playSequence(C.randomScramble2(12), 130);
        data.m.paint = C.stateToShapes(pbState);
        await sleep(500);
        mirrorGeo = false;
        render();
      }
      pbState = null;
      showMsg('Scrambled! Now hit “Solve my cube”.', 'ok');
    } finally {
      scrambling = false;
    }
  });

  // ---------- pretty patterns ----------
  // Applied by animating the algorithm from a solved cube, so the moves shown
  // in the message really do produce the pattern on a real cube.
  const PATTERNS = {
    '3': [
      { name: 'Checkerboard', alg: 'R2 L2 U2 D2 F2 B2' },
      { name: 'Cube in cube', alg: "F L F U' R U F2 L2 U' L' B D' B' L2 U" },
      { name: 'Cube³', alg: "U' L' U' F' R2 B' R F U B2 U B' L U' F U R F'" },
      { name: 'Six spots', alg: "U D' R L' F B' U D'" },
      { name: 'Tetris', alg: "L R F B U' D' L' R'" },
      { name: 'Superflip', alg: "U R2 F B R B2 R U2 L B2 R U' D' R2 F R' L B2 U2 F2" },
    ],
    // NOTE: a true checkerboard is impossible on even cubes — the full 2×2
    // group was searched exhaustively and no two-colour diagonal pattern
    // exists in it (and 4×4 blocks reduce to the same corner arrangement).
    '4': [
      { name: 'Diamonds', alg: 'r2 l2 f2 b2 u2 d2' },
      { name: 'Pillars', alg: 'r2 l2' },
      { name: 'Belt', alg: 'u2 d2' },
    ],
    '2': [
      { name: 'Half & half', alg: 'R2 U2' },
      { name: 'Pinwheel', alg: 'R2 F2 R2 U2' },
    ],
  };
  const patternsCard = document.getElementById('patternsCard');
  const patternRow = document.getElementById('patternRow');
  function buildPatterns() {
    const list = PATTERNS[mode] || [];
    patternsCard.style.display = list.length ? '' : 'none';
    patternRow.innerHTML = '';
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = p.name;
      b.addEventListener('click', () => applyPattern(p));
      patternRow.appendChild(b);
    }
  }
  async function applyPattern(p) {
    if (scrambling || animating) return;
    scrambling = true;
    shareVirgin = false;
    try {
      await waitIdle();
      exitPlayback();
      clearMsg();
      if (viewMode === 'net') setView('3d');   // watch the moves happen
      data[mode].paint = mode === '4' ? C4.solvedState() : C.solvedState();
      pbState = data[mode].paint;
      render();
      await sleep(300);
      await playSequence(p.alg.split(' '), 110);
      data[mode].paint = pbState;
      pbState = null;
      render();
      showMsg(`${p.name} — from a solved cube: ${p.alg}`, 'ok');
    } finally {
      scrambling = false;
    }
  }

  btnSolve.addEventListener('click', async () => {
    if (animating || scrambling) return;
    shareVirgin = false;
    clearMsg();
    // blank checks first (cheap)
    if (mode === '3' || mode === '4') {
      const st = data[mode].paint;
      if (st.includes('X')) {
        const left = st.filter((c) => c === 'X').length;
        showMsg(`Keep painting — ${left} sticker${left > 1 ? 's' : ''} still blank.`, 'err');
        return;
      }
    } else {
      const arr = data[mode].paint;
      const left = C.CORNER_IDX.filter((i) => arr[i] === 'X' || arr[i] === undefined).length;
      if (left) {
        showMsg(mode === 'm' ? `Keep going — ${left} sticker${left > 1 ? 's' : ''} still need a size.` : `Keep painting — ${left} sticker${left > 1 ? 's' : ''} still blank.`, 'err');
        return;
      }
    }
    // fast solvers build lookup tables on first use; the 4x4 search always
    // takes a few seconds — let the UI paint a notice first
    const needsWarmup = (method === 'fast' && (mode === '3' || mode === '4' ? !C.K.ready : !C.Pocket.dist)) || mode === '4';
    if (needsWarmup) {
      const msg = mode === '4'
        ? (method === 'fast'
          ? 'Searching hard for a short solution — a few seconds…'
          : 'Solving — a 4×4 takes a few seconds of thinking…')
        : 'Preparing the fast solver (first time only)…';
      showMsg(msg, 'ok');
      btnSolve.disabled = true;
      await sleep(80);
    }
    let res;
    try {
      if (mode === '3') {
        const st = data['3'].paint;
        res = method === 'fast' ? C.solve3Fast(st, { timeLimit: 2500, target: 21, minSearch: 450 }) : C.solve(st);
        if (!res.error && !res.alreadySolved) baseState = st.slice();
      } else if (mode === '4') {
        const st = data['4'].paint;
        res = method === 'fast' ? await solver4.solveFast(st) : C4.solve4(st, 'beginner');
        if (!res.error && !res.alreadySolved) baseState = st.slice();
      } else if (mode === '2') {
        const st = data['2'].paint;
        res = method === 'fast' ? C.solve2Optimal(st) : C.solve2(st);
        if (!res.error && !res.alreadySolved) baseState = st.slice();
      } else {
        const sh = data.m.paint;
        res = method === 'fast' ? C.solveMirrorOptimal(sh) : C.solveMirror(sh);
        if (!res.error && !res.alreadySolved) baseState = res.state.slice();
      }
    } finally {
      btnSolve.disabled = false;
    }
    if (res.error) { showMsg(fixMsg(res.error), 'err'); return; }
    if (res.alreadySolved) {
      showMsg(mode === 'm' ? 'This mirror cube is already a perfect cube! 🎉 Scramble it or set your own shapes.'
        : 'This cube is already solved! 🎉 Scramble it or paint your own.', 'ok');
      return;
    }
    solution = res;
    moveIndex = 0;
    enterPlayback();
    updateHarderButton();
  });

  // 4×4 fast solutions can be refined by a much deeper (~1 min) search
  function updateHarderButton() {
    btnHarder.style.display = mode === '4' && method === 'fast' && typeof Worker !== 'undefined' ? '' : 'none';
  }

  const btnHarder = document.getElementById('btnHarder');
  btnHarder.addEventListener('click', async () => {
    if (!solution || !baseState) return;
    await waitIdle();
    const st = baseState.slice();
    const cur = solution;
    const before = cur.moves.length;
    btnHarder.disabled = true;
    try {
      const res = await solver4.solveHard(st, (done, total) => {
        showMsg(`Searching much harder — ${Math.round((100 * done) / total)}% (best so far stays at ${before} moves until this finishes)…`, 'ok');
      });
      if (solution !== cur) {
        showMsg('The cube changed while searching — deeper result discarded.', 'ok');
      } else if (res && !res.error && res.moves && res.moves.length < before) {
        solution = res;
        moveIndex = 0;
        enterPlayback();
        showMsg(`Found a shorter solution: ${res.moves.length} moves (was ${before}). Playback reset to the start.`, 'ok');
      } else {
        showMsg(`No shorter solution found — keeping the ${before}-move one.`, 'ok');
      }
    } catch (_) {
      showMsg(`The deeper search didn’t finish — keeping the ${before}-move solution.`, 'err');
    } finally {
      btnHarder.disabled = false;
    }
  });

  function fixMsg(err) {
    if (err.startsWith('needs exactly')) return 'Color count is off: each color needs exactly 9 stickers. ' + err;
    return err;
  }

  btnEdit.addEventListener('click', async () => { await waitIdle(); exitPlayback(); render(); });

  // ---------- solution UI ----------
  const stagelistEl = document.getElementById('stagelist');
  const progText = document.getElementById('progText');
  const bigdone = document.getElementById('bigdone');
  const pb = {
    start: document.getElementById('pbStart'),
    back: document.getElementById('pbBack'),
    play: document.getElementById('pbPlay'),
    fwd: document.getElementById('pbFwd'),
    end: document.getElementById('pbEnd'),
  };
  document.getElementById('speed').addEventListener('input', (e) => { speedVal = +e.target.value; saveState(); });

  function enterPlayback() {
    solutionEl.style.display = 'block';
    btnEdit.style.display = '';
    btnSolve.style.display = 'none';
    paintCard.style.opacity = 0.45;
    paintCard.style.pointerEvents = 'none';
    pbState = baseState.slice();
    if (mode === 'm') mirrorGeo = true;
    syncView();   // playback always plays on the 3D cube
    render();
    buildSolutionUI();
    updatePlaybackUI();
    // only the 2×2 and mirror fast solvers are truly optimal; the 3×3 and
    // 4×4 fast paths find short (not shortest) solutions
    showMsg(method === 'fast'
      ? `${mode === '2' || mode === 'm' ? 'Shortest possible' : 'Short'} solution found: just ${solution.moves.length} moves! Follow along below.`
      : `Solution found: ${solution.moves.length} moves in ${solution.stages.length} stages. Follow along below!`, 'ok');
    solutionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function exitPlayback() {
    if (!solution) return;
    playing = false;
    // keep whatever the paint was; playback state discarded
    solution = null;
    pbState = null;
    mirrorGeo = false;
    solutionEl.style.display = 'none';
    btnEdit.style.display = 'none';
    document.getElementById('btnHarder').style.display = 'none';
    btnSolve.style.display = '';
    paintCard.style.opacity = '';
    paintCard.style.pointerEvents = '';
    bigdone.style.display = 'none';
    clearMsg();
    syncView();
    render();
  }

  // per-stage "why this works" — the understanding the move lists alone don't
  // give. Keyed by stage name (shared stages appear in several modes).
  const WHY = {
    'White Cross': 'Edges carry two stickers, so a cross piece is only right when its side colour matches the side centre too — not just white-on-bottom. The cross goes first because it costs nothing: with everything else unsolved, each edge can drop straight in with nothing to protect.',
    'White Corners': 'The repeating R′ D′ R D trick lifts a corner out, turns its slot underneath it, and re-inserts it — each repeat rotates the corner one step. It never disturbs the finished cross because everything else it touches is still unsolved.',
    'Middle Layer': 'The middle layer is only four edges — the centres never move on a 3×3. The insert sequence brings an edge down from the top and swaps it into its slot while shuffling top-layer pieces only, so the solved layer below survives untouched.',
    'Yellow Cross': 'F R U R′ U′ F′ flips top edges in place. Started from the right shape (dot → L → line), each pass flips exactly the edges needed to grow the cross — and every move that touches the solved layers is undone before the sequence ends.',
    'Yellow Edges': 'This sequence cycles three top edges and touches nothing below. Lining up one correct edge first turns "several wrong" into a single three-piece cycle, which the sequence finishes in one or two passes.',
    'Yellow Corners': 'U R U′ L′ U R′ U′ L is a commutator: it does a small job, does a second job, then undoes both — and the leftover difference is exactly a three-corner cycle on top, with the rest of the cube returned to how it was.',
    'Final Twist': 'Repeating R′ D′ R D twists the held corner but appears to wreck the layers below. It hasn’t: corner twists on a legal cube must total a multiple of three, so by the time the last corner is turned right, the damage below has exactly cancelled itself out. That’s why you must never rotate the whole cube mid-stage — only the top layer.',
    'Solve the Centers': 'Unlike a 3×3, a 4×4 has no fixed centres — the middle pieces travel. They come first because centre blocks only need each other to assemble, and once built they decide which colour every face will be for the rest of the solve.',
    'Pair the Edges': 'Every 4×4 edge is two separate wing pieces. A slice move brings matching wings side by side, an outer turn stores the finished pair out of the way, and the slice is undone — repeat until all twelve edges are whole and the cube behaves exactly like a 3×3.',
    'Flip Parity': 'A single flipped edge is impossible on a 3×3 — but this "edge" is secretly two pieces that were paired in a mirrored way. The long inner-slice sequence re-splits the pair and re-joins it the right way round.',
    'Swap Parity': 'Two edges swapped with nothing else wrong can’t happen on a 3×3 either. On a 4×4 the identical-looking centre pieces silently absorbed the difference — this sequence trades the visible swap back into the invisible centres.',
    'Bottom Layer': 'With no fixed centres, only the pieces’ relative positions matter. Holding the back-bottom-left piece still removes whole-cube spins from the puzzle — every other piece is then solved relative to that anchor.',
    'Top Color Up': 'R′ D′ R D twists one corner at a time. The bottom looks damaged in between, but a legal cube only allows total twist in multiples of three — when the last corner is set, the bottom snaps back by itself.',
    'Level the Top': 'Same principle as twisting corners on a colour cube: each block is rotated in place until its height fits. Mid-sequence the bottom looks disturbed, but the twists must cancel by the end, so it returns exactly.',
    'Final Positions': 'The closing sequences shuffle only top-layer pieces: every move that dips into the bottom is undone by its mirror later on. What remains is a pure cycle of the last pieces into their slots.',
  };
  function buildSolutionUI() {
    stagelistEl.innerHTML = '';
    solution.stages.forEach((st, si) => {
      const d = document.createElement('div');
      d.className = 'stg';
      d.id = 'stg' + si;
      const chips = [];
      for (let i = st.start; i < st.end; i++) chips.push(`<span class="mv" id="mv${i}">${solution.moves[i]}</span>`);
      const why = st.end > st.start && WHY[st.name]
        ? `<details class="why"><summary>Why this works</summary><p>${WHY[st.name]}</p></details>`
        : '';
      d.innerHTML = `
        <div class="shead">
          <div class="num">${si + 1}</div>
          <div class="sname">${st.name}</div>
          <div class="scount">${st.end === st.start ? '✓ already done' : (st.end - st.start) + ' moves'}</div>
        </div>
        <div class="sdesc">${st.desc}</div>
        ${why}
        <div class="smoves">${chips.join('')}</div>`;
      stagelistEl.appendChild(d);
    });
  }

  function updatePlaybackUI() {
    if (!solution) return;
    const total = solution.moves.length;
    progText.textContent = `Move ${moveIndex} / ${total}`;
    solution.moves.forEach((_, i) => {
      const el = document.getElementById('mv' + i);
      el.className = 'mv' + (i < moveIndex ? ' done' : i === moveIndex ? ' cur' : '');
    });
    solution.stages.forEach((st, si) => {
      const el = document.getElementById('stg' + si);
      const done = moveIndex >= st.end;
      const active = moveIndex >= st.start && moveIndex < st.end;
      el.className = 'stg' + (done ? ' done' : active ? ' active' : '');
    });
    const finished = moveIndex >= total;
    bigdone.style.display = finished ? 'block' : 'none';
    bigdone.textContent = mode === 'm' ? '🎉 Perfect cube again — nice work!' : '🎉 Cube solved — nice work!';
    pb.play.innerHTML = playing ? '❚❚ Pause' : finished ? '↺ Replay' : '▶ Play';
    pb.back.disabled = moveIndex === 0 || playing;
    pb.start.disabled = moveIndex === 0 || playing;
    pb.fwd.disabled = finished || playing;
    pb.end.disabled = finished || playing;
    const st = solution.stages.find((s) => moveIndex >= s.start && moveIndex < s.end);
    if (st) {
      const stgEl = document.getElementById('stg' + solution.stages.indexOf(st));
      if (stagelistEl.scrollHeight > stagelistEl.clientHeight + 4) {
        // desktop: the stage list scrolls inside its own box
        const top = stgEl.offsetTop, bot = top + stgEl.offsetHeight;
        const vTop = stagelistEl.scrollTop, vBot = vTop + stagelistEl.clientHeight;
        if (top < vTop || bot > vBot) stagelistEl.scrollTo({ top: top - 6, behavior: 'smooth' });
      } else {
        // phone: the page scrolls under the pinned cube — keep the active
        // stage in the visible band between the cube and the bottom edge
        const stage = document.querySelector('.stage3d');
        const band0 = (stage ? stage.getBoundingClientRect().bottom : 0) + 60;
        const r = stgEl.getBoundingClientRect();
        if (r.top < band0 || r.top > innerHeight - 120) {
          window.scrollTo({ top: window.scrollY + r.top - band0, behavior: 'smooth' });
        }
      }
    }
  }

  const INV = (mv) => (mv.length === 1 ? mv + "'" : mv[1] === '2' ? mv : mv[0]);

  pb.fwd.addEventListener('click', async () => {
    if (animating || !solution || moveIndex >= solution.moves.length) return;
    animating = true;
    await animateMove(solution.moves[moveIndex], animDuration());
    moveIndex++;
    animating = false;
    updatePlaybackUI();
  });
  pb.back.addEventListener('click', async () => {
    if (animating || !solution || moveIndex === 0) return;
    animating = true;
    await animateMove(INV(solution.moves[moveIndex - 1]), animDuration());
    moveIndex--;
    animating = false;
    updatePlaybackUI();
  });
  pb.start.addEventListener('click', () => {
    if (animating || !solution) return;
    pbState = baseState.slice();
    moveIndex = 0;
    render(); updatePlaybackUI();
  });
  pb.end.addEventListener('click', () => {
    if (animating || !solution) return;
    pbState = ENG().applyAlg(baseState, solution.moves);
    moveIndex = solution.moves.length;
    render(); updatePlaybackUI();
  });
  pb.play.addEventListener('click', async () => {
    if (playing) { playing = false; updatePlaybackUI(); return; }
    if (!solution) return;
    if (moveIndex >= solution.moves.length) {
      pbState = baseState.slice();
      moveIndex = 0;
      render();
    }
    playing = true;
    updatePlaybackUI();
    while (playing && solution && moveIndex < solution.moves.length) {
      animating = true;
      await animateMove(solution.moves[moveIndex], animDuration());
      moveIndex++;
      animating = false;
      updatePlaybackUI();
      await new Promise((r) => setTimeout(r, Math.max(20, 140 - speedVal * 12)));
    }
    playing = false;
    updatePlaybackUI();
  });

  // ---------- theme toggle ----------
  const themeBtn = document.getElementById('themeToggle');
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    const mtc = document.querySelector('meta[name="theme-color"]');
    if (mtc) mtc.content = t === 'light' ? '#f2f4f7' : '#0e1013';
    themeBtn.textContent = t === 'light' ? '🌙' : '☀️';
  };
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  themeBtn.addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(t);
    try { localStorage.setItem('cubeTheme', t); } catch (_) {}
  });

  // ---------- share & copy ----------
  async function copyText(txt) {
    try {
      await navigator.clipboard.writeText(txt);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }
  document.getElementById('btnShare').addEventListener('click', async () => {
    const payload = btoa(JSON.stringify({ m: mode, p: data[mode].paint }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#c=${payload}`;
    const ok = await copyText(url);
    showMsg(ok ? 'Link copied — anyone who opens it gets this exact cube.' : url, 'ok');
  });
  document.getElementById('btnCopyMoves').addEventListener('click', async () => {
    if (!solution) return;
    const ok = await copyText(solution.moves.join(' '));
    showMsg(ok ? `Copied all ${solution.moves.length} moves.` : 'Copy failed — your browser blocked clipboard access.', ok ? 'ok' : 'err');
  });

  // ---------- init ----------
  // sync the static markup with any restored state before the first paint
  // (howto/hint text is already set from the restored mode further up)
  if (savedState || sharedCube) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
    document.querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('on', x.dataset.method === method));
    document.getElementById('speed').value = speedVal;
  }
  buildPalette();
  buildCube();
  buildNet();
  buildPatterns();
  syncView();
  render();
  // resume an in-progress solution at the exact move it was left on.
  // enterPlayback resets pbState to baseState, so advance it afterwards.
  if (!sharedCube && savedState && savedState.playback && savedState.playback.solution
      && Array.isArray(savedState.playback.solution.moves) && Array.isArray(savedState.playback.baseState)) {
    try {
      solution = savedState.playback.solution;
      baseState = savedState.playback.baseState;
      moveIndex = Math.max(0, Math.min(solution.moves.length, savedState.playback.moveIndex | 0));
      enterPlayback();   // draws the playback UI at the restored moveIndex
      if (moveIndex > 0) {
        // enterPlayback reset pbState to the start — advance it and redraw
        pbState = ENG().applyAlg(baseState, solution.moves.slice(0, moveIndex));
        render();
      }
      showMsg(`Welcome back — resumed at move ${moveIndex} of ${solution.moves.length}.`, 'ok');
      updateHarderButton();
    } catch (_) {
      exitPlayback();
      render();
    }
  }
  if (sharedCube) showMsg('Loaded a shared cube — hit “Solve my cube” to see the solution.', 'ok');
  updateStickyOffsets();
  // a share link pasted into a tab that already has the app open is a
  // same-document navigation — no reload, so apply it live
  window.addEventListener('hashchange', () => {
    const s = parseShareHash();
    if (!s) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (scrambling || animating) return;
    exitPlayback();
    mode = s.m;
    data[mode].paint = s.p;
    shareVirgin = true;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
    howtoEl.innerHTML = HOWTO[mode];
    updateMethodNote();
    updateScanButton();
    pbState = null;
    mirrorGeo = false;
    buildPalette();
    buildCube();
    buildNet();
    buildPatterns();
    syncView();
    render();
    updateStickyOffsets();
    showMsg('Loaded a shared cube — hit “Solve my cube” to see the solution.', 'ok');
  });
  booted = true;
  window.addEventListener('resize', () => { buildCube(); render(false); updateStickyOffsets(); });

  // installable + offline (GitHub Pages is https; localhost keeps tests honest)
  if ('serviceWorker' in navigator
    && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // gentle idle wobble
  let idleT = 0;
  function idle() {
    if (!pDown && !animating && !solution) {
      idleT += 0.008;
      cubeEl.style.transform = `rotateX(${rx + Math.sin(idleT) * 1.2}deg) rotateY(${ry + Math.cos(idleT * 0.8) * 1.6}deg)`;
    }
    requestAnimationFrame(idle);
  }
  requestAnimationFrame(idle);

  updateMethodNote();

  // ================= camera scanner =================
  const SCAN = window.SCAN;
  const scanEls = {
    overlay: document.getElementById('scanOverlay'),
    video: document.getElementById('scanVideo'),
    draw: document.getElementById('scanDraw'),
    progress: document.getElementById('scanProgress'),
    status: document.getElementById('scanStatus'),
    title: document.getElementById('scanTitle'),
    hint: document.getElementById('scanHint'),
    torch: document.getElementById('scanTorch'),
    close: document.getElementById('scanClose'),
    manual: document.getElementById('scanManual'),
    usePhoto: document.getElementById('scanUsePhoto'),
    undo: document.getElementById('scanUndo'),
    mirror: document.getElementById('scanMirror'),
    file: document.getElementById('scanFile'),
    photoStage: document.getElementById('photoStage'),
    photoCanvas: document.getElementById('photoCanvas'),
    photoSize: document.getElementById('photoSize'),
    photoAngle: document.getElementById('photoAngle'),
    photoLabel: document.getElementById('photoLabel'),
    photoConfirm: document.getElementById('photoConfirm'),
    photoRetake: document.getElementById('photoRetake'),
    choice: document.getElementById('scanChoice'),
    choiceMsg: document.getElementById('scanChoiceMsg'),
    openFull: document.getElementById('scanOpenFull'),
    retryCam: document.getElementById('scanRetryCam'),
    choicePhoto: document.getElementById('scanChoicePhoto'),
  };
  const btnScan = document.getElementById('btnScan');
  const scan = {
    active: false, scanMode: '3', step: 0, captures: [], signatures: [],
    stream: null, raf: 0, stable: 0, lastSig: '', cooldownUntil: 0,
    sampleCanvas: document.createElement('canvas'),
    detectCanvas: document.createElement('canvas'),
    photo: { img: null, rect: null, drag: null },
    live: false,
    mirror: false, facing: '',      // preview mirrored? (front camera) / camera facing mode
    track: null, frame: 0,          // auto-detected cube square (sample-canvas coords)
    tracker: SCAN.createTracker(),  // temporal smoothing/locking of detections
    debugUI: /[?&]debug\b/.test(location.search),   // on-screen gate readout
    acc: null, startedAt: 0,        // colour accumulator over the stable streak
  };

  function scanFaceLabel(i) { return ['F', 'R', 'B', 'L', 'U', 'D'][i]; }
  function updateScanUI() {
    scanEls.progress.innerHTML = '';
    const n = SCAN.gridN(scan.scanMode);
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'pip' + (i < scan.step ? ' done' : i === scan.step ? ' cur' : '');
      if (i < scan.step && scan.captureLabels && scan.captureLabels[i]) {
        // captured: the pip becomes a mini thumbnail of what was read, so a
        // misread face is visible the moment it happens (and Undo has a target)
        d.classList.add('thumb');
        const g = document.createElement('div');
        g.className = 'pipgrid';
        g.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
        for (const l of scan.captureLabels[i]) {
          const c = document.createElement('div');
          c.style.background = l ? CSSCOLORS[l] : 'rgba(255,255,255,0.25)';
          g.appendChild(c);
        }
        d.appendChild(g);
      } else if (scan.scanMode === '3') {
        // the 3×3 protocol names faces by colour ("Green face") — show the
        // colour, not a notation letter
        d.style.borderColor = CSSCOLORS[scanFaceLabel(i)];
        if (i === scan.step) d.style.background = CSSCOLORS[scanFaceLabel(i)] + '55';
      } else {
        // relative modes have no fixed colours: number the six faces
        d.textContent = i < scan.step ? '✓' : String(i + 1);
      }
      scanEls.progress.appendChild(d);
    }
    const info = SCAN.stepInfo(scan.scanMode, Math.min(scan.step, 5), { mirror: scan.mirror });
    scanEls.title.textContent = `Face ${Math.min(scan.step + 1, 6)} of 6 — ${info.title}`;
    scanEls.hint.textContent = info.hint;
    scanEls.undo.style.display = scan.live && scan.step > 0 ? '' : 'none';
  }
  function setScanStatus(text, kind) {
    if (scanEls.status.textContent !== text) scanEls.status.textContent = text;
    const cls = 'scanStatus' + (kind ? ' ' + kind : '');
    if (scanEls.status.className !== cls) scanEls.status.className = cls;
  }

  async function startScan() {
    scan.scanMode = mode;
    scan.step = 0; scan.captures = []; scan.signatures = []; scan.captureLabels = [];
    scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
    scan.stableSince = 0; scan.movedSinceCapture = false; scan.lastDetAt = 0;
    scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
    scan.mirror = false; scan.facing = '';
    scan.active = true;
    setScanStatus('', '');
    try { scan.audio = scan.audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    scanEls.overlay.classList.add('on');
    scanEls.photoStage.style.display = 'none';
    scanEls.choice.style.display = 'none';
    updateScanUI();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      await startLive(stream);
    } catch (e) {
      // no camera / not permitted / embedded frame / insecure context
      showScanChoice(e);
    }
  }
  async function startLive(stream) {
    scan.stream = stream;
    scanEls.video.srcObject = stream;
    await scanEls.video.play();
    // front cameras (laptops, selfie cams) get a mirrored preview so the cube
    // moves the way the user moves it; a remembered manual choice wins
    const track = stream.getVideoTracks()[0];
    const facing = (track && track.getSettings && track.getSettings().facingMode) || '';
    scan.facing = facing;
    let saved = null;
    try { saved = localStorage.getItem('cubeScanMirror:' + (facing || 'unknown')); } catch (_) {}
    scan.mirror = saved !== null ? saved === '1' : facing !== 'environment';
    scan.live = true;
    scan.startedAt = performance.now();
    scanEls.video.style.display = '';
    scanEls.manual.style.display = '';
    scanEls.mirror.style.display = '';
    // flashlight, where the camera supports it (mostly phone back cameras)
    try {
      const caps = track && track.getCapabilities && track.getCapabilities();
      scanEls.torch.style.display = caps && caps.torch ? '' : 'none';
      scan.torchTrack = caps && caps.torch ? track : null;
    } catch (_) { scanEls.torch.style.display = 'none'; }
    applyMirror();
    scanLoop();
  }
  function showScanChoice(err) {
    scan.live = false;
    scanEls.video.style.display = 'none';
    scanEls.manual.style.display = 'none';
    scanEls.mirror.style.display = 'none';
    let framed = false;
    try { framed = window.self !== window.top; } catch (_) { framed = true; }
    const secure = location.protocol === 'https:' || location.protocol === 'file:' || location.hostname === 'localhost';
    let msg;
    if (!secure) {
      msg = 'Browsers only allow the live camera on secure (https) pages, so this copy can’t stream video. You can still scan face-by-face with photos.';
    } else if (framed) {
      msg = 'This page is embedded inside another app, which blocks the live camera preview. Open it in its own browser tab and the QR-style live scanner will work — point, hold steady, and each face captures itself.';
    } else if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      msg = 'Camera access was blocked. Allow the camera for this site in your browser settings (or reload and tap Allow), then try again — or scan with photos.';
    } else {
      msg = 'No live camera is available here. You can scan face-by-face with photos instead.';
    }
    scanEls.choiceMsg.textContent = msg;
    const showFull = framed && secure;
    scanEls.openFull.style.display = showFull ? '' : 'none';
    scanEls.openFull.href = location.href;
    // whichever action is most likely to get live video going gets the primary style
    scanEls.openFull.classList.toggle('primary', showFull);
    scanEls.retryCam.classList.toggle('primary', !showFull);
    scanEls.choice.style.display = 'flex';
  }
  scanEls.retryCam.addEventListener('click', () => {
    scanEls.choice.style.display = 'none';
    startScan();
  });
  scanEls.choicePhoto.addEventListener('click', () => {
    scanEls.choice.style.display = 'none';
    openPhotoStep();
  });
  scanEls.openFull.addEventListener('click', () => {
    scanEls.choice.style.display = 'none';
    stopScan();
  });
  function stopScan() {
    scan.active = false;
    cancelAnimationFrame(scan.raf);
    if (scan.stream) { for (const t of scan.stream.getTracks()) t.stop(); scan.stream = null; }
    scanEls.video.srcObject = null;
    scan.live = false;
    scan.track = null;
    scan.tracker.reset();
    scan.source = null;
    // a reopened scanner (or the camera-denied card) must not sit on the
    // previous session's frozen grid
    const dctx = scanEls.draw.getContext('2d');
    dctx.clearRect(0, 0, scanEls.draw.width, scanEls.draw.height);
    setScanStatus('', '');
    scanEls.torch.style.display = 'none';
    scanEls.torch.classList.remove('active');
    scanEls.overlay.classList.remove('on');
    scanEls.photoStage.style.display = 'none';
    scanEls.choice.style.display = 'none';
  }

  // ---- frame geometry ----
  // The video is shown object-fit: cover, and mirrored for a front camera so
  // the preview moves the way the user does. Samples are always taken from the
  // unmirrored frame, so facelets keep their true left/right.
  // frame source: the live video, or a canvas injected by the test hooks
  function frameSource() {
    const v = scan.source || scanEls.video;
    return { el: v, w: v.videoWidth || v.width || 0, h: v.videoHeight || v.height || 0 };
  }
  function videoMapping(f) {
    const { w, h } = frameSource();
    const scale = Math.max(innerWidth / w, innerHeight / h);
    return {
      k: scale / f,                                     // sample-canvas px -> screen px
      offX: (w * scale - innerWidth) / 2,
      offY: (h * scale - innerHeight) / 2,
    };
  }
  function sampleToScreen(r, f) {
    const { k, offX, offY } = videoMapping(f);
    let cx = (r.x + r.size / 2) * k - offX;
    const cy = (r.y + r.size / 2) * k - offY, size = r.size * k;
    let angle = r.angle || 0;
    if (scan.mirror) { cx = innerWidth - cx; angle = -angle; }
    return { x: cx - size / 2, y: cy - size / 2, size, angle };
  }
  function screenToSample(g, f) {
    const { k, offX, offY } = videoMapping(f);
    let cx = g.x + g.size / 2, angle = g.angle || 0;
    if (scan.mirror) { cx = innerWidth - cx; angle = -angle; }
    cx = (cx + offX) / k;
    const cy = (g.y + g.size / 2 + offY) / k, size = g.size / k;
    return { x: cx - size / 2, y: cy - size / 2, size, angle };
  }
  // default guide square in *screen* coordinates (used until the cube is found)
  function guideRect() {
    const W = innerWidth, H = innerHeight;
    const side = Math.min(W, H) * 0.68;
    return { x: (W - side) / 2, y: (H - side) / 2 - H * 0.05, size: side, angle: 0 };
  }
  // copy the current video frame into the sample canvas (≤ 720 px wide)
  function grabFrame() {
    const { el, w, h: vh } = frameSource();
    if (!w || !vh) return null;
    const sc = scan.sampleCanvas;
    const targetW = Math.min(w, 720);
    const f = targetW / w;
    const h = Math.round(vh * f);
    if (sc.width !== targetW || sc.height !== h) { sc.width = targetW; sc.height = h; }
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(el, 0, 0, sc.width, sc.height);
    return { px: sctx.getImageData(0, 0, sc.width, sc.height), f };
  }

  // ---- cube tracking ----
  // detectFace runs on a half-size frame; SCAN.createTracker turns the raw
  // per-frame detections into a stable lock (confirm over a few frames,
  // survive brief dropouts, never teleport on one disagreeing frame).
  function updateTrack(fr, n, now) {
    const small = SCAN.downsample2(fr.px);
    const t = scan.track;
    const prefer = t ? { x: t.cx / 2, y: t.cy / 2 } : { x: small.width / 2, y: small.height / 2 };
    const det = SCAN.detectFace(small, n, { prefer });
    scan.track = scan.tracker.update(det && {
      cx: det.cx * 2, cy: det.cy * 2, size: det.size * 2, angle: det.angle,
      count: det.count, total: det.total, single: det.single,
    }, now);
  }
  // the square currently used for sampling, in sample-canvas coords
  function currentRect(f) {
    const t = scan.track;
    if (t) return { x: t.cx - t.size / 2, y: t.cy - t.size / 2, size: t.size, angle: t.angle };
    return screenToSample(guideRect(), f);
  }
  function sampleCurrent() {
    const fr = grabFrame();
    if (!fr) return null;
    const rect = currentRect(fr.f);
    return { res: SCAN.sampleGrid(fr.px, rect, SCAN.gridN(scan.scanMode)), rect, fr };
  }

  const CSSCOLORS = { U: '#ffd500', D: '#f4f4f4', F: '#00a651', B: '#1163d8', R: '#ff7a00', L: '#e0244a' };
  // draws a (possibly rotated) grid square with the live colour dots
  function drawGridSquare(ctx, g, n, labels, color, dashed, progress) {
    const cx = g.x + g.size / 2, cy = g.y + g.size / 2, s = g.size, cs = s / n;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(g.angle || 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    if (dashed) ctx.setLineDash([10, 8]);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.setLineDash([]);
    if (progress > 0) {
      // the hold-still countdown fills the square's own border — always on
      // screen, unlike a ring that outgrows small viewports
      ctx.setLineDash([progress * 4 * s, 4 * s]);
      ctx.strokeStyle = '#3ddc84';
      ctx.lineWidth = 6;
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    for (let i = 1; i < n; i++) {
      ctx.beginPath(); ctx.moveTo(-s / 2 + i * cs, -s / 2); ctx.lineTo(-s / 2 + i * cs, s / 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s / 2, -s / 2 + i * cs); ctx.lineTo(s / 2, -s / 2 + i * cs); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (labels) {
      labels.forEach((l, i) => {
        // screen columns run the other way when the preview is mirrored
        const r = Math.floor(i / n), c0 = i % n, c = scan.mirror ? n - 1 - c0 : c0;
        ctx.beginPath();
        ctx.arc(-s / 2 + (c + 0.66) * cs, -s / 2 + (r + 0.34) * cs, cs * 0.11, 0, 7);
        ctx.fillStyle = l ? CSSCOLORS[l] : 'rgba(120,120,120,0.8)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.stroke();
      });
    }
    ctx.restore();
  }
  function drawPill(ctx, text, x, y) {
    ctx.save();
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    const w = ctx.measureText(text).width + 24;
    const px = Math.max(8, Math.min(ctx.canvas.width - w - 8, x - w / 2));
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(px, y - 13, w, 26, 13);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + w / 2, y);
    ctx.restore();
  }

  function scanLoop() {
    if (!scan.active || !scan.live) return;
    scanFrame();
    scan.raf = requestAnimationFrame(scanLoop);
  }
  // one frame of the live scanner: sample, track, gate, draw, maybe capture
  function scanFrame() {
    const draw = scanEls.draw;
    if (draw.width !== innerWidth || draw.height !== innerHeight) { draw.width = innerWidth; draw.height = innerHeight; }
    const ctx = draw.getContext('2d');
    ctx.clearRect(0, 0, draw.width, draw.height);
    const n = SCAN.gridN(scan.scanMode);
    const now = performance.now();
    const fr = grabFrame();
    if (fr) {
      scan.frame++;
      // time-gate the (8ms-ish) detector so 120Hz displays don't run it at
      // double rate against a 30fps camera; the cheap grid sampling below
      // still runs every frame so the overlay stays perfectly smooth
      if (!scan.track || now - (scan.lastDetAt || 0) >= 60) {
        updateTrack(fr, n, now);
        scan.lastDetAt = now;
      }
      const tracked = !!scan.track;
      const rect = currentRect(fr.f);
      const res = SCAN.sampleGrid(fr.px, rect, n);
      const labels = res.cells.map((c) => SCAN.hueClass(c));
      const allKnown = labels.every((l) => l !== null);
      const calm = res.cellVar.filter((x) => x < 1100).length >= n * n - 1;
      const bordered = res.borderDarkRatio >= 0.3;
      const sig = labels.join('');
      // signatures are compared with one cell of tolerance everywhere: real
      // cameras flicker a borderline sticker between two hues, and one noisy
      // cell must neither restart the countdown nor count as "the cube moved"
      const ham = (a, b) => {
        if (!a || !b || a.length !== b.length) return 99;
        let d = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
        return d;
      };
      // block re-capturing the face we just took until the cube has visibly moved
      // (a clearly different reading, or the lock dropped)
      const lastSig = scan.signatures.length ? scan.signatures[scan.signatures.length - 1] : null;
      if (lastSig !== null && (ham(sig, lastSig) > 1 || !tracked)) scan.movedSinceCapture = true;
      // on a 3×3/4×4 every face is captured exactly once, so a reading that
      // matches ANY earlier capture is a re-show of a face already taken —
      // block it however the cube moved in between. On a 3×3 the centre
      // identifies the face, so a match whose centre differs is NOT a
      // re-show — it is a genuinely different face that happens to share
      // the pattern (one-cell tolerance would otherwise eat the centre).
      // (A 2×2 can repeat a whole pattern, so there only the just-captured
      // face is blocked.)
      const dup = n >= 3
        ? scan.signatures.some((prev) => ham(sig, prev) <= 1 && (n !== 3 || prev[4] === sig[4]))
        : lastSig !== null && ham(sig, lastSig) <= 1 && !scan.movedSinceCapture;
      // the 3×3 protocol dictates which centre each step shows (green, orange,
      // blue, red, yellow, white) — refuse to auto-capture a face whose centre
      // reads as a different colour. Red/orange are lenient with each other
      // (warm light blurs them; the global colour assignment sorts that out).
      const expected = n === 3 ? scanFaceLabel(Math.min(scan.step, 5)) : null;
      const centerRead = n === 3 ? labels[4] : null;
      const centerOK = !expected || centerRead === expected
        || ('RL'.includes(expected) && 'RL'.includes(centerRead));
      // auto-capture only arms while the cube is genuinely locked: a sticker-
      // lattice lock proves the dark gaps by itself, a plain-face lock (solved /
      // single-colour face) still has to show them. The untracked fallback
      // guide square NEVER auto-captures — manual capture covers it.
      const latticeLock = tracked && !scan.track.single;
      const gates = allKnown && calm && !dup && centerOK && tracked && (latticeLock || bordered);
      // scan.lastSig anchors the current stable streak: frames may drift one
      // cell from the anchor without resetting the countdown
      if (gates && scan.stable > 0 && ham(sig, scan.lastSig) <= 1) {
        scan.stable++;
      } else {
        scan.stable = gates ? 1 : 0;
        scan.stableSince = now;
        scan.lastSig = sig;
      }
      scan.diag = { allKnown, calm, bordered, dup, centerOK, latticeLock, sig, stable: scan.stable, cellVar: res.cellVar.map(Math.round), borderDark: +res.borderDarkRatio.toFixed(2) };
      // average the sticker colours over the whole stable streak
      if (scan.stable <= 1 || !scan.acc) {
        scan.acc = { sum: res.cells.map((c) => c.slice()), n: 1 };
      } else {
        res.cells.forEach((c, i) => { const s = scan.acc.sum[i]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; });
        scan.acc.n++;
      }
      const info = SCAN.stepInfo(scan.scanMode, Math.min(scan.step, 5), { mirror: scan.mirror });
      // one visible state machine: post-capture confirmation, capturing,
      // blocked (with the top reason in plain words), or searching. The face
      // still in view right after a capture is EXPECTED, not a duplicate —
      // that moment shows "captured ✓" plus the next rotation instruction,
      // which is exactly when the user decides how to move the cube.
      const justCaptured = scan.captures.length > 0 && !scan.movedSinceCapture;
      const HOLD_MS = 280, MIN_FRAMES = 4;
      const held = scan.stable >= MIN_FRAMES && now - scan.stableSince >= HOLD_MS;
      const progress = scan.stable > 0 ? Math.min(1, Math.min(scan.stable / MIN_FRAMES, (now - scan.stableSince) / HOLD_MS)) : 0;
      let state, statusText, statusKind = '';
      if (justCaptured && scan.step > 0) {
        state = 'captured';
        const done = SCAN.stepInfo(scan.scanMode, scan.step - 1, { mirror: scan.mirror });
        statusText = `✓ ${done.title} captured — now: face ${Math.min(scan.step + 1, 6)}`;
        statusKind = 'ok';
      } else if (!tracked) {
        state = 'searching';
        statusText = now - scan.startedAt > 1500 ? '🔍 Looking for the cube — hold it flat, facing the camera' : '🔍 Looking for the cube…';
      } else if (gates) {
        state = 'capturing';
        statusText = 'Hold still…';
        statusKind = 'ok';
      } else {
        state = 'blocked';
        statusKind = 'warn';
        statusText = dup
          ? 'Already scanned this face — show another (Capture now overrides)'
          : !centerOK && centerRead
            ? `That’s the ${COLOR_NAMES[centerRead]} face — show the ${COLOR_NAMES[expected]} one`
            : !allKnown
              ? 'A sticker reads too dark — add light or tilt out of shadow'
              : !calm
                ? 'Glare or blur on a sticker — tilt the cube slightly'
                : 'Can’t confirm the sticker edges — move a little closer';
      }
      setScanStatus(statusText, statusKind);
      const hint = dup && scan.movedSinceCapture && allKnown && calm
        ? 'If it really is a different face that just looks the same, use Capture now.'
        : info.hint;
      if (scanEls.hint.textContent !== hint) scanEls.hint.textContent = hint;
      // overlay: dim outside the square, grid (searching = dashed white,
      // blocked = amber, ready/capturing = green with the border filling up)
      const g = sampleToScreen(rect, fr.f);
      const s = g.size, gcx = g.x + s / 2, gcy = g.y + s / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, draw.width, draw.height);
      ctx.translate(gcx, gcy);
      ctx.rotate(g.angle);
      ctx.rect(-s / 2, -s / 2, s, s);
      ctx.restore();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill('evenodd');
      const boxColor = !tracked ? 'rgba(255,255,255,0.85)'
        : state === 'blocked' ? '#ffb020'
        : '#3ddc84';
      drawGridSquare(ctx, g, n, labels, boxColor, !tracked, state === 'capturing' ? progress : 0);
      if (scan.debugUI) {
        // ?debug: which auto-capture gate is failing right now
        const b = (x) => (x ? '✓' : '✗');
        drawPill(ctx,
          `trk${b(tracked)} lat${b(latticeLock)} known${b(allKnown)} calm${b(calm)} brd${b(bordered)} ctr${b(centerOK)} dup${dup ? '!' : '·'} ${scan.stable}f/${Math.round(now - scan.stableSince)}ms`,
          gcx, Math.min(draw.height - 118, gcy + s * 0.72 + 34));
      }
      if (held && now >= scan.cooldownUntil) {
        const k = scan.acc.n;
        captureFace(scan.acc.sum.map((c) => [c[0] / k, c[1] / k, c[2] / k]), sig);
      }
    }
  }

  function captureFace(cells, sig) {
    scan.captures.push(cells.map((c) => c.slice()));
    scan.captureLabels.push(cells.map((c) => SCAN.hueClass(c)));
    scan.signatures.push(sig || 'manual' + scan.step);
    scan.step++;
    scan.stable = 0;
    scan.acc = null;
    scan.movedSinceCapture = false;
    // short settle time only — double-captures are already blocked by the
    // duplicate-signature and centre gates, so the cooldown needn't be long
    scan.cooldownUntil = performance.now() + 600;
    const fl = document.getElementById('scanFlash');
    fl.style.transition = 'none'; fl.style.opacity = '0.85';
    requestAnimationFrame(() => { fl.style.transition = 'opacity 0.35s ease-out'; fl.style.opacity = '0'; });
    if (navigator.vibrate) navigator.vibrate(60);
    scanBeep();   // iOS has no vibrate — sound is the non-visual confirmation
    if (scan.step >= 6) { finishScan(); return; }
    updateScanUI();
  }
  // short confirmation blip (the AudioContext is created on the Scan tap,
  // inside a user gesture, so autoplay policies allow it)
  function scanBeep() {
    try {
      const ac = scan.audio;
      if (!ac) return;
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), gn = ac.createGain();
      o.frequency.value = 880;
      gn.gain.setValueAtTime(0.12, ac.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.12);
      o.connect(gn).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.13);
    } catch (_) {}
  }

  // is this paint state a real, solvable cube? (pieces + parity)
  function scanIsValid(scanMode, paint) {
    if (scanMode === '3') {
      if (C.validate(paint).length) return false;
      const c = C.stateToCubies(paint);
      if (!c) return false;
      const par = (p) => { let inv = 0; for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inv++; return inv % 2; };
      return c.co.reduce((a, b) => a + b, 0) % 3 === 0 && c.eo.reduce((a, b) => a + b, 0) % 2 === 0 && par(c.cp) === par(c.ep);
    }
    if (scanMode === '2') {
      if (C.validate2(paint).length) return false;
      return SCAN.cornersConsistent(paint, Object.values(C.CORNERS));
    }
    if (C4.validate4(paint).length) return false;
    return SCAN.cornersConsistent(paint, C4.CORNERS);
  }
  // turn the six captures into a paint state, fixing scan order / orientation slips
  function scanApply(scanMode, letters) {
    const rep = SCAN.repairOrder(scanMode, letters, (p) => scanIsValid(scanMode, p));
    SCAN.applyToPaint(scanMode, rep.letters, data[scanMode].paint);
    return rep;
  }
  function finishScan() {
    const capturesN = SCAN.normalizeAll(scan.captures);
    const letters = SCAN.assignColors(scan.scanMode, capturesN);
    const rep = scanApply(scan.scanMode, letters);
    stopScan();
    pbState = null;
    render();
    if (!rep.found) {
      showMsg('Scanned, but this doesn’t add up to a real cube yet — a few stickers were probably misread. Compare the 3D cube with yours and tap any wrong sticker to fix it, then hit Solve.', 'err');
    } else if (rep.moved || rep.rotated) {
      const what = [];
      if (rep.moved) what.push(`${rep.moved} faces were scanned in a different order`);
      if (rep.rotated) what.push(`${rep.rotated} ${rep.rotated === 1 ? 'face was' : 'faces were'} turned`);
      showMsg(`Scanned! It looks like ${what.join(' and ')} — I’ve rearranged them so everything fits together. Compare the 3D cube with yours, tap any wrong sticker to fix it, then hit Solve.`, 'ok');
    } else {
      showMsg('Scanned! Compare the 3D cube with yours — tap any wrong sticker to fix it, then hit Solve.', 'ok');
    }
    // the overlay vanishes abruptly — make sure the outcome is on screen
    // (on phones the message card can sit fully below the fold)
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- mirrored preview (front cameras) ----
  function applyMirror() {
    scanEls.video.classList.toggle('mirror', scan.mirror);
    scanEls.mirror.classList.toggle('active', scan.mirror);
    scanEls.mirror.title = scan.mirror ? 'Preview is mirrored — tap to show it as the camera sees it' : 'Tap to mirror the preview';
    if (scan.live) updateScanUI();
  }
  scanEls.mirror.addEventListener('click', () => {
    scan.mirror = !scan.mirror;
    try { localStorage.setItem('cubeScanMirror:' + (scan.facing || 'unknown'), scan.mirror ? '1' : '0'); } catch (_) {}
    applyMirror();
  });
  scanEls.torch.addEventListener('click', async () => {
    const on = !scanEls.torch.classList.contains('active');
    try {
      await scan.torchTrack.applyConstraints({ advanced: [{ torch: on }] });
      scanEls.torch.classList.toggle('active', on);
    } catch (_) {}
  });

  // ---- photo fallback ----
  function openPhotoStep() {
    updateScanUI();
    scanEls.file.value = '';
    scanEls.file.click();
  }
  function loadPhoto(img) {
    scan.photo.img = img;
    scanEls.photoStage.style.display = 'block';
    const L = photoLayout();
    const n = SCAN.gridN(scan.scanMode);
    // try to find the face automatically
    let det = null;
    try {
      const dc = scan.detectCanvas;
      const ds = Math.min(1, 360 / img.width);
      dc.width = Math.max(1, Math.round(img.width * ds));
      dc.height = Math.max(1, Math.round(img.height * ds));
      const dctx = dc.getContext('2d', { willReadFrequently: true });
      dctx.drawImage(img, 0, 0, dc.width, dc.height);
      det = SCAN.detectFace(dctx.getImageData(0, 0, dc.width, dc.height), n);
      if (det) {
        const k = L.s / ds;   // detect px -> screen px
        const cx = L.x + det.cx * k, cy = L.y + det.cy * k, size = det.size * k;
        scan.photo.rect = { x: cx - size / 2, y: cy - size / 2, size, angle: det.angle };
      }
    } catch (_) { det = null; }
    if (!det) {
      const side = Math.min(innerWidth, innerHeight) * 0.6;
      scan.photo.rect = { x: (innerWidth - side) / 2, y: (innerHeight - side) / 2 - innerHeight * 0.06, size: side, angle: 0 };
    }
    const minDim = Math.min(innerWidth, innerHeight);
    scanEls.photoSize.value = Math.max(10, Math.min(95, Math.round((scan.photo.rect.size / minDim) * 100)));
    scanEls.photoAngle.value = Math.round((scan.photo.rect.angle * 180) / Math.PI);
    scanEls.photoLabel.textContent = det
      ? 'Found the face — drag or use the sliders if the grid is off, then confirm'
      : 'Drag the grid onto the cube face · sliders resize and rotate it';
    drawPhotoStage();
  }
  scanEls.file.addEventListener('change', () => {
    const f = scanEls.file.files && scanEls.file.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => loadPhoto(img);
    img.src = URL.createObjectURL(f);
  });
  function photoLayout() {
    // fit-contain layout of the photo on the full-screen canvas
    const img = scan.photo.img;
    const W = innerWidth, H = innerHeight;
    const s = Math.min(W / img.width, H / img.height);
    return { s, w: img.width * s, h: img.height * s, x: (W - img.width * s) / 2, y: (H - img.height * s) / 2 };
  }
  function drawPhotoStage() {
    const cv = scanEls.photoCanvas;
    cv.width = innerWidth; cv.height = innerHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const L = photoLayout();
    ctx.drawImage(scan.photo.img, L.x, L.y, L.w, L.h);
    const n = SCAN.gridN(scan.scanMode);
    const px = ctx.getImageData(0, 0, cv.width, cv.height);
    const res = SCAN.sampleGrid(px, scan.photo.rect, n);
    drawGridSquare(ctx, scan.photo.rect, n, res.cells.map((c) => SCAN.hueClass(c)), '#3ddc84', false);
  }
  scanEls.photoCanvas.addEventListener('pointerdown', (e) => {
    scan.photo.drag = { x: e.clientX, y: e.clientY, rx: scan.photo.rect.x, ry: scan.photo.rect.y };
    scanEls.photoCanvas.setPointerCapture(e.pointerId);
  });
  scanEls.photoCanvas.addEventListener('pointermove', (e) => {
    if (!scan.photo.drag) return;
    scan.photo.rect.x = scan.photo.drag.rx + e.clientX - scan.photo.drag.x;
    scan.photo.rect.y = scan.photo.drag.ry + e.clientY - scan.photo.drag.y;
    drawPhotoStage();
  });
  scanEls.photoCanvas.addEventListener('pointerup', () => { scan.photo.drag = null; });
  scanEls.photoSize.addEventListener('input', () => {
    const r = scan.photo.rect;
    const cx = r.x + r.size / 2, cy = r.y + r.size / 2;
    const side = Math.min(innerWidth, innerHeight) * (+scanEls.photoSize.value / 100);
    scan.photo.rect = { x: cx - side / 2, y: cy - side / 2, size: side, angle: r.angle };
    drawPhotoStage();
  });
  scanEls.photoAngle.addEventListener('input', () => {
    scan.photo.rect.angle = (+scanEls.photoAngle.value * Math.PI) / 180;
    drawPhotoStage();
  });
  scanEls.photoConfirm.addEventListener('click', () => {
    if (performance.now() < scan.cooldownUntil) return;   // debounce double-taps
    const cv = scanEls.photoCanvas;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    // sample from the bare photo (no overlay)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const L = photoLayout();
    ctx.drawImage(scan.photo.img, L.x, L.y, L.w, L.h);
    const px = ctx.getImageData(0, 0, cv.width, cv.height);
    const res = SCAN.sampleGrid(px, scan.photo.rect, SCAN.gridN(scan.scanMode));
    scanEls.photoStage.style.display = 'none';
    captureFace(res.cells, null);
    if (scan.step < 6 && scan.active) openPhotoStep();
  });
  scanEls.photoRetake.addEventListener('click', () => {
    scanEls.photoStage.style.display = 'none';
    openPhotoStep();
  });

  scanEls.manual.addEventListener('click', () => {
    // force-capture whatever the grid currently reads. The cooldown doubles
    // as a debounce: a double-tap must not capture the same face twice.
    if (performance.now() < scan.cooldownUntil) return;
    const s = sampleCurrent();
    if (s) captureFace(s.res.cells, null);
  });
  scanEls.undo.addEventListener('click', () => {
    // drop the last captured face (a double-tap or a wrong face) and redo it
    if (!scan.captures.length || scan.step >= 6) return;
    scan.captures.pop();
    scan.captureLabels.pop();
    scan.signatures.pop();
    scan.step--;
    scan.stable = 0;
    scan.acc = null;
    scan.movedSinceCapture = true;
    scan.cooldownUntil = performance.now() + 600;
    updateScanUI();
  });
  scanEls.usePhoto.addEventListener('click', () => {
    if (scan.stream) { for (const t of scan.stream.getTracks()) t.stop(); scan.stream = null; }
    scan.live = false;
    scan.mirror = false;
    cancelAnimationFrame(scan.raf);
    scanEls.video.style.display = 'none';
    scanEls.manual.style.display = 'none';
    scanEls.mirror.style.display = 'none';
    const ctx = scanEls.draw.getContext('2d');
    ctx.clearRect(0, 0, scanEls.draw.width, scanEls.draw.height);
    openPhotoStep();
  });
  scanEls.close.addEventListener('click', stopScan);
  btnScan.addEventListener('click', async () => {
    if (mode === 'm') return;
    await waitIdle();
    exitPlayback();
    clearMsg();
    startScan();
  });
  function updateScanButton() {
    btnScan.style.display = mode === 'm' ? 'none' : '';
  }
  updateScanButton();

  // test hook
  window.__cubeDebug = {
    get mode() { return mode; },
    get method() { return method; },
    get pbState() { return pbState; },
    get paint() { return data[mode].paint; },
    get solution() { return solution; },
    get scanActive() { return scan.active; },
    get scanStep() { return scan.step; },
    get scanTrack() { return scan.track; },
    get scanDiag() { return scan.diag; },
    get scanMirror() { return scan.mirror; },
    get scanCaptures() { return scan.captures; },
    scanSetMirror(v) { scan.mirror = !!v; applyMirror(); },
    // test hook: run the live scanner on any MediaStream (e.g. canvas.captureStream())
    async scanStartWithStream(stream) {
      await waitIdle(); exitPlayback(); clearMsg();
      scan.scanMode = mode;
      scan.step = 0; scan.captures = []; scan.signatures = []; scan.captureLabels = [];
      scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
      scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
      scan.stableSince = 0; scan.movedSinceCapture = false; scan.lastDetAt = 0;
      scan.active = true;
      scanEls.overlay.classList.add('on');
      scanEls.photoStage.style.display = 'none';
      scanEls.choice.style.display = 'none';
      updateScanUI();
      await startLive(stream);
    },
    scanLoadPhoto(img) { loadPhoto(img); },
    // test hook: scan from a canvas, stepping frames by hand (no camera, no rAF)
    scanStartSynthetic(canvas, o) {
      o = o || {};
      scan.scanMode = mode;
      scan.step = 0; scan.captures = []; scan.signatures = []; scan.captureLabels = [];
      scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
      scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
      scan.stableSince = 0; scan.movedSinceCapture = false; scan.lastDetAt = 0;
      scan.active = true; scan.live = true; scan.source = canvas;
      scan.mirror = !!o.mirror; scan.startedAt = performance.now();
      scanEls.overlay.classList.add('on');
      scanEls.photoStage.style.display = 'none';
      scanEls.choice.style.display = 'none';
      scanEls.video.style.display = 'none';
      scanEls.manual.style.display = '';
      scanEls.mirror.style.display = '';
      applyMirror();
      updateScanUI();
    },
    scanTick() {
      if (!scan.active || !scan.live) return false;
      scan.cooldownUntil = 0;
      scan.lastDetAt = 0;
      // synthetic ticks run back-to-back; simulate ~40ms/frame pacing so the
      // hold-still time window behaves as it would on a real camera
      if (scan.stable > 0) scan.stableSince -= 40;
      scanFrame();
      return true;
    },
    scanManualCapture() { scanEls.manual.click(); },
    scanInject(scanMode, captures) {
      // test hook: feed raw per-face capture cell colors straight through the pipeline
      const capturesN = SCAN.normalizeAll(captures);
      const letters = SCAN.assignColors(scanMode, capturesN);
      const rep = scanApply(scanMode, letters);
      pbState = null;
      render();
      return rep.letters;
    },
    scanRepair(scanMode, letters) { return SCAN.repairOrder(scanMode, letters, (p) => scanIsValid(scanMode, p)); },
    scanIsValid,
  };
})();
