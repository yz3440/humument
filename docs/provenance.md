# Provenance & License

## Source

Everything derives from a single scan: the Internet Archive item
[`ahumandocumenta04mallgoog`](https://archive.org/details/ahumandocumenta04mallgoog),
a Google-digitized copy of the **one-volume Chapman & Hall "New Edition" (1892)**
of W. H. Mallock's _A Human Document_.

This is deliberately the **same edition Tom Phillips used** for _A Humument_, so
this project's page numbers map **page-for-page** onto both the printed book and
Phillips's work — printed page `N` = `humument` page `N` = _A Humument_ page `N`,
for `N` in 1–367.

> The multi-volume "three-decker" first edition has different pagination and
> does **not** line up with _A Humument_; this repo deliberately uses only the
> one-volume 1892 edition.

## How the data was made

The scanned PDF is rasterized, OCR'd **locally with Apple Vision** (via
[`ocrmac`](https://github.com/straussmaximilian/ocrmac) — **no cloud APIs**),
deskewed and aligned, contrast-normalized to clean B&W, annotated with NLP
features, and analyzed for whitespace geometry. The full process is described in
[The Pipeline](pipeline.md).

`data/humument.db` is the **canonical OCR artifact**. Because Apple Vision OCR is
nondeterministic, re-running the pipeline will not reproduce it byte-for-byte —
so the database is versioned in the repository (via git-lfs) rather than treated
as regenerable.

## License

The 1892 novel is in the **public domain**. This project's **code, the derived
data, and the packaging are MIT-licensed** — the
[`humument`](https://github.com/yz3440/humument) repository and all three npm
packages ([humument-lib](data/packages.md), [humument-data](data/packages.md),
[humument-images](data/packages.md)).

See the [`LICENSE`](https://github.com/yz3440/humument/blob/main/LICENSE) file
for the full text.

## Citing / building on it

If you make something with these tools, a link back to the
[repository](https://github.com/yz3440/humument) is appreciated.
