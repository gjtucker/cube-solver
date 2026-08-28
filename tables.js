// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

(function(){
// Shipped-table container: packs named byte arrays into one gzipped bundle
// and loads it back — in the browser via fetch + DecompressionStream, in
// Node via fs + zlib (used by tools/gen-tables.mjs and the test harnesses).
//
// Format (after gunzip):
//   4 bytes  magic 'CT01'
//   4 bytes  little-endian header JSON length
//   N bytes  header JSON: { version, entries: [{ name, len, pack }] }
//            pack: 'nib' = two 4-bit values per byte (value capped at 15,
//                          admissible for distance tables), 'raw' = bytes
//   payload  entries concatenated in order
//
// Distance tables are low-entropy, so nibble-packing + gzip typically lands
// 4-8x smaller than the in-memory arrays.

const MAGIC = [0x43, 0x54, 0x30, 0x31]; // 'CT01'

function packNib(arr) {
  const out = new Uint8Array((arr.length + 1) >> 1);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.min(15, arr[i]);
    out[i >> 1] |= (i & 1) ? v << 4 : v;
  }
  return out;
}
function unpackNib(bytes, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (i & 1) ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 15;
  }
  return out;
}

// entries: [{name, data: Uint8Array, pack: 'nib'|'raw'}] -> Uint8Array (not yet gzipped)
function pack(version, entries) {
  const metas = [], blobs = [];
  for (const e of entries) {
    const packed = e.pack === 'nib' ? packNib(e.data) : e.data;
    metas.push({ name: e.name, len: e.data.length, pack: e.pack });
    blobs.push(packed);
  }
  const header = new TextEncoder().encode(JSON.stringify({ version, entries: metas }));
  let total = 8 + header.length;
  for (const b of blobs) total += b.length;
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let off = 8 + header.length;
  for (const b of blobs) { out.set(b, off); off += b.length; }
  return out;
}

// Uint8Array (gunzipped) -> { version, tables: {name: Uint8Array} }
function unpack(buf) {
  for (let i = 0; i < 4; i++) if (buf[i] !== MAGIC[i]) throw new Error('bad table bundle magic');
  const hlen = new DataView(buf.buffer, buf.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hlen)));
  const tables = {};
  let off = 8 + hlen;
  for (const e of header.entries) {
    const stored = e.pack === 'nib' ? (e.len + 1) >> 1 : e.len;
    const bytes = buf.subarray(off, off + stored);
    tables[e.name] = e.pack === 'nib' ? unpackNib(bytes, e.len) : new Uint8Array(bytes);
    off += stored;
  }
  return { version: header.version, tables };
}

// browser: fetch a .bin.gz bundle and unpack it. Served files keep their own
// gzip framing, so inflate explicitly via DecompressionStream.
async function fetchBundle(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('tables fetch failed: ' + resp.status);
  const ds = new DecompressionStream('gzip');
  const buf = new Uint8Array(await new Response(resp.body.pipeThrough(ds)).arrayBuffer());
  return unpack(buf);
}

// node: read + gunzip a bundle from disk
function readBundle(path) {
  const fs = require('fs');
  const zlib = require('zlib');
  return unpack(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path))));
}
function writeBundle(path, version, entries) {
  const fs = require('fs');
  const zlib = require('zlib');
  const raw = pack(version, entries);
  fs.writeFileSync(path, zlib.gzipSync(raw, { level: 9 }));
  return raw.length;
}

const api = { pack, unpack, packNib, unpackNib, fetchBundle };
if (typeof module !== 'undefined') module.exports = Object.assign(api, { readBundle, writeBundle });
if (typeof globalThis !== 'undefined') globalThis.CubeTables = api;

})();
