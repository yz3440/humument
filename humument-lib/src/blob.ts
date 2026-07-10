/**
 * Text-hugging blob outlines — the silhouette language of A Humument's
 * "kept word" balloons.
 *
 * Phillips's balloons are not ellipses: each phrase is a tight hull hugging
 * its words (union of padded rounded rects, so multi-line phrases read as
 * stepped, concave lobes), and consecutive phrases merge into ONE organic
 * silhouette through tapered necks that flare where they attach. This module
 * reproduces that construction:
 *
 *   signed-distance union of (rounded word rects + tapered capsule necks)
 *   -> marching squares at the zero isoline
 *   -> resample / box-smooth / hand-cut wobble along the field gradient
 *
 * Pure geometry — returns plain `Pt[][]` contours (outer loops and holes
 * carry opposite windings, ready for nonzero-winding fill). No DOM.
 */

import { makeNoise } from './noise.js';
import { catmullRom } from './geometry.js';
import type { Bbox, Pt, Word } from './types.js';

/* ---------- public types ------------------------------------------- */

/** A neck between phrase hulls: a spine polyline swept with a (possibly
 *  tapered) width. `width` is the FULL width in px — a scalar `w` expands to
 *  `[w, 0.55*w, w]`, the classic pinched neck. */
export interface BlobCapsule {
  points: Pt[];
  width: number | [number, number, number];
}

/** Input geometry for one blob (one balloon or one connected chain).
 *  Everything in a single spec is allowed to fuse — call `blobPath` once per
 *  balloon/chain; never batch unrelated balloons into one spec. */
export interface BlobSpec {
  /** Word (or line-run) bboxes to hug. `Word` satisfies `Bbox` structurally. */
  rects: Bbox[];
  /** Neck spines connecting the hulls. */
  capsules?: BlobCapsule[];
}

export interface BlobOptions {
  /** Outward offset from the rects (px). Corners round by this much for free
   *  (SDF offsetting). Default 6. */
  pad?: number;
  /** Extra corner rounding on top of `pad`. Default 0. */
  cornerRadius?: number;
  /** Smooth-union radius (px): necks and stacked lines flare into each other
   *  instead of meeting at a crease. 0 = hard union. Default 8. */
  blend?: number;
  /** Max sample-grid cell size (px). Auto-clamped down for small blobs and
   *  so the thinnest capsule spans >= 4 cells. Default 3. */
  cell?: number;
  /** Output vertex spacing along the contour (px). Default 2.5. */
  resample?: number;
  /** Box-filter smoothing passes over the contour. Default 2. */
  smooth?: number;
  /** Hand-cut wobble amplitude along the outward normal (px). Default 2. */
  wobble?: number;
  /** Wobble frequency in cycles per px of arc length. Default 0.02. */
  wobbleFreq?: number;
  /** PRNG seed. Default 0. */
  seed?: number;
}

/* ---------- SDF primitives ----------------------------------------- */

interface RectPrim {
  cx: number; cy: number;   // centre
  hx: number; hy: number;   // half extents shrunk by cornerRadius
  r: number;                // total corner offset = pad + cornerRadius
  bx0: number; by0: number; bx1: number; by1: number; // inflated bbox
}

interface CapSeg {
  ax: number; ay: number;
  dx: number; dy: number;   // b - a
  len2: number;
  ra: number; rb: number;   // half-width at each end
}

interface CapPrim {
  segs: CapSeg[];
  bx0: number; by0: number; bx1: number; by1: number;
}

function sdRect(x: number, y: number, p: RectPrim): number {
  const qx = Math.abs(x - p.cx) - p.hx;
  const qy = Math.abs(y - p.cy) - p.hy;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const outside = Math.sqrt(ox * ox + oy * oy);
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - p.r;
}

