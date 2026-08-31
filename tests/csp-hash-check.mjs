#!/usr/bin/env node
// Guards the Content-Security-Policy in index.html.
//
// script-src pins each inline <script> by sha256. Editing one of those scripts
// changes its hash, and the browser then silently refuses to run it — the
// theme resolver just stops working, with nothing in the page to say why. This
// recomputes the hashes from the current markup and checks them against the
// policy, so that failure shows up here instead of in production.
//
// It also asserts the directives that carry the actual security value, so a
// future edit cannot quietly loosen the policy without the test noticing.
//
//   node tests/csp-hash-check.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const fail = [];

const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
if (!meta) {
  console.error('FAIL: no Content-Security-Policy meta tag in index.html');
  process.exit(1);
}
const csp = meta[1];

// --- 1. every inline script must be pinned by its current hash ---
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!inline.length) fail.push('no inline scripts found — did the markup change shape?');
for (const [i, body] of inline.entries()) {
  const h = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
  if (!csp.includes(h)) {
    fail.push(`inline script #${i + 1} is not pinned in script-src.\n`
      + `      expected ${h}\n`
      + `      fix: put that hash in the script-src directive in index.html`);
  }
}
// and no stale hashes left behind
const pinned = [...csp.matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)].map((m) => m[0]);
const live = inline.map((b) => `'sha256-${createHash('sha256').update(b, 'utf8').digest('base64')}'`);
for (const p of pinned) if (!live.includes(p)) fail.push(`stale hash in script-src, no inline script matches it: ${p}`);

// --- 2. the directives that do the work must not regress ---
const required = {
  "default-src 'self'": 'the fallback must stay same-origin',
  "base-uri 'none'": 'stops <base> injection redirecting every relative URL',
  "object-src 'none'": 'no plugin content',
  "connect-src 'self'": 'nowhere for injected script to exfiltrate to',
  "font-src 'self'": 'the font is vendored; nothing off-origin',
  "style-src 'self'": 'no inline styles; the markup must stay style-attribute free',
  "worker-src 'self'": 'the 4x4 solver workers are same-origin',
};
for (const [d, why] of Object.entries(required)) {
  if (!csp.includes(d)) fail.push(`missing directive: ${d}  (${why})`);
}
// neither script-src nor style-src may gain an inline/eval escape
for (const dir of ['script-src', 'style-src']) {
  const value = (csp.match(new RegExp(dir + ' ([^;]*)')) || [, ''])[1];
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", '*']) {
    if (value.split(/\s+/).includes(bad)) fail.push(`${dir} must not contain ${bad} — found: ${value.trim()}`);
  }
}

// style-src 'self' only holds if NOTHING produces a style="" attribute — not
// the markup, and not an HTML string that script assembles and injects. The
// second kind is the sneaky one: it renders fine until the policy is tightened,
// and then the styling just silently vanishes. (That is exactly how the colour
// chips in app.js's how-to copy were caught.) So scan the shipped JS too.
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
for (const m of htmlNoComments.matchAll(/<[^>]*\sstyle\s*=\s*["'][^"']*["'][^>]*>/g)) {
  fail.push(`index.html: inline style attribute — blocked by style-src 'self': ${m[0].trim().slice(0, 80)}`);
}
for (const f of ['app.js', 'scan.js', 'cube.js', 'cube4.js', 'tpr4.js', 'sw.js']) {
  const src = readFileSync(join(root, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;               // comments may discuss it
    // a style attribute inside an HTML string literal, e.g. `<span style="...">`
    if (/<[a-z][^>]*\sstyle\s*=\s*\\?["'][^"'>]*\\?["']/i.test(line)) {
      fail.push(`${f}:${i + 1}: builds HTML with a style="" attribute — it will be blocked. `
        + `Use a class instead: ${line.trim().slice(0, 70)}`);
    }
  });
}

// --- 3. nothing off-origin should have crept back into the shipped files ---
for (const f of ['index.html', 'style.css', 'app.js', 'sw.js', 'scan.js']) {
  const src = readFileSync(join(root, f), 'utf8');
  for (const line of src.split('\n')) {
    // Only things the browser actually FETCHES count. A canonical link, an
    // og:url, or a URL in a comment is metadata, not a subresource.
    const isFetched =
      /<(?:script|img|iframe|video|audio|source|embed)\b[^>]*\bsrc\s*=\s*["']https?:/i.test(line)
      || /<link\b[^>]*\brel\s*=\s*["'](?:stylesheet|preload|preconnect|dns-prefetch|prefetch|modulepreload)["'][^>]*\bhref\s*=\s*["']https?:/i.test(line)
      || /<link\b[^>]*\bhref\s*=\s*["']https?:[^>]*\brel\s*=\s*["'](?:stylesheet|preload|preconnect|dns-prefetch|prefetch|modulepreload)["']/i.test(line)
      || /\bfetch\(\s*["'`]https?:/i.test(line)
      || /\bimportScripts\(\s*["'`]https?:/i.test(line)
      || /@import\s+(?:url\()?["']?https?:/i.test(line);
    if (!isFetched) continue;
    const host = (line.match(/https?:\/\/([a-z0-9.-]+)/i) || [])[1] || '';
    if (!/^localhost$|^127\.0\.0\.1$/.test(host)) {
      fail.push(`${f}: off-origin subresource (${host}) — ${line.trim().slice(0, 80)}`);
    }
  }
}

if (fail.length) {
  console.error('CSP CHECK FAILED\n' + fail.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`CSP ok — ${inline.length} inline script(s) pinned, key directives present, no off-origin subresources`);
