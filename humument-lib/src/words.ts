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

/** Full-text search over the OCR text.
 *
 *  A single-word query is a substring match against the lowercased token keys
 *  of the prebuilt index (so it stays substring-like, not stemmed), ranked by
 *  total hits — no per-page fetch needed for ranking.
 *
 *  A multi-word query is treated as a *phrase*: it matches where the query
 *  appears as consecutive words in reading order within a line. The index is
 *  used only to narrow the candidate pages (those containing every term); the
 *  phrase itself is confirmed against each candidate page's actual text.
 *
 *  In both cases a snippet is built lazily from the matched page's JSON.
 *  `opts.limit` defaults to `50`. */
export async function searchPages(
  query: string,
  opts: { limit?: number } = {},
): Promise<PageMatch[]> {
  const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 50;
  const terms = q.split(' ');
  return terms.length > 1
    ? searchPhrase(q, terms, limit)
    : searchToken(q, limit);
}

/** Single-word path: rank every matching page straight from the index, then
 *  fetch only the top `limit` pages to build their snippets. */
async function searchToken(q: string, limit: number): Promise<PageMatch[]> {
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

  return Promise.all(ranked.map(async ([pageNum, hits]): Promise<PageMatch> => {
    let snippet = '';
    try {
      snippet = matchOnPage((await getPageData(pageNum)).words, q).snippet;
    } catch { /* snippet is best-effort */ }
    return { pageNum, hits, snippet };
  }));
}

/** Multi-word (phrase) path: intersect the per-term candidate pages from the
 *  index, then confirm the phrase against each candidate's real text. */
async function searchPhrase(
  q: string,
  terms: string[],
  limit: number,
): Promise<PageMatch[]> {
  const index = await getSearchIndex();

  // Pages that contain a token matching every term (a necessary condition for
  // the phrase to appear). Cheap prefilter; the phrase is verified per page.
  const perTerm: Set<number>[] = [];
  for (const term of terms) {
    const forTerm = new Set<number>();
    for (const token in index) {
      if (!token.includes(term)) continue;
      for (const [page] of index[token]) forTerm.add(page);
    }
    if (!forTerm.size) return [];
    perTerm.push(forTerm);
  }
  // Intersect by scanning the smallest set against the rest.
  perTerm.sort((a, b) => a.size - b.size);
  const candidates: number[] = [];
  perTerm[0].forEach((page) => {
    if (perTerm.every((s) => s.has(page))) candidates.push(page);
  });
  if (!candidates.length) return [];

  const matched = await Promise.all(
    candidates.map(async (pageNum): Promise<PageMatch | null> => {
      try {
        const { hits, snippet } = matchOnPage((await getPageData(pageNum)).words, q);
        return hits ? { pageNum, hits, snippet } : null;
      } catch {
        return null;
      }
    }),
  );

  return matched
    .filter((m): m is PageMatch => m !== null)
    .sort((a, b) => b.hits - a.hits || a.pageNum - b.pageNum)
    .slice(0, limit);
}

/** Count occurrences of `q` (a lowercased word or phrase) as consecutive words
 *  within a single line, and build a ~6-word snippet around the first hit.
 *  Phrases are matched against each line's space-joined text in reading order. */
function matchOnPage(words: Word[], q: string): { hits: number; snippet: string } {
  let hits = 0;
  let snippet = '';
  for (const line of groupByLine(words)) {
    // Char offset where each word's text begins in the space-joined line.
    const texts = line.map((w) => w.text.toLowerCase());
    const offsets: number[] = [];
    let pos = 0;
    for (const t of texts) { offsets.push(pos); pos += t.length + 1; }
    const joined = texts.join(' ');

    let at = joined.indexOf(q);
    while (at !== -1) {
      hits++;
      if (!snippet) {
        const endChar = at + q.length - 1;
        let startWord = 0, endWord = 0;
        for (let k = 0; k < offsets.length; k++) {
          if (offsets[k] <= at) startWord = k;
          if (offsets[k] <= endChar) endWord = k;
        }
        const from = Math.max(0, startWord - 3);
        const to = Math.min(line.length, endWord + 4);
        snippet =
          (from > 0 ? '… ' : '') +
          line.slice(from, to).map((w) => w.text).join(' ') +
          (to < line.length ? ' …' : '');
      }
      at = joined.indexOf(q, at + q.length);
    }
  }
  return { hits, snippet };
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
