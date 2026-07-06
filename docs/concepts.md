# Concepts

The vocabulary `humument-lib` uses, and how the pieces fit together. Every term
here maps to a concrete type in [`src/types.ts`](https://github.com/yz3440/humument/blob/main/humument-lib/src/types.ts)
and a section of the [Library API](api/index.md).

## Coordinate system

All coordinates are **pixel coordinates on the normalized page image**, which is
**1400 × 2100** grayscale (see [humument-images](data/packages.md)). The origin
is the **top-left**, with the **y-axis pointing down** — the same convention as
an HTML `<canvas>`. A bounding box is
`{ x0, y0, x1, y1 }` (`Bbox`), and a point is `{ x, y }` (`Pt`).

Because the word boxes are in this image's pixel space, drawing over the page is
1:1: size your canvas to `H.page.width × H.page.height`, draw the page scan at
`(0, 0)`, and every word/gutter/river coordinate lands in the right place.

## Pages

A page is one printed leaf of the 1892 edition, numbered **1–367** — the same
number Tom Phillips used, because this edition maps page-for-page onto
_A Humument_. `Humument.load({ page })` returns everything for one page:
`H.page` (dimensions, the type-block `body` bbox, the OCR-`valid` region, and the
image URL) plus the words and whitespace geometry below.

## Words and lines

A **word** (`Word`) is one OCR'd token: its `text`, its pixel box
(`x0,y0,x1,y1`), a 0-based `lineIdx` within the page, OCR `conf`idence, split-off
`prefix`/`suffix` punctuation, and NLP annotations — `pos` (spaCy UPOS tag),
`lemma`, `freq` (modern-corpus frequency), `rarity` (normalized log-inverse
frequency, higher = rarer), and the `isContent` / `isConnective` flags.

`H.words` is the page's words sorted by `(lineIdx, x0)`; `H.lines` is the same
words grouped into lines. These annotations are what the chunker scores on.

## Chunks

A **chunk** is a short, reading-order-adjacent phrase — the candidate "kept
words" of an erasure. The chunker (`H.chunks` / `H.selectChunks`) matches two
shallow part-of-speech patterns greedily, longest-first:

```text
NP := ADP? (DET|PRON|VERB)? (ADJ|ADV|NUM)* (NOUN|PROPN)+
VP := ADV* (VERB|AUX) (ADJ|ADV|NUM|AUX|PART)*
```

so a chunk reads as a little noun or verb phrase ("the embracing thoughts",
"quietly waited"). `selectChunks` then scores each phrase (favoring rarer words
and 2–3-word phrases ending on a noun, penalizing clichés) and picks the top few,
spread across the page by line distance so they don't clump. See
[Chunks](api/chunks.md).

## Whitespace geometry

The pipeline precomputes the empty space _between_ the type so you can route
rivers without any image analysis at runtime. Three related structures:

- **Gutters** (`H.gutters`) — the channels of whitespace. A `Gutter` is either a
  horizontal inter-line gap (`h_line`) or a vertical intra-line slit
  (`v_slit`), described by a centre-line `polyline`, its narrowest `minWidth`,
  and a heuristic `riverScore` (how river-like it looks).
- **Docks** (`H.docks`, a `Map<wordId, Dock>`) — for each word, how much empty
  space it has in each direction (`breathing*`), which direction has the most
  slack, and the **ports** (compass-tagged entry/exit points) into the
  surrounding gutters.
- **Navigation graph** (`H.graph`) — a graph whose nodes are gutter/port
  positions and whose edges are the traversable whitespace, weighted by
  distance. This is what the Dijkstra river pathfinder walks.

See [Pages & Words](api/pages.md) for the exact shapes.

## Rivers

A **river** is a path of whitespace connecting two kept words — the hand-drawn
line Phillips runs between the words he keeps. `humument-lib` finds them two
ways ([Rivers](api/rivers.md)):

- **`H.river.between(a, b)`** — Dijkstra over the whitespace graph. Constrained
  to real gutters, cheap, and returns a `ChannelSegment` (an ordered polyline
  plus the gutter id used for each span, so a renderer can vary stroke width).
- **`H.river.flow(a, b, opts)`** — a greedy walk through a Perlin noise field,
  biased toward the target and away from obstacle words. Organic, and a good
  fallback when the graph can't connect two words (island gutters).

## Balloons and ribbons

The geometry helpers turn bounding boxes and river paths into point arrays you
can render with any 2D API:

- A **balloon** (`H.geom.balloon`) is a wobbly closed loop around a word or
  phrase's bounding box — the outline you'd ink around a kept fragment.
- A **channel / ribbon** (`H.geom.channel`) turns a river `ChannelSegment` into a
  thick wavy band that meanders within its gutter.

Both are driven by cheap **seedable value-noise** (`H.noise`, `H.random`), so a
given seed always redraws the same hand-drawn wobble. See
[Geometry](api/geometry.md) and [Noise & Random](api/noise.md).

## Chapters

A **chapter** (`ChapterRef`) is a page whose top line reads "CHAPTER &lt;Roman&gt;".
`Humument.catalog.listChapters()` returns them as `{ pageNum, label, roman }`,
the chapter taken to start on that page and run until the next.
