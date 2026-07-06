/**
 * p5-aware drawing sugar. Optional — every primitive in `geometry.ts`
 * also returns plain arrays so users can render with bare p5 calls.
 *
 * The helpers accept a p5 instance (instance mode) OR fall back to the
 * window globals (global mode). Inside the editor's preview iframe the
 * sketch runs in global mode, so passing nothing Just Works.
 */

import { balloonPath, channelPath, type BalloonOptions, type ChannelOptions } from './geometry.js';
import { bboxOf } from './words.js';
import type { ChannelSegment, Word } from './types.js';
import type p5 from 'p5';

type AnyP5 = p5 | (Window & typeof globalThis);

function p(g?: AnyP5): AnyP5 {
  if (g) return g;
  // p5 global mode attaches functions to window.
  if (typeof window !== 'undefined') return window as AnyP5;
  throw new Error('No p5 instance provided and no window global available');
}

/** Draw the wobbly balloon enclosing the given words. */
export function drawBalloon(
  words: Word[],
  opts: BalloonOptions = {},
  pInst?: p5,
): void {
  if (!words.length) return;
  const g = p(pInst) as any;
  const pts = balloonPath(bboxOf(words), opts);
  g.beginShape();
  // Catmull-Rom-ish spline through points so the boundary reads as a smooth
  // hand-drawn curve rather than a 32-sided polygon.
  g.curveVertex(pts[pts.length - 1].x, pts[pts.length - 1].y);
  for (const pt of pts) g.curveVertex(pt.x, pt.y);
  g.curveVertex(pts[0].x, pts[0].y);
  g.curveVertex(pts[1].x, pts[1].y);
  g.endShape(g.CLOSE);
}

/** Draw a thick wavy ribbon along a river segment. */
export function drawRiver(
  segment: ChannelSegment,
  opts: ChannelOptions = {},
  pInst?: p5,
): void {
  if (!segment || segment.points.length < 2) return;
  const g = p(pInst) as any;
  const ring = channelPath(segment, opts);
  if (!ring.length) return;
  g.beginShape();
  for (const pt of ring) g.vertex(pt.x, pt.y);
  g.endShape(g.CLOSE);
}

/**
 * Draw the original word's pixels onto the canvas — useful for
 * "preserved word stays crisp" effects. Crops the page image at the
 * word's bbox and re-blits at the same coordinates.
 *
 * Requires that `pageImage` was loaded (e.g. via Humument.load).
 */
export function drawWord(
  word: Word,
  pageImage: p5.Image,
  pInst?: p5,
): void {
  const g = p(pInst) as any;
  const w = word.x1 - word.x0;
  const h = word.y1 - word.y0;
  if (w <= 0 || h <= 0) return;
  g.image(pageImage, word.x0, word.y0, w, h, word.x0, word.y0, w, h);
}

/** Draw the full page image at native resolution. */
export function drawImage(pageImage: p5.Image, pInst?: p5): void {
  const g = p(pInst) as any;
  g.image(pageImage, 0, 0);
}
