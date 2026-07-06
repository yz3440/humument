"""Maintenance — re-extract OCR words from the existing corrected pages.

Use after changing ocr.py (word segmentation, merged-line repair, tokenize):
rewrites the `pages` and `words` rows from data/pages_corrected/*.jpg without
touching geometry. Do NOT re-run 01c for this — its correction math assumes
the DB holds first-pass raw-scan words, which is no longer true after a full
pipeline run. Downstream stages must be re-run afterwards:

    uv run python pipeline/reocr_corrected.py
    uv run python pipeline/01d_normalize_color.py
    uv run python pipeline/01e_features.py
    uv run python pipeline/02_whitespace_graph.py
"""

from __future__ import annotations

import argparse
import sqlite3

from config import DB_PATH, PDF_CONTENT_END, PDF_CONTENT_START, page_img_corrected, parse_pages
from ocr import extract_page, init_db


def main():
    ap = argparse.ArgumentParser(description="Re-OCR corrected pages in place")
    ap.add_argument("--pages", help="e.g. '40' or '1,3,5-10'. Default: all content pages.")
    a = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    init_db(db)

    if a.pages:
        nums = parse_pages(a.pages, PDF_CONTENT_END)
    else:
        nums = list(range(PDF_CONTENT_START, PDF_CONTENT_END + 1))

    for n in nums:
        img = page_img_corrected(n)
        if not img.exists():
            print(f"  skip page {n} (no corrected image)")
            continue
        nw = extract_page(img, n, db)
        print(f"  page {n:4d}: {nw} words", flush=True)

    db.close()


if __name__ == "__main__":
    main()
