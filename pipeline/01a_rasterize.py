"""Stage 1a — rasterise PDF pages to JPEG at 300dpi via PyMuPDF.

Pages are addressed by PRINTED page number (== DB page_num == A Humument page).
The PDF's raster image index is `printed + PAGE_OFFSET`; this stage is the only
place that bridge is applied, so JPEGs are written printed-keyed (p{printed}.jpg)
and every downstream stage works in printed-page space.
"""

from __future__ import annotations

import argparse

import fitz
from PIL import Image

from config import (
    DPI, PDF, DIR_PAGES, PAGE_OFFSET, PDF_CONTENT_START, PDF_CONTENT_END,
    page_img, parse_pages,
)


def main():
    ap = argparse.ArgumentParser(description="Stage 1a: PDF → JPEG pages")
    ap.add_argument("--pages", help="printed page(s), e.g. '33' or '1,5-10'. "
                                     "Default: content range.")
    ap.add_argument("--dpi", type=int, default=DPI)
    a = ap.parse_args()

    DIR_PAGES.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(PDF)
    try:
        if a.pages:
            pages = parse_pages(a.pages, len(doc))
        else:
            pages = list(range(PDF_CONTENT_START, PDF_CONTENT_END + 1))
        for p in pages:  # p is the PRINTED page number == DB page_num
            raster = p + PAGE_OFFSET  # 1-based index into the PDF
            if not 1 <= raster <= len(doc):
                print(f"  skip printed {p} (raster {raster} out of 1..{len(doc)})")
                continue
            jpg = page_img(p)
            if not jpg.exists():
                pix = doc[raster - 1].get_pixmap(dpi=a.dpi)
                img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                img.save(jpg, quality=90)
                print(f"  printed {p:4d} (raster {raster}) → {jpg}")
            else:
                print(f"  printed {p:4d} → {jpg} (exists)")
    finally:
        doc.close()


if __name__ == "__main__":
    main()