function sdCapsule(x: number, y: number, c: CapPrim): number {
  let best = Infinity;
  for (const s of c.segs) {
    const px = x - s.ax;
    const py = y - s.ay;
    let t = s.len2 > 0 ? (px * s.dx + py * s.dy) / s.len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = px - s.dx * t;
    const ey = py - s.dy * t;
    // Distance minus the radius lerped along this sub-segment. Sub-segments
    // are short (~4px), so linear radius here is visually exact.
    const d = Math.sqrt(ex * ex + ey * ey) - (s.ra + (s.rb - s.ra) * t);
    if (d < best) best = d;
  }
  return best;
}

/** Polynomial smooth-min: blends the union so junctions flare (fillet ~k). */
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.min(Math.max(0.5 + (0.5 * (b - a)) / k, 0), 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Half-width along the spine for a `width` spec at normalized arc t. */
function radiusAt(width: number | [number, number, number], t: number): number {
  if (typeof width === 'number') {
    // scalar -> pinched middle
    return radiusAt([width, width * 0.55, width], t);
  }
  const [w0, wm, w1] = width;
  const ss = (u: number) => u * u * (3 - 2 * u);
  if (t < 0.5) return (w0 + (wm - w0) * ss(t / 0.5)) / 2;
  return (wm + (w1 - wm) * ss((t - 0.5) / 0.5)) / 2;
}

/* ---------- field construction ------------------------------------- */

interface Field {
  eval(x: number, y: number): number;
  window: Bbox;             // sampling window (strictly outside at the border)
  minCapWidth: number;      // thinnest capsule full width (Infinity if none)
}

function buildField(spec: BlobSpec, pad: number, cornerRadius: number, blend: number, margin: number): Field | null {
  const rects: RectPrim[] = [];
  const caps: CapPrim[] = [];
  const off = pad + cornerRadius;
  let minCapWidth = Infinity;

  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 < wx0) wx0 = x0;
    if (y0 < wy0) wy0 = y0;
    if (x1 > wx1) wx1 = x1;
    if (y1 > wy1) wy1 = y1;
  };

  for (const b of spec.rects ?? []) {
    const hx = (b.x1 - b.x0) / 2 - cornerRadius;
    const hy = (b.y1 - b.y0) / 2 - cornerRadius;
    const p: RectPrim = {
      cx: (b.x0 + b.x1) / 2,
      cy: (b.y0 + b.y1) / 2,
      hx: Math.max(hx, 0.5),
      hy: Math.max(hy, 0.5),
      r: off,
      bx0: b.x0 - off - margin, by0: b.y0 - off - margin,
      bx1: b.x1 + off + margin, by1: b.y1 + off + margin,
    };
    rects.push(p);
    grow(p.bx0, p.by0, p.bx1, p.by1);
  }

  for (const cap of spec.capsules ?? []) {
    if (!cap.points || cap.points.length < 2) continue;
    const w = cap.width;
    const wMax = typeof w === 'number' ? w : Math.max(w[0], w[1], w[2]);
    const wMin = typeof w === 'number' ? w * 0.55 : Math.min(w[0], w[1], w[2]);
    if (wMin < minCapWidth) minCapWidth = wMin;

    // Densify the spine so per-sub-segment linear radius is exact enough.
    // Tension 1 is the *interpolating* Catmull-Rom in this formulation —
    // lower tensions do not pass through the control points, which would
    // detach the neck from its anchors.
    const spine = cap.points.length >= 3 ? catmullRom(cap.points, 1, 8) : cap.points;
    let arc = 0;
    const cum: number[] = [0];
    for (let i = 1; i < spine.length; i++) {
      arc += Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
      cum.push(arc);
    }
    if (arc <= 0) continue;

    const segs: CapSeg[] = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let i = 1; i < spine.length; i++) {
      const a = spine[i - 1];
      const b = spine[i];
      const ta = cum[i - 1] / arc;
      const tb = cum[i] / arc;
      segs.push({
        ax: a.x, ay: a.y,
        dx: b.x - a.x, dy: b.y - a.y,
        len2: (b.x - a.x) ** 2 + (b.y - a.y) ** 2,
        ra: radiusAt(w, ta), rb: radiusAt(w, tb),
      });
      bx0 = Math.min(bx0, a.x, b.x); by0 = Math.min(by0, a.y, b.y);
      bx1 = Math.max(bx1, a.x, b.x); by1 = Math.max(by1, a.y, b.y);
    }
    const rr = wMax / 2 + margin;
    const prim: CapPrim = { segs, bx0: bx0 - rr, by0: by0 - rr, bx1: bx1 + rr, by1: by1 + rr };
    caps.push(prim);
    grow(prim.bx0, prim.by0, prim.bx1, prim.by1);
  }

  if (!rects.length && !caps.length) return null;

  // Coarse spatial buckets so each sample only evaluates nearby primitives.
  const TILE = 64;
  const tw = Math.max(1, Math.ceil((wx1 - wx0) / TILE));
  const th = Math.max(1, Math.ceil((wy1 - wy0) / TILE));
  const buckets: Array<{ rects: RectPrim[]; caps: CapPrim[] } | undefined> = new Array(tw * th);
  const bucketOf = (x: number, y: number) => {
    let i = Math.floor((x - wx0) / TILE);
    let j = Math.floor((y - wy0) / TILE);
    if (i < 0) i = 0; else if (i >= tw) i = tw - 1;
    if (j < 0) j = 0; else if (j >= th) j = th - 1;
    return j * tw + i;
  };
  const insert = (bx0: number, by0: number, bx1: number, by1: number, put: (b: { rects: RectPrim[]; caps: CapPrim[] }) => void) => {
    const i0 = Math.max(0, Math.floor((bx0 - wx0) / TILE));
    const j0 = Math.max(0, Math.floor((by0 - wy0) / TILE));
    const i1 = Math.min(tw - 1, Math.floor((bx1 - wx0) / TILE));
    const j1 = Math.min(th - 1, Math.floor((by1 - wy0) / TILE));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * tw + i;
        let b = buckets[k];
        if (!b) { b = { rects: [], caps: [] }; buckets[k] = b; }
        put(b);
      }
    }
  };
  for (const p of rects) insert(p.bx0, p.by0, p.bx1, p.by1, (b) => b.rects.push(p));
  for (const c of caps) insert(c.bx0, c.by0, c.bx1, c.by1, (b) => b.caps.push(c));

  // Fallback value when a sample's bucket is empty: distance is definitely
  // > margin there, and the contour never visits — any positive value works.
  const FAR = margin + TILE;

  const evalAll = (x: number, y: number): number => {
    const b = buckets[bucketOf(x, y)];
    if (!b) return FAR;
    let d = Infinity;
    for (const p of b.rects) {
      if (x < p.bx0 || x > p.bx1 || y < p.by0 || y > p.by1) continue;
      const v = sdRect(x, y, p);
      d = d === Infinity ? v : smin(d, v, blend);
      if (d < -margin) return d;   // deep inside — precise value irrelevant
    }
    for (const c of b.caps) {
      if (x < c.bx0 || x > c.bx1 || y < c.by0 || y > c.by1) continue;
      const v = sdCapsule(x, y, c);
      d = d === Infinity ? v : smin(d, v, blend);
      if (d < -margin) return d;
    }
    return d === Infinity ? FAR : d;
  };

  return {
    eval: evalAll,
    window: { x0: wx0, y0: wy0, x1: wx1, y1: wy1 },
    minCapWidth,
  };
}

