/**
 * Static data layer. The editor ships as a fully static site: instead of
 * loading a SQLite DB in the browser, it fetches small per-page JSON files
 * (plus a catalog and a search index) produced by `pipeline/03_export_web.py`.
 *
 * Everything is fetched lazily and cached. `init()` warms the catalog so the
 * page list / chapters are ready; per-page data is fetched on first use.
 */
interface InitOptions {
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
declare const CDN_DATA_BASE = "https://cdn.jsdelivr.net/npm/humument-data@0.1/db";
declare const CDN_IMAGE_BASE = "https://cdn.jsdelivr.net/npm/humument-images@0.1/pages";
/** Configure base URLs and warm the catalog. Idempotent. */
declare function init(opts?: InitOptions): Promise<void>;

/**
 * Shared data shapes for the Humument library.
 *
 * Coordinates are pixel coordinates in the page image's native resolution
 * (~1500x2400 @ 300dpi), origin at top-left, y-axis pointing down — same
 * convention as a `<canvas>`.
 */
interface Pt {
    x: number;
    y: number;
}
interface Bbox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}
/** A single OCR'd word on a page. */
interface Word {
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
interface PageMeta {
    width: number;
    height: number;
    /** Type-block bbox (printed area) — null if the page wasn't tilt-corrected. */
    body: Bbox | null;
    /** Bbox of the OCR-valid region — usually equal to body. */
    valid: Bbox | null;
}
interface PageRef {
    pageNum: number;
}
/** A chapter break detected from the OCR text — a page whose top-of-page
 *  line reads "CHAPTER <Roman numeral>". The chapter is taken to start on
 *  this `pageNum` and run until the next chapter. */
interface ChapterRef {
    pageNum: number;
    /** Full label as it appears on the page, e.g. "CHAPTER III". */
    label: string;
    /** Roman numeral component, e.g. "III". */
    roman: string;
}
/** A page-level full-text search hit. */
interface PageMatch {
    pageNum: number;
    /** Number of word rows on this page that matched the query. */
    hits: number;
    /** Short snippet around the first hit on the page (~6 words wide). */
    snippet: string;
}
/** A horizontal inter-line gap or a vertical intra-line slit. */
interface Gutter {
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
type Compass = 'N' | 'S' | 'E' | 'W';
interface Port {
    x: number;
    y: number;
    gutterId: number;
    compass: Compass;
    /** ID of the corresponding node in the page graph. */
    nodeId: number;
}
interface Dock {
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
interface GraphNode {
    id: number;
    x: number;
    y: number;
    /** "port" | "gutter_centre" | etc. — informational. */
    kind: string;
    /** [neighborId, edgeCost, gutterId] tuples. */
    edges: [number, number, number][];
}
interface PageGraph {
    nodes: Map<number, GraphNode>;
}
/**
 * One river segment: an ordered polyline through the whitespace graph,
 * with the gutter id used for each consecutive pair (so the renderer can
 * vary stroke width per gutter).
 */
interface ChannelSegment {
    points: Pt[];
    /** `gutterIds[i]` is the gutter used between `points[i]` and `points[i+1]`. */
    gutterIds: number[];
}
interface HumumentLoadOptions {
    page: number;
    /** Base URL holding catalog.json + pages/pNNNN.json(.gz).
     *  Default: npm-hosted data (humument-data via jsDelivr). */
    dataBase?: string;
    /** Base URL for page JPEGs. URL is `${imageBase}/pNNNN.jpg`.
     *  Default: npm-hosted images (humument-images via jsDelivr). */
    imageBase?: string;
}

/**
 * Page-level data accessors backed by the static JSON export
 * (`pipeline/03_export_web.py`): one fetch per page, plus a catalog and a
 * search index. All page/catalog/search reads are async; the per-page JSON is
 * shaped to match these types, so decoding is trivial.
 */

/** Words for a page (used by the editor's word overlay). */
declare function getWords(pageNum: number): Promise<Word[]>;
/** Content page numbers, ascending. (`contentOnly` kept for API compatibility;
 *  the export only ships content pages.) */
declare function listPages(_contentOnly?: boolean): Promise<number[]>;
declare function listAllPageRefs(): Promise<PageRef[]>;
declare function listChapters(): Promise<ChapterRef[]>;
/** Substring search over OCR word tokens. Matches the query against the
 *  lowercased token keys of the prebuilt index (so it stays substring-like,
 *  not stemmed), ranks pages by total hits, and builds a snippet lazily from
 *  each matched page's JSON. */
declare function searchPages(query: string, opts?: {
    limit?: number;
}): Promise<PageMatch[]>;
/** Build the page-image URL from the configured image base. */
declare function pageImageUrl(pageNum: number): string;

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

interface ChunksOptions {
    /** Maximum words per chunk. Default 4. */
    maxLen?: number;
    /** Pre-filtered candidate list. Defaults to `passesCandidacy` filter. */
    candidates?: Word[];
}
interface SelectChunksOptions extends ChunksOptions {
    /** Number of chunks to pick (default 3). */
    nSeeds?: number;
    /** Minimum line distance between picked chunks (default 2). */
    minLineDist?: number;
    /** PRNG seed for shuffling among same-score candidates (default 42). */
    seed?: number;
    /** 0 = pure top-N, 1 = light shuffle, 2 = wider shuffle. Default 0. */
    variation?: number;
}

/**
 * Pure geometry helpers — no DOM, no framework. Each returns plain arrays of
 * `{x, y}` points so callers can render with whatever drawing API.
 */

interface BalloonOptions {
    /** Extra px of padding beyond the bbox edges. Default 6. */
    pad?: number;
    /** Boundary radius modulation as a fraction of radius. Default 0.12. */
    wobble?: number;
    /** Spatial frequency of the wobble noise. Default 0.45. */
    wobbleFreq?: number;
    /** Number of points around the boundary. Default 32. */
    samples?: number;
    /** PRNG seed. Default 0. */
    seed?: number;
}
/** Wobbly closed loop around a bounding box. Returns polygon vertices. */
declare function balloonPath(bbox: Bbox, opts?: BalloonOptions): Pt[];
interface ChannelOptions {
    /** Thickness of the ribbon at the centerline (px). Default 4. */
    halfWidth?: number;
    /** High-frequency wobble amplitude (px). Default 1.4. */
    jitter?: number;
    /** High-frequency wobble spatial frequency. Default 0.09. */
    jitterFreq?: number;
    /** Low-frequency lateral drift fraction (0..1) of gutter half-width. Default 0.55. */
    meander?: number;
    /** Spatial frequency of the meander noise. Default 0.018. */
    meanderFreq?: number;
    /** Thickness variance (0..0.8). Default 0.4. */
    widthMod?: number;
    /** Thickness modulation frequency. Default 0.035. */
    widthModFreq?: number;
    /** Sample step in px along the polyline. Default 1.6. */
    sampleStep?: number;
    /** PRNG seed. Default 0. */
    seed?: number;
    /** Optional gutter map for per-segment max width info. */
    gutterById?: Map<number, Gutter>;
}
/**
 * Convert a polyline segment into a thick wavy ribbon — returns the
 * outer polygon as an ordered list of points (top edge then bottom edge
 * reversed) suitable for filling as a closed path.
 */
declare function channelPath(seg: ChannelSegment, opts?: ChannelOptions): Pt[];
/** Smooth a polyline with Catmull-Rom interpolation. */
declare function catmullRom(points: Pt[], tension?: number, samplesPerSegment?: number): Pt[];

/**
 * River pathfinding — two strategies:
 *
 *   1. `between(a, b, graph, docks)` — Dijkstra over the precomputed
 *      whitespace navigation graph. Constrained to real gutters; cheap.
 *
 *   2. `flow(a, b, opts)` — greedy walk through a Perlin field, biased
 *      toward the target and away from obstacles. Organic; good fallback
 *      when Dijkstra can't connect (graph islands).
 *
 * Plus port selection (`pickPorts`) and a border-edge penaliser so paths
 * don't hug the page margins.
 */

declare function dijkstra(graph: PageGraph, start: number, end: number): {
    nodeIds: number[];
    gutterIds: number[];
};
interface FlowOptions {
    seed?: number;
    /** px per step (smaller = smoother). Default 2.5. */
    stepSize?: number;
    /** Hard step cap. Default 600. */
    maxSteps?: number;
    /** Spatial scale of the noise field. Default 0.007. */
    noiseFreq?: number;
    /** Bias toward the target (0 = pure flow, 1 = straight line). Default 0.45. */
    targetWeight?: number;
    /** Number of directions evaluated per step. Default 24. */
    candidateCount?: number;
    /** Padding around obstacles (px). Default 1. */
    obstaclePad?: number;
    /** Body bbox the path must stay inside. Required. */
    body: Bbox;
    /** Bboxes to avoid (typically non-selected words). Default empty. */
    obstacles?: Bbox[];
}
/** Convenience: build obstacle bboxes from words minus a selected set. */
declare function obstaclesFrom(words: Word[], selectedIds: Iterable<number>, pad?: number): Bbox[];

/**
 * humument — public entry.
 *
 * Renderer-agnostic: every drawing primitive returns plain `{x, y}` point
 * arrays, so the caller renders with any 2D API (Canvas2D, SVG, WebGL, …).
 *
 * Quick start:
 *
 *   import { Humument } from 'humument';
 *
 *   const H = await Humument.load({ page: 33 });  // data/images come from npm (jsDelivr)
 *   const phrases = H.selectChunks({ nSeeds: 4, seed: 42 });
 *   const outlines = phrases.map((ph) =>
 *     H.geom.balloon(H.bboxOf(ph), { wobble: 0.18 }),  // → Pt[]
 *   );
 *   // draw H.page.imageUrl and the outlines with your renderer
 *
 * Self-hosting the data instead:
 *
 *   Humument.load({ page: 33, dataBase: '/db', imageBase: '/pages_normalized' });
 */

interface HumumentInstance {
    /** Page-level metadata. */
    page: {
        number: number;
        width: number;
        height: number;
        body: Bbox | null;
        valid: Bbox | null;
        /** Source URL for the page image. Always set. The lib never loads the
         *  image itself — the host fetches/decodes it with its own renderer. */
        imageUrl: string;
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
        flow(a: Pt, b: Pt, opts: Omit<FlowOptions, 'body'> & {
            body?: Bbox;
        }): Pt[];
        pickPorts(a: Word, b: Word): [Port, Port] | null;
        penalizeBorders(margin?: number, penalty?: number): PageGraph;
        dijkstra: typeof dijkstra;
        obstaclesFrom: typeof obstaclesFrom;
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
    POS: {
        NOUN: 'NOUN';
        VERB: 'VERB';
        ADJ: 'ADJ';
        ADV: 'ADV';
        ADP: 'ADP';
        DET: 'DET';
        PRON: 'PRON';
        NUM: 'NUM';
        PROPN: 'PROPN';
        AUX: 'AUX';
        PART: 'PART';
        CCONJ: 'CCONJ';
        SCONJ: 'SCONJ';
    };
    HEAD(w: Word): boolean;
    MOD(w: Word): boolean;
}
declare const Humument: {
    /**
     * Configure base URLs and warm the catalog. Call once before using
     * `catalog.*` from outside a sketch context. `load()` calls this internally.
     */
    init: typeof init;
    /** Loaded data for a single page. The page image isn't preloaded — the
     *  caller loads `H.page.imageUrl` with its own renderer. */
    load(opts: HumumentLoadOptions): Promise<HumumentInstance>;
    /** List metadata helpers — usable before `load` for catalog UIs. All async. */
    catalog: {
        listPages: typeof listPages;
        listAllPageRefs: typeof listAllPageRefs;
        listChapters: typeof listChapters;
        searchPages: typeof searchPages;
        getWords: typeof getWords;
        pageImageUrl: typeof pageImageUrl;
    };
};

export { type BalloonOptions, type Bbox, CDN_DATA_BASE, CDN_IMAGE_BASE, type ChannelOptions, type ChannelSegment, type ChapterRef, type ChunksOptions, type Compass, type Dock, type FlowOptions, type GraphNode, type Gutter, Humument, type HumumentInstance, type HumumentLoadOptions, type PageGraph, type PageMatch, type PageMeta, type PageRef, type Port, type Pt, type SelectChunksOptions, type Word };
