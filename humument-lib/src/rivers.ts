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

import { makeNoise2D } from './noise.js';
import type {
  Bbox, ChannelSegment, Compass, Dock, GraphNode, PageGraph, Port, Pt, Word,
} from './types.js';

/* ---------- port selection ----------------------------------------- */

function compassVec(c: Compass): Pt {
  switch (c) {
    case 'N': return { x: 0, y: -1 };
    case 'S': return { x: 0, y: 1 };
    case 'E': return { x: 1, y: 0 };
    case 'W': return { x: -1, y: 0 };
  }
}

function bboxCenter(b: { x0: number; y0: number; x1: number; y1: number }): Pt {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** Pick the (portA, portB) pair that flows most directly from A to B. */
export function pickPorts(a: Dock, b: Dock, wA: Word, wB: Word): [Port, Port] | null {
  if (!a.ports.length || !b.ports.length) return null;
  const ca = bboxCenter(wA);
  const cb = bboxCenter(wB);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  let best: [Port, Port] | null = null;
  let bestScore = Infinity;
  for (const pa of a.ports) {
    for (const pb of b.ports) {
      const aDir = compassVec(pa.compass);
      const bDir = compassVec(pb.compass);
      const forward  = dx * aDir.x + dy * aDir.y;
      const backward = -dx * bDir.x + -dy * bDir.y;
      const dd = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const score = dd - 0.5 * forward - 0.5 * backward;
      if (score < bestScore) {
        bestScore = score;
        best = [pa, pb];
      }
    }
  }
  return best;
}

/* ---------- Dijkstra ----------------------------------------------- */

interface HeapEntry { cost: number; id: number; }

class MinHeap {
  private a: HeapEntry[] = [];
  size() { return this.a.length; }
  push(e: HeapEntry) {
    this.a.push(e);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].cost <= this.a[i].cost) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): HeapEntry | undefined {
    if (!this.a.length) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.a[l].cost < this.a[smallest].cost) smallest = l;
        if (r < n && this.a[r].cost < this.a[smallest].cost) smallest = r;
        if (smallest === i) break;
        [this.a[smallest], this.a[i]] = [this.a[i], this.a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

export function dijkstra(
  graph: PageGraph,
  start: number,
  end: number,
): { nodeIds: number[]; gutterIds: number[] } {
  if (start === end) return { nodeIds: [start], gutterIds: [] };
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const prevGutter = new Map<number, number>();
  dist.set(start, 0);
  const heap = new MinHeap();
  heap.push({ cost: 0, id: start });
  while (heap.size()) {
    const cur = heap.pop()!;
    if (cur.id === end) break;
    if (cur.cost > (dist.get(cur.id) ?? Infinity)) continue;
    const node = graph.nodes.get(cur.id);
    if (!node) continue;
    for (const [nb, cost, gid] of node.edges) {
      const nd = cur.cost + cost;
      if (nd < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, nd);
        prev.set(nb, cur.id);
        prevGutter.set(nb, gid);
        heap.push({ cost: nd, id: nb });
      }
    }
  }
  if (!dist.has(end)) return { nodeIds: [], gutterIds: [] };
  const nodeIds: number[] = [];
  const gutterIds: number[] = [];
  let cur: number | undefined = end;
  while (cur !== undefined) {
    nodeIds.push(cur);
    const g = prevGutter.get(cur);
    if (g !== undefined) gutterIds.push(g);
    cur = prev.get(cur);
  }
  nodeIds.reverse();
  gutterIds.reverse();
  return { nodeIds, gutterIds };
}

/**
 * Discourage — but don't forbid — graph edges that hug the body bbox.
 * Returns a new graph with inflated edge costs along the borders.
 */
export function penalizeBorders(
  graph: PageGraph,
  body: Bbox,
  margin = 30,
  penalty = 30,
): PageGraph {
  const out = new Map<number, GraphNode>();
  graph.nodes.forEach((node, id) => {
    const modEdges: [number, number, number][] = node.edges.map(([neigh, cost, gid]) => {
      const n2 = graph.nodes.get(neigh);
      if (!n2) return [neigh, cost, gid];
      const nearTop = node.y <= body.y0 + margin && n2.y <= body.y0 + margin;
      const nearBot = node.y >= body.y1 - margin && n2.y >= body.y1 - margin;
      const nearLft = node.x <= body.x0 + margin && n2.x <= body.x0 + margin;
      const nearRgt = node.x >= body.x1 - margin && n2.x >= body.x1 - margin;
      if (nearTop || nearBot || nearLft || nearRgt) return [neigh, cost * penalty, gid];
      return [neigh, cost, gid];
    });
    out.set(id, { ...node, edges: modEdges });
  });
  return { nodes: out };
}

