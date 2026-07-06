# Geometry

`humument-lib` is **renderer-agnostic**: it turns words and river paths into plain
`{x, y}` point arrays and draws nothing itself. You render those arrays with
whatever 2D API you like — the Canvas2D `<canvas>`, SVG, WebGL, or a server-side
canvas.

## `H.geom.balloon(bbox, opts?)`

```ts
H.geom.balloon(bbox: Bbox, opts?: BalloonOptions): Pt[]
```

A wobbly closed loop around a **bounding box** (note: a `Bbox`, not words — use
[`H.bboxOf`](pages.md#words) to go from a phrase to a box). Returns polygon
vertices.

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
