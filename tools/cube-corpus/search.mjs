#!/usr/bin/env node
// Stage 1 — SEARCH. Ask Wikimedia Commons and Openverse for cube photos and
// write a candidate index with licence + attribution attached to every entry.
//
//   node tools/cube-corpus/search.mjs                 # committable licences only
//   node tools/cube-corpus/search.mjs --license all   # + CC BY / BY-SA (local only)
//   node tools/cube-corpus/search.mjs --per 40        # results per query per source
//   node tools/cube-corpus/search.mjs --queries logo  # only the 'logo' query group
//
// Nothing is downloaded here — this stage only produces corpus/index.json, so
// you can read what it found (and what it costs licence-wise) before fetching.
//
// LICENCE POLICY. Rectified crops are derivative works. CC0 and public-domain
// crops can be committed to this MIT repository without friction; CC BY and
// CC BY-SA cannot (share-alike would infect the corpus directory). So the
// default keeps only the committable set, and --license all marks the rest
// `commit: false` — fetch.mjs puts those under corpus/local/, which is
// gitignored. Either way `attribution` travels with every record.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, CORPUS } from './paths.mjs';

// Query groups chosen for the ways a real cube differs from the harness's
// procedural face: printed logos, no seams at all, mirrored/uniform faces,
// textured vinyl, and colour schemes outside the canonical six.
const QUERY_GROUPS = {
  logo: [
    "rubik's cube logo",
    'rubiks cube centre cap logo',
    'speed cube brand logo sticker',
    'rubiks cube 3x3 official',
  ],
  stickerless: [
    'stickerless speed cube',
    'gan 356 cube',
    'moyu weilong cube',
    'qiyi speed cube',
  ],
  exotic: [
    'mirror cube puzzle',
    'ghost cube puzzle',
    'carbon fibre rubiks cube',
    'transparent rubiks cube',
  ],
  scheme: [
    'rubiks cube pastel colours',
    'rubiks cube black body',
    'rubiks cube white body',
    'japanese colour scheme cube',
  ],
  scene: [
    'rubiks cube in hand',
    'solving rubiks cube',
    'rubiks cube on desk',
    'rubiks cube scrambled',
  ],
};

// Commons reports licences as free-text short names; map the ones we care
// about onto our own two-tier policy.
const COMMITTABLE = /^(cc0|pd|public domain|cc-pd|no restrictions)/i;
const PERMISSIVE = /^(cc0|pd|public domain|cc-pd|no restrictions|cc[- ]by)/i;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const licenseMode = flag('license', 'committable');
const perQuery = +flag('per', 25);
const groupFilter = flag('queries', null);

const groups = groupFilter
  ? { [groupFilter]: QUERY_GROUPS[groupFilter] || [] }
  : QUERY_GROUPS;
if (groupFilter && !QUERY_GROUPS[groupFilter]) {
  console.error(`unknown query group '${groupFilter}'; have: ${Object.keys(QUERY_GROUPS).join(', ')}`);
  process.exit(2);
}

const UA = 'cube-solver-corpus/1.0 (https://github.com/gjtucker/cube-solver)';

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// ---------- Wikimedia Commons ----------
async function searchCommons(q, limit) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: `filetype:bitmap ${q}`,
    gsrnamespace: '6', gsrlimit: String(limit),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata|mime',
  });
  const j = await getJSON(url);
  const pages = j?.query?.pages ? Object.values(j.query.pages) : [];
  return pages.flatMap((p) => {
    const ii = p.imageinfo?.[0];
    if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) return [];
    const meta = ii.extmetadata || {};
    const strip = (s) => (s ? String(s).replace(/<[^>]*>/g, '').trim() : '');
    const license = strip(meta.LicenseShortName?.value) || 'unknown';
    return [{
      source: 'commons',
      id: `commons:${p.pageid}`,
      title: p.title,
      url: ii.url,
      width: ii.width,
      height: ii.height,
      license,
      licenseUrl: strip(meta.LicenseUrl?.value) || null,
      creator: strip(meta.Artist?.value) || 'unknown',
      pageUrl: ii.descriptionurl,
    }];
  });
}

// ---------- Openverse ----------
async function searchOpenverse(q, limit) {
  const url = 'https://api.openverse.org/v1/images/?' + new URLSearchParams({
    q, page_size: String(Math.min(limit, 50)),
    license: licenseMode === 'committable' ? 'cc0,pdm' : 'cc0,pdm,by,by-sa',
  });
  const j = await getJSON(url);
  return (j.results || []).map((r) => ({
    source: 'openverse',
    id: `openverse:${r.id}`,
    title: r.title || r.id,
    url: r.url,
    width: r.width,
    height: r.height,
    license: (r.license || 'unknown').toUpperCase() === 'PDM' ? 'PD' : `CC ${(r.license || '').toUpperCase()}`,
    licenseUrl: r.license_url || null,
    creator: r.creator || 'unknown',
    pageUrl: r.foreign_landing_url || r.url,
  }));
}

const keep = licenseMode === 'committable' ? COMMITTABLE : PERMISSIVE;

const seen = new Set();
const records = [];
let rejected = 0;
for (const [group, queries] of Object.entries(groups)) {
  for (const q of queries) {
    for (const [name, fn] of [['commons', searchCommons], ['openverse', searchOpenverse]]) {
      let hits = [];
      try {
        hits = await fn(q, perQuery);
      } catch (err) {
        console.error(`  ! ${name} "${q}": ${err.message}`);
        continue;
      }
      let kept = 0;
      for (const h of hits) {
        if (seen.has(h.url)) continue;
        if (!keep.test(h.license)) { rejected++; continue; }
        seen.add(h.url);
        records.push({ ...h, group, query: q, commit: COMMITTABLE.test(h.license) });
        kept++;
      }
      console.log(`  ${name.padEnd(9)} ${group}/"${q}": ${kept} kept of ${hits.length}`);
    }
  }
}

mkdirSync(CORPUS, { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  licenseMode,
  counts: {
    total: records.length,
    committable: records.filter((r) => r.commit).length,
    localOnly: records.filter((r) => !r.commit).length,
    rejectedByLicense: rejected,
  },
  byGroup: Object.fromEntries(Object.keys(groups).map((g) => [g, records.filter((r) => r.group === g).length])),
  records,
};
writeFileSync(join(CORPUS, 'index.json'), JSON.stringify(out, null, 2));
console.log(`\n${records.length} candidates -> ${join(CORPUS, 'index.json').replace(ROOT + '/', '')}`);
console.log(`  committable ${out.counts.committable} · local-only ${out.counts.localOnly} · rejected on licence ${rejected}`);
console.log(`  by group: ${Object.entries(out.byGroup).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log('\nnext: node tools/cube-corpus/fetch.mjs');