/* ---------- between(a, b) — graph path with port selection --------- */

/** Find a river path from word A to word B through the whitespace graph. */
export function between(
  wordA: Word,
  wordB: Word,
  graph: PageGraph,
  docks: Map<number, Dock>,
): ChannelSegment | null {
  const da = docks.get(wordA.id);
  const db = docks.get(wordB.id);
  if (!da || !db) return null;
  const picked = pickPorts(da, db, wordA, wordB);
  if (!picked) return null;
  const [pa, pb] = picked;
  const { nodeIds, gutterIds } = dijkstra(graph, pa.nodeId, pb.nodeId);
  if (nodeIds.length < 2) return null;
  const pts: Pt[] = nodeIds
    .map((nid) => graph.nodes.get(nid))
    .filter((n): n is GraphNode => !!n)
    .map((n) => ({ x: n.x, y: n.y }));
  return { points: pts, gutterIds };
}

/* ---------- flow walker -------------------------------------------- */

export interface FlowOptions {
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

function insideRect(x: number, y: number, r: Bbox): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Greedy Perlin walk from `start` to `end`. Returns the polyline. */
export function flow(start: Pt, end: Pt, opts: FlowOptions): Pt[] {
  const seed = opts.seed ?? 0;
  const stepSize = opts.stepSize ?? 2.5;
  const maxSteps = opts.maxSteps ?? 600;
  const noiseFreq = opts.noiseFreq ?? 0.007;
  const targetWeight = opts.targetWeight ?? 0.45;
  const candidateCount = opts.candidateCount ?? 24;
  const obstacles = opts.obstacles ?? [];

  const noise2 = makeNoise2D(seed);
  const pts: Pt[] = [{ ...start }];
  let p = { ...start };
  const startDist = Math.hypot(end.x - start.x, end.y - start.y);
  let bestDistSeen = startDist;
  let stallCount = 0;

  for (let iter = 0; iter < maxSteps; iter++) {
    const dxe = end.x - p.x;
    const dye = end.y - p.y;
    const dist = Math.hypot(dxe, dye);
    if (dist < stepSize * 1.5) break;
    const toTX = dxe / dist;
    const toTY = dye / dist;

    if (dist < bestDistSeen - 1) {
      bestDistSeen = dist;
      stallCount = 0;
    } else {
      stallCount++;
    }
    const stallBoost = Math.min(3, stallCount / 15);

    let bestTheta = Math.atan2(dye, dxe);
    let bestScore = Infinity;
    let foundValid = false;
    for (let k = 0; k < candidateCount; k++) {
      const theta = (k / candidateCount) * 2 * Math.PI;
      const cx = Math.cos(theta);
      const cy = Math.sin(theta);
      const nx = p.x + stepSize * cx;
      const ny = p.y + stepSize * cy;
      if (nx < opts.body.x0 || nx > opts.body.x1 || ny < opts.body.y0 || ny > opts.body.y1) continue;
      let blocked = false;
      for (const r of obstacles) {
        if (insideRect(nx, ny, r)) { blocked = true; break; }
      }
      if (blocked) continue;
      const nval = noise2(nx * noiseFreq, ny * noiseFreq);
      const towardTarget = 1 - (cx * toTX + cy * toTY);
      const effectiveTW = targetWeight * (1 + stallBoost);
      const score = nval * 0.7 + towardTarget * effectiveTW;
      if (score < bestScore) {
        bestScore = score;
        bestTheta = theta;
        foundValid = true;
      }
    }
    if (!foundValid) break;
    p = {
      x: p.x + stepSize * Math.cos(bestTheta),
      y: p.y + stepSize * Math.sin(bestTheta),
    };
    pts.push({ ...p });
  }
  pts.push({ ...end });
  return pts;
}

/** Convenience: build obstacle bboxes from words minus a selected set. */
export function obstaclesFrom(words: Word[], selectedIds: Iterable<number>, pad = 1): Bbox[] {
  const sel = new Set(selectedIds);
  return words
    .filter((w) => !sel.has(w.id))
    .map((w) => ({ x0: w.x0 - pad, y0: w.y0 - pad, x1: w.x1 + pad, y1: w.y1 + pad }));
}
