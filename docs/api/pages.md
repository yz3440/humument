# Pages & Words

Once you have an [`H` instance](index.md#the-h-instance), the page's content and
whitespace geometry hang off it directly. All coordinates are pixels on the
1400 × 2100 page image (see [Concepts → Coordinate system](../concepts.md#coordinate-system)).

## `H.page`

```ts
H.page: {
  number: number;
  width: number;
  height: number;
  body: Bbox | null;      // type-block (printed area) bbox
  valid: Bbox | null;     // OCR-valid region, usually == body
  imageUrl: string;       // always set — load this with your renderer
}
```

`body` / `valid` are `null` only if the page wasn't tilt-corrected. The library
never loads the page scan itself — take `imageUrl` and load it with your renderer
(see [Quick Start](../quickstart.md)).

## Words

```ts
H.words: Word[]                      // sorted by (lineIdx, x0)
H.lines: Word[][]                    // the same words grouped into lines
H.wordById(id: number): Word | undefined
H.bboxOf(words: Iterable<Word>): Bbox // union bbox; zero-area at origin if empty
```

### `Word`

```ts
interface Word {
  id: number;              // DB primary key — stable across re-OCRs
  text: string;
  x0: number; y0: number; x1: number; y1: number;  // pixel bbox
  lineIdx: number;         // 0-based line index within the page
  conf: number;            // OCR confidence in [0, 1]
  prefix: string | null;   // leading punctuation/quotes, else null
  suffix: string | null;   // trailing punctuation, else null
  pos: string | null;      // spaCy UPOS tag — NOUN, VERB, ADJ, …
  lemma: string | null;
  freq: number | null;     // wordfreq score (modern-corpus frequency)
  rarity: number | null;   // normalized log inverse frequency, [0,1]; higher = rarer
  isContent: 0 | 1;        // 1 if NOUN/VERB/ADJ/ADV
  isConnective: 0 | 1;     // 1 if it reads as a connective bridge
}
```

`rarity` and `isContent` are what the [chunk scorer](chunks.md#hchunkscorechunk)
rewards; `pos` drives the [chunker's patterns](chunks.md).

### `Bbox` and `Pt`

```ts
interface Bbox { x0: number; y0: number; x1: number; y1: number }
interface Pt   { x: number; y: number }
```

`bboxOf` is the usual bridge from a phrase to a balloon:

```js
const box = H.bboxOf(phrase);            // phrase: Word[]
const outline = H.geom.balloon(box);     // → Pt[]
```

## Whitespace geometry

The pipeline precomputes these so runtime needs no image analysis. See
[Concepts → Whitespace geometry](../concepts.md#whitespace-geometry) for the
narrative; the shapes:

### `H.gutters: Gutter[]`

```ts
interface Gutter {
  gutterId: number;
  kind: 'h_line' | 'v_slit';         // horizontal inter-line gap / vertical intra-line slit
  lineIdxA: number | null;           // line above (h_line) or left (v_slit); null at edges
  lineIdxB: number | null;           // line below (h_line) or right (v_slit); null at edges
  x0: number; y0: number; x1: number; y1: number;
  polyline: [number, number][];      // centre-line of the channel
  minWidth: number;                  // narrowest width along its length, px
  riverScore: number;                // heuristic: how "river-like" it looks
}
```

### `H.docks: Map<number, Dock>`

Keyed by `wordId`.

```ts
interface Dock {
  wordId: number;
  breathingTop: number; breathingBottom: number;   // px to nearest obstacle
  breathingLeft: number; breathingRight: number;   //   in each direction
  slackDirection: string;                          // direction with most slack, e.g. "NE"
  ports: Port[];                                    // entry/exit points into gutters
  dockAbove: number | null; dockBelow: number | null;
  dockLeft: number | null;  dockRight: number | null;   // neighbouring gutter ids
}

interface Port {
  x: number; y: number;
  gutterId: number;
  compass: 'N' | 'S' | 'E' | 'W';
  nodeId: number;      // corresponding node in H.graph
}
```

### `H.graph: PageGraph`

```ts
interface PageGraph { nodes: Map<number, GraphNode> }

interface GraphNode {
  id: number;
  x: number; y: number;
  kind: string;                             // informational (empty in the JSON export)
  edges: [number, number, number][];        // [neighborId, edgeCost, gutterId] tuples
}
```

This is the graph the Dijkstra pathfinder walks. You rarely touch it directly —
[`H.river.between`](rivers.md#hriverbetweena-b) does — but `H.river.dijkstra`
and `H.river.penalizeBorders` operate on it if you want to.
