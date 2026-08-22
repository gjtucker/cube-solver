#!/usr/bin/env node
// Offline generator for the shipped 4x4 solver tables.
//
//   node tools/gen-tables.mjs            # writes tables/tpr4-v<N>.bin.gz
//
// Builds every table the phased reducer needs (the same code the browser
// falls back to), packs them (two 4-bit distances per byte where the table's
// values allow it, raw bytes otherwise) and gzips the bundle. The app fetches
// the bundle at load; on-device generation remains the fallback.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const TPR4 = require(join(root, 'tpr4.js'));
const TAB = require(join(root, 'tables.js'));

console.error('building tables (same code as the on-device fallback)…');
const t0 = Date.now();
const tables = TPR4.exportTables();
console.error(`built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const entries = [];
let raw = 0;
for (const [name, data] of Object.entries(tables)) {
  let max = 0;
  for (const v of data) if (v > max) max = v;
  // 255 marks unreachable states in some tables — capping those to 15 would
  // make them look near, so such tables ship as raw bytes
  const pack = max <= 15 ? 'nib' : 'raw';
  entries.push({ name, data, pack });
  raw += data.length;
  console.error(`  ${name.padEnd(12)} ${String(data.length).padStart(9)} B  max ${max}  ${pack}`);
}

const version = TPR4.TABLES_VERSION;
mkdirSync(join(root, 'tables'), { recursive: true });
const out = join(root, 'tables', `tpr4-v${version}.bin.gz`);
TAB.writeBundle(out, version, entries);
const gz = statSync(out).size;
console.error(`${out}: ${entries.length} tables, ${(raw / 1e6).toFixed(2)} MB raw -> ${(gz / 1e6).toFixed(2)} MB gzipped`);
