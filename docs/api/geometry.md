# Geometry

`humument` is **renderer-agnostic**: it turns words and river paths into plain
`{x, y}` point arrays and draws nothing itself. You render those arrays with
whatever 2D API you like — the Canvas2D `<canvas>`, SVG, WebGL, or a server-side
canvas.

## `H.geom.blob(spec, opts?)` {: #blob }

```ts
H.geom.blob(spec: BlobSpec, opts?: BlobOptions): Pt[][]
```

*Added in 0.2.0.* The **faithful A Humument balloon**. Phillips's balloons are
not ellipses: each phrase is a tight hull hugging its words, and consecutive
phrases merge into **one organic silhouette** through tapered necks that flare
where they attach. `blob` reproduces that construction: a signed-distance
**union** of padded word rects and tapered neck capsules (blended with a
smooth-min so junctions fillet), sampled on a grid and traced at the zero
isoline with marching squares, then resampled, smoothed, and given a hand-cut
wobble along the field gradient.

Returns **closed contours sorted by |area| descending** — `result[0]` is the
main silhouette. Outer loops and holes carry opposite windings, so a
nonzero-winding fill renders holes correctly. (Phillips cuts only the outer
contour, so most consumers simply fill every contour and ignore holes.)

One `spec` = one balloon or one connected chain. Anything in the same spec
within `2·pad + blend` will fuse — call `blob` once per balloon/chain, never
batch unrelated balloons into one spec.

`BlobSpec`:

| Field | Type | Notes |
| --- | --- | --- |
| `rects` | `Bbox[]` | Word (or line-run) bboxes to hug. `Word` satisfies `Bbox` structurally, so you can pass words directly. |
| `capsules` | `BlobCapsule[]?` | Neck spines: `{ points: Pt[], width: number \| [start, mid, end] }`. `width` is the full width in px; a scalar `w` expands to `[w, 0.55·w, w]` (the classic pinched neck). Spines with 3+ points are smoothed with an interpolating Catmull-Rom. |

`BlobOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `pad` | `number?` | `6` | Outward offset from the rects (px). Corners round by this much for free (SDF offsetting). |
| `cornerRadius` | `number?` | `0` | Extra corner rounding on top of `pad`. |
| `blend` | `number?` | `8` | Smooth-union radius (px): necks and stacked lines flare into each other instead of meeting at a crease. `0` = hard union. |
| `cell` | `number?` | `3` | Max sample-grid cell (px). Auto-clamped down for small blobs and so the thinnest capsule spans ≥ 4 cells. |
| `resample` | `number?` | `2.5` | Output vertex spacing along the contour (px). |
| `smooth` | `number?` | `2` | Box-filter smoothing passes (kills grid stair-steps, preserves the stepped concavities of multi-line hulls). |
| `wobble` | `number?` | `2` | Hand-cut wobble amplitude along the outward normal (px). |
| `wobbleFreq` | `number?` | `0.02` | Wobble frequency in cycles per px of arc length. |
| `seed` | `number?` | `0` | PRNG seed. |

```js
// one chain: two phrases fused by a tapered neck
const spec = H.geom.blobSpec([phraseA, phraseB]); // or hand-build the BlobSpec
const contours = H.geom.blob(spec, { pad: 8, blend: 10, seed: 7 }); // → Pt[][]

