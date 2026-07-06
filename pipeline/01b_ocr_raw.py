"""Stage 1b — run OCR on raw rasterised pages, write to SQLite.
First pass. Used by 01c to detect tilt and find the title position."""

from __future__ import annotations

import argparse
import sqlite3

from config import DB_PATH, DIR_PAGES, page_img, parse_pages
from ocr import init_db, extract_page


def main():
    ap = argparse.ArgumentParser(description="Stage 1b: raw page JPEGs → OCR in SQLite")
    ap.add_argument("--pages", help="e.g. '33' or '1,3,5-10'. Default: all JPEGs found.")
    ap.add_argument("--level", choices=("accurate", "fast"), default="accurate")
    a = ap.parse_args()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    init_db(db)

    if a.pages:
        pngs = [page_img(p) for p in parse_pages(a.pages, 9999)]
    else:
        pngs = sorted(DIR_PAGES.glob("p*.jpg"))

    for png in pngs:
        if not png.exists():
            print(f"  skip {png.name} (not found)")
            continue
        page_num = int(png.stem[1:])
        nw = extract_page(png, page_num, db, a.level)
        print(f"  page {page_num:4d}: {nw} words")

    db.close()


if __name__ == "__main__":
    main()
