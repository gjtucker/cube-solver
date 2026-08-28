// Stage 3 — ANNOTATE. Auto-propose a face quad, let a human correct it, and
// export a rectified crop plus its ground-truth labels.
//
// The browser is doing real work here, not just showing a form: it is the only
// runtime in this pipeline that can decode an arbitrary JPEG/WebP off the
// internet, so it also does the rectification and hands Node a plain PNG.
import { proposeQuad, homography, applyH, classifyStickerColor } from './propose.mjs';

// class index from propose.mjs -> the harness's face letters
// (0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 white)
const CLASS_TO_LETTER = ['L', 'R', 'U', 'F', 'B', 'D'];
const LETTERS = ['U', 'D', 'F', 'B', 'R', 'L', '?'];
const LETTER_RGB = {
  U: '#ffd500', D: '#f4f4f4', F: '#00a651', B: '#1163d8',
  R: '#ff7a00', L: '#e0244a', '?': '#6a6f80',
};

const $ = (s) => document.querySelector(s);
const stage = $('#stage'), sctx = stage.getContext('2d', { willReadFrequently: true });
const preview = $('#preview'), pctx = preview.getContext('2d', { willReadFrequently: true });

let queue = [], at = 0;
let img = null, srcData = null, view = { scale: 1 };
let corners = null, dragging = -1;
let n = 3, style = 'stickered', colors = [], proposal = null;

const rectSize = () => 48 * n;   // 96 / 144 / 192 px crops

// ---------- load ----------
async function boot() {
  const res = await fetch('/api/queue');
  if (!res.ok) { setStatus((await res.json()).error || 'queue failed', true); return; }
  queue = (await res.json()).images;
  if (!queue.length) { setStatus('nothing fetched yet — run fetch.mjs', true); return; }
  const firstTodo = queue.findIndex((q) => q.state === 'todo');
  at = firstTodo >= 0 ? firstTodo : 0;
  await load();
}

async function load() {
  const item = queue[at];
  updateProgress();
  // metadata here is third-party text straight off an image API, so it is
  // escaped, and the source link is restricted to http(s) rather than trusted
  const href = /^https?:\/\//i.test(item.pageUrl || '') ? item.pageUrl : '';
  $('#meta').innerHTML = `<b>${esc(item.title)}</b> — ${esc(item.creator)} — ${esc(item.license)}`
    + (href ? ` — <a href="${esc(href)}" target="_blank" rel="noreferrer">source</a>` : '')
    + `<br>${esc(item.file)}${item.commit ? '' : ' · local-only (not committed)'}`;

  img = await loadImage('/' + item.file);
  // draw at natural size into an offscreen buffer, so proposals and corner
  // coordinates live in original-image pixels regardless of display scale
  const off = document.createElement('canvas');
  off.width = img.naturalWidth; off.height = img.naturalHeight;
  off.getContext('2d').drawImage(img, 0, 0);
  srcData = off.getContext('2d').getImageData(0, 0, off.width, off.height);

  const maxW = Math.min(820, window.innerWidth - 380);
  view.scale = Math.min(1, maxW / img.naturalWidth, 620 / img.naturalHeight);
  stage.width = Math.round(img.naturalWidth * view.scale);
  stage.height = Math.round(img.naturalHeight * view.scale);

  // restore a previous label, or propose fresh
  const prev = item.label;
  if (prev && prev.state === 'labelled') {
    corners = prev.corners.map((c) => c.slice());
    n = prev.n; style = prev.style; colors = prev.colors.slice();
    setSeg('#nSeg', 'n', String(n)); setSeg('#styleSeg', 'style', style);
    for (const cb of document.querySelectorAll('#tags input')) cb.checked = (prev.tags || []).includes(cb.value);
    $('#notes').value = prev.notes || '';
    proposal = null;
    $('#confidence').textContent = 'previously labelled — edit and save to update';
  } else {
    for (const cb of document.querySelectorAll('#tags input')) cb.checked = false;
    $('#notes').value = '';
    repropose();
  }
  redraw();
  setStatus('');
}

