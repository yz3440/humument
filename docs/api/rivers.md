# Rivers (pathfinding)

A river is a path of whitespace between two kept words. There are two
strategies, plus the building blocks they're made of. See
[Concepts → Rivers](../concepts.md#rivers) for the idea.

Both `between` and `flow` produce polylines in page-pixel coordinates; feed the
result to [`H.geom.channel`](geometry.md#hgeomchannelseg-opts) to turn it into a
ribbon.

## `H.river.between(a, b)`

```ts
H.river.between(a: Word, b: Word): ChannelSegment | null
```

**Dijkstra** over the precomputed whitespace [graph](pages.md#hgraph-pagegraph).
Picks the best entry/exit ports on each word's dock, finds the shortest gutter
path between them, and returns a `ChannelSegment` — or `null` if either word
lacks a dock or no path connects them.

```ts
interface ChannelSegment {
  points: Pt[];          // ordered polyline through the whitespace
  gutterIds: number[];   // gutterIds[i] is the gutter used from points[i] to points[i+1]
}
```

The per-segment `gutterIds` let a renderer vary stroke width by the gutter's
`minWidth` (see [`channel`](geometry.md#hgeomchannelseg-opts)).

```js
const seg = H.river.between(wordA, wordB);
const ribbon = seg ? H.geom.channel(seg) : null; // → Pt[], fill as a closed path
```

## `H.river.flow(a, b, opts)`

```ts
H.river.flow(a: Pt, b: Pt, opts: Omit<FlowOptions, 'body'> & { body?: Bbox }): Pt[]
```

A greedy walk through a **Perlin noise field**, biased toward the target and
away from obstacles. Organic, and a good fallback when `between` returns `null`
(graph islands). Note it takes **points** (`Pt`), not words, and always returns a
polyline (it appends the endpoint even if it stalls).

The options object itself is **required** — pass at least `{}` — but every field
inside it is optional. In particular, unlike the raw `flow` export, `body` is
optional here: it defaults to the page's `body` bbox, or the full page if there
isn't one.

`FlowOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `seed` | `number?` | `0` | Noise seed. |
| `stepSize` | `number?` | `2.5` | Px per step (smaller = smoother). |
| `maxSteps` | `number?` | `600` | Hard step cap. |
| `noiseFreq` | `number?` | `0.007` | Spatial scale of the noise field. |
| `targetWeight` | `number?` | `0.45` | Bias toward target (0 = pure flow, 1 = straight line). |
| `candidateCount` | `number?` | `24` | Directions evaluated per step. |
| `obstaclePad` | `number?` | `1` | Padding around obstacles (px). |
| `body` | `Bbox` | page body | Box the path must stay inside (optional via `H.river.flow`). |
| `obstacles` | `Bbox[]?` | `[]` | Boxes to avoid (typically non-selected words). |

```js
// flow works in points — take each word's centre:
const centre = (w) => ({ x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 });

const path = H.river.flow(centre(wordA), centre(wordB), {
  seed: 7,
  obstacles: H.river.obstaclesFrom(H.words, selectedIds),
});
```

## Building blocks

### `H.river.pickPorts(a, b)`

```ts
H.river.pickPorts(a: Word, b: Word): [Port, Port] | null
```

Chooses the `(portA, portB)` pair whose compass directions flow most directly
from A toward B. Returns `null` if either word has no dock/ports. `between` uses
this internally.

### `H.river.penalizeBorders(margin?, penalty?)`

```ts
H.river.penalizeBorders(margin = 30, penalty = 30): PageGraph
```

Returns a **new** graph whose edges that hug the body margins have inflated cost,
so Dijkstra paths avoid crawling along the page edges. Feed the result to
`H.river.dijkstra` if you want that behaviour.

### `H.river.dijkstra(graph, start, end)`

```ts
H.river.dijkstra(graph: PageGraph, start: number, end: number):
  { nodeIds: number[]; gutterIds: number[] }
```

The raw shortest-path over graph node ids. Returns empty arrays if `end` is
unreachable.

### `H.river.obstaclesFrom(words, selectedIds, pad?)`

```ts
H.river.obstaclesFrom(words: Word[], selectedIds: Iterable<number>, pad = 1): Bbox[]
```

Convenience: the bounding boxes of every word **except** the selected ids
(padded), ready to pass as `flow`'s `obstacles` — i.e. "route around everything
I'm not keeping".
