# CubeSnap

**[gjtucker.github.io/cube-solver](https://gjtucker.github.io/cube-solver/)** — a free Rubik's cube solver. No ads, no app, no sign-up.

Scan your cube with the camera and follow a step-by-step 3D solution, right in the browser. Installable as an app (Add to Home Screen) and works offline.

![CubeSnap](og-image.png)

## Features

- **Camera scanning** — point your camera at each face and the scanner locks on automatically: position, size and tilt. Works with stickered cubes *and* gapless stickerless cubes (it reads the corner notches where tiles meet, since those cubes have no seams). Auto-captures only when it's genuinely sure; manual capture and undo are always available.
- **Four puzzles** — 3×3, 4×4, 2×2 and Mirror 2×2.
- **Two solving styles** — *Step-by-step* teaches the classic layer-by-layer method in friendly stages, each with a "Why this works" explainer of the underlying idea (commutators, twist parity, 4×4 parities); *Fewest moves* finds short solutions (two-phase for 3×3; the 4×4 reduces phase-by-phase and finishes with exact IDA* over TPR-style pruning tables — ~46 moves in about a second, ~44 with "Search harder").
- **Fast 4×4 solving in the browser** — 228 KB of compressed lookup tables load in ~50 ms. The big exact-search pruning table (57 MB, 239.5M entries at 2 bits) is built on-device inside each Web Worker, prewarmed when you enter 4×4 mode: it is ready to solve with after ~1.5 s, then deepens itself in the background for another ~9 s without ever blocking a solve. A fewest-moves solve takes about a second at ~46 moves, or ~44 with "Search harder", without freezing the page.
- **3D playback** — animated cube with play/pause, stepping, speed control, and per-stage move lists. Your cube and playback position survive refreshes.
- **2D net view** — a flat unfolded cross as an alternative to the 3D cube while painting; some find it much easier to copy a real cube face-by-face.
- **Pretty patterns** — checkerboard, cube-in-cube, superflip and friends, animated from a solved cube with the moves shown so you can follow along. Every algorithm is verified against the engine (fun fact discovered doing so: a true checkerboard is mathematically impossible on 2×2 and 4×4 cubes).
- **Share & copy** — share a link that reproduces your exact cube on any device; copy a solution's move sequence with one tap.
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
| `cube4.js`, `tpr4.js`, `worker4.js` | 4×4 engine and phased-reduction solver: beam-portfolio fast path plus a deep engine (exact phase 3 by IDA* over an edge-pairing permutation table, parity solved structurally) racing colour-axis rotations across workers |
| `tables/` | Pre-built solver tables (nibble-packed, gzipped); regenerate with `tools/gen-tables.mjs` |
| `app.js` | UI: painting, 3D rendering, playback, persistence, scanner overlay |
| `tools/cube-corpus/` | Pipeline that turns openly-licensed cube photos into labelled scanner test scenes — real logos, gloss and worn stickers, which the synthetic harness cannot draw |

Both core pipelines have measurement harnesses with pass/fail targets:

```sh
node tests/scan-harness.mjs --seed 1     # scanner: lock rate / bad fits / false locks on synthetic scenes
node tests/scan-harness.mjs --corpus     # scanner: the same, on rectified photos of real cubes
node tests/solve4-harness.mjs            # 4×4 solver: move count + wall time
node tests/solve4-harness.mjs --hard     # the "Search harder" deep mode
node tests/browser-worker-test.mjs       # the real-browser worker path (needs playwright)
```

`--corpus` needs a corpus first; see [`tools/cube-corpus/`](tools/cube-corpus/README.md),
which finds openly-licensed cube photographs, rectifies each face to a canonical
crop, and lets the harness composite those real textures into scenes with exact
ground truth. It scores the colour read as well as the fit, because a logo
printed on a centre cap breaks the read long before it breaks the geometry.

## Themes

CubeSnap follows your system's light/dark preference; the toggle in the header (persisted per browser) or `?theme=dark` / `?theme=light` in the URL overrides it.

## Credits

CubeSnap's solvers stand on decades of public cube theory. **No third-party code is copied into this repository** — each algorithm below was implemented here from its published description.

- **[Herbert Kociemba](http://kociemba.org/cube.htm)** — the two-phase algorithm behind the 3×3 *Fewest moves* solver (`cube.js`), which also finishes every 4×4 solution.
- **Morwen Thistlethwaite** — the nested-subgroup idea (solve into progressively smaller move groups so later phases cannot undo earlier ones) that the 4×4 phased reduction is built on.
- **Richard Korf** — IDA*, the iterative-deepening A* search the 4×4 deep engine runs over its pruning tables.
- **[Chen Shuang (cs0x7f)](https://github.com/cs0x7f/TPR-4x4x4-Solver)** — the Three-Phase-Reduction solver that generates official WCA 4×4 scrambles. CubeSnap's deep 4×4 engine follows its design; see the note below.
- **Charles Tsai** — the 8-step 4×4 method that TPR builds on.
- **The [speedsolving.com](https://www.speedsolving.com/) community** — the layer-by-layer method taught in *Step-by-step*, and the 4×4 OLL/PLL parity algorithms in `cube4.js`.

### On the 4×4 deep engine and TPR

[TPR-4x4x4-Solver](https://github.com/cs0x7f/TPR-4x4x4-Solver) is GPL-licensed Java. CubeSnap's deep engine is an independent JavaScript implementation, written from a prose description of TPR's *algorithm* — its phase structure, the relative-pairing edge coordinate, and the idea of folding parity into the pruning coordinates so parity is never repaired by a dedicated 15-move algorithm. No TPR source was copied, and the two implementations diverge substantially:

| | TPR | CubeSnap |
|---|---|---|
| Edge pruning table | 31M entries × 2 bits, 8-fold symmetry reduction, depth 9 | 239.5M entries × 2 bits, direct-indexed by even-permutation rank, depth 9 (no symmetry reduction) |
| Phase-2 goal | centers + wing parity; phase-3 feasibility filtered afterwards | centers, parity **and** phase-3 feasibility searched jointly as one exact-depth problem |
| 3×3 finish | min2phase | CubeSnap's own two-phase solver (`cube.js`) |
| Orientation | one symmetry frame, rotations stripped at output | three color-axis rotations raced across Web Workers |

Copyright covers the expression of a program rather than the algorithm it implements, which is why this project is MIT-licensed rather than GPL. TPR remains the more efficient solver — it reaches ~44.4 moves in ~250 ms against our ~44.1 in ~12 s, on a fraction of the memory — and it is the reference this one was measured against throughout.

### Assets and tooling

- **[Inter](https://rsms.me/inter/)** by Rasmus Andersson, under the [SIL Open Font License 1.1](https://openfontlicense.org/) — loaded from Google Fonts at runtime, not redistributed here.
- **[Playwright](https://playwright.dev/)** (Apache-2.0) — an optional dev dependency for `tests/browser-worker-test.mjs` only; installed ad hoc (`npm install playwright --no-save`), never bundled. The app itself ships no bundled dependencies.

## License

[MIT](LICENSE) © CubeSnap contributors.