function repropose() {
  proposal = proposeQuad(srcData);
  if (proposal) {
    corners = proposal.corners.map((c) => c.slice());
    const pct = Math.round(proposal.confidence * 100);
    $('#confidence').textContent = `proposed from ${proposal.patches} patches · confidence ${pct}%`
      + (pct < 60 ? ' — check this one carefully' : '');
    // patch count is a decent guess at n
    const guess = proposal.patches >= 12 ? 4 : proposal.patches >= 6 ? 3 : 2;
    n = guess; setSeg('#nSeg', 'n', String(n));
  } else {
    // nothing found — drop a centred default for the human to drag
    const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h) * 0.45;
    corners = [[w / 2 - s / 2, h / 2 - s / 2], [w / 2 + s / 2, h / 2 - s / 2],
               [w / 2 + s / 2, h / 2 + s / 2], [w / 2 - s / 2, h / 2 + s / 2]];
    $('#confidence').textContent = 'no proposal — drag the handles onto the face';
  }
  colors = [];
  redraw();
}

// ---------- rectify ----------
// Walk destination pixels and pull from the source through the homography
// (dst -> src), which is what keeps the output free of resampling holes.
function rectify() {
  const S = rectSize();
  const dst = [[0, 0], [S, 0], [S, S], [0, S]];
  const H = homography(dst, corners);
  if (!H) return null;
  const out = pctx.createImageData(S, S);
  const { data: sd, width: sw, height: sh } = srcData;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [fx, fy] = applyH(H, x + 0.5, y + 0.5);
      const o = (y * S + x) * 4;
      if (fx < 0 || fy < 0 || fx >= sw - 1 || fy >= sh - 1) { out.data[o + 3] = 255; continue; }
      // bilinear
      const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const p00 = sd[(y0 * sw + x0) * 4 + c], p10 = sd[(y0 * sw + x0 + 1) * 4 + c];
        const p01 = sd[((y0 + 1) * sw + x0) * 4 + c], p11 = sd[((y0 + 1) * sw + x0 + 1) * 4 + c];
        out.data[o + c] = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

// median of the central half of each cell — median, not mean, so one specular
// blob or a printed logo stroke does not drag the whole tile off its colour
function sampleColors(rect) {
  const S = rect.width, cell = S / n, out = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x0 = Math.round(c * cell + cell * 0.25), x1 = Math.round(c * cell + cell * 0.75);
      const y0 = Math.round(r * cell + cell * 0.25), y1 = Math.round(r * cell + cell * 0.75);
      const R = [], G = [], B = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * S + x) * 4;
        R.push(rect.data[o]); G.push(rect.data[o + 1]); B.push(rect.data[o + 2]);
      }
      const mid = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] || 0; };
      const k = classifyStickerColor(mid(R), mid(G), mid(B));
      out.push(k < 0 ? '?' : CLASS_TO_LETTER[k]);
    }
  }
  return out;
}

// ---------- draw ----------
function redraw() {
  if (!img) return;
  sctx.clearRect(0, 0, stage.width, stage.height);
  sctx.drawImage(img, 0, 0, stage.width, stage.height);
  const s = view.scale;
  sctx.lineWidth = 2; sctx.strokeStyle = '#5b8cff';
  sctx.beginPath();
  corners.forEach(([x, y], i) => (i ? sctx.lineTo(x * s, y * s) : sctx.moveTo(x * s, y * s)));
  sctx.closePath(); sctx.stroke();
  // lattice guides, so a wrong n is visible on the photo itself
  sctx.strokeStyle = 'rgba(91,140,255,.35)'; sctx.lineWidth = 1;
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], corners);
  if (H) {
    for (let i = 1; i < n; i++) {
      const t = i / n;
      for (const [a, b] of [[[t, 0], [t, 1]], [[0, t], [1, t]]]) {
        const p = applyH(H, a[0], a[1]), q = applyH(H, b[0], b[1]);
        sctx.beginPath(); sctx.moveTo(p[0] * s, p[1] * s); sctx.lineTo(q[0] * s, q[1] * s); sctx.stroke();
      }
    }
  }
  corners.forEach(([x, y], i) => {
    sctx.beginPath(); sctx.arc(x * s, y * s, 7, 0, 7);
    sctx.fillStyle = i === dragging ? '#fff' : '#5b8cff'; sctx.fill();
    sctx.strokeStyle = '#000'; sctx.lineWidth = 1.5; sctx.stroke();
  });

  const rect = rectify();
  if (!rect) return;
  const S = rect.width;
  preview.width = S; preview.height = S;
  pctx.putImageData(rect, 0, 0);
  if (colors.length !== n * n) colors = sampleColors(rect);
  // colour chips in each cell corner: the photo stays readable underneath
  const cell = S / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const L = colors[r * n + c];
    pctx.fillStyle = LETTER_RGB[L];
    pctx.fillRect(c * cell + 2, r * cell + 2, cell * 0.3, cell * 0.3);
    pctx.strokeStyle = '#000'; pctx.lineWidth = 1;
    pctx.strokeRect(c * cell + 2, r * cell + 2, cell * 0.3, cell * 0.3);
  }
}

