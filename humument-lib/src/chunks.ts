/**
 * Shallow POS-pattern chunker over a page's words.
 *
 * Patterns matched greedily, longest-first:
 *   NP := ADP? (DET|PRON|VERB)? (ADJ|ADV|NUM)* (NOUN|PROPN)+
 *   VP := ADV* (VERB|AUX) (ADJ|ADV|AUX|PART)*
 *
 * A leading VERB inside NP captures gerund/participial modifiers
 * ("embracing thoughts"). Words must be reading-order adjacent and within
 * one line of each other.
 *
 * Public API:
 *   chunks(opts)        -> Word[][]   — all matching chunks on the page
 *   selectChunks(opts)  -> Word[][]   — top-N by chunkScore, line-distributed
 *   chunkScore(chunk)   -> number
 *   passesCandidacy(w)  -> boolean
 */

import { mulberry32 } from './noise.js';
import type { Word } from './types.js';

/* ---------- candidacy ---------------------------------------------- */

const PLOT_NAME_BLOCKLIST = new Set(['grenville']);
const BANNED_CLICHES = new Set([
  'heart', 'soul', 'love', 'dream', 'hope', 'darkness', 'light', 'shadow',
]);

export function detectHeaderLines(words: Word[]): Set<number> {
  const lineWords = new Map<number, Word[]>();
  for (const w of words) {
    if (!lineWords.has(w.lineIdx)) lineWords.set(w.lineIdx, []);
    lineWords.get(w.lineIdx)!.push(w);
  }
  const out = new Set<number>();
  for (const [lineIdx, ws] of lineWords) {
    if (lineIdx > 1) continue;
    const allUpper = ws.every((w) => w.text === w.text.toUpperCase());
    const text = ws.map((w) => w.text).join(' ');
    if (allUpper && text.includes('HUMAN DOCUMENT')) out.add(lineIdx);
  }
  return out;
}

export function isHeaderOrPagenum(w: Word): boolean {
  return /^\d+$/.test(w.text) && w.lineIdx <= 1;
}

export function passesCandidacy(w: Word, headerLines: Set<number>): boolean {
  const lower = w.text.toLowerCase();
  if (PLOT_NAME_BLOCKLIST.has(lower)) return false;
  if (w.conf < 0.7) return false;
  if (w.text.length === 1 && !['I', 'a', 'O'].includes(w.text)) return false;
  if (isHeaderOrPagenum(w)) return false;
  if (headerLines.has(w.lineIdx)) return false;
  return true;
}

/* ---------- POS classification ------------------------------------- */

type PC = 'ADP' | 'DET' | 'PRON' | 'ADJ' | 'ADV' | 'NUM' | 'NOUN' | 'PROPN'
        | 'VERB' | 'AUX' | 'PART' | 'CCONJ' | 'SCONJ' | 'OTHER';

function tag(w: Word): PC {
  const p = w.pos ?? '';
  switch (p) {
    case 'ADP': case 'DET': case 'PRON': case 'ADJ': case 'ADV':
    case 'NUM': case 'NOUN': case 'PROPN': case 'VERB': case 'AUX':
    case 'PART': case 'CCONJ': case 'SCONJ':
      return p as PC;
    default:
      return 'OTHER';
  }
}

const isHead = (t: PC) => t === 'NOUN' || t === 'PROPN';
const isMod  = (t: PC) => t === 'ADJ'  || t === 'NUM'   || t === 'ADV';
const isDet  = (t: PC) => t === 'DET'  || t === 'PRON';

function adjacent(a: Word, b: Word): boolean {
  return Math.abs(b.lineIdx - a.lineIdx) <= 1;
}

function tryMatchNP(run: Word[], start: number, maxLen: number): number {
  let i = start;
  if (i < run.length && tag(run[i]) === 'ADP') i++;
  // Optional opener: DET/PRON, or a leading VERB (gerund).
  if (i < run.length && (isDet(tag(run[i])) || tag(run[i]) === 'VERB')) i++;
  while (i < run.length && isMod(tag(run[i]))) i++;
  let hadHead = false;
  while (i < run.length && isHead(tag(run[i]))) {
    hadHead = true;
    i++;
  }
  if (!hadHead) return start;
  if (i - start > maxLen) return start + maxLen;
  return i;
}

