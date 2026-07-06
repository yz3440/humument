/**
 * humument-lib — public entry.
 *
 * Quick start (inside the editor):
 *
 *   // `H` is already loaded for the active page.
 *   function setup() {
 *     createCanvas(H.page.width, H.page.height);
 *     if (H.page.image) image(H.page.image, 0, 0);
 *     const phrases = H.selectChunks({ nSeeds: 4, seed: 42 });
 *     for (const ph of phrases) {
 *       fill(255); stroke(0);
 *       H.draw.balloon(ph, { wobble: 0.18 });
 *     }
 *   }
 *
 * Standalone (in a vanilla p5 sketch):
 *
 *   import { Humument } from 'humument-lib';
 *
 *   let H, pageImg;
 *   async function preload() {
 *     H = await Humument.load({ page: 33 });   // data/images come from npm (jsDelivr)
 *     pageImg = loadImage(H.page.imageUrl);
 *   }
 *
 * Self-hosting the data instead:
 *
 *   Humument.load({ page: 33, dataBase: '/db', imageBase: '/pages_normalized' });
 */

import { init } from './data.js';
import {
  bboxOf, getPageData, getWords, groupByLine, listAllPageRefs, listChapters,
  listPages, pageImageUrl, searchPages,
} from './words.js';
import {
  chunks as chunksFn, chunkScore, passesCandidacy, selectChunks,
  type ChunksOptions, type SelectChunksOptions,
} from './chunks.js';
import {
  balloonPath, catmullRom, channelPath,
  type BalloonOptions, type ChannelOptions,
} from './geometry.js';
import {
  between, dijkstra, flow, obstaclesFrom, penalizeBorders, pickPorts,
  type FlowOptions,
} from './rivers.js';
import { makeNoise, makeNoise2D, mulberry32 } from './noise.js';
import { drawBalloon, drawImage, drawRiver, drawWord } from './draw.js';

import type {
  Bbox, ChannelSegment, Dock, Gutter, HumumentLoadOptions,
  PageGraph, Port, Pt, Word,
} from './types.js';

import type p5 from 'p5';

/* ---------- the H namespace shape ---------------------------------- */

export interface HumumentInstance {
  /** Page-level metadata + image. */
  page: {
    number: number;
    width: number;
    height: number;
    body: Bbox | null;
    valid: Bbox | null;
    /** Source URL for the page image. Always set. */
    imageUrl: string;
    /**
     * Page image as a p5.Image. The lib never assigns this — the host
     * (editor or user sketch) sets it after `loadImage(H.page.imageUrl)`
     * resolves. The `H.draw.image()` / `H.draw.word()` helpers read
     * from this slot at call time, so updating it works mid-sketch.
     */
    image: p5.Image | null;
  };

  /** Words sorted by (lineIdx, x0). */
  words: Word[];
  lines: Word[][];
  wordById(id: number): Word | undefined;
  bboxOf(words: Iterable<Word>): Bbox;

  /** Whitespace geometry. */
  gutters: Gutter[];
  docks: Map<number, Dock>;
  graph: PageGraph;

  /** Chunker. */
  chunks(opts?: ChunksOptions): Word[][];
  selectChunks(opts?: SelectChunksOptions): Word[][];
  chunkScore(chunk: Word[]): number;
  passesCandidacy(word: Word, headerLines?: Set<number>): boolean;

  /** Pathfinding. */
  river: {
    between(a: Word, b: Word): ChannelSegment | null;
    flow(a: Pt, b: Pt, opts: Omit<FlowOptions, 'body'> & { body?: Bbox }): Pt[];
    pickPorts(a: Word, b: Word): [Port, Port] | null;
    penalizeBorders(margin?: number, penalty?: number): PageGraph;
    dijkstra: typeof dijkstra;
    obstaclesFrom: typeof obstaclesFrom;
  };

  /** p5-aware drawing sugar. Pass an instance for instance mode; omitted = global. */
  draw: {
    balloon(words: Word[], opts?: BalloonOptions, p?: p5): void;
    river(segment: ChannelSegment, opts?: ChannelOptions, p?: p5): void;
    word(word: Word, p?: p5): void;
    image(p?: p5): void;
  };

  /** Pure geometry primitives (no drawing). */
  geom: {
    balloon: typeof balloonPath;
    channel: typeof channelPath;
    catmullRom: typeof catmullRom;
  };

  /** Noise utilities. */
  noise(seed: number): (x: number) => number;
  noise2D(seed: number): (x: number, y: number) => number;
  random(seed: number): () => number;

