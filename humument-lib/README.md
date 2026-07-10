# humument

Renderer-agnostic Phillips-style erasure-poetry primitives over W. H. Mallock's _A Human Document_ (1892).

This is the canonical toolkit for making computational _Humument_-type work: the full book — every page's words, OCR boxes, whitespace geometry — ships on npm ([humument-data](https://www.npmjs.com/package/humument-data), [humument-images](https://www.npmjs.com/package/humument-images)) and loads with zero configuration.

Loads a single page's words, OCR boxes, line groupings, whitespace gutters, and a navigation graph; provides a POS-pattern phrase chunker, two river-pathfinders, and blob/balloon/banner/ribbon geometry. Every drawing primitive returns plain `{x, y}` point arrays — render them with any 2D API (Canvas2D, SVG, WebGL, a server-side canvas, …).

## Install

```sh
npm install humument
```

Zero runtime dependencies.

### CDN / no build step

Load the IIFE bundle from a CDN — it exposes a `HumumentLib` global, so it works in a plain `<script>` with no bundler:

```html
<script src="https://cdn.jsdelivr.net/npm/humument@0.1/dist/index.global.js"></script>
<script>
  const { Humument } = HumumentLib;
  // ... same API as the ESM import
</script>
```

## Usage

**Zero config.** The full 367-page dataset is published on npm alongside the library — [humument-data](https://www.npmjs.com/package/humument-data) (OCR words, gutters, navigation graph) and [humument-images](https://www.npmjs.com/package/humument-images) (normalized page scans) — and the library's defaults point at them via jsDelivr's CDN. `Humument.load({ page: 33 })` works from any origin without hosting anything.

`Humument.load` is async; await it, then read everything off the returned `H` instance. The library never loads the page image itself — take `H.page.imageUrl` and load it with your renderer. A complete Canvas2D example:

```js
import { Humument } from 'humument'; // CDN: const { Humument } = HumumentLib;

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');

const H = await Humument.load({ page: 33 });
canvas.width = H.page.width;
canvas.height = H.page.height;

// 1. draw the page scan (coordinates are 1:1 with the image's pixels)
const img = new Image();
img.crossOrigin = 'anonymous';
img.src = H.page.imageUrl;
await img.decode();
ctx.drawImage(img, 0, 0);

// 2. wrap a balloon around each selected phrase
ctx.strokeStyle = '#141414';
ctx.fillStyle = '#ffffff';
for (const phrase of H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 })) {
  const outline = H.geom.balloon(H.bboxOf(phrase), { wobble: 0.15 }); // → [{x,y}, …]
  ctx.beginPath();
  outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
```

For the faithful A Humument silhouette, fuse the phrases into **one text-hugging
blob** — tight hulls around every word, joined by tapered necks (`v0.2.0`):

```js
const phrases = H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 });
const spec = H.geom.blobSpec(phrases);            // auto-necks between phrases
for (const loop of H.geom.blob(spec, { pad: 8, blend: 10, seed: 7 })) { // → [{x,y}, …][]
  ctx.beginPath();
  loop.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();   // fill + stroke one path = one ink rim
  ctx.stroke();
}
```

(`H.geom.balloon` stays the cheap analytic loop for animated / per-frame drawing;
`blob` is the faithful shape for one-shot page renders.)

Rivers work the same way — pathfind, turn the path into a ribbon polygon, fill it:

```js
const seg = H.river.between(wordA, wordB); // ChannelSegment | null
if (seg) {
  const ribbon = H.geom.channel(seg); // → [{x,y}, …] (closed ring)
  ctx.beginPath();
  ribbon.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
}
```

### Hosting the data elsewhere

Pass `dataBase`/`imageBase` to `Humument.load`/`Humument.init` to override the CDN defaults, e.g. a self-hosted export (`dataBase: '/db', imageBase: '/pages_normalized'` for a page served next to its own data — see **Data format** below).

## API at a glance

- `H.page` — `{ number, width, height, body, valid, imageUrl }`
- `H.words` / `H.lines` / `H.wordById(id)` / `H.bboxOf(words)`
- `H.gutters` / `H.docks` / `H.graph` — whitespace geometry
- `H.chunks(opts)` — POS-pattern chunker
- `H.selectChunks(opts)` — top-N chunks distributed by line distance
- `H.river.between(a, b)` — Dijkstra over the whitespace graph
- `H.river.flow(a, b, opts)` — Perlin walker
- `H.geom.blob(spec, opts)` / `H.geom.blobSpec(groups, opts)` / `H.geom.blobField(spec, opts)` — text-hugging blob silhouettes (word hulls fused by tapered necks)
- `H.geom.banner(bbox, opts)` — angular pennant strips (square/point/swallowtail ends)
- `H.geom.balloon(bbox, opts)` / `H.geom.channel(seg, opts)` / `H.geom.catmullRom(pts)` — simple balloon, river ribbon, spline — pure geometry, returns `{x, y}` arrays
- `H.noise(seed)` / `H.noise2D(seed)` / `H.random(seed)`

Catalog helpers (all async; usable before `load`): `Humument.init({ dataBase, imageBase })`, then `Humument.catalog.listPages()` / `listChapters()` / `searchPages(q)` / `getWords(page)` / `pageImageUrl(page)`.

## Data format

`Humument.load` fetches static JSON. Produce it with this project's `pipeline/03_export_web.py`, or supply your own with the same shapes:

- `${dataBase}/catalog.json` — `{ "pages": number[], "chapters": [{ "pageNum", "label", "roman" }] }`
- `${dataBase}/pages/pNNNN.json` (zero-padded, e.g. `p0033.json`) — `{ "meta": { width, height, body, valid }, "words": Word[], "gutters": Gutter[], "docks": Dock[], "graph": [id, x, y, edges][] }`
- `${dataBase}/search-index.json` — `{ "<token>": [[pageNum, count], …] }` (lowercased tokens; lazy-loaded on first search)
- `${imageBase}/pNNNN.jpg` — one page image per page

Page fetches try a gzipped twin first (`pages/pNNNN.json.gz`, decoded with
`DecompressionStream`) and fall back to plain `pNNNN.json` — the npm-hosted
data ships only the `.gz` files; a self-hosted export can supply either.

See `src/types.ts` for the exact `Word` / `Gutter` / `Dock` shapes.

## License

MIT