/* ---------- marching squares --------------------------------------- */

/** Directed (fromEdge -> toEdge) pairs per 4-bit case, inside on the left.
 *  Corner bits: 1=TL, 2=TR, 4=BR, 8=BL. Edges: 0=T, 1=R, 2=B, 3=L.
 *  Saddles (5, 10) are resolved with the cell-centre field value. */
const CASES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  /* 0  */ [],
  /* 1  */ [[3, 0]],
  /* 2  */ [[0, 1]],
  /* 3  */ [[3, 1]],
  /* 4  */ [[1, 2]],
  /* 5  */ [],            // saddle — handled inline
  /* 6  */ [[0, 2]],
  /* 7  */ [[3, 2]],
  /* 8  */ [[2, 3]],
  /* 9  */ [[2, 0]],
  /* 10 */ [],            // saddle — handled inline
  /* 11 */ [[2, 1]],
  /* 12 */ [[1, 3]],
  /* 13 */ [[1, 0]],
  /* 14 */ [[0, 3]],
  /* 15 */ [],
];

interface MarchLoopsResult {
  loops: Pt[][];
}

function marchingSquares(
  f: Float32Array,
  nx: number,               // grid columns (values), ny rows
  ny: number,
  ox: number, oy: number,   // world origin of grid node (0,0)
  cell: number,
  centerEval: (x: number, y: number) => number,
): MarchLoopsResult {
  // Edge keys: horizontal edge right of node (i,j) -> (j*nx+i)*2,
  //            vertical   edge below    node (i,j) -> (j*nx+i)*2+1.
  const segs = new Map<number, { to: number; x: number; y: number }>();

  const val = (i: number, j: number) => f[j * nx + i];
  const cross = (fa: number, fb: number) => fa / (fa - fb);

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const tl = val(i, j);
      const tr = val(i + 1, j);
      const br = val(i + 1, j + 1);
      const bl = val(i, j + 1);
      let idx = 0;
      if (tl < 0) idx |= 1;
      if (tr < 0) idx |= 2;
      if (br < 0) idx |= 4;
      if (bl < 0) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      const x = ox + i * cell;
      const y = oy + j * cell;

      // Crossing point + integer key per edge of this cell.
      const edgePt = (e: number): { key: number; px: number; py: number } => {
        switch (e) {
          case 0: { // top: TL-TR
            const t = cross(tl, tr);
            return { key: (j * nx + i) * 2, px: x + t * cell, py: y };
          }
          case 1: { // right: TR-BR
            const t = cross(tr, br);
            return { key: (j * nx + (i + 1)) * 2 + 1, px: x + cell, py: y + t * cell };
          }
          case 2: { // bottom: BL-BR
            const t = cross(bl, br);
            return { key: ((j + 1) * nx + i) * 2, px: x + t * cell, py: y + cell };
          }
          default: { // left: TL-BL
            const t = cross(tl, bl);
            return { key: (j * nx + i) * 2 + 1, px: x, py: y + t * cell };
          }
        }
      };

      let pairs: ReadonlyArray<readonly [number, number]>;
      if (idx === 5 || idx === 10) {
        const centerInside = centerEval(x + cell / 2, y + cell / 2) < 0;
        if (idx === 5) pairs = centerInside ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]];
        else pairs = centerInside ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]];
      } else {
        pairs = CASES[idx];
      }

      for (const [eFrom, eTo] of pairs) {
        const a = edgePt(eFrom);
        const b = edgePt(eTo);
        segs.set(a.key, { to: b.key, x: a.px, y: a.py });
      }
    }
  }

  // Join directed segments into closed loops by following edge keys.
  const loops: Pt[][] = [];
  while (segs.size) {
    const startKey = segs.keys().next().value as number;
    const loop: Pt[] = [];
    let k = startKey;
    for (;;) {
      const s = segs.get(k);
      if (!s) break;              // open chain (shouldn't happen) — bail
      loop.push({ x: s.x, y: s.y });
      segs.delete(k);
      k = s.to;
      if (k === startKey) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return { loops };
}

/* ---------- contour post-processing -------------------------------- */

function loopArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Uniform arc-length resampling of a closed loop. */
function resampleClosed(pts: Pt[], spacing: number): Pt[] {
  let perim = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    perim += Math.hypot(q.x - p.x, q.y - p.y);
  }
  const count = Math.max(8, Math.round(perim / spacing));
  const step = perim / count;
  const out: Pt[] = [];
  let acc = 0;
  let target = 0;
  for (let i = 0; i < n && out.length < count; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const seg = Math.hypot(q.x - p.x, q.y - p.y);
    while (target <= acc + seg && out.length < count) {
      const t = seg > 0 ? (target - acc) / seg : 0;
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      target += step;
    }
    acc += seg;
  }
  return out;
}

