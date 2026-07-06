# Library API — Overview

`humument-lib` exposes one object, **`Humument`**, plus a rich re-export of
types. You load a page and get back an **`H` instance** (`HumumentInstance`)
whose members are the whole toolkit.

```js
import { Humument } from 'humument-lib'; // CDN: const { Humument } = HumumentLib;

const H = await Humument.load({ page: 33 });
```

Everything below hangs off that `H`, except the `Humument.*` loader/catalog
surface (which is usable before any page is loaded).

## The `Humument` object

| Member | Purpose | Reference |
| --- | --- | --- |
| `Humument.load(opts)` | Fetch one page → `Promise<HumumentInstance>`. | [Loading & Catalog](loading.md) |
| `Humument.init(opts)` | Set base URLs + warm the catalog (called by `load`). | [Loading & Catalog](loading.md) |
| `Humument.catalog.*` | Page list, chapters, search, per-page words — all async, usable before `load`. | [Loading & Catalog](loading.md) |

## The `H` instance

| Member | Purpose | Reference |
| --- | --- | --- |
| `H.page` | `{ number, width, height, body, valid, imageUrl, image }`. | [Pages & Words](pages.md) |
| `H.words` / `H.lines` | Words sorted by `(lineIdx, x0)`; the same grouped into lines. | [Pages & Words](pages.md) |
| `H.wordById(id)` / `H.bboxOf(words)` | Look up a word; union bbox of words. | [Pages & Words](pages.md) |
| `H.gutters` / `H.docks` / `H.graph` | Whitespace geometry. | [Pages & Words](pages.md) |
| `H.chunks(opts)` | POS-pattern phrase chunker → `Word[][]`. | [Chunks](chunks.md) |
| `H.selectChunks(opts)` | Top-N chunks, distributed by line distance. | [Chunks](chunks.md) |
| `H.chunkScore(chunk)` / `H.passesCandidacy(word)` | Score a chunk; word candidacy test. | [Chunks](chunks.md) |
| `H.river.between(a, b)` | Dijkstra river over the whitespace graph. | [Rivers](rivers.md) |
| `H.river.flow(a, b, opts)` | Perlin-field river walker. | [Rivers](rivers.md) |
| `H.river.pickPorts / penalizeBorders / dijkstra / obstaclesFrom` | River building blocks. | [Rivers](rivers.md) |
| `H.geom.balloon / channel / catmullRom` | Pure geometry — returns `{x,y}` arrays, no renderer. | [Geometry](geometry.md) |
| `H.noise / noise2D / random` | Seedable value-noise + PRNG. | [Noise & Random](noise.md) |
| `H.POS`, `H.HEAD(w)`, `H.MOD(w)` | UPOS tag constants and helpers. | [Chunks](chunks.md#pos-helpers) |

## Layers

The library is deliberately layered so you can use as much or as little as you
want:

- **Data + accessors** (`H.page`, `H.words`, `H.gutters`, …) — plain data.
- **Chunking & pathfinding** (`H.chunks`, `H.river.*`) — pure logic over that
  data.
- **Geometry** (`H.geom.*`) — returns `{x, y}` arrays; render with any 2D API.

Nothing here depends on a specific renderer — draw the returned points with
Canvas2D, SVG, WebGL, or a server-side canvas (see [Geometry](geometry.md)).

## Types

All shapes (`Word`, `Bbox`, `Pt`, `PageMeta`, `PageRef`, `Gutter`, `Dock`,
`Port`, `Compass`, `GraphNode`, `PageGraph`, `ChannelSegment`, `ChapterRef`,
`PageMatch`, `HumumentLoadOptions`, `BalloonOptions`, `ChannelOptions`,
`ChunksOptions`, `SelectChunksOptions`, `FlowOptions`) are exported from the
package entry and documented alongside the methods that use them. The canonical definitions live in
[`src/types.ts`](https://github.com/yz3440/humument/blob/main/humument-lib/src/types.ts).
