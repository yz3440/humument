# Loading & Catalog

The `Humument` object is the entry point: it configures where data comes from,
loads a page, and exposes catalog helpers you can call before loading anything.

## `Humument.load(opts)`

```ts
Humument.load(opts: HumumentLoadOptions): Promise<HumumentInstance>
```

Fetches one page's data and returns an [`H` instance](index.md#the-h-instance).
Calls `init` internally, so you don't have to.

```js
const H = await Humument.load({ page: 33 });
```

`HumumentLoadOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | `number` | — | Printed page number, 1–367. Required. |
| `dataBase` | `string?` | npm/jsDelivr | Base URL holding `catalog.json` + `pages/pNNNN.json(.gz)`. |
| `imageBase` | `string?` | npm/jsDelivr | Base URL for page JPEGs (`${imageBase}/pNNNN.jpg`). |

The library never loads the page scan itself — take `H.page.imageUrl` and load
it with your renderer (see [Quick Start](../quickstart.md)).

## `Humument.init(opts)`

```ts
Humument.init(opts?: InitOptions): Promise<void>   // InitOptions = { dataBase?, imageBase? }
```

Sets the base URLs and **warms the catalog** so `catalog.*` is ready. It's
idempotent, resets the per-page cache, and `load` calls it for you — call it
directly only when you want catalog data (a page list, chapters, search) *before*
loading a page:

```js
await Humument.init();                       // defaults → jsDelivr
const pages = await Humument.catalog.listPages();
```

## CDN defaults

With no `dataBase`/`imageBase`, the loader points at the npm-published data via
jsDelivr — the `@0.1` tag floats on the newest `0.1.x` data release, so data
fixes reach sketches without a library update:

```js
import { CDN_DATA_BASE, CDN_IMAGE_BASE } from 'humument-lib';
// 'https://cdn.jsdelivr.net/npm/humument-data@0.1/db'
// 'https://cdn.jsdelivr.net/npm/humument-images@0.1/pages'
```

## Overriding the data source

Pass `dataBase` / `imageBase` to `load` or `init` to serve the data from
somewhere else — a CORS-enabled host of your own, or a self-hosted export:

```js
// A CORS-enabled copy you host:
Humument.load({
  page: 33,
  dataBase:  'https://your-host.example/db',
  imageBase: 'https://your-host.example/pages_normalized',
});

// A self-hosted export served next to your page:
Humument.load({ page: 33, dataBase: '/db', imageBase: '/pages_normalized' });
```

Any origin that serves the [Data Format](../data/format.md) works. Trailing
slashes are trimmed for you.

## Catalog helpers

`Humument.catalog.*` reads the catalog and search index. All are async except
`pageImageUrl`. They work after `init` (or after any `load`).

### `listPages()`

```ts
listPages(): Promise<number[]>
```

Content page numbers, ascending (the export ships only content pages).

### `listAllPageRefs()`

```ts
listAllPageRefs(): Promise<PageRef[]>   // PageRef = { pageNum }
```

The same pages as `{ pageNum }` objects, handy for catalog UIs.

### `listChapters()`

```ts
listChapters(): Promise<ChapterRef[]>   // ChapterRef = { pageNum, label, roman }
```

Chapter-opening pages detected from the OCR (a top line reading
"CHAPTER &lt;Roman&gt;"), e.g. `{ pageNum: 12, label: 'CHAPTER III', roman: 'III' }`.

### `searchPages(query, opts?)`

```ts
searchPages(query: string, opts?: { limit?: number }): Promise<PageMatch[]>
```

Substring search over the OCR tokens. Ranks pages by total hit count and returns
`PageMatch = { pageNum, hits, snippet }`, where `snippet` is a short window
around the first hit on the page. `opts.limit` defaults to `50`. The search index
is lazy-loaded on first call.

```js
const hits = await Humument.catalog.searchPages('window', { limit: 10 });
```

### `getWords(page)`

```ts
getWords(pageNum: number): Promise<Word[]>
```

Just the words for a page (the same array you'd get as `H.words`), without
building a full instance — useful for word-overlay previews.

### `pageImageUrl(page)`

```ts
pageImageUrl(pageNum: number): string
```

Synchronous. Builds `${imageBase}/pNNNN.jpg` from the configured image base
(so call `init`/`load` first). This is the same value as `H.page.imageUrl`.
