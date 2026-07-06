/**
 * Cheap, deterministic, seedable value-noise. Use for hand-drawn jitter on
 * balloon outlines, river meander, etc. Returns values in [-1, 1].
 *
 * `makeNoise(seed)`   -> 1D
 * `makeNoise2D(seed)` -> 2D
 */

export function makeNoise(seed: number): (x: number) => number {
  const mul = 0x45d9f3b;
  return (x: number) => {
    const xi = Math.floor(x);
    const xf = x - xi;
    const h = (i: number) => {
      let n = ((i ^ seed) * mul) >>> 0;
      n = ((n ^ (n >>> 16)) * mul) >>> 0;
      n = (n ^ (n >>> 16)) >>> 0;
      return (n & 0xffff) / 0xffff;
    };
    const a = h(xi);
    const b = h(xi + 1);
    const t = xf * xf * (3 - 2 * xf);
    return (a * (1 - t) + b * t) * 2 - 1;
  };
}

export function makeNoise2D(seed: number): (x: number, y: number) => number {
  const hash = (i: number, j: number) => {
    let n = (((i | 0) * 374761393 + (j | 0) * 668265263 + seed) * 1274126177) >>> 0;
    n = ((n ^ (n >>> 13)) * 1274126177) >>> 0;
    n = (n ^ (n >>> 16)) >>> 0;
    return ((n & 0xffffff) / 0xffffff) * 2 - 1;
  };
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

/** Mulberry32 PRNG — float in [0, 1). Seedable, ~2^32 period. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
