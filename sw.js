// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

// Service worker: makes the app installable and usable offline.
// Strategy: network-first with cache fallback for every same-origin GET, so
// deploys are picked up immediately and the cache only serves when the
// network can't. The core files are pre-cached on install so the app works
// offline even for pages never revisited.
const CACHE = 'cube-solver-v3'; // bump on every release so offline clients refresh
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'cube.js',
  'cube4.js',
  'tpr4.js',
  'scan.js',
  'tables.js',
  'worker4.js',
  'tables/tpr4-v1.bin.gz',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // web fonts are immutable — cache-first keeps typography working offline
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })).catch(() => Response.error())
    );
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') }))
  );
});
