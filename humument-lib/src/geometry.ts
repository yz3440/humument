/**
 * Pure geometry helpers — no DOM, no framework. Each returns plain arrays of
 * `{x, y}` points so callers can render with whatever drawing API.
 */

import { makeNoise } from './noise.js';
import type { Bbox, ChannelSegment, Gutter, Pt } from './types.js';

/* ---------- balloon outline ---------------------------------------- */

export interface BalloonOptions {
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
export function balloonPath(bbox: Bbox, opts: BalloonOptions = {}): Pt[] {
  const pad = opts.pad ?? 6;
  const wobble = opts.wobble ?? 0.12;
  const wobbleFreq = opts.wobbleFreq ?? 0.45;
  const samples = opts.samples ?? 32;
  const seed = opts.seed ?? 0;
  const noise = makeNoise(seed);

  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  const rxBase = (bbox.x1 - bbox.x0) / 2 + pad;
  const ryBase = (bbox.y1 - bbox.y0) / 2 + pad;

  const out: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const n = noise(i * wobbleFreq);
    const n2 = noise(i * wobbleFreq * 2.3 + 100) * 0.5;
    const mod = 1 + (n + n2) * wobble;
    out.push({ x: cx + ct * rxBase * mod, y: cy + st * ryBase * mod });
  }
  return out;
}

/* ---------- river/channel ribbon ----------------------------------- */

export interface ChannelOptions {
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
export function channelPath(seg: ChannelSegment, opts: ChannelOptions = {}): Pt[] {
  const halfWidth   = opts.halfWidth ?? 4;
  const jitter      = opts.jitter ?? 1.4;
  const jitterFreq  = opts.jitterFreq ?? 0.09;
  const meander     = opts.meander ?? 0.55;
  const meanderFreq = opts.meanderFreq ?? 0.018;
  const widthMod    = opts.widthMod ?? 0.4;
  const widthModFreq= opts.widthModFreq ?? 0.035;
  const sampleStep  = opts.sampleStep ?? 1.6;
  const seed        = opts.seed ?? 0;
  const gutterById  = opts.gutterById;
  const noise = makeNoise(seed);

  const dense = sampleCatmullRomWithGutter(seg.points, seg.gutterIds, sampleStep);
  if (dense.length < 2) return [];

  const top: Pt[] = [];
  const bot: Pt[] = [];
  for (let i = 0; i < dense.length; i++) {
    const q = dense[i].p;
    const gid = dense[i].gid;
    const g = gutterById?.get(gid);
    const gutterHalf = g ? Math.max(1, g.minWidth / 2) : 6;

    const prev = dense[Math.max(0, i - 1)].p;
    const next = dense[Math.min(dense.length - 1, i + 1)].p;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    const wobble = noise(i * jitterFreq) * jitter;
    const meanderMax = Math.max(0, gutterHalf - halfWidth - 0.5);
    const meanderOff = noise(i * meanderFreq + 50) * meander * meanderMax;
    const widthN = noise(i * widthModFreq + 200);
    const hwFrac = 1 + widthN * widthMod;
    const hw = Math.min(gutterHalf - 0.3, Math.max(0.6, halfWidth * hwFrac));

    const cx = q.x + nx * (wobble + meanderOff);
    const cy = q.y + ny * (wobble + meanderOff);
    top.push({ x: cx + nx * hw, y: cy + ny * hw });
    bot.push({ x: cx - nx * hw, y: cy - ny * hw });
  }

  return [...top, ...bot.reverse()];
}

interface DensePt {
  p: Pt;
  gid: number;
}

function sampleCatmullRomWithGutter(
  pts: Pt[],
  gutterIds: number[],
  step: number,
): DensePt[] {
  if (pts.length < 2) return pts.map((p) => ({ p, gid: gutterIds[0] ?? -1 }));
  if (pts.length === 2) {
    const gid = gutterIds[0] ?? -1;
    const out: DensePt[] = [];
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const n = Math.max(2, Math.ceil(d / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push({
        p: { x: pts[0].x + (pts[1].x - pts[0].x) * t, y: pts[0].y + (pts[1].y - pts[0].y) * t },
        gid,
      });
    }
    return out;
  }
  const padded: Pt[] = [
    { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y },
    ...pts,
    {
      x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x,
      y: 2 * pts[pts.length - 1].y - pts[pts.length - 2].y,
    },
  ];
  const out: DensePt[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    const segIdx = i - 1;
    const gid = gutterIds[segIdx] ?? gutterIds[gutterIds.length - 1] ?? -1;
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const nSteps = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < nSteps; k++) {
      const t = k / nSteps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ p: { x, y }, gid });
    }
  }
  out.push({ p: pts[pts.length - 1], gid: gutterIds[gutterIds.length - 1] ?? -1 });
  return out;
}

/* ---------- banner / pennant strip --------------------------------- */

export type BannerEnd = 'square' | 'point' | 'swallowtail';

