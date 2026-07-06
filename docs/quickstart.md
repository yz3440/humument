# Quick Start

`humument` loads a single page of _A Human Document_ — its words, OCR boxes,
line groupings, whitespace geometry, and a navigation graph — and gives you a
POS-pattern phrase chunker, two river pathfinders, and balloon/ribbon geometry to
draw over it. It is **renderer-agnostic**: every drawing primitive returns plain
`{x, y}` point arrays, so you render with any 2D API. The full 367-page dataset is
published on npm and fetched from a CDN, so there is **nothing to host**.

## Install

```sh
npm install humument
```

Zero runtime dependencies. The examples below draw with the browser's built-in
**Canvas2D** API, so nothing else is needed.

## No build step? CDN

Load the IIFE bundle from a CDN — it exposes a `HumumentLib` global, so it works
in a plain `<script>` with no bundler:

```html
<script src="https://cdn.jsdelivr.net/npm/humument@0.1/dist/index.global.js"></script>
<script>
  const { Humument } = HumumentLib;
  // ... same API as the ESM import
</script>
```

## Load a page

The full dataset ([humument-data](data/packages.md) for OCR words + geometry,
[humument-images](data/packages.md) for page scans) is published on npm, and the
library's defaults point at it via jsDelivr. `Humument.load({ page: 33 })` works
from any origin without hosting anything.

`Humument.load` is **async** — it returns a promise. Await it (or use `.then`),
then read the page's data off the returned `H` instance:

```js
import { Humument } from 'humument'; // CDN: const { Humument } = HumumentLib;

const H = await Humument.load({ page: 33 });

console.log(H.page.number, H.page.width, H.page.height);
const phrases = H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 });
```

`H.page.imageUrl` is the URL of the page scan; the library never loads the image
itself — that's the host's job (see below).

## Draw it (Canvas2D)

Load the page image, then stroke a balloon around each selected phrase. Every
coordinate is already in the page image's pixel space, so it lines up 1:1.

```js
import { Humument } from 'humument';

const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');

const H = await Humument.load({ page: 33 });
canvas.width = H.page.width;
canvas.height = H.page.height;

// 1. draw the page scan
const img = new Image();
img.crossOrigin = 'anonymous';
img.src = H.page.imageUrl;
await img.decode();
ctx.drawImage(img, 0, 0);

// 2. wrap a balloon around each selected phrase
ctx.strokeStyle = '#141414';
ctx.fillStyle = '#ffffff';
for (const phrase of H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 })) {
  const outline = H.geom.balloon(H.bboxOf(phrase), { wobble: 0.15 }); // → Pt[]
  ctx.beginPath();
  outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
```

The same pattern renders to SVG, WebGL, or a server-side canvas — `H.geom.*`
returns points, and you draw them however you like (see [Geometry](api/geometry.md)).

## Draw a river

Connect two words with a whitespace river, then fill its ribbon:

```js
const seg = H.river.between(wordA, wordB); // ChannelSegment | null
if (seg) {
  const ribbon = H.geom.channel(seg); // → Pt[] (closed ring)
  ctx.beginPath();
  ribbon.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
}
```

## Next

- [Concepts](concepts.md) — what chunks, rivers, balloons, gutters, and docks
  are.
- [Library API](api/index.md) — every method on `H` and `Humument`.
- [Geometry](api/geometry.md) — the renderer-agnostic drawing primitives.
- [Hosting the data elsewhere](api/loading.md#overriding-the-data-source) —
  point the loader at your own export.