/** `[1,2,1]/4` box filter with wraparound, `passes` times. */
function smoothClosed(pts: Pt[], passes: number): Pt[] {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const n = cur.length;
    const next: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
    }
    cur = next;
  }
  return cur;
}

/** Displace along the outward field gradient with 1D noise over arc length. */
function wobbleAlongGradient(
  pts: Pt[],
  field: (x: number, y: number) => number,
  amp: number,
  freq: number,
  seed: number,
): Pt[] {
  if (amp <= 0) return pts;
  const noise = makeNoise(seed);
  const out: Pt[] = new Array(pts.length);
  let s = 0;
  const EPS = 1;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const p = pts[i];
    const gx = field(p.x + EPS, p.y) - field(p.x - EPS, p.y);
    const gy = field(p.x, p.y + EPS) - field(p.x, p.y - EPS);
    const gl = Math.hypot(gx, gy) || 1;
    const d = noise(s * freq) * amp;
    out[i] = { x: p.x + (gx / gl) * d, y: p.y + (gy / gl) * d };
  }
  return out;
}

/* ---------- public API --------------------------------------------- */

/**
 * The union field itself — `(x, y) -> signed distance` (negative inside).
 * Useful for probing clearance between separately drawn balloons.
 */
export function blobField(spec: BlobSpec, opts: BlobOptions = {}): (x: number, y: number) => number {
  const pad = opts.pad ?? 6;
  const cornerRadius = opts.cornerRadius ?? 0;
  const blend = opts.blend ?? 8;
  const wobble = opts.wobble ?? 2;
  const margin = blend + wobble + 8;
  const f = buildField(spec, pad, cornerRadius, blend, margin);
  return f ? f.eval : () => Infinity;
}

