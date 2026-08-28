#!/usr/bin/env node
// Stage 2 — FETCH. Download the candidates in corpus/index.json, dedupe by
// content hash, and split them by licence: committable originals into
// corpus/raw/, everything else into corpus/local/ (gitignored).
//
//   node tools/cube-corpus/fetch.mjs               # fetch everything indexed
//   node tools/cube-corpus/fetch.mjs --limit 60    # cap the download
//   node tools/cube-corpus/fetch.mjs --group logo  # one query group only
//   node tools/cube-corpus/fetch.mjs --max-mb 8    # skip huge originals
//
// Re-running is cheap: an already-downloaded file is skipped, so this resumes
// after an interrupted run instead of starting over.
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { ROOT, CORPUS, RAW, LOCAL, INDEX_JSON } from './paths.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const limit = +flag('limit', Infinity);
const group = flag('group', null);
const maxBytes = +flag('max-mb', 12) * 1024 * 1024;

if (!existsSync(INDEX_JSON)) {
  console.error('no corpus/index.json — run tools/cube-corpus/search.mjs first');
  process.exit(2);
}
const index = JSON.parse(readFileSync(INDEX_JSON, 'utf8'));
let records = index.records;
if (group) records = records.filter((r) => r.group === group);
records = records.slice(0, limit);

mkdirSync(RAW, { recursive: true });
mkdirSync(LOCAL, { recursive: true });

const UA = 'cube-solver-corpus/1.0 (https://github.com/gjtucker/cube-solver)';
const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const seenHash = new Map();
const fetched = [];
let skipped = 0, failed = 0, dupes = 0, oversize = 0;

for (const [i, rec] of records.entries()) {
  const dir = rec.commit ? RAW : LOCAL;
  let ext = extname(new URL(rec.url).pathname).toLowerCase();
  if (!EXT_OK.has(ext)) ext = '.jpg';
  const slug = rec.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = join(dir, slug + ext);
  const rel = file.replace(ROOT + '/', '');

  if (existsSync(file)) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    seenHash.set(hash, rel);
    fetched.push({ ...rec, file: rel, bytes: statSync(file).size, hash });
    skipped++;
    continue;
  }

  process.stdout.write(`[${i + 1}/${records.length}] ${rec.id} ... `);
  try {
    const res = await fetch(rec.url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const declared = +(res.headers.get('content-length') || 0);
    if (declared > maxBytes) { console.log(`skip (${(declared / 1e6).toFixed(1)} MB > cap)`); oversize++; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) { console.log(`skip (${(buf.length / 1e6).toFixed(1)} MB > cap)`); oversize++; continue; }

    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    if (seenHash.has(hash)) { console.log(`dupe of ${seenHash.get(hash)}`); dupes++; continue; }
    seenHash.set(hash, rel);

    writeFileSync(file, buf);
    fetched.push({ ...rec, file: rel, bytes: buf.length, hash });
    console.log(`${(buf.length / 1024).toFixed(0)} KB -> ${rel}`);
  } catch (err) {
    console.log(`FAIL ${err.message}`);
    failed++;
  }
}

writeFileSync(join(CORPUS, 'fetched.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  counts: { fetched: fetched.length, alreadyPresent: skipped, dupes, oversize, failed },
  records: fetched,
}, null, 2));

// Attribution travels with the corpus, not in a commit message: every crop in
// corpus/faces/ is a derivative of one of these originals.
const lines = ['# Corpus attribution', '',
  'Every image in `corpus/` is a third-party photograph reused under the licence',
  'named below. Rectified crops in `corpus/faces/` are derivative works of these.',
  'Originals under `corpus/local/` are not committed to the repository.', ''];
for (const r of fetched.slice().sort((a, b) => a.id.localeCompare(b.id))) {
  lines.push(`- **${r.title}** — ${r.creator} — ${r.license}${r.licenseUrl ? ` ([licence](${r.licenseUrl}))` : ''} — [source](${r.pageUrl}) — \`${r.file}\``);
}
writeFileSync(join(CORPUS, 'ATTRIBUTION.md'), lines.join('\n') + '\n');

console.log(`\n${fetched.length} images available (${skipped} already present, ${dupes} dupes, ${oversize} oversize, ${failed} failed)`);
console.log('wrote corpus/fetched.json and corpus/ATTRIBUTION.md');
console.log('\nnext: node tools/cube-corpus/serve.mjs   then open the annotator it prints');
