"""Render showcase collages of the CV pipeline for the README + docs site.

Produces, under docs/assets/:
  pipeline-stages.jpg  — one page through the four visible stages, side by side:
                         raw scan → deskewed & cropped → normalized B&W →
                         whitespace + feature analysis (word boxes coloured by
                         rarity, gutters coloured by river-score).
  dataset-grid.jpg     — a grid of normalized pages spread across the book,
                         showing the 367-page dataset at a glance.

Needs the full local pipeline outputs (data/pages, data/pages_corrected,
data/pages_normalized are gitignored) plus data/humument.db, so it is a
dev-time generator — the rendered JPEGs are committed, not regenerated in CI.

    uv run python pipeline/render_showcase.py
"""

from __future__ import annotations

import json
import sqlite3

from PIL import Image, ImageDraw, ImageFont

from config import (
    DB_PATH, DIR_PAGES, DIR_PAGES_CORRECTED, DIR_PAGES_NORMALIZED,
    OUTPUT_WIDTH, OUTPUT_HEIGHT, REPO_ROOT,
)

ASSETS = REPO_ROOT / "docs" / "assets"

SHOWCASE_PAGES = [1, 61, 155, 231, 300, 355]   # six pages for the stage matrix
INK = (20, 20, 22)
PAPER = (255, 255, 255)
RARE = (222, 92, 42)               # high-rarity word accent (warm)
COMMON = (150, 150, 160)           # common word (cool grey)
RIVER = (40, 110, 210)             # high river-score gutter (blue)


# --------------------------------------------------------------------------- #
# helpers                                                                      #
# --------------------------------------------------------------------------- #

