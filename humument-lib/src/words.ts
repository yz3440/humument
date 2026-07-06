/**
 * Page-level data accessors backed by the static JSON export
 * (`pipeline/03_export_web.py`): one fetch per page, plus a catalog and a
 * search index. All page/catalog/search reads are async; the per-page JSON is
 * shaped to match these types, so decoding is trivial.
 */

import { getCatalog, getPageRaw, getSearchIndex, config } from './data.js';
import type {
  Bbox, ChapterRef, Dock, GraphNode, Gutter, PageGraph, PageMatch, PageMeta,
  PageRef, Word,
} from './types.js';

/** Fully decoded page payload. */
export interface PageData {
  meta: PageMeta;
  words: Word[];
  gutters: Gutter[];
  docks: Map<number, Dock>;
  graph: PageGraph;
}

interface RawPage {
  meta: PageMeta;
  words: Word[];
  gutters: Gutter[];
  docks: Dock[];
  /** Compact node tuples: [id, x, y, edges]. */
  graph: [number, number, number, [number, number, number][]][];
}

/** Fetch + decode one page (words already sorted by lineIdx, x0 at export). */
export async function getPageData(pageNum: number): Promise<PageData> {
  const j = await getPageRaw<RawPage>(pageNum);
  const docks = new Map<number, Dock>();
  for (const d of j.docks) docks.set(d.wordId, d);
  const nodes = new Map<number, GraphNode>();
  for (const [id, x, y, edges] of j.graph) {
    nodes.set(id, { id, x, y, kind: '', edges });
  }
  return { meta: j.meta, words: j.words, gutters: j.gutters, docks, graph: { nodes } };
}

/** Words for a page (used by the editor's word overlay). */
export async function getWords(pageNum: number): Promise<Word[]> {
  return (await getPageData(pageNum)).words;
}

/** Content page numbers, ascending. (`contentOnly` kept for API compatibility;
 *  the export only ships content pages.) */
export async function listPages(_contentOnly = true): Promise<number[]> {
  return (await getCatalog()).pages;
}

export async function listAllPageRefs(): Promise<PageRef[]> {
  return (await getCatalog()).pages.map((pageNum) => ({ pageNum }));
}

export async function listChapters(): Promise<ChapterRef[]> {
  return (await getCatalog()).chapters.map((c) => ({ ...c }));
}

/** Substring search over OCR word tokens. Matches the query against the
 *  lowercased token keys of the prebuilt index (so it stays substring-like,
 *  not stemmed), ranks pages by total hits, and builds a snippet lazily from
 *  each matched page's JSON. */
export async function searchPages(
  query: string,
  opts: { limit?: number } = {},
): Promise<PageMatch[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 50;
  const index = await getSearchIndex();

  const hitsByPage = new Map<number, number>();
  for (const token in index) {
    if (!token.includes(q)) continue;
    for (const [page, count] of index[token]) {
      hitsByPage.set(page, (hitsByPage.get(page) ?? 0) + count);
    }
  }
  const ranked = [...hitsByPage.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit);
  if (!ranked.length) return [];

  return Promise.all(ranked.map(async ([pageNum, hits]): Promise<PageMatch> => {
    let snippet = '';
    try {
      const { words } = await getPageData(pageNum);
      const i = words.findIndex((w) => w.text.toLowerCase().includes(q));
      if (i >= 0) {
        const line = words.filter((w) => w.lineIdx === words[i].lineIdx);
        const at = line.indexOf(words[i]);
        const start = Math.max(0, at - 3);
        const end = Math.min(line.length, at + 4);
        snippet =
          (start > 0 ? '… ' : '') +
          line.slice(start, end).map((w) => w.text).join(' ') +
          (end < line.length ? ' …' : '');
      }
    } catch { /* snippet is best-effort */ }
    return { pageNum, hits, snippet };
  }));
}

export async function getPageMeta(pageNum: number): Promise<PageMeta | null> {
  try {
    return (await getPageData(pageNum)).meta;
  } catch {
    return null;
  }
}

/* ---- pure helpers (no fetch) --------------------------------------- */

export function groupByLine(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  let curLine = -1;
  for (const w of words) {
    if (w.lineIdx !== curLine) {
      if (cur.length) out.push(cur);
      cur = [w];
      curLine = w.lineIdx;
    } else {
      cur.push(w);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Union bounding box of an iterable of words. Returns a zero-area bbox at
 *  origin if the input is empty. */
export function bboxOf(words: Iterable<Word>): Bbox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const w of words) {
    any = true;
    if (w.x0 < x0) x0 = w.x0;
    if (w.y0 < y0) y0 = w.y0;
    if (w.x1 > x1) x1 = w.x1;
    if (w.y1 > y1) y1 = w.y1;
  }
  if (!any) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/** Build the page-image URL from the configured image base. */
export function pageImageUrl(pageNum: number): string {
  return `${config().imageBase}/p${String(pageNum).padStart(4, '0')}.jpg`;
}
