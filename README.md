# humument

The canonical toolkit and data for computational work over **W. H. Mallock's
_A Human Document_ (1892)** — the one-volume Chapman & Hall "New Edition" that
Tom Phillips treated to make _A Humument_. It maps page-for-page onto that
edition, so page numbers here equal the **printed book page (= the _A Humument_
page), 1–367**.

This repository is two things:

- a **CV/OCR pipeline** (Python, run with [`uv`](https://docs.astral.sh/uv/))
  that turns the source PDF into a canonical OCR database and normalized page
  images, and
- a set of **npm packages** — a TypeScript library plus two data packages —
  that let anyone build Phillips-style erasure poetry from the book with zero
  configuration.

All OCR is local (macOS Vision); no cloud APIs are used.

📖 **Documentation:** <https://yz3440.github.io/humument/>

## The three npm packages

| Package | What it is | Size (unpacked) |
| --- | --- | --- |
| [`humument-lib`](humument-lib) | Erasure-poetry primitives for p5.js (words, OCR boxes, whitespace rivers, balloons). Zero runtime deps; `p5` is an optional peer. | ~230 KB |
| [`humument-data`](data-packages/humument-data) | Per-page OCR JSON (words, bboxes, gutters, navigation graph), gzipped. | ~27 MB |
| [`humument-images`](data-packages/humument-images) | 367 normalized B&W page JPEGs. | ~126 MB |

`humument-lib`'s defaults fetch `humument-data` and `humument-images` straight
from the jsDelivr CDN, so `Humument.load({ page: 33 })` works from any origin
without hosting anything. Data and images are **separate packages** — and pages
ship **gzipped** — because jsDelivr refuses any package over **150 MB
unpacked**; keeping them apart holds both comfortably under that ceiling.

## Zero-config example (p5.js)

```js
import { Humument } from 'humument-lib'; // CDN: const { Humument } = HumumentLib;

let H = null;

function setup() {
  createCanvas(100, 100); // resized once the page loads
  noLoop();
  Humument.load({ page: 33 }).then((h) => {
    H = h;
    resizeCanvas(H.page.width, H.page.height);
    H.page.image = loadImage(H.page.imageUrl, () => redraw());
  });
}

function draw() {
  if (!H || !H.page.image) return;
  image(H.page.image, 0, 0);

  const phrases = H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 });
  fill(255); stroke(20);
  for (const ph of phrases) H.draw.balloon(ph, { wobble: 0.15 });
}
```

See [`humument-lib/README.md`](humument-lib/README.md) for the full API, CDN /
p5 web-editor usage, and the data format.

## The pipeline

Requires macOS (for Vision OCR) and `uv`. From the repo root:

```sh
uv sync
make pipeline   # stages 01a → 03, in order
make verify     # validate + pytest + typecheck (the data-contract gate)
```

The stages ([`pipeline/`](pipeline), configured in
[`pipeline/config.py`](pipeline/config.py)):

- **01a `rasterize`** — PDF → `data/pages/*.jpg` at 300 dpi. The raster index
  is `printed_page + 9`; the offset is applied here and nowhere else, so every
  later stage works in printed-page space.
- **01b `ocr_raw`** — raw macOS Vision OCR → `data/humument.db`.
- **01c `correct_tilt`** — deskew, align, and re-OCR → `data/pages_corrected/`.
- **01d `normalize_color`** — B&W high-contrast normalization, shadow removal,
  text-bbox crop → `data/pages_normalized/`.
- **01e `features`** — tag every word with POS, lemma, frequency, rarity (spaCy
  + wordfreq).
- **02 `whitespace_graph`** — whitespace gutters, word docks, and the routing
  graph used to draw rivers of type.
- **03 `export_web`** — export the DB to static JSON under `output/db/`
  (catalog, per-page `pNNNN.json` + gzipped twin, search index). This is the
  payload published as `humument-data`.

`data/humument.db` is the **canonical OCR artifact** (keyed by `page_num`,
1–367). Apple Vision OCR is nondeterministic, so re-running the pipeline will
not reproduce it byte-for-byte — the DB is versioned here (via git-lfs) rather
than regenerated.

`data-packages/sync.mjs` copies the pipeline outputs into the two data packages
at publish time (`output/db` → `humument-data`; `data/pages_normalized` →
`humument-images`).

## Building the docs

The documentation site (MkDocs, deployed to GitHub Pages) is built with `uv`:

```sh
uv sync --group docs      # or: uv pip install --group docs
uv run mkdocs serve       # live preview at http://127.0.0.1:8000
uv run mkdocs build       # one-off build → ./site (git-ignored)
```

Pages live in [`docs/`](docs); the nav and theme are configured in
[`mkdocs.yml`](mkdocs.yml). A push to `main` auto-deploys via
[`.github/workflows/docs.yml`](.github/workflows/docs.yml).

## Provenance

Scanned from the Internet Archive item
[`ahumandocumenta04mallgoog`](https://archive.org/details/ahumandocumenta04mallgoog)
(digitized by Google from a public-domain copy). The 1892 text is in the public
domain; this code, the derived data, and the packaging are **MIT-licensed** (see
[`LICENSE`](LICENSE)).

> The multi-volume "three-decker" first edition has different pagination and
> does **not** line up with _A Humument_; this repo deliberately uses only the
> one-volume 1892 edition.