// draw with Canvas2D — fill + stroke one path = one ink rim
for (const loop of contours) {
  ctx.beginPath();
  loop.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
```

## `H.geom.blobSpec(groups, opts?)` {: #blobspec }

```ts
H.geom.blobSpec(groups: Word[][], opts?: BlobSpecOptions): BlobSpec
```

*Added in 0.2.0.* Convenience builder: rects from every word in `groups`, plus
a tapered neck between each **consecutive pair of groups**, anchored at the
last word of one group and the first word of the next (how Phillips attaches
them), with a gently bowed spine. Hand-build the `BlobSpec` instead when you
need custom neck routing.

`BlobSpecOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `neckWidth` | `number \| [number, number, number]?` | from line height | Full neck width; defaults to `[0.5·h, 0.28·h, 0.5·h]` of the anchor words' line height, floored at 10 px. |
| `bow` | `number?` | `0.22` | Perpendicular bow of the neck spine as a fraction of the chord length; sign alternates pseudo-randomly per neck. |
| `seed` | `number?` | `0` | PRNG seed for the bow direction. |

## `H.geom.blobField(spec, opts?)` {: #blobfield }

```ts
H.geom.blobField(spec: BlobSpec, opts?: BlobOptions): (x: number, y: number) => number
```

*Added in 0.2.0.* The blob's signed-distance field itself (negative inside).
Useful for probing clearance between separately drawn balloons — e.g. assert
`field(otherAnchor) > margin` before placing a neighbour.

## `H.geom.banner(bbox, opts?)` {: #banner }

```ts
H.geom.banner(bbox: Bbox, opts?: BannerOptions): Pt[]
```

*Added in 0.2.0.* An angular **pennant/banner strip** around a text-line bbox —
the paper-ribbon dialogue shapes of A Humument p15: straight long edges with a
subtle hand-cut wobble, ends cut square, to a point, or with an inward
swallowtail notch. Returns polygon vertices (clockwise in screen coordinates,
matching `blob` outers).

`BannerOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `pad` | `number?` | `6` | Extra px beyond the bbox edges. |
| `ends` | `BannerEnd \| [BannerEnd, BannerEnd]?` | `'swallowtail'` | End style, or `[left, right]` per end: `'square' \| 'point' \| 'swallowtail'`. |
| `endLength` | `number?` | `0.55 × height` | How far an end extends beyond the padded bbox (px). |
| `notch` | `number?` | `0.65` | Swallowtail notch depth as a fraction of `endLength`. |
| `skew` | `number?` | `0` | Total x-shear from top edge to bottom edge (px). |
| `angle` | `number?` | `0` | Rotation about the banner centre (radians). |
| `wobble` | `number?` | `1.2` | Wobble on the long edges only — end vertices stay crisp (px). |
| `wobbleFreq` | `number?` | `0.03` | Wobble frequency (cycles per px). |
| `step` | `number?` | `4` | Long-edge densification step (px). |
| `seed` | `number?` | `0` | PRNG seed. |

## `H.geom.balloon(bbox, opts?)`

```ts
H.geom.balloon(bbox: Bbox, opts?: BalloonOptions): Pt[]
```

A wobbly closed loop around a **bounding box** (note: a `Bbox`, not words — use
[`H.bboxOf`](pages.md#words) to go from a phrase to a box). Returns polygon
vertices.

**Picking between `balloon` and [`blob`](#blob):** `blob` is the faithful
text-hugging silhouette but costs a field march (~tens of ms per chain) —
perfect for a one-shot page render. `balloon` is a cheap analytic 32-point
loop — the right choice when drawing every frame or animating many shapes.

`BalloonOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `pad` | `number?` | `6` | Extra px beyond the bbox edges. |
| `wobble` | `number?` | `0.12` | Boundary radius modulation, as a fraction of radius. |
| `wobbleFreq` | `number?` | `0.45` | Spatial frequency of the wobble noise. |
| `samples` | `number?` | `32` | Points around the boundary. |
| `seed` | `number?` | `0` | PRNG seed. |

```js
const outline = H.geom.balloon(H.bboxOf(phrase), { wobble: 0.15 }); // → Pt[]

// draw it with Canvas2D:
ctx.beginPath();
outline.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
ctx.closePath();
ctx.stroke();
```

## `H.geom.channel(seg, opts?)`

```ts
H.geom.channel(seg: ChannelSegment, opts?: ChannelOptions): Pt[]
```

Turns a river [`ChannelSegment`](rivers.md#hriverbetweena-b) into a thick wavy
ribbon: it smooths the polyline (Catmull-Rom), meanders it within its gutter, and
returns the **outer polygon** as an ordered ring (top edge, then bottom edge
reversed) — fill it as a closed path.

`ChannelOptions`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `halfWidth` | `number?` | `4` | Ribbon half-thickness at the centreline (px). |
| `jitter` | `number?` | `1.4` | High-frequency wobble amplitude (px). |
| `jitterFreq` | `number?` | `0.09` | High-frequency wobble frequency. |
| `meander` | `number?` | `0.55` | Low-frequency lateral drift, as a fraction of gutter half-width. |
| `meanderFreq` | `number?` | `0.018` | Meander noise frequency. |
| `widthMod` | `number?` | `0.4` | Thickness variance (0–0.8). |
| `widthModFreq` | `number?` | `0.035` | Thickness modulation frequency. |
| `sampleStep` | `number?` | `1.6` | Sample step along the polyline (px). |
| `seed` | `number?` | `0` | PRNG seed. |
| `gutterById` | `Map<number, Gutter>?` | — | Gutter map, so the ribbon can respect each gutter's `minWidth`. |

Pass `gutterById` (e.g. `new Map(H.gutters.map(g => [g.gutterId, g]))`) to let the
ribbon widen and narrow with the actual channels.

## `H.geom.catmullRom(points, tension?, samplesPerSegment?)`

```ts
H.geom.catmullRom(points: Pt[], tension = 0.5, samplesPerSegment = 12): Pt[]
```

Smooths any polyline with Catmull-Rom interpolation — handy for softening a
[`between`](rivers.md#hriverbetweena-b) path before drawing it as a thin line.
Returns the input unchanged if it has fewer than 3 points.

## The page image

The library gives you `H.page.imageUrl`; loading and drawing the page scan is the
host's job (any image-capable renderer). A minimal Canvas2D version:

```js
const img = new Image();
img.crossOrigin = 'anonymous';
img.onload = () => ctx.drawImage(img, 0, 0);
img.src = H.page.imageUrl;
```