export interface BannerOptions {
  /** Extra px of padding beyond the bbox edges. Default 6. */
  pad?: number;
  /** End style, or [left, right] per end. Default 'swallowtail'. */
  ends?: BannerEnd | [BannerEnd, BannerEnd];
  /** How far an end extends beyond the padded bbox (px).
   *  Default 0.55 x banner height. */
  endLength?: number;
  /** Swallowtail notch depth as a fraction of `endLength`. Default 0.65. */
  notch?: number;
  /** Total x-shear from top edge to bottom edge (px). Default 0. */
  skew?: number;
  /** Rotation about the banner centre (radians). Default 0. */
  angle?: number;
  /** Hand-cut wobble on the long edges only (px) — end vertices stay crisp.
   *  Default 1.2. */
  wobble?: number;
  /** Wobble frequency in cycles per px along the edge. Default 0.03. */
  wobbleFreq?: number;
  /** Long-edge densification step (px). Default 4. */
  step?: number;
  /** PRNG seed. Default 0. */
  seed?: number;
}

/**
 * Angular pennant/banner strip around a text-line bbox — the paper-ribbon
 * shapes of A Humument p15's dialogue: straight long edges, ends cut square,
 * to a point, or with an inward swallowtail notch. Returns polygon vertices
 * (clockwise in screen coords, matching blobPath outers).
 */
export function bannerPath(bbox: Bbox, opts: BannerOptions = {}): Pt[] {
  const pad = opts.pad ?? 6;
  const x0 = bbox.x0 - pad;
  const x1 = bbox.x1 + pad;
  const y0 = bbox.y0 - pad;
  const y1 = bbox.y1 + pad;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const cx = (x0 + x1) / 2;

  const ends = opts.ends ?? 'swallowtail';
  const [leftEnd, rightEnd]: [BannerEnd, BannerEnd] =
    Array.isArray(ends) ? ends : [ends, ends];
  const e = opts.endLength ?? 0.55 * h;
  const depth = (opts.notch ?? 0.65) * e;
  const skew = opts.skew ?? 0;
  const angle = opts.angle ?? 0;
  const wobble = opts.wobble ?? 1.2;
  const wobbleFreq = opts.wobbleFreq ?? 0.03;
  const step = opts.step ?? 4;
  const noise = makeNoise(opts.seed ?? 0);

  // End vertex runs, top-to-bottom on the right, bottom-to-top on the left.
  const rightRun: Pt[] =
    rightEnd === 'square' ? [{ x: x1, y: y0 }, { x: x1, y: y1 }]
    : rightEnd === 'point' ? [{ x: x1, y: y0 }, { x: x1 + e, y: cy }, { x: x1, y: y1 }]
    : [{ x: x1 + e, y: y0 }, { x: x1 + e - depth, y: cy }, { x: x1 + e, y: y1 }];
  const leftRun: Pt[] =
    leftEnd === 'square' ? [{ x: x0, y: y1 }, { x: x0, y: y0 }]
    : leftEnd === 'point' ? [{ x: x0, y: y1 }, { x: x0 - e, y: cy }, { x: x0, y: y0 }]
    : [{ x: x0 - e, y: y1 }, { x: x0 - e + depth, y: cy }, { x: x0 - e, y: y0 }];

  // Long edges densified + wobbled in y; corner vertices stay exact.
  const edge = (ax: number, bx: number, y: number, phase: number): Pt[] => {
    const out: Pt[] = [];
    const len = Math.abs(bx - ax);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + (bx - ax) * t;
      out.push({ x, y: y + noise(Math.abs(x - x0) * wobbleFreq + phase) * wobble });
    }
    return out;
  };

  const topLeft = leftRun[leftRun.length - 1];
  const topRight = rightRun[0];
  const bottomRight = rightRun[rightRun.length - 1];
  const bottomLeft = leftRun[0];

  const pts: Pt[] = [
    ...leftRun,
    ...edge(topLeft.x, topRight.x, y0, 0),
    ...rightRun,
    ...edge(bottomRight.x, bottomLeft.x, y1, 100),
  ];

  // Shear, then rotate about the centre.
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return pts.map((p) => {
    const sx = p.x + skew * ((p.y - cy) / h);
    if (!angle) return { x: sx, y: p.y };
    const dx = sx - cx;
    const dy = p.y - cy;
    return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca };
  });
}

/** Smooth a polyline with Catmull-Rom interpolation. */
export function catmullRom(points: Pt[], tension = 0.5, samplesPerSegment = 12): Pt[] {
  if (points.length < 3) return points.slice();
  const padded: Pt[] = [
    { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y },
    ...points,
    {
      x: 2 * points[points.length - 1].x - points[points.length - 2].x,
      y: 2 * points[points.length - 1].y - points[points.length - 2].y,
    },
  ];
  const out: Pt[] = [points[0]];
  for (let i = 1; i < padded.length - 2; i++) {
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    for (let k = 1; k <= samplesPerSegment; k++) {
      const t = k / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t * tension + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t * tension + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y });
    }
  }
  return out;
}
