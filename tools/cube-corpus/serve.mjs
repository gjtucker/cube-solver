#!/usr/bin/env node
// Stage 3 host — a tiny static server for the annotator, with two API routes
// so the browser can persist labels and crops straight to disk instead of
// dribbling files through the download folder.
//
//   node tools/cube-corpus/serve.mjs [--port 8777]
//
// Serves the repo root (the annotator needs corpus/raw/*.jpg), plus:
//   GET  /api/queue        -> images still to annotate, and those already done
//   POST /api/face         -> { id, png, ...labels }; writes the crop + record
//   POST /api/skip         -> { id, reason }; records a deliberate rejection
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { ROOT, CORPUS, FACES, FACES_JSON } from './paths.mjs';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? +args[portArg + 1] : 8777;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

const loadFaces = () => (existsSync(FACES_JSON)
  ? JSON.parse(readFileSync(FACES_JSON, 'utf8'))
  : { generatedAt: null, records: [] });

const readBody = (req) => new Promise((res, rej) => {
  const parts = [];
  let n = 0;
  req.on('data', (c) => {
    n += c.length;
    if (n > 32 * 1024 * 1024) { rej(new Error('body too large')); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', () => res(Buffer.concat(parts).toString('utf8')));
  req.on('error', rej);
});

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
};

async function saveFaces(faces) {
  faces.generatedAt = new Date().toISOString();
  await mkdir(CORPUS, { recursive: true });
  await writeFile(FACES_JSON, JSON.stringify(faces, null, 2));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/queue') {
    const fetchedPath = join(CORPUS, 'fetched.json');
    if (!existsSync(fetchedPath)) return json(res, 404, { error: 'no corpus/fetched.json — run fetch.mjs' });
    const fetched = JSON.parse(readFileSync(fetchedPath, 'utf8'));
    const faces = loadFaces();
    const done = new Map(faces.records.map((r) => [r.id, r]));
    return json(res, 200, {
      images: fetched.records.map((r) => ({
        id: r.id, file: r.file, title: r.title, group: r.group,
        license: r.license, creator: r.creator, pageUrl: r.pageUrl, commit: r.commit,
        state: done.get(r.id)?.state || 'todo',
        label: done.get(r.id) || null,
      })),
    });
  }

  if (req.method === 'POST' && (url.pathname === '/api/face' || url.pathname === '/api/skip')) {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: e.message }); }
    if (!body.id) return json(res, 400, { error: 'missing id' });
    const faces = loadFaces();
    const slug = body.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    let record;
    if (url.pathname === '/api/skip') {
      record = { id: body.id, state: 'skipped', reason: body.reason || 'unusable', annotatedAt: new Date().toISOString() };
    } else {
      const m = /^data:image\/png;base64,(.+)$/.exec(body.png || '');
      if (!m) return json(res, 400, { error: 'missing or malformed png data URL' });
      await mkdir(FACES, { recursive: true });
      await writeFile(join(FACES, slug + '.png'), Buffer.from(m[1], 'base64'));
      record = {
        id: body.id, state: 'labelled',
        face: `corpus/faces/${slug}.png`,
        source: body.source, license: body.license, creator: body.creator, pageUrl: body.pageUrl,
        commit: body.commit !== false,
        n: body.n, style: body.style, tags: body.tags || [],
        corners: body.corners, colors: body.colors, notes: body.notes || '',
        annotatedAt: new Date().toISOString(),
      };
    }
    const i = faces.records.findIndex((r) => r.id === body.id);
    if (i >= 0) faces.records[i] = record; else faces.records.push(record);
    await saveFaces(faces);
    const labelled = faces.records.filter((r) => r.state === 'labelled').length;
    return json(res, 200, { ok: true, labelled, total: faces.records.length });
  }

  // static
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/tools/cube-corpus/annotate.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`cube-corpus annotator: http://localhost:${PORT}/`);
  console.log('  labels -> corpus/faces.json   crops -> corpus/faces/');
});
