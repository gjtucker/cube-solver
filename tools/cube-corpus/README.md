# cube-corpus

A five-stage pipeline that turns openly-licensed cube photographs from the web
into **labelled** scanner test scenes — the branded, glossy, worn and gapless
cubes that `tests/scan-harness.mjs` cannot draw.

## Why

`scan.js` is a classical CV pipeline, and its harness renders faces from flat
sticker RGB with ideal gaps. Nothing in that parameter space has a logo printed
across a centre cap, a specular sweep off polished ABS, sun-faded vinyl, or the
seamless body of a stickerless cube. Those are exactly the things that cost the
scanner in the field, and they are invisible to a synthetic sweep.

The trick that makes real photos usable as *measurements* rather than an
unlabelled pile: **rectify first**. Each photo is warped down to a canonical
N×N face crop, and the harness then places that crop into a scene itself, at a
centre, size and angle it chose. Ground truth stays exact, so every metric the
synthetic harness reports carries over unchanged — only the texture is real.

## The stages

```sh
node tools/cube-corpus/search.mjs        # 1. find openly-licensed photos
node tools/cube-corpus/fetch.mjs         # 2. download + dedupe
node tools/cube-corpus/serve.mjs         # 3. label in the browser (open the URL)
                                         # 4. rectify — happens in the annotator
node tests/scan-harness.mjs --corpus     # 5. composite + score
```

**1. search** — queries Wikimedia Commons and Openverse across five query
groups (`logo`, `stickerless`, `exotic`, `scheme`, `scene`) aimed at the
tripwires, and writes `corpus/index.json`. Downloads nothing, so you can read
what it found before committing to it.

**2. fetch** — downloads, dedupes by content hash, splits by licence, and writes
`corpus/ATTRIBUTION.md`. Resumable: re-running skips what is already present.

**3. annotate** — `serve.mjs` hosts a page that proposes a face quad, which you
correct by dragging four handles. It also guesses `n` from the patch count and
auto-samples the per-tile colours, which you fix by clicking a tile. Keys:
`←/→` image, `2/3/4` cube size, `R` re-propose, `Enter` save, `X` skip.

The proposer (`propose.mjs`) is deliberately **not** `scan.js`. Labelling with
the detector under test would only ever admit images that detector already
handles, and the hard cases — the whole reason for the corpus — would filter
themselves out. It is a separate, far more permissive finder: colour-class
blobs → keep the ones that look like a wall of equal-sized patches → minimum
area rectangle over their centroids, grown by half a lattice pitch. On drawn
test faces it lands within 8% of face size on 64 of 72 cases (mean corner error
2.5%); the eight it misses are white-body cubes where white stickers merge into
white plastic, and it reports a low `confidence` on exactly those.

**4. rectify** — a homography from the four corners to a square, sampled
bilinearly. This runs in the *browser*, because that is the only runtime in the
pipeline that can decode an arbitrary JPEG or WebP off the internet; Node then
only ever reads the PNG the browser wrote, which is why `png.mjs` is a page of
code instead of a dependency.

**5. score** — `--corpus` composites each face across scale × tilt × background
with the harness's own lighting, glare and sensor noise, and reports:

- **lock rate** and **bad-fit rate** — same definitions as the synthetic run.
- **colour read** — per-tile agreement with `SCAN.hueClass`. Tiles the
  annotator marked `?` (a logo, a reflection, a colour outside the six) are
  excluded rather than counted as failures.
- **separability** — smallest between-colour distance over largest within-colour
  distance in the scanner's own feature space. Threshold-free: above 1 the face
  separates cleanly, at or below 1 two different colours sit closer than one
  colour sits to itself and no thresholding recovers it.

then breaks all of it down by tag, style, cube size, scale, tilt and background,
and lists the hardest individual faces by filename so you can go look at them.

## Licensing

Rectified crops are derivative works, so the default keeps only what can live in
an MIT repository: **CC0 and public domain**. `--license all` also admits CC BY
and CC BY-SA, which land in `corpus/local/` and are gitignored — usable for your
own measurements, never committed. `corpus/ATTRIBUTION.md` is regenerated on
every fetch and names the creator, licence and source page of every image.

## Trying it without downloading anything

```sh
node tools/cube-corpus/demo-corpus.mjs   # drawn fixtures: logo, glossy, worn, gapless
node tests/scan-harness.mjs --corpus
node tools/cube-corpus/demo-corpus.mjs --clean
```

These are **drawn**, not photographed. They exist to exercise the pipeline and
show the report's shape; the harness prints a warning and sets `demoFaces` in
its JSON so a demo run cannot be mistaken for a measurement on real cubes.

## Layout

| Path | What | Committed |
|---|---|---|
| `corpus/index.json` | search results + licences | no |
| `corpus/raw/`, `corpus/local/` | downloaded originals | no |
| `corpus/faces/` | rectified N×N crops | yes (CC0/PD) |
| `corpus/faces.json` | labels: corners, `n`, style, tags, colours | yes |
| `corpus/ATTRIBUTION.md` | creator / licence / source per image | yes |
