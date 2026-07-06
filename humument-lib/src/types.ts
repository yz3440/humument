/**
 * Shared data shapes for the Humument library.
 *
 * Coordinates are pixel coordinates in the page image's native resolution
 * (~1500x2400 @ 300dpi), origin at top-left, y-axis pointing down — same
 * convention as a `<canvas>`.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A single OCR'd word on a page. */
export interface Word {
  /** DB primary key — stable across re-OCRs of the same page. */
  id: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0-based line index within the page (post tilt-correction). */
  lineIdx: number;
  /** OCR confidence in [0, 1]. */
  conf: number;
  /** Leading punctuation/quotes ("\"", "(") — null if none. */
  prefix: string | null;
  /** Trailing punctuation (".", ",", ";") — null if none. */
  suffix: string | null;
  /** spaCy UPOS tag — NOUN, VERB, ADJ, ADV, ADP, DET, ... */
  pos: string | null;
  lemma: string | null;
  /** wordfreq score (frequency in modern English corpora). */
  freq: number | null;
  /** Normalised log inverse frequency in [0, 1]; higher = rarer. */
  rarity: number | null;
  /** 1 if the word is a content word (NOUN/VERB/ADJ/ADV). */
  isContent: 0 | 1;
  /** 1 if the word reads naturally as a connective bridge between content words. */
  isConnective: 0 | 1;
}

export interface PageMeta {
  width: number;
  height: number;
  /** Type-block bbox (printed area) — null if the page wasn't tilt-corrected. */
  body: Bbox | null;
  /** Bbox of the OCR-valid region — usually equal to body. */
  valid: Bbox | null;
}

export interface PageRef {
  pageNum: number;
}

/** A chapter break detected from the OCR text — a page whose top-of-page
 *  line reads "CHAPTER <Roman numeral>". The chapter is taken to start on
 *  this `pageNum` and run until the next chapter. */
export interface ChapterRef {
  pageNum: number;
  /** Full label as it appears on the page, e.g. "CHAPTER III". */
  label: string;
  /** Roman numeral component, e.g. "III". */
  roman: string;
}

/** A page-level full-text search hit. */
export interface PageMatch {
  pageNum: number;
  /** Number of word rows on this page that matched the query. */
  hits: number;
  /** Short snippet around the first hit on the page (~6 words wide). */
  snippet: string;
}

/* ------------------------------------------------------------------ */
/* Whitespace navigation graph                                         */
/* ------------------------------------------------------------------ */

/** A horizontal inter-line gap or a vertical intra-line slit. */
export interface Gutter {
  gutterId: number;
  kind: 'h_line' | 'v_slit';
  /** Index of the line above (h_line) or to the left (v_slit). Null at edges. */
  lineIdxA: number | null;
  /** Index of the line below (h_line) or to the right (v_slit). Null at edges. */
  lineIdxB: number | null;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Centre-line of the gutter as a polyline. */
  polyline: [number, number][];
  /** Min width of the channel along its length, in px. */
  minWidth: number;
  /** Heuristic score: how "river-like" this gutter looks. */
  riverScore: number;
}

export type Compass = 'N' | 'S' | 'E' | 'W';

export interface Port {
  x: number;
  y: number;
  gutterId: number;
  compass: Compass;
  /** ID of the corresponding node in the page graph. */
  nodeId: number;
}

export interface Dock {
  wordId: number;
  /** Distance in px to the nearest obstacle in each cardinal direction. */
  breathingTop: number;
  breathingBottom: number;
  breathingLeft: number;
  breathingRight: number;
  /** Direction with the most slack, e.g. "NE". */
  slackDirection: string;
  /** Entry/exit ports into the surrounding gutters. */
  ports: Port[];
  /** IDs of immediately neighbouring gutters. */
  dockAbove: number | null;
  dockBelow: number | null;
  dockLeft: number | null;
  dockRight: number | null;
}

export interface GraphNode {
  id: number;
  x: number;
  y: number;
  /** "port" | "gutter_centre" | etc. — informational. */
  kind: string;
  /** [neighborId, edgeCost, gutterId] tuples. */
  edges: [number, number, number][];
}

export interface PageGraph {
  nodes: Map<number, GraphNode>;
}

/* ------------------------------------------------------------------ */
/* River output                                                        */
/* ------------------------------------------------------------------ */

/**
 * One river segment: an ordered polyline through the whitespace graph,
 * with the gutter id used for each consecutive pair (so the renderer can
 * vary stroke width per gutter).
 */
export interface ChannelSegment {
  points: Pt[];
  /** `gutterIds[i]` is the gutter used between `points[i]` and `points[i+1]`. */
  gutterIds: number[];
}

/* ------------------------------------------------------------------ */
/* Loader options                                                      */
/* ------------------------------------------------------------------ */

export interface HumumentLoadOptions {
  page: number;
  /** Base URL holding catalog.json + pages/pNNNN.json(.gz).
   *  Default: npm-hosted data (humument-data via jsDelivr). */
  dataBase?: string;
  /** Base URL for page JPEGs. URL is `${imageBase}/pNNNN.jpg`.
   *  Default: npm-hosted images (humument-images via jsDelivr). */
  imageBase?: string;
}
