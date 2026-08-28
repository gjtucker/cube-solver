// CubeSnap — a free in-browser Rubik's cube solver.
// Copyright (C) 2026 CubeSnap contributors
// SPDX-License-Identifier: GPL-3.0-or-later (see LICENSE for the full text)

// Dev-time declarations for the checker (`npx tsc --noEmit`, see
// jsconfig.json). Nothing here ships: the app files are plain scripts that
// publish their APIs on globalThis behind IIFEs, so the checker cannot see
// across file boundaries — these declarations stand in for those globals.

// CommonJS guard used by the engine files (real in Node, undefined in the browser)
declare var module: { exports: unknown } | undefined;

// the engine/scanner APIs published on globalThis
declare var Cube: any;
declare var Cube4: any;
declare var TPR4: any;
declare var CubeTables: any;
declare var SCAN: any;

interface Navigator {
  /** GiB of device RAM; Chrome-only, absent on iOS */
  deviceMemory?: number;
}

interface Window {
  /** prefixed AudioContext on older iOS Safari */
  webkitAudioContext?: typeof AudioContext;
  Cube: any;
  Cube4: any;
  TPR4: any;
  CubeTables: any;
  SCAN: any;
  /** test hooks exposed by app.js (behind ?debug and for the harnesses) */
  __cubeDebug: any;
}

// worker context (worker4.js runs under importScripts; sw.js under a
// ServiceWorkerGlobalScope — checked against the dom lib with these shims)
declare function importScripts(...urls: string[]): void;
declare function require(id: string): any; // Node branch of tables.js
declare module 'fs';   // resolved only when that branch actually runs (Node)
declare module 'zlib';
interface Window {
  /** ServiceWorkerGlobalScope members, reached as `self.…` in sw.js */
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
