# humument-data

Per-page OCR data for the **1892 one-volume Chapman & Hall edition** of
W. H. Mallock's *A Human Document* — the novel Tom Phillips treated to make
*A Humument*. This package is the data layer consumed by
[humument-lib](https://www.npmjs.com/package/humument-lib); most users should
use that library instead of fetching these files directly.

## Layout

```
db/
  catalog.json          { pages: [...], chapters: [...] }
  search-index.json     { token: [[pageNum, count], ...] }
  pages/pNNNN.json.gz   one per printed page (1–367), gzipped JSON:
                        { meta, words[], gutters[], docks[], graph[] }
```

Page files are **gzip-compressed** (the raw set is ~159MB; gzipped ~26MB so
CDNs will serve it). Decode in the browser with `DecompressionStream`:

```js
const res = await fetch('https://cdn.jsdelivr.net/npm/humument-data@0.1/db/pages/p0040.json.gz');
const page = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
```

`words[]` carry text, pixel bboxes (on the 1400×2100 normalized page images —
see [humument-images](https://www.npmjs.com/package/humument-images)),
line index, OCR confidence, punctuation prefix/suffix, and NLP annotations
(POS, lemma, frequency, rarity). `gutters`/`docks`/`graph` describe the
inter-word whitespace and a navigable graph for drawing Phillips-style
"rivers".

## Provenance

OCR'd (Apple Vision) from the Internet Archive scan
[`ahumandocumenta04mallgoog`](https://archive.org/details/ahumandocumenta04mallgoog).
The 1892 novel is in the public domain; this packaging and the derived data
are MIT-licensed. `pNNNN` is the printed book page = the *A Humument* page.
