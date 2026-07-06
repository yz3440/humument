# Data Format

`Humument.load` fetches static JSON produced by the pipeline's
[`03_export_web.py`](https://github.com/yz3440/humument/blob/main/pipeline/03_export_web.py).
You can point the loader at [any origin](../api/loading.md#overriding-the-data-source)
that serves these files with these shapes — the npm packages are just one such
origin. Shapes are camelCase and match the exported [types](../api/index.md#types)
exactly, so decoding is a plain `JSON.parse`.

## The files

Given a `dataBase` and an `imageBase`:

| URL | Contents |
| --- | --- |
| `${dataBase}/catalog.json` | `{ "pages": number[], "chapters": [{ "pageNum", "label", "roman" }] }` |
| `${dataBase}/pages/pNNNN.json` | One page: `{ "meta", "words"[], "gutters"[], "docks"[], "graph"[] }` |
| `${dataBase}/pages/pNNNN.json.gz` | Gzipped twin of the above (tried first). |
| `${dataBase}/search-index.json` | `{ "<token>": [[pageNum, count], …] }` (lowercased tokens). |
| `${imageBase}/pNNNN.jpg` | One page image (1400 × 2100 grayscale JPEG). |

`NNNN` is the **zero-padded printed page**, e.g. `p0033`.

### Gzip twin

Page fetches try `pages/pNNNN.json.gz` first, decoding it in the browser with
[`DecompressionStream`](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream),
and fall back to plain `pNNNN.json`. The npm-hosted data ships **only** the `.gz`
files (the plain set exceeds jsDelivr's package-size limit); a self-hosted export
can supply either.

```js
const res = await fetch(`${dataBase}/pages/p0033.json.gz`);
const page = await new Response(
  res.body.pipeThrough(new DecompressionStream('gzip'))
).json();
```

## Per-page JSON shape

```jsonc
{
  "meta":   { "width": 1400, "height": 2100, "body": {…} | null, "valid": {…} | null },
  "words":  [ /* Word objects: id, text, x0,y0,x1,y1, lineIdx, conf,
                 prefix, suffix, pos, lemma, freq, rarity, isContent, isConnective */ ],
  "gutters":[ /* Gutter objects: gutterId, kind, lineIdxA/B, x0,y0,x1,y1,
                 polyline, minWidth, riverScore */ ],
  "docks":  [ /* Dock objects, one per word (decoded into a Map<wordId, Dock>) */ ],
  "graph":  [ /* compact node tuples: [id, x, y, edges],
                 edges = [ [neighborId, cost, gutterId], … ] */ ]
}
```

Two representations differ between the wire format and what `H` gives you:

- **`docks`** ships as an array and is decoded into `H.docks`, a
  `Map<wordId, Dock>`.
- **`graph`** ships as compact `[id, x, y, edges]` tuples (the informational
  `kind` field is dropped to save bytes) and is decoded into `H.graph`, a
  `PageGraph` with a `Map<id, GraphNode>`.

Everything else parses 1:1 into the types documented under
[Pages & Words](../api/pages.md). Pixel coordinates are on the 1400 × 2100
normalized image ([Concepts → Coordinate system](../concepts.md#coordinate-system)).

## The OCR database

The JSON above is exported from `data/humument.db`, a **SQLite** database keyed
by `page_num` (1–367) — the canonical OCR artifact (see
[The Pipeline](../pipeline.md)). Its six tables map onto the JSON like so:

| Table | Holds | Exported into |
| --- | --- | --- |
| `pages` | `page_num`, image path, `width_px`, `height_px`. | `meta.width` / `meta.height` |
| `words` | one row per OCR'd word (bbox, line, conf, punctuation, NLP columns). | `words[]` |
| `page_corrections` | per-page deskew angle/offset + body/valid bboxes. Its `page_num` set **is** the content range. | `meta.body` / `meta.valid`; `catalog.pages` |
| `page_gutters` | whitespace gutters/slits (`polyline_json`, `min_width`, `river_score`). | `gutters[]` |
| `word_docks` | per-word breathing room, slack direction, `ports_json`. | `docks[]` |
| `page_graph` | navigation nodes (`x`, `y`, `edges_json`). | `graph[]` |

The `catalog.json` `chapters` are computed at export time from pages whose top
line reads "CHAPTER &lt;Roman&gt;", and `search-index.json` is built by counting
lowercased word tokens per page. Consumers never touch SQLite — they only see the
static JSON.

## Building your own

To host the data yourself, run the pipeline's stage 03 (or produce equivalent
JSON) and serve `output/db/` as `dataBase` and your page images as `imageBase`.
See [The Pipeline](../pipeline.md) and
[Overriding the data source](../api/loading.md#overriding-the-data-source).
