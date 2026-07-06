"""Debug-only — visualize OCR results on corrected pages.

Not part of the pipeline; for inspecting alignment / OCR output.

Layers:
  --layer words   per-word OCR bboxes (red)
  --layer bboxes  page/valid/body bboxes from page_corrections (green/blue/red)
  --layer all     both (default)

Output: data/vis/<layer>/p####.jpg
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from config import DB_PATH, DIR_VIS, page_img, page_img_corrected, parse_pages


def _font(size: int):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", size)
    except OSError:
        return ImageFont.load_default()


def draw_words(img: Image.Image, db: sqlite3.Connection, page_num: int):
    """Overlay every OCR'd word bbox in red, with the word text above."""
    rows = db.execute(
        "SELECT text, bbox_x0, bbox_y0, bbox_x1, bbox_y1 FROM words "
        "WHERE page_num = ?",
        (page_num,),
    ).fetchall()
    draw = ImageDraw.Draw(img, "RGBA")
    for text, x0, y0, x1, y1 in rows:
        draw.rectangle([x0, y0, x1, y1], fill=(255, 0, 0, 30), outline=(255, 0, 0, 160), width=1)
        size = max(8, min(14, (y1 - y0) // 3))
        draw.text((x0, y0 - size - 2), text, fill=(255, 0, 0, 200), font=_font(size))


def draw_bboxes(img: Image.Image, db: sqlite3.Connection, page_num: int):
    """Overlay page bounds (green), valid region (blue), body bbox (red)."""
    row = db.execute(
        "SELECT angle, dx, dy, valid_x0, valid_y0, valid_x1, valid_y1, "
        "body_x0, body_y0, body_x1, body_y1 "
        "FROM page_corrections WHERE page_num = ?",
        (page_num,),
    ).fetchone()
    if not row:
        return
    w, h = img.size
    draw = ImageDraw.Draw(img, "RGBA")
    draw.rectangle([0, 0, w - 1, h - 1], outline=(0, 180, 0, 255), width=3)
    angle, dx, dy = row[0], row[1], row[2]
    vx0, vy0, vx1, vy1 = row[3:7]
    bx0, by0, bx1, by1 = row[7:11]
    if vx0 is not None:
        draw.rectangle([vx0, vy0, vx1, vy1], outline=(0, 100, 255, 255), width=3)
    if bx0 is not None:
        draw.rectangle([bx0, by0, bx1, by1], outline=(220, 30, 30, 255), width=3)
    label = (
        f"p{page_num}  {w}×{h}  angle={angle:+.3f}°  dx={dx:+.0f}  dy={dy:+.0f}\n"
        f"valid: [{vx0},{vy0}-{vx1},{vy1}]\n"
        f"body:  [{bx0},{by0}-{bx1},{by1}]"
        if bx0 is not None
        else f"p{page_num}  {w}×{h}  angle={angle:+.3f}°  dx={dx:+.0f}  dy={dy:+.0f}"
    )
    draw.multiline_text((15, 15), label, fill=(0, 0, 0, 255), font=_font(18), spacing=4)


def render(page_num: int, db: sqlite3.Connection, layer: str) -> Image.Image | None:
    img_path = page_img_corrected(page_num)
    if not img_path.exists():
        img_path = page_img(page_num)
    if not img_path.exists():
        return None
    img = Image.open(img_path).convert("RGB")
    if layer in ("words", "all"):
        draw_words(img, db, page_num)
    if layer in ("bboxes", "all"):
        draw_bboxes(img, db, page_num)
    return img


def main():
    ap = argparse.ArgumentParser(description="Stage 1d: overlay OCR/bbox layers on corrected pages")
    ap.add_argument("--pages", help="e.g. '33' or '1,3,5-10'. Default: all pages in DB.")
    ap.add_argument("--layer", choices=("words", "bboxes", "all"), default="all")
    a = ap.parse_args()

    if not DB_PATH.exists():
        print(f"DB not found: {DB_PATH}")
        return

    db = sqlite3.connect(DB_PATH)

    if a.pages:
        nums = parse_pages(a.pages, 9999)
    else:
        nums = [r[0] for r in db.execute(
            "SELECT page_num FROM pages ORDER BY page_num",
        ).fetchall()]

    if not nums:
        print("No pages to show.")
        db.close()
        return

    out_dir = DIR_VIS / a.layer
    out_dir.mkdir(parents=True, exist_ok=True)
    for n in nums:
        img = render(n, db, a.layer)
        if img is None:
            print(f"  skip page {n}")
            continue
        out = out_dir / f"p{n:04d}.jpg"
        img.save(out, quality=90)
        print(f"  page {n:4d} → {out}")

    db.close()


if __name__ == "__main__":
    main()
