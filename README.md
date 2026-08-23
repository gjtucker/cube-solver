# 🧩 Cube Solver

**[gjtucker.github.io/cube-solver](https://gjtucker.github.io/cube-solver/)** — free, no app, no sign-up.

Scan your Rubik's cube with the camera and follow a step-by-step 3D solution, right in the browser. Installable as an app (Add to Home Screen) and works offline.

![Cube Solver](og-image.png)

## Features

- **Camera scanning** — point your camera at each face and the scanner locks on automatically: position, size and tilt. Works with stickered cubes *and* gapless stickerless cubes (it reads the corner notches where tiles meet, since those cubes have no seams). Auto-captures only when it's genuinely sure; manual capture and undo are always available.
- **Four puzzles** — 3×3, 4×4, 2×2 and Mirror 2×2.
- **Two solving styles** — *Step-by-step* teaches the classic layer-by-layer method in friendly stages; *Fewest moves* finds short solutions (two-phase for 3×3, phased reduction for 4×4 with a "Search harder" deep mode that averages ~55 moves).
- **Fast 4×4 solving in the browser** — 232 KB of compressed lookup tables load in ~50 ms and the search runs on parallel Web Workers, so a fewest-moves 4×4 solve takes ~4 seconds without freezing the page.
- **3D playback** — animated cube with play/pause, stepping, speed control, and per-stage move lists. Your cube and playback position survive refreshes.
- **No build, no backend** — plain HTML/CSS/JS served statically. Clone it and open `index.html`.

## Run locally

```sh
git clone https://github.com/gjtucker/cube-solver
cd cube-solver
python3 -m http.server 8000   # or any static server
# open http://localhost:8000
```

Opening `index.html` directly from `file://` also works (the 4×4 falls back to building its tables on-device).

## Development

Everything is plain scripts — no bundler, no dependencies. The interesting parts:

| File | What it is |
|---|---|
| `scan.js` | Camera scanner: blob segmentation → lattice fitting → physical-evidence gates (sticker seams / corner notches) → temporal tracker |
| `cube.js` | 3×3/2×2 engine + layer-by-layer and two-phase solvers |
| `cube4.js`, `tpr4.js`, `worker4.js` | 4×4 engine and phased-reduction solver with a worker-pool portfolio search |
| `tables/` | Pre-built solver tables (nibble-packed, gzipped); regenerate with `tools/gen-tables.mjs` |
| `app.js` | UI: painting, 3D rendering, playback, persistence, scanner overlay |

Both core pipelines have measurement harnesses with pass/fail targets:

```sh
node tests/scan-harness.mjs --seed 1     # scanner: lock rate / bad fits / false locks on synthetic scenes
node tests/solve4-harness.mjs            # 4×4 solver: move count + wall time
node tests/solve4-harness.mjs --hard     # the "Search harder" deep mode
```

## Theme previews

Add `?theme=pro` (refined dark) or `?theme=light` (clean light) to the URL to preview alternative looks.