/**
 * Outline(s) of the blob: closed contours sorted by |area| descending
 * (`result[0]` is the main silhouette). Outer loops and holes carry opposite
 * windings, so nonzero-winding fill renders holes correctly.
 */
export function blobPath(spec: BlobSpec, opts: BlobOptions = {}): Pt[][] {
  const pad = opts.pad ?? 6;
  const cornerRadius = opts.cornerRadius ?? 0;
  const blend = opts.blend ?? 8;
  const cellMax = opts.cell ?? 3;
  const spacing = opts.resample ?? 2.5;
  const smoothPasses = opts.smooth ?? 2;
  const wobble = opts.wobble ?? 2;
  const wobbleFreq = opts.wobbleFreq ?? 0.02;
  const seed = opts.seed ?? 0;

  const margin = blend + wobble + 8;
  const field = buildField(spec, pad, cornerRadius, blend, margin);
  if (!field) return [];

  // Grid cell: shrink for small blobs (crisp corners) and so the thinnest
  // neck spans at least ~4 cells (no aliasing a neck into disconnection).
  const w = field.window;
  const maxDim = Math.max(w.x1 - w.x0, w.y1 - w.y0);
  let cell = Math.min(cellMax, Math.max(2, maxDim / 350));
  if (field.minCapWidth !== Infinity) cell = Math.min(cell, Math.max(1, field.minCapWidth / 4));

  // Window already includes `margin` around every primitive, so the border
  // ring samples are strictly outside and every contour closes.
  const nx = Math.ceil((w.x1 - w.x0) / cell) + 2;
  const ny = Math.ceil((w.y1 - w.y0) / cell) + 2;
  const ox = w.x0;
  const oy = w.y0;

  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = oy + j * cell;
    for (let i = 0; i < nx; i++) {
      f[j * nx + i] = field.eval(ox + i * cell, y);
    }
  }

  const { loops } = marchingSquares(f, nx, ny, ox, oy, cell, field.eval);
  loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));

  return loops.map((loop) => {
    let pts = resampleClosed(loop, spacing);
    pts = smoothClosed(pts, smoothPasses);
    pts = wobbleAlongGradient(pts, field.eval, wobble, wobbleFreq, seed);
    return pts;
  });
}

