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
    call(worker, msg) {
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.calls.set(id, { resolve, reject });
        worker.postMessage(Object.assign({ id }, msg));
      });
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
        w.onerror = () => {
          for (const [id, c] of this.calls) { this.calls.delete(id); c.reject(new Error('worker error')); }
        };
        if (tables) this.call(w, { t: 'tables', tables });
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
    // "Search harder": the deep portfolio queued over the pool, then the top
    // distinct reductions each get their own generous 3×3 finish; shortest
    // total wins. ~30-60s. Returns null if workers are unavailable.
    async solveHard(state, onProgress) {
      if (typeof Worker === 'undefined') return null;
      const TPR4 = window.TPR4;
      const tables = await this.loadTables();
      const n = Math.min(TPR4.PORTFOLIO.length, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
      const pool = this.getPool(n, tables);
      const reds = await this.mapPool(pool, TPR4.PORTFOLIO_DEEP,
        (cfg) => ({ t: 'reduce', state, cfg }),
        (done, total) => onProgress && onProgress(done, total + 1));
      const good = reds.map((r) => r && r.red).filter(Boolean).sort((a, b) => a.length - b.length);
      if (!good.length) return null;
      const picks = [];
      for (const r of good) {
        if (!picks.some((p) => p.join(' ') === r.join(' '))) picks.push(r);
        if (picks.length === 3) break;
      }
      const budget3 = { timeLimit: 4000, target: 18, minSearch: 1500 };
      const fins = await this.mapPool(pool, picks, (red) => ({ t: 'finish', state, red, budget3 }));
      if (onProgress) onProgress(TPR4.PORTFOLIO_DEEP.length + 1, TPR4.PORTFOLIO_DEEP.length + 1);
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
        let best = null;
        for (const r of reds) if (r && r.red && (!best || r.red.length < best.length)) best = r.red;
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
  function render() {
    if (mode === 'm') {
      if (mirrorGeo && pbState) renderMirrorGeo(pbState);
      else renderMirrorPaint();
      return;
    }
    const st = (pbState && mode !== 'm') ? pbState : data[mode].paint;
    for (const idx in stickerEls) {
      const el = stickerEls[idx];
      const c = st[idx];
      el.style.background = COLORS[c] || COLORS.X;
      el.classList.toggle('blank', c === 'X');
      el.classList.remove('gold', 'mirrorbody');
      el.innerHTML = '';
    }
  }

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
    pDown = { x: e.clientX, y: e.clientY, rx, ry, moved: false, target: e.target };
    try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!pDown) return;
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
  viewport.addEventListener('pointerup', () => {
    if (pDown && !pDown.moved && !animating && !solution) {
      const t = pDown.target;
      const stickerEl = t.classList && t.classList.contains('sticker') ? t
        : t.classList && t.classList.contains('shaperect') ? t.parentElement : null;
      if (stickerEl && stickerEl.dataset.idx !== undefined) {
        const idx = +stickerEl.dataset.idx;
        if (mode === '3' && idx % 9 === 4) { pDown = null; return; } // centers locked
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
        pbState = ENG().applyMove(pbState, move);
        affected.forEach((el) => { el.style.transition = 'none'; });
        render();
        for (const k in cubies) cubies[k].el.style.transform = cubies[k].el.dataset.base;
        void cubeEl.offsetWidth;
        cubeEl.classList.remove('turning');
        resolve();
      }, dur + 30);
    });
  }

  async function playSequence(moves, durPer) {
    animating = true;
    for (const m of moves) await animateMove(m, durPer);
    animating = false;
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
      if (t.dataset.mode === mode) return;
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
      '4': 'Phased reduction guided by exact lookup tables (≈1.3 MB, generated on your device the first time), then a two-phase finish — around 95 moves. Solving takes a few seconds.',
      '2': 'The mathematically shortest solution — never more than 11 turns. First use takes a moment to warm up.',
      'm': 'The mathematically shortest way back to a perfect cube — never more than 11 turns. First use takes a moment to warm up.',
    },
  };
  function updateMethodNote() { methodNote.textContent = METHOD_NOTES[method][mode]; }
  document.querySelectorAll('.segbtn').forEach((b) => {
    b.addEventListener('click', async () => {
      if (b.dataset.method === method) return;
      await waitIdle();
      exitPlayback();
      method = b.dataset.method;
      document.querySelectorAll('.segbtn').forEach((x) => x.classList.toggle('on', x === b));
      updateMethodNote();
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
    await waitIdle();
    exitPlayback();
    data[mode].paint = mode === 'm' ? C.stateToShapes(C.solvedState()) : ENG().solvedState();
    pbState = null; mirrorGeo = false;
    render(); clearMsg();
  });
  document.getElementById('btnClear').addEventListener('click', async () => {
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

  let scrambling = false;
  document.getElementById('btnScramble').addEventListener('click', async () => {
    if (scrambling) return;
    scrambling = true;
    await waitIdle();
    exitPlayback();
    clearMsg();
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
    scrambling = false;
  });

  btnSolve.addEventListener('click', async () => {
    if (animating) return;
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
    // 4×4 fast solutions can be refined by a much deeper (~1 min) search
    btnHarder.style.display = mode === '4' && method === 'fast' && typeof Worker !== 'undefined' ? '' : 'none';
  });

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
  document.getElementById('speed').addEventListener('input', (e) => { speedVal = +e.target.value; });

  function enterPlayback() {
    solutionEl.style.display = 'block';
    btnEdit.style.display = '';
    btnSolve.style.display = 'none';
    paintCard.style.opacity = 0.45;
    paintCard.style.pointerEvents = 'none';
    pbState = baseState.slice();
    if (mode === 'm') mirrorGeo = true;
    render();
    buildSolutionUI();
    updatePlaybackUI();
    showMsg(method === 'fast'
      ? `${mode === '3' ? 'Short' : 'Shortest possible'} solution found: just ${solution.moves.length} moves! Follow along below.`
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
    render();
  }

  function buildSolutionUI() {
    stagelistEl.innerHTML = '';
    solution.stages.forEach((st, si) => {
      const d = document.createElement('div');
      d.className = 'stg';
      d.id = 'stg' + si;
      const chips = [];
      for (let i = st.start; i < st.end; i++) chips.push(`<span class="mv" id="mv${i}">${solution.moves[i]}</span>`);
      d.innerHTML = `
        <div class="shead">
          <div class="num">${si + 1}</div>
          <div class="sname">${st.name}</div>
          <div class="scount">${st.end === st.start ? '✓ already done' : (st.end - st.start) + ' moves'}</div>
        </div>
        <div class="sdesc">${st.desc}</div>
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

  // ---------- init ----------
  buildPalette();
  buildCube();
  render();
  window.addEventListener('resize', () => { buildCube(); render(); });

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
    title: document.getElementById('scanTitle'),
    hint: document.getElementById('scanHint'),
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
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'pip' + (i < scan.step ? ' done' : i === scan.step ? ' cur' : '');
      d.textContent = i < scan.step ? '✓' : scanFaceLabel(i);
      scanEls.progress.appendChild(d);
    }
    const info = SCAN.stepInfo(scan.scanMode, Math.min(scan.step, 5), { mirror: scan.mirror });
    scanEls.title.textContent = `Face ${Math.min(scan.step + 1, 6)} of 6 — ${info.title}`;
    scanEls.hint.textContent = info.hint;
    scanEls.undo.style.display = scan.live && scan.step > 0 ? '' : 'none';
  }

  async function startScan() {
    scan.scanMode = mode;
    scan.step = 0; scan.captures = []; scan.signatures = [];
    scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
    scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
    scan.mirror = false; scan.facing = '';
    scan.active = true;
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
  function drawGridSquare(ctx, g, n, labels, color, dashed) {
    const cx = g.x + g.size / 2, cy = g.y + g.size / 2, s = g.size, cs = s / n;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(g.angle || 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    if (dashed) ctx.setLineDash([10, 8]);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.setLineDash([]);
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
      if (scan.frame % 2 === 0 || !scan.track) updateTrack(fr, n, now);
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
      // (a clearly different reading, or the lock dropped); identical faces
      // elsewhere on the cube are allowed — a 2×2 can genuinely repeat a pattern
      const lastSig = scan.signatures.length ? scan.signatures[scan.signatures.length - 1] : null;
      if (lastSig !== null && (ham(sig, lastSig) > 1 || !tracked)) scan.movedSinceCapture = true;
      const dup = lastSig !== null && ham(sig, lastSig) <= 1 && !scan.movedSinceCapture;
      // auto-capture only arms while the cube is genuinely locked: a sticker-
      // lattice lock proves the dark gaps by itself, a plain-face lock (solved /
      // single-colour face) still has to show them. The untracked fallback
      // guide square NEVER auto-captures — manual capture covers it.
      const latticeLock = tracked && !scan.track.single;
      const gates = allKnown && calm && !dup && tracked && (latticeLock || bordered);
      // scan.lastSig anchors the current stable streak: frames may drift one
      // cell from the anchor without resetting the countdown
      if (gates && scan.stable > 0 && ham(sig, scan.lastSig) <= 1) {
        scan.stable++;
      } else {
        scan.stable = gates ? 1 : 0;
        scan.lastSig = sig;
      }
      scan.diag = { allKnown, calm, bordered, dup, latticeLock, sig, stable: scan.stable, cellVar: res.cellVar.map(Math.round), borderDark: +res.borderDarkRatio.toFixed(2) };
      // average the sticker colours over the whole stable streak
      if (scan.stable <= 1 || !scan.acc) {
        scan.acc = { sum: res.cells.map((c) => c.slice()), n: 1 };
      } else {
        res.cells.forEach((c, i) => { const s = scan.acc.sum[i]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; });
        scan.acc.n++;
      }
      const info = SCAN.stepInfo(scan.scanMode, Math.min(scan.step, 5), { mirror: scan.mirror });
      const hint = dup && allKnown && calm
        ? 'This looks like a face you already scanned — move on to the next one.'
        : info.hint;
      if (scanEls.hint.textContent !== hint) scanEls.hint.textContent = hint;
      // overlay: dim outside the square, grid, status
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
      drawGridSquare(ctx, g, n, labels, tracked ? '#3ddc84' : 'rgba(255,255,255,0.85)', !tracked);
      const t = scan.track;
      const status = !tracked
        ? (now - scan.startedAt > 1500 ? '🔍 Looking for the cube — hold it flat, facing the camera' : '🔍 Looking for the cube…')
        : t.single ? '✓ Cube found — plain face' : `✓ Cube locked · ${t.count}/${t.total} stickers`;
      drawPill(ctx, status, gcx, Math.min(draw.height - 150, gcy + s * 0.72 + 30));
      // stability arc
      const NEED = 10;
      if (scan.debugUI) {
        // ?debug: which auto-capture gate is failing right now
        const b = (x) => (x ? '✓' : '✗');
        drawPill(ctx,
          `trk${b(tracked)} lat${b(latticeLock)} known${b(allKnown)} calm${b(calm)} brd${b(bordered)} dup${dup ? '!' : '·'} ${scan.stable}/${NEED}`,
          gcx, Math.min(draw.height - 118, gcy + s * 0.72 + 62));
      }
      if (scan.stable > 0 && now >= scan.cooldownUntil) {
        ctx.beginPath();
        ctx.strokeStyle = '#3ddc84';
        ctx.lineWidth = 5;
        ctx.arc(gcx, gcy, s * 0.71 + 14, -Math.PI / 2, -Math.PI / 2 + (Math.min(scan.stable, NEED) / NEED) * Math.PI * 2);
        ctx.stroke();
      }
      if (scan.stable >= NEED && now >= scan.cooldownUntil) {
        const k = scan.acc.n;
        captureFace(scan.acc.sum.map((c) => [c[0] / k, c[1] / k, c[2] / k]), sig);
      }
    }
  }

  function captureFace(cells, sig) {
    scan.captures.push(cells.map((c) => c.slice()));
    scan.signatures.push(sig || 'manual' + scan.step);
    scan.step++;
    scan.stable = 0;
    scan.acc = null;
    scan.movedSinceCapture = false;
    scan.cooldownUntil = performance.now() + 1300;
    const fl = document.getElementById('scanFlash');
    fl.style.transition = 'none'; fl.style.opacity = '0.85';
    requestAnimationFrame(() => { fl.style.transition = 'opacity 0.35s ease-out'; fl.style.opacity = '0'; });
    if (navigator.vibrate) navigator.vibrate(60);
    if (scan.step >= 6) { finishScan(); return; }
    updateScanUI();
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
      scan.step = 0; scan.captures = []; scan.signatures = [];
      scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
      scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
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
      scan.step = 0; scan.captures = []; scan.signatures = [];
      scan.stable = 0; scan.lastSig = ''; scan.cooldownUntil = 0;
      scan.track = null; scan.tracker.reset(); scan.frame = 0; scan.acc = null;
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
    scanTick() { if (!scan.active || !scan.live) return false; scan.cooldownUntil = 0; scanFrame(); return true; },
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
