# Noise & Random

Cheap, deterministic, **seedable** randomness — the hand-drawn wobble on balloons
and the meander on rivers all come from here. Because everything is seeded, a
given seed always redraws the exact same shape, which is what makes sketches
reproducible.

## `H.noise(seed)`

```ts
H.noise(seed: number): (x: number) => number
```

Returns a **1D value-noise** function. Call it with a coordinate to get a smooth
value in **`[-1, 1]`**. Nearby inputs give nearby outputs (unlike `random`),
which is what makes it read as organic jitter rather than static.

```js
const n = H.noise(42);
n(0.0);   // e.g. -0.13
n(0.1);   // close to n(0.0)
```

## `H.noise2D(seed)`

```ts
H.noise2D(seed: number): (x: number, y: number) => number
```

The **2D** counterpart — a value in `[-1, 1]` that varies smoothly across the
plane. This is the field `H.river.flow` walks.

```js
const field = H.noise2D(7);
field(x * 0.007, y * 0.007);
```

## `H.random(seed)`

```ts
H.random(seed: number): () => number
```

A seeded **PRNG** (mulberry32). Returns a function you call with no arguments for
the next float in **`[0, 1)`**. Unlike `noise`, successive values are
uncorrelated — use it for shuffles and discrete choices.

```js
const rnd = H.random(123);
rnd();                       // e.g. 0.7263
const pick = arr[Math.floor(rnd() * arr.length)];
```

## Why seeded?

All of `humument`'s wobble/meander/shuffle is driven by these three, so
passing the same `seed` to [`selectChunks`](chunks.md#hselectchunksopts),
[`balloon`](geometry.md#hgeomballoonbbox-opts), or
[`channel`](geometry.md#hgeomchannelseg-opts) reproduces the identical result —
essential for iterating on a composition, saving a sketch, or rendering the same
frame twice.
