// End-to-end browser check of the worker 'deep' path: serve the repo, load
// the solver scripts in a real page, run worker4.js as an actual Web Worker
// (tables imported the way app.js does it), request a deep reduction, and
// verify the solution solves the cube.
//
// Needs playwright (the only dev-time dependency in this repo, install it
// ad hoc: `npm install playwright --no-save`) and a chromium; set
// CHROMIUM_PATH if yours isn't at the default below.
//   node tests/browser-worker-test.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.gz': 'application/gzip' };
const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/test.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><script src="/cube.js"></script>' +
      '<script src="/cube4.js"></script><script src="/tpr4.js"></script>' +
      '<script src="/tables.js"></script></body></html>');
    return;
  }
  const p = join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  const headers = { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' };
  res.writeHead(200, headers);
  res.end(readFileSync(p));
});
await new Promise((ok) => server.listen(8765, ok));

const { chromium } = await import('playwright');
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH || existsSync('/opt/pw-browsers/chromium')
    ? { executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }
    : {});
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8765/test.html');

const result = await page.evaluate(async () => {
  const C4 = window.Cube4, TPR4 = window.TPR4;
  // fetch shipped tables exactly like app.js does
  const bundle = await window.CubeTables.fetchBundle('http://localhost:8765/tables/tpr4-v' + TPR4.TABLES_VERSION + '.bin.gz');
  // scrambled state
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const s = C4.applyAlg(C4.solvedState(), C4.randomScramble(30, rnd).join(' '));

  const w = new Worker('http://localhost:8765/worker4.js');
  const call = (msg) => new Promise((resolve, reject) => {
    const id = Math.random();
    const on = (e) => { if (e.data.id === id) { w.removeEventListener('message', on); resolve(e.data); } };
    w.addEventListener('message', on);
    setTimeout(() => reject(new Error('worker timeout')), 120000);
    w.postMessage(Object.assign({ id }, msg));
  });
  const tab = {};
  for (const k in bundle.tables) tab[k] = bundle.tables[k];
  await call({ t: 'tables', tables: tab });
  const t0 = Date.now();
  const deep = await call({ t: 'deep', state: s, cfg: { rotate: 0, tries: 2, solutions: 2, results: 2 } });
  const deepMs = Date.now() - t0;
  if (deep.error) return { error: 'deep: ' + deep.error };
  if (!deep.reds || !deep.reds.length) return { error: 'no reductions' };
  const red = deep.reds[0];
  const fin = await call({ t: 'finish', state: s, red });
  if (!fin.res || fin.res.error) return { error: 'finish: ' + (fin.res && fin.res.error) };
  const solved = C4.isSolved(C4.applyAlg(s, fin.res.moves));
  return { redLen: red.length, totalLen: fin.res.moves.length, solved, deepMs };
});
console.log('RESULT', JSON.stringify(result));
await browser.close();
server.close();
process.exit(result.solved ? 0 : 1);
