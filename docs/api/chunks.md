# Chunks (phrase selection)

The chunker finds short, reading-order phrases on a page — the candidate "kept
words" of an erasure — and selects a spread of the strongest ones. See
[Concepts → Chunks](../concepts.md#chunks) for the idea.

## `H.chunks(opts?)`

```ts
H.chunks(opts?: ChunksOptions): Word[][]
```

All matching chunks on the page. Each chunk is a `Word[]` in reading order.

Two shallow POS patterns are matched greedily, longest-first, over
adjacency runs (words within one line of each other, `|Δ lineIdx| ≤ 1`):

```text
NP := ADP? (DET|PRON|VERB)? (ADJ|ADV|NUM)* (NOUN|PROPN)+
VP := ADV* (VERB|AUX) (ADJ|ADV|NUM|AUX|PART)*
```

A leading `VERB` inside `NP` captures gerund/participial modifiers
("embracing thoughts").

`ChunksOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxLen` | `number?` | `4` | Maximum words per chunk. |
| `candidates` | `Word[]?` | `passesCandidacy` filter | Pre-filtered candidate words. |

By default the candidate list is every word that passes
[`passesCandidacy`](#hpassescandidacyword-headerlines) (header lines and the
running page number are excluded automatically).

## `H.selectChunks(opts?)`

```ts
H.selectChunks(opts?: SelectChunksOptions): Word[][]
```

Scores every chunk with [`chunkScore`](#hchunkscorechunk) and picks the best
few, **spread across the page** so they don't clump on adjacent lines. The
result is sorted by `(lineIdx, x0)`.

`SelectChunksOptions` extends `ChunksOptions` and adds:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `nSeeds` | `number?` | `3` | How many chunks to pick. |
| `minLineDist` | `number?` | `2` | Minimum line distance between picks. |
| `seed` | `number?` | `42` | PRNG seed for the shuffle. |
| `variation` | `number?` | `0` | `0` = pure top-N, `1` = light shuffle, `2` = wider shuffle. |

```js
const phrases = H.selectChunks({ nSeeds: 4, minLineDist: 3, seed: 42 });
// each phrase is a Word[]; turn it into a balloon outline to render:
const outlines = phrases.map((ph) => H.geom.balloon(H.bboxOf(ph), { wobble: 0.15 }));
```

With `variation: 0` (the default) you get the deterministic top-N. Raising it
shuffles among the strongest candidates using `seed`, so different seeds yield
different — but still strong — selections.

## `H.chunkScore(chunk)`

```ts
H.chunkScore(chunk: Word[]): number
```

The heuristic `selectChunks` ranks by. Higher is better:

- **+ `rarity`** of each word (rarer words score higher);
- **+0.4** per content word; a chunk with **no** content word scores **−999**
  (effectively disqualified);
- **−0.4** for each banned cliché (`heart`, `soul`, `love`, `dream`, `hope`,
  `darkness`, `light`, `shadow`);
- a **length bonus**: 2 words `+0.7`, 3 words `+0.6`, 4 words `+0.2`, 1 word
  `+0`, longer `−0.4`;
- **+0.4** if the last word is a `NOUN` or `PROPN`.

## `H.passesCandidacy(word, headerLines?)`

```ts
H.passesCandidacy(word: Word, headerLines?: Set<number>): boolean
```

Whether a word is eligible to appear in a chunk. Rejects: a small plot-name
blocklist, words with `conf < 0.7`, single characters other than `I`/`a`/`O`,
the page number / header digits (numbers on line ≤ 1), and words on detected
header lines. `headerLines` defaults to an empty set; `H.chunks` computes and
passes the real header lines for you.

## POS helpers

The UPOS tag constants and two convenience predicates (over a word's `pos`):

```ts
H.POS   // { NOUN:'NOUN', VERB:'VERB', ADJ:'ADJ', ADV:'ADV', ADP:'ADP', DET:'DET',
        //   PRON:'PRON', NUM:'NUM', PROPN:'PROPN', AUX:'AUX', PART:'PART',
        //   CCONJ:'CCONJ', SCONJ:'SCONJ' }

H.HEAD(w)  // true if w.pos is NOUN or PROPN   (a phrase head)
H.MOD(w)   // true if w.pos is ADJ, ADV, or NUM (a modifier)
```