def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _contain(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    """Fit img inside (box_w, box_h) preserving aspect, centred on paper."""
    scale = min(box_w / img.width, box_h / img.height)
    resized = img.resize(
        (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
        Image.LANCZOS,
    )
    panel = Image.new("RGB", (box_w, box_h), PAPER)
    panel.paste(resized, ((box_w - resized.width) // 2, (box_h - resized.height) // 2))
    return panel


def _lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# --------------------------------------------------------------------------- #
# stage 4: whitespace + feature analysis overlay                              #
# --------------------------------------------------------------------------- #

def analysis_overlay(db: sqlite3.Connection, page: int, n_highlight: int = 20) -> Image.Image:
    """Normalized page, faded, with the whitespace-graph gutters (stage 02) as a
    blue channel map, content words boxed and coloured by rarity (stage 01e),
    and the rarest few filled — the erasure-poetry candidates."""
    base = Image.open(DIR_PAGES_NORMALIZED / f"p{page:04d}.jpg").convert("RGB")
    if base.size != (OUTPUT_WIDTH, OUTPUT_HEIGHT):
        base = base.resize((OUTPUT_WIDTH, OUTPUT_HEIGHT), Image.LANCZOS)
    base = Image.blend(base, Image.new("RGB", base.size, PAPER), 0.62)  # fade ink

    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    # whitespace gutters underneath: blue, alpha + weight scale with river-score,
    # so the more river-like channels stand out from the general whitespace map.
    for poly_json, score in db.execute(
        "SELECT polyline_json, river_score FROM page_gutters "
        "WHERE page_num=? AND polyline_json IS NOT NULL", (page,)
    ):
        pts = [(x, y) for x, y in json.loads(poly_json)]
        if len(pts) < 2:
            continue
        s = score or 0.0
        d.line(pts, fill=RIVER + (int(45 + 165 * s),), width=1 + round(3 * s))

    # content words only, coloured by rarity; fill the rarest few as candidates.
    rmin, rmax = 1.5, 6.0
    rows = db.execute(
        "SELECT bbox_x0, bbox_y0, bbox_x1, bbox_y1, rarity FROM words "
        "WHERE page_num=? AND is_content=1 ORDER BY rarity DESC", (page,)
    ).fetchall()
    for i, (x0, y0, x1, y1, rarity) in enumerate(rows):
        t = ((rarity or rmin) - rmin) / (rmax - rmin)
        col = _lerp(COMMON, RARE, t)
        if i < n_highlight:                       # the rarest → filled candidates
            d.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], fill=RARE + (55,),
                        outline=RARE + (235,), width=3)
        else:
            d.rectangle([x0, y0, x1, y1], outline=col + (150,), width=2)

    return Image.alpha_composite(base.convert("RGBA"), ov).convert("RGB")


# --------------------------------------------------------------------------- #
# collage 1: the four-stage progression strip                                 #
# --------------------------------------------------------------------------- #

def pipeline_stages(db: sqlite3.Connection, pages: list[int]) -> Image.Image:
    """Matrix: one row per pipeline stage, one column per page. Reading down a
    column shows a single page getting better aligned and colour-processed, then
    analysed; reading across a row shows the stage applied to six pages."""
    stages = [
        ("1\nRaw scan", lambda pn: Image.open(DIR_PAGES / f"p{pn:04d}.jpg").convert("RGB")),
        ("2\nDeskewed\n& cropped", lambda pn: Image.open(DIR_PAGES_CORRECTED / f"p{pn:04d}.jpg").convert("RGB")),
        ("3\nNormalized\nB&W", lambda pn: Image.open(DIR_PAGES_NORMALIZED / f"p{pn:04d}.jpg").convert("RGB")),
        ("4\nWhitespace\n+ features", lambda pn: analysis_overlay(db, pn)),
    ]

    cell_w, cell_h = 214, 321
    gutter, header, gap, pad = 168, 40, 12, 24
    label_font, head_font = _font(21), _font(19)

    grid_w = pad * 2 + gutter + len(pages) * cell_w + (len(pages) - 1) * gap
    grid_h = pad * 2 + header + len(stages) * cell_h + (len(stages) - 1) * gap
    grid = Image.new("RGB", (grid_w, grid_h), PAPER)
    draw = ImageDraw.Draw(grid)

    x0 = pad + gutter
    # column headers: page numbers
    for c, pn in enumerate(pages):
        cx = x0 + c * (cell_w + gap) + cell_w // 2
        tb = draw.textbbox((0, 0), f"page {pn}", font=head_font)
        draw.text((cx - (tb[2] - tb[0]) // 2, pad + (header - (tb[3] - tb[1])) // 2 - tb[1]),
                  f"page {pn}", fill=(110, 110, 120), font=head_font)

    for r, (label, load) in enumerate(stages):
        y = pad + header + r * (cell_h + gap)
        # stage label, multi-line, right-aligned in the gutter, vertically centred
        lb = draw.multiline_textbbox((0, 0), label, font=label_font, spacing=6, align="right")
        draw.multiline_text((pad + gutter - 18 - (lb[2] - lb[0]), y + (cell_h - (lb[3] - lb[1])) // 2 - lb[1]),
                            label, fill=INK, font=label_font, spacing=6, align="right")
        for c, pn in enumerate(pages):
            x = x0 + c * (cell_w + gap)
            grid.paste(_contain(load(pn), cell_w, cell_h), (x, y))
            draw.rectangle([x, y, x + cell_w - 1, y + cell_h - 1], outline=(228, 228, 233), width=1)

    return grid


# --------------------------------------------------------------------------- #
# collage 2: dataset grid                                                      #
# --------------------------------------------------------------------------- #

def dataset_grid(pages: list[int], cols: int = 6, thumb_w: int = 240) -> Image.Image:
    thumb_h = round(thumb_w * OUTPUT_HEIGHT / OUTPUT_WIDTH)
    rows = (len(pages) + cols - 1) // cols
    gap, pad = 14, 24
    font = _font(15)

    grid_w = pad * 2 + cols * thumb_w + (cols - 1) * gap
    grid_h = pad * 2 + rows * thumb_h + (rows - 1) * gap
    grid = Image.new("RGB", (grid_w, grid_h), PAPER)
    draw = ImageDraw.Draw(grid)

    for i, pn in enumerate(pages):
        r, c = divmod(i, cols)
        x = pad + c * (thumb_w + gap)
        y = pad + r * (thumb_h + gap)
        thumb = Image.open(DIR_PAGES_NORMALIZED / f"p{pn:04d}.jpg").convert("RGB").resize(
            (thumb_w, thumb_h), Image.LANCZOS)
        grid.paste(thumb, (x, y))
        draw.rectangle([x, y, x + thumb_w - 1, y + thumb_h - 1], outline=(225, 225, 230), width=1)
        draw.text((x + 6, y + 6), f"{pn}", fill=(120, 120, 130), font=font)

    return grid


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    matrix = pipeline_stages(db, SHOWCASE_PAGES)
    matrix.save(ASSETS / "pipeline-stages.jpg", quality=88, optimize=True)
    print(f"wrote pipeline-stages.jpg {matrix.size} pages={SHOWCASE_PAGES}")

    # 24 pages evenly spread across the content range
    pages = [round(1 + i * (367 - 1) / 23) for i in range(24)]
    grid = dataset_grid(pages)
    grid.save(ASSETS / "dataset-grid.jpg", quality=86, optimize=True)
    print(f"wrote dataset-grid.jpg {grid.size} pages={pages[0]}..{pages[-1]}")

    db.close()


if __name__ == "__main__":
    main()