function tryMatchVP(run: Word[], start: number, maxLen: number): number {
  let i = start;
  while (i < run.length && tag(run[i]) === 'ADV') i++;
  if (i >= run.length || (tag(run[i]) !== 'VERB' && tag(run[i]) !== 'AUX')) return start;
  i++;
  while (i < run.length && (isMod(tag(run[i])) || tag(run[i]) === 'AUX' || tag(run[i]) === 'PART')) i++;
  if (i === start) return start;
  if (i - start > maxLen) return start + maxLen;
  return i;
}

/* ---------- main entry --------------------------------------------- */

export interface ChunksOptions {
  /** Maximum words per chunk. Default 4. */
  maxLen?: number;
  /** Pre-filtered candidate list. Defaults to `passesCandidacy` filter. */
  candidates?: Word[];
}

/** Build all chunks on the page. */
export function chunks(words: Word[], opts: ChunksOptions = {}): Word[][] {
  const maxLen = opts.maxLen ?? 4;
  const candidates = opts.candidates ?? defaultCandidates(words);
  const sorted = candidates.slice().sort((a, b) => a.lineIdx - b.lineIdx || a.x0 - b.x0);

  // Group into adjacency runs so chunks never cross gaps.
  const runs: Word[][] = [];
  let cur: Word[] = [];
  for (const w of sorted) {
    if (!cur.length || adjacent(cur[cur.length - 1], w)) {
      cur.push(w);
    } else {
      if (cur.length) runs.push(cur);
      cur = [w];
    }
  }
  if (cur.length) runs.push(cur);

  const out: Word[][] = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      const npEnd = tryMatchNP(run, i, maxLen);
      const vpEnd = tryMatchVP(run, i, maxLen);
      const end = Math.max(npEnd, vpEnd);
      if (end > i) {
        out.push(run.slice(i, end));
        i = end;
      } else {
        i++;
      }
    }
  }
  return out;
}

function defaultCandidates(words: Word[]): Word[] {
  const headers = detectHeaderLines(words);
  return words.filter((w) => passesCandidacy(w, headers));
}

/* ---------- scoring & selection ------------------------------------ */

export function chunkScore(chunk: Word[]): number {
  let s = 0;
  let hasContent = false;
  for (const w of chunk) {
    s += (w.rarity ?? 0) * 1.0;
    if (w.isContent) {
      s += 0.4;
      hasContent = true;
    }
    if (BANNED_CLICHES.has(w.text.toLowerCase())) s -= 0.4;
  }
  if (!hasContent) return -999;
  const len = chunk.length;
  if (len === 1) s += 0;
  else if (len === 2) s += 0.7;
  else if (len === 3) s += 0.6;
  else if (len === 4) s += 0.2;
  else s -= 0.4;
  const last = chunk[chunk.length - 1];
  if (last.pos === 'NOUN' || last.pos === 'PROPN') s += 0.4;
  return s;
}

export interface SelectChunksOptions extends ChunksOptions {
  /** Number of chunks to pick (default 3). */
  nSeeds?: number;
  /** Minimum line distance between picked chunks (default 2). */
  minLineDist?: number;
  /** PRNG seed for shuffling among same-score candidates (default 42). */
  seed?: number;
  /** 0 = pure top-N, 1 = light shuffle, 2 = wider shuffle. Default 0. */
  variation?: number;
}

/** Pick N best chunks, distributed across the page by line distance. */
export function selectChunks(words: Word[], opts: SelectChunksOptions = {}): Word[][] {
  const all = chunks(words, opts);
  if (!all.length) return [];

  const nSeeds = opts.nSeeds ?? 3;
  const minDist = opts.minLineDist ?? 2;
  const variation = opts.variation ?? 0;
  const rng = mulberry32((opts.seed ?? 42) * 1000);

  const scored = all
    .map((c) => ({ c, s: chunkScore(c) }))
    .filter((x) => x.s > -100)
    .sort((a, b) => b.s - a.s);

  let pool: typeof scored;
  if (variation === 0) pool = scored;
  else if (variation === 1) {
    pool = scored.slice(0, Math.max(nSeeds * 4, 12));
    shuffle(pool, rng);
  } else {
    pool = scored.slice(0, Math.max(nSeeds * 6, 18));
    shuffle(pool, rng);
  }

  const picked: Word[][] = [];
  for (const { c } of pool) {
    if (picked.every((p) => Math.abs(c[0].lineIdx - p[0].lineIdx) >= minDist)) {
      picked.push(c);
      if (picked.length >= nSeeds) break;
    }
  }
  picked.sort((a, b) => a[0].lineIdx - b[0].lineIdx || a[0].x0 - b[0].x0);
  return picked;
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