/* ---------- word-group convenience --------------------------------- */

export interface BlobSpecOptions {
  /** Neck full width: scalar or [start, mid, end]. Default derives from the
   *  anchor words' line height: `[0.5*h, 0.28*h, 0.5*h]`, floored at 10px. */
  neckWidth?: number | [number, number, number];
  /** Perpendicular bow of the neck spine as a fraction of the chord length.
   *  Sign alternates pseudo-randomly per neck. Default 0.22. */
  bow?: number;
  /** PRNG seed for bow direction. Default 0. */
  seed?: number;
}

/**
 * Build a `BlobSpec` from ordered word groups: rects from every word, plus a
 * tapered neck between each consecutive pair of groups, anchored at the last
 * word of one group and the first word of the next (how Phillips attaches
 * them). Hand-build the spec instead when you need custom routing.
 */
export function blobSpecFromWords(groups: Word[][], opts: BlobSpecOptions = {}): BlobSpec {
  const bow = opts.bow ?? 0.22;
  const noise = makeNoise((opts.seed ?? 0) + 31);

  const rects: Bbox[] = [];
  for (const g of groups) for (const w of g) rects.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });

  const capsules: BlobCapsule[] = [];
  for (let i = 0; i < groups.length - 1; i++) {
    const ga = groups[i];
    const gb = groups[i + 1];
    if (!ga.length || !gb.length) continue;
    const a = ga[ga.length - 1];   // last word of group i
    const b = gb[0];               // first word of group i+1
    const anchors = neckAnchors(a, b);
    if (!anchors) continue;
    const [pa, pb] = anchors;

    const chord = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const side = noise(i * 3.7) >= 0 ? 1 : -1;
    const nx = -(pb.y - pa.y) / (chord || 1);
    const ny = (pb.x - pa.x) / (chord || 1);
    const mid = {
      x: (pa.x + pb.x) / 2 + nx * side * bow * chord,
      y: (pa.y + pb.y) / 2 + ny * side * bow * chord,
    };

    const lineH = ((a.y1 - a.y0) + (b.y1 - b.y0)) / 2;
    const dflt: [number, number, number] = [
      Math.max(10, 0.5 * lineH),
      Math.max(10, 0.28 * lineH),
      Math.max(10, 0.5 * lineH),
    ];
    capsules.push({ points: [pa, mid, pb], width: opts.neckWidth ?? dflt });
  }

  return { rects, capsules };
}

/** Attachment points between two word bboxes, chosen by relative position:
 *  below -> bottom/top edges; beside -> facing side edges. */
function neckAnchors(a: Bbox, b: Bbox): [Pt, Pt] | null {
  const acx = (a.x0 + a.x1) / 2;
  const acy = (a.y0 + a.y1) / 2;
  const bcx = (b.x0 + b.x1) / 2;
  const bcy = (b.y0 + b.y1) / 2;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));

  if (b.y0 - a.y1 >= -4) {
    // b is (mostly) below a
    return [
      { x: clamp(bcx, a.x0 + 4, a.x1 - 4), y: a.y1 },
      { x: clamp(acx, b.x0 + 4, b.x1 - 4), y: b.y0 },
    ];
  }
  if (a.y0 - b.y1 >= -4) {
    // b is above a
    return [
      { x: clamp(bcx, a.x0 + 4, a.x1 - 4), y: a.y0 },
      { x: clamp(acx, b.x0 + 4, b.x1 - 4), y: b.y1 },
    ];
  }
  if (a.x1 <= b.x0) {
    // b to the right
    return [
      { x: a.x1, y: clamp(bcy, a.y0 + 3, a.y1 - 3) },
      { x: b.x0, y: clamp(acy, b.y0 + 3, b.y1 - 3) },
    ];
  }
  // b to the left (or overlapping — anchor on facing edges anyway)
  return [
    { x: a.x0, y: clamp(bcy, a.y0 + 3, a.y1 - 3) },
    { x: b.x1, y: clamp(acy, b.y0 + 3, b.y1 - 3) },
  ];
}
