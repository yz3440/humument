/**
 * Static data layer. The editor ships as a fully static site: instead of
 * loading a SQLite DB in the browser, it fetches small per-page JSON files
 * (plus a catalog and a search index) produced by `pipeline/03_export_web.py`.
 *
 * Everything is fetched lazily and cached. `init()` warms the catalog so the
 * page list / chapters are ready; per-page data is fetched on first use.
 */

export interface InitOptions {
  /**
   * Base URL holding catalog.json, pages/pNNNN.json(.gz), search-index.json.
   * Defaults to the npm-hosted data (humument-data via jsDelivr).
   */
  dataBase?: string;
  /**
   * Base URL for page JPEGs (`${imageBase}/pNNNN.jpg`).
   * Defaults to the npm-hosted images (humument-images via jsDelivr).
   */
  imageBase?: string;
}

/** npm-hosted data/images, served by jsDelivr. `@0.1` floats on the newest
 *  0.1.x data release, so data fixes reach sketches without a lib update. */
export const CDN_DATA_BASE = 'https://cdn.jsdelivr.net/npm/humument-data@0.1/db';
export const CDN_IMAGE_BASE = 'https://cdn.jsdelivr.net/npm/humument-images@0.1/pages';

export interface Catalog {
  pages: number[];
  chapters: { pageNum: number; label: string; roman: string }[];
}

/** token (lowercased) → [pageNum, count] pairs, sorted by count desc. */
export type SearchIndex = Record<string, [number, number][]>;

let cfg = { dataBase: CDN_DATA_BASE, imageBase: CDN_IMAGE_BASE };
let catalogP: Promise<Catalog> | null = null;
let searchP: Promise<SearchIndex> | null = null;
const pageCache = new Map<number, Promise<unknown>>();

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

/**
 * Per-page JSON, gzipped twin first. The npm-hosted data ships only
 * `pNNNN.json.gz` (the plain set exceeds jsDelivr's package size limit);
 * plain `.json` remains as the fallback for self-hosts and old browsers
 * without DecompressionStream.
 */
async function fetchPageJSON<T>(base: string): Promise<T> {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const r = await fetch(`${base}.json.gz`);
      if (r.ok && r.body) {
        const gunzip = r.body.pipeThrough(new DecompressionStream('gzip'));
        return (await new Response(gunzip).json()) as T;
      }
    } catch {
      // fall through to plain .json
    }
  }
  return fetchJSON<T>(`${base}.json`);
}

/** Configure base URLs and warm the catalog. Idempotent. */
export async function init(opts: InitOptions = {}): Promise<void> {
  cfg = {
    dataBase: (opts.dataBase ?? cfg.dataBase).replace(/\/$/, ''),
    imageBase: (opts.imageBase ?? cfg.imageBase).replace(/\/$/, ''),
  };
  catalogP = null;
  searchP = null;
  pageCache.clear();
  await getCatalog();
}

export function config(): { dataBase: string; imageBase: string } {
  return cfg;
}

export function getCatalog(): Promise<Catalog> {
  return (catalogP ??= fetchJSON<Catalog>(`${cfg.dataBase}/catalog.json`));
}

export function getSearchIndex(): Promise<SearchIndex> {
  return (searchP ??= fetchJSON<SearchIndex>(`${cfg.dataBase}/search-index.json`));
}

/** Raw per-page JSON (deduped + cached by page number). */
export function getPageRaw<T = unknown>(pageNum: number): Promise<T> {
  let p = pageCache.get(pageNum);
  if (!p) {
    const base = `${cfg.dataBase}/pages/p${String(pageNum).padStart(4, '0')}`;
    p = fetchPageJSON(base);
    pageCache.set(pageNum, p);
  }
  return p as Promise<T>;
}

/** Reset caches (tests / hot-reload). */
export function resetData(): void {
  catalogP = null;
  searchP = null;
  pageCache.clear();
}
