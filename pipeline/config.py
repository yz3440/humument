"""Shared paths, constants, and helpers for all pipeline stages.

Single-edition source: the one-volume Chapman & Hall 1892 "New Edition" of
W. H. Mallock's *A Human Document* (Internet Archive item
`ahumandocumenta04mallgoog`) — the edition Tom Phillips treated to make
*A Humument*, which maps page-for-page onto it.

DB `page_num` equals the PRINTED book page (= the A Humument page), 1..367.
The PDF scan has front matter and a trailing publisher catalogue, so the
raster image index differs from the printed page by a constant `page_offset`:

    raster_index (1-based into the PDF) = printed_page + page_offset

The offset is applied in exactly one place (stage 01a); after rasterisation
every artifact and DB row is keyed by printed page, so all later stages and
the editor work in printed-page space with no offset awareness.

Single edition: there is no `volume` abstraction. The DB is keyed by
`page_num` alone, and data lives directly under `data/<sub>/`.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


# === Source edition (scan-specific settings) ================================

PDF_NAME = "ahumandocumenta04mallgoog.pdf"
PDF_CONTENT_START = 1       # printed page 1 (Introduction) == raster 10
PDF_CONTENT_END = 367       # printed page 367 ("THE END") == raster 376;
                            # raster 377 is the colophon, 378+ the catalogue
PAGE_OFFSET = 9             # raster_index = printed_page + PAGE_OFFSET (measured)
HEADER_TOP_FRAC = 0.067
# Body region as fractions (top, bottom, left, right).
BODY_TOP_FRAC, BODY_BOTTOM_FRAC, BODY_LEFT_FRAC, BODY_RIGHT_FRAC = 0.106, 0.972, 0.15, 0.85
# Empty: this edition prints the "A HUMAN DOCUMENT" running header at the top of
# EVERY page (chapter openings just add "CHAPTER N" below it), so all pages
# align as title pages (01c Pass 1) — there are no header-less chapter pages.
CHAPTER_PAGES: set[int] = set()


# === Scan-agnostic constants ================================================

DPI = 300
OUTPUT_WIDTH = 1400         # output canvas width
OUTPUT_HEIGHT = 2100        # output canvas height. Tall enough to hold this
                            # densely-set edition's full text block with a
                            # natural bottom margin (source rasters are ~2246px;
                            # 1867 clipped the last line flush to the edge). The
                            # header is anchored near the top, so the remaining
                            # space falls as bottom margin.

# Stage 1d B&W cleanup tuning knobs.
TEXT_BBOX_MARGIN      = 60     # px around OCR'd word bboxes before whitewash
SHADOW_STRIP_PX       = 100    # px depth scanned inward from valid edge
SHADOW_GRAD_THRESHOLD = 12     # luma gradient peak treated as a shadow edge
STRETCH_WINDOW        = 200    # px window for local mean/std contrast stretch
STRETCH_WHITE_K       = 0.3    # white-point = local_mean − k · local_std
STRETCH_BLACK_K       = 2.5    # black-point = local_mean − k · local_std
STRETCH_MIN_SPAN      = 100    # floor for (white_pt − black_pt) — prevents
                               # noise amplification in uniform paper regions
NORMALIZED_JPEG_Q     = 50     # JPEG quality for pages_normalized/*.jpg
FLATFIELD_MAX_KERNEL  = 81     # max-filter size for the local paper estimate
FLATFIELD_SMOOTH_SIGMA = 60.0  # Gaussian blur sigma applied to the paper estimate


# === Derived paths ==========================================================

PDF = REPO_ROOT / "original-document" / PDF_NAME

_data = REPO_ROOT / "data"
DIR_PAGES = _data / "pages"
DIR_PAGES_CORRECTED = _data / "pages_corrected"
DIR_PAGES_NORMALIZED = _data / "pages_normalized"
DIR_VIS = _data / "vis"
DIR_OUTPUT = REPO_ROOT / "output"

DB_PATH = REPO_ROOT / "data" / "humument.db"


# === Helpers ================================================================

def page_img(n: int) -> Path:
    return DIR_PAGES / f"p{n:04d}.jpg"


def page_img_corrected(n: int) -> Path:
    return DIR_PAGES_CORRECTED / f"p{n:04d}.jpg"


def page_img_normalized(n: int) -> Path:
    return DIR_PAGES_NORMALIZED / f"p{n:04d}.jpg"


def parse_pages(spec: str | None, total: int) -> list[int]:
    """Parse '1,3,5-10' into [1, 3, 5, 6, 7, 8, 9, 10]. None → all pages."""
    if not spec:
        return list(range(1, total + 1))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out
