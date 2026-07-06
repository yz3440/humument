# npm Packages

The project publishes three packages. Most people only install the first — the
other two are the data it fetches from a CDN.

| Package | Version | What it is | Size (unpacked) |
| --- | --- | --- | --- |
| [`humument`](https://www.npmjs.com/package/humument) | `0.1.0` | The TypeScript library — renderer-agnostic erasure-poetry primitives. | ~230 KB |
| [`humument-data`](https://www.npmjs.com/package/humument-data) | `0.1.0` | Per-page OCR JSON (words, bboxes, gutters, navigation graph), gzipped. | ~27 MB |
| [`humument-images`](https://www.npmjs.com/package/humument-images) | `0.1.0` | 367 normalized B&W page JPEGs (1400 × 2100). | ~126 MB |

## `humument`

The only package you install. Zero runtime dependencies. Ships ESM
(`dist/index.js`) plus an IIFE bundle (`dist/index.global.js`) that exposes a
`HumumentLib` global for no-build `<script>` use. See
[Quick Start](../quickstart.md) and the [Library API](../api/index.md).

```sh
npm install humument
```

## `humument-data`

The data layer: `catalog.json`, `search-index.json`, and one gzipped JSON per
printed page under `db/pages/pNNNN.json.gz`. `humument` fetches it by default
from jsDelivr; you rarely reference it directly. Its exact shapes are the
[Data Format](format.md).

```text
https://cdn.jsdelivr.net/npm/humument-data@0.1/db/…
```

## `humument-images`

The image layer: 367 deskewed, aligned, flat-fielded, contrast-normalized B&W
JPEGs at **1400 × 2100**, one per printed page. The word bounding boxes in
`humument-data` are in **these images' pixel coordinates**, so drawing over a
page is 1:1.

```text
https://cdn.jsdelivr.net/npm/humument-images@0.1/pages/pNNNN.jpg
```

## Why data and images are separate packages

Two reasons, both about the CDN:

- **jsDelivr refuses any package over 150 MB unpacked.** The images alone are
  ~126 MB and the raw page JSON is ~159 MB — together they'd blow the ceiling.
  Splitting them keeps each package comfortably under it.
- **The page JSON ships gzipped** (`.json.gz` only), which brings the ~159 MB raw
  set down to ~26 MB. `humument` decodes it with `DecompressionStream` and
  falls back to plain `.json` for self-hosted exports (see
  [Data Format → Gzip twin](format.md#gzip-twin)).

Because both are on jsDelivr and `humument` points at them by default,
`Humument.load({ page })` works from any origin with nothing self-hosted.

## Versioning

`humument`'s CDN defaults float on the **`@0.1`** tag of the data/images
packages (`CDN_DATA_BASE` / `CDN_IMAGE_BASE`), so a data fix reaches sketches
without a library release. Pin a different origin or version by passing
`dataBase` / `imageBase` to [`Humument.load`](../api/loading.md#overriding-the-data-source).

## How they're built

The data packages are generated, not hand-edited: `data-packages/sync.mjs` copies
the pipeline's outputs into each package at publish time (`output/db` →
`humument-data`; `data/pages_normalized` → `humument-images`). See
[The Pipeline](../pipeline.md).
