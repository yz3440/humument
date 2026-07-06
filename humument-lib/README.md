# humument-lib

Phillips-style erasure-poetry primitives over W. H. Mallock's _A Human Document_ (1892), for p5.js sketches.

This is the canonical toolkit for making computational _Humument_-type work: the full book — every page's words, OCR boxes, whitespace geometry — ships on npm ([humument-data](https://www.npmjs.com/package/humument-data), [humument-images](https://www.npmjs.com/package/humument-images)) and loads with zero configuration. The [InHumument editor](https://inhumument.pages.dev) is built on this same API.

Loads a single page's words, OCR boxes, line groupings, whitespace gutters, and a navigation graph; provides a POS-pattern phrase chunker, two river-pathfinders, and balloon/ribbon geometry. The drawing layer is optional p5 sugar — the geometry and pathfinding are pure and work with any renderer.

## Install

```sh
npm install humument-lib p5
```

`p5` is an **optional** peer dependency: you only need it for the `H.draw.*` helpers. The pure geometry (`H.geom.*`), chunker, and pathfinding work without it. The library has zero runtime dependencies.

TypeScript users: the shipped types reference p5's types (p5 1.x doesn't bundle its own), so also `npm i -D @types/p5` — or set `skipLibCheck: true`.

### CDN / p5 web editor

No build step? Load the IIFE bundle from a CDN — it exposes a `HumumentLib` global:

```html
<script src="https://cdn.jsdelivr.net/npm/p5@1.11.2/lib/p5.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/humument-lib@0.2/dist/index.global.js"></script>
<script>
  const { Humument } = HumumentLib;
  // ... same API as the ESM import
</script>
```

This is the way to use it on [editor.p5js.org](https://editor.p5js.org) or OpenProcessing: add both script tags to `index.html`. No further setup — the data loads from npm too (below).

## Usage

**Zero config.** The full 367-page dataset is published on npm alongside the library — [humument-data](https://www.npmjs.com/package/humument-data) (OCR words, gutters, navigation graph) and [humument-images](https://www.npmjs.com/package/humument-images) (normalized page scans) — and the library's defaults point at them via jsDelivr's CDN. `Humument.load({ page: 33 })` works from any origin without hosting anything.

### Hosting the data elsewhere

Pass `dataBase`/`imageBase` to `Humument.load`/`Humument.init` to override, e.g. the InHumument site (CORS enabled):

```js
dataBase:  'https://inhumument.pages.dev/db',
imageBase: 'https://inhumument.pages.dev/pages_normalized',
```

or a self-hosted export (`dataBase: '/db', imageBase: '/pages_normalized'` for a sketch served next to its own data — see **Data format** below).

`Humument.load` is async, and p5 **1.x** does not await async `preload`/`setup` (top-level `await` is also a SyntaxError in classic scripts). Kick off the load in `setup()` and gate `draw()` until it resolves:

```js
import { Humument } from 'humument-lib'; // CDN: const { Humument } = HumumentLib;

let H = null;

function setup() {
  createCanvas(100, 100); // resized once the page loads
  noLoop();
  Humument.load({ page: 33 }).then((h) => {
    H = h;
    resizeCanvas(H.page.width, H.page.height);
    // The lib never loads the image itself — assign it, then draw:
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

(On p5 2.x, `setup` may be `async` — there you can simply `await Humument.load(...)` inside it.)

Using the geometry without p5 (render to Canvas2D / SVG / WebGL yourself):

```js
const outline = H.geom.balloon(H.bboxOf(phrase), { wobble: 0.15 }); // → [{x,y}, …]
```

## API at a glance

- `H.page` — `{ number, width, height, body, valid, imageUrl, image }`
- `H.words` / `H.lines` / `H.wordById(id)` / `H.bboxOf(words)`
- `H.gutters` / `H.docks` / `H.graph` — whitespace geometry
- `H.chunks(opts)` — POS-pattern chunker
- `H.selectChunks(opts)` — top-N chunks distributed by line distance
- `H.river.between(a, b)` — Dijkstra over the whitespace graph
- `H.river.flow(a, b, opts)` — Perlin walker
- `H.draw.balloon(words, opts)` / `H.draw.river(seg, opts)` / `H.draw.word(w)` / `H.draw.image()`
- `H.geom.balloon(bbox, opts)` / `H.geom.channel(seg, opts)` / `H.geom.catmullRom(pts)` — pure geometry, no drawing
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
