# humument-images

Normalized page scans of the **1892 one-volume Chapman & Hall edition** of
W. H. Mallock's *A Human Document* — the novel Tom Phillips treated to make
*A Humument*. This package is the image layer consumed by
[humument](https://www.npmjs.com/package/humument); the word bboxes in
[humument-data](https://www.npmjs.com/package/humument-data) are in these
images' pixel coordinates.

## Layout

```
pages/pNNNN.jpg    one per printed page (1–367), 1400×2100 grayscale JPEG
```

Pages are deskewed, aligned (running header anchored), flat-fielded, and
contrast-normalized B&W renditions of the original scan — ready to draw over.

```js
const url = 'https://cdn.jsdelivr.net/npm/humument-images@0.1/pages/p0040.jpg';
```

## Provenance

Derived from the Internet Archive scan
[`ahumandocumenta04mallgoog`](https://archive.org/details/ahumandocumenta04mallgoog)
(Google-digitized). The 1892 book is in the public domain; this packaging is
MIT-licensed. `pNNNN` is the printed book page = the *A Humument* page.