  /** POS helpers. */
  POS: { NOUN: 'NOUN'; VERB: 'VERB'; ADJ: 'ADJ'; ADV: 'ADV'; ADP: 'ADP'; DET: 'DET'; PRON: 'PRON'; NUM: 'NUM'; PROPN: 'PROPN'; AUX: 'AUX'; PART: 'PART'; CCONJ: 'CCONJ'; SCONJ: 'SCONJ' };
  HEAD(w: Word): boolean;
  MOD(w: Word): boolean;
}

/* ---------- public Humument loader --------------------------------- */

export const Humument = {
  /**
   * Configure base URLs and warm the catalog. Call once before using
   * `catalog.*` from outside a sketch context. `load()` calls this internally.
   */
  init,

  /** Loaded data for a single page. The page image isn't preloaded — the
   *  caller assigns `H.page.image` after `loadImage(H.page.imageUrl)`. */
  async load(opts: HumumentLoadOptions): Promise<HumumentInstance> {
    await init({ dataBase: opts.dataBase, imageBase: opts.imageBase });

    const { meta, words, gutters, docks, graph } = await getPageData(opts.page);
    const lines   = groupByLine(words);
    const wordIndex = new Map(words.map((w) => [w.id, w]));
    const imageUrl = pageImageUrl(opts.page);

    const inst: HumumentInstance = {
      page: {
        number: opts.page,
        width: meta.width,
        height: meta.height,
        body: meta.body,
        valid: meta.valid,
        imageUrl,
        image: null,
      },
      words,
      lines,
      wordById: (id) => wordIndex.get(id),
      bboxOf,
      gutters,
      docks,
      graph,
      chunks: (o) => chunksFn(words, o),
      selectChunks: (o) => selectChunks(words, o),
      chunkScore,
      passesCandidacy: (w, h) => passesCandidacy(w, h ?? new Set()),
      river: {
        between: (a, b) => between(a, b, graph, docks),
        flow: (a, b, o) => flow(a, b, { ...o, body: o.body ?? meta.body ?? { x0: 0, y0: 0, x1: meta.width, y1: meta.height } }),
        pickPorts: (a, b) => {
          const da = docks.get(a.id);
          const db = docks.get(b.id);
          if (!da || !db) return null;
          return pickPorts(da, db, a, b);
        },
        penalizeBorders: (margin, penalty) =>
          penalizeBorders(graph, meta.body ?? { x0: 0, y0: 0, x1: meta.width, y1: meta.height }, margin, penalty),
        dijkstra,
        obstaclesFrom,
      },
      draw: {
        balloon: (words_, o, p) => drawBalloon(words_, o, p),
        river:   (seg, o, p)    => drawRiver(seg, o, p),
        word:    (w, p)         => { if (inst.page.image) drawWord(w, inst.page.image, p); },
        image:   (p)            => { if (inst.page.image) drawImage(inst.page.image, p); },
      },
      geom: {
        balloon: balloonPath,
        channel: channelPath,
        catmullRom,
      },
      noise:   makeNoise,
      noise2D: makeNoise2D,
      random:  mulberry32,
      POS: {
        NOUN: 'NOUN', VERB: 'VERB', ADJ: 'ADJ', ADV: 'ADV', ADP: 'ADP',
        DET: 'DET', PRON: 'PRON', NUM: 'NUM', PROPN: 'PROPN', AUX: 'AUX',
        PART: 'PART', CCONJ: 'CCONJ', SCONJ: 'SCONJ',
      },
      HEAD: (w) => w.pos === 'NOUN' || w.pos === 'PROPN',
      MOD:  (w) => w.pos === 'ADJ'  || w.pos === 'ADV'  || w.pos === 'NUM',
    };
    return inst;
  },

  /** List metadata helpers — usable before `load` for catalog UIs. All async. */
  catalog: {
    listPages,
    listAllPageRefs,
    listChapters,
    searchPages,
    getWords,
    pageImageUrl,
  },
};

/* ---------- re-exports --------------------------------------------- */

export type {
  Bbox, ChannelSegment, ChapterRef, Compass, Dock, GraphNode, Gutter,
  HumumentLoadOptions, PageGraph, PageMatch, PageMeta, PageRef, Port, Pt, Word,
} from './types.js';
export { CDN_DATA_BASE, CDN_IMAGE_BASE } from './data.js';
export type { BalloonOptions, ChannelOptions } from './geometry.js';
export type { ChunksOptions, SelectChunksOptions } from './chunks.js';
export type { FlowOptions } from './rivers.js';