// ---------- interaction ----------
const evtPos = (e) => {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left) * (stage.width / r.width) / view.scale,
          (e.clientY - r.top) * (stage.height / r.height) / view.scale];
};
stage.addEventListener('pointerdown', (e) => {
  const [x, y] = evtPos(e);
  let best = -1, bd = 22 / view.scale;
  corners.forEach(([cx, cy], i) => { const d = Math.hypot(cx - x, cy - y); if (d < bd) { bd = d; best = i; } });
  if (best >= 0) { dragging = best; stage.setPointerCapture(e.pointerId); redraw(); }
});
stage.addEventListener('pointermove', (e) => {
  if (dragging < 0) return;
  corners[dragging] = evtPos(e);
  colors = [];                        // geometry moved; re-sample colours
  redraw();
});
stage.addEventListener('pointerup', () => { dragging = -1; redraw(); });

preview.addEventListener('click', (e) => {
  const r = preview.getBoundingClientRect();
  const c = Math.floor((e.clientX - r.left) / (r.width / n));
  const row = Math.floor((e.clientY - r.top) / (r.height / n));
  const i = row * n + c;
  if (i < 0 || i >= colors.length) return;
  colors[i] = LETTERS[(LETTERS.indexOf(colors[i]) + 1) % LETTERS.length];
  redraw();
});

function setSeg(sel, attr, val) {
  for (const b of document.querySelectorAll(`${sel} button`)) b.classList.toggle('on', b.dataset[attr] === val);
}
$('#nSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.n) return;
  n = +e.target.dataset.n; colors = []; setSeg('#nSeg', 'n', String(n)); redraw();
});
$('#styleSeg').addEventListener('click', (e) => {
  if (!e.target.dataset.style) return;
  style = e.target.dataset.style; setSeg('#styleSeg', 'style', style);
});
$('#repropose').addEventListener('click', repropose);
$('#prev').addEventListener('click', () => step(-1));
$('#skip').addEventListener('click', skip);
$('#save').addEventListener('click', save);

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'Enter') save();
  else if (e.key.toLowerCase() === 'x') skip();
  else if (e.key.toLowerCase() === 'r') repropose();
  else if ('234'.includes(e.key)) { n = +e.key; colors = []; setSeg('#nSeg', 'n', e.key); redraw(); }
  else return;
  e.preventDefault();
});

// ---------- persist ----------
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function save() {
  const item = queue[at];
  try {
    const rect = rectify();
    if (!rect) throw new Error('degenerate quad — corners are collinear');
    const off = document.createElement('canvas');
    off.width = rect.width; off.height = rect.height;
    off.getContext('2d').putImageData(rect, 0, 0);
    const tags = [...document.querySelectorAll('#tags input:checked')].map((c) => c.value);
    await post('/api/face', {
      id: item.id, png: off.toDataURL('image/png'),
      source: item.file, license: item.license, creator: item.creator,
      pageUrl: item.pageUrl, commit: item.commit,
      n, style, tags, corners, colors, notes: $('#notes').value.trim(),
    });
    item.state = 'labelled';
    item.label = { state: 'labelled', n, style, tags, corners, colors, notes: $('#notes').value.trim() };
    setStatus('saved');
    step(1);
  } catch (err) { setStatus(err.message, true); }
}

async function skip() {
  const item = queue[at];
  try {
    await post('/api/skip', { id: item.id, reason: $('#notes').value.trim() || 'unusable' });
    item.state = 'skipped';
    setStatus('skipped');
    step(1);
  } catch (err) { setStatus(err.message, true); }
}

function step(d) {
  at = (at + d + queue.length) % queue.length;
  load();
}
function updateProgress() {
  const done = queue.filter((q) => q.state === 'labelled').length;
  const skipped = queue.filter((q) => q.state === 'skipped').length;
  $('#progress').textContent = `${at + 1}/${queue.length} · ${done} labelled · ${skipped} skipped`;
}
function setStatus(msg, err) {
  $('#status').textContent = msg || '';
  $('#status').classList.toggle('err', !!err);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const loadImage = (src) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i); i.onerror = () => rej(new Error('cannot load ' + src));
  i.src = src;
});

boot();
