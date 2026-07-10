"""Render showcase collages of the CV pipeline for the README + docs site.

Produces, under docs/assets/:
  pipeline-stages.jpg  — one page through the four visible stages, side by side:
                         raw scan → deskewed & cropped → normalized B&W →
                         whitespace + feature analysis (word boxes coloured by
                         rarity, gutters coloured by river-score).
  dataset-grid.jpg     — a grid of normalized pages spread across the book,
                         showing the 367-page dataset at a glance.

With --video it instead renders (needs ffmpeg on PATH):
  pipeline-stages.mp4  — a flip-through, one page per frame, cutting through all
                         367 pages in order. Each frame shows that page across the
                         six pipeline stages as columns: raw scan → deskew & crop →
                         normalize B&W → whitespace rivers → word rarity → erasure
                         candidates (the animated column-slice of pipeline-stages.jpg).

Needs the full local pipeline outputs (data/pages, data/pages_corrected,
data/pages_normalized are gitignored) plus data/humument.db, so it is a
dev-time generator — the rendered assets are committed, not regenerated in CI.

    uv run python pipeline/render_showcase.py            # the two JPEGs
    uv run python pipeline/render_showcase.py --video    # the filmstrip mp4
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from config import (
    DB_PATH, DIR_PAGES, DIR_PAGES_CORRECTED, DIR_PAGES_NORMALIZED,
    OUTPUT_WIDTH, OUTPUT_HEIGHT, PDF_CONTENT_END, REPO_ROOT,
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

def _analysis_base(page: int) -> Image.Image:
    """Normalized page, faded toward paper so overlays read clearly (RGBA)."""
    base = Image.open(DIR_PAGES_NORMALIZED / f"p{page:04d}.jpg").convert("RGB")
    if base.size != (OUTPUT_WIDTH, OUTPUT_HEIGHT):
        base = base.resize((OUTPUT_WIDTH, OUTPUT_HEIGHT), Image.LANCZOS)
    base = Image.blend(base, Image.new("RGB", base.size, PAPER), 0.62)  # fade ink
    return base.convert("RGBA")


def _draw_gutters(d: ImageDraw.ImageDraw, db: sqlite3.Connection, page: int) -> None:
    # whitespace gutters: blue, alpha + weight scale with river-score, so the more
    # river-like channels stand out from the general whitespace map.
    for poly_json, score in db.execute(
        "SELECT polyline_json, river_score FROM page_gutters "
        "WHERE page_num=? AND polyline_json IS NOT NULL", (page,)
    ):
        pts = [(x, y) for x, y in json.loads(poly_json)]
        if len(pts) < 2:
            continue
        s = score or 0.0
        d.line(pts, fill=RIVER + (int(45 + 165 * s),), width=1 + round(3 * s))


def _word_rows(db: sqlite3.Connection, page: int) -> list:
    return db.execute(
        "SELECT bbox_x0, bbox_y0, bbox_x1, bbox_y1, rarity FROM words "
        "WHERE page_num=? AND is_content=1 ORDER BY rarity DESC", (page,)
    ).fetchall()


def _draw_word_outlines(d: ImageDraw.ImageDraw, rows: list) -> None:
    rmin, rmax = 1.5, 6.0
    for x0, y0, x1, y1, rarity in rows:
        t = ((rarity or rmin) - rmin) / (rmax - rmin)
        d.rectangle([x0, y0, x1, y1], outline=_lerp(COMMON, RARE, t) + (150,), width=2)


def _draw_candidates(d: ImageDraw.ImageDraw, rows: list, n: int) -> None:
    for x0, y0, x1, y1, _rarity in rows[:n]:   # the rarest few → filled candidates
        d.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], fill=RARE + (55,),
                    outline=RARE + (235,), width=3)


def analysis_stages(db: sqlite3.Connection, page: int, n_highlight: int = 20
                    ) -> tuple[Image.Image, Image.Image, Image.Image]:
    """The analysis overlay built up as three cumulative snapshots on the faded
    normalized page: (rivers, +word-rarity, +erasure-candidates). Shares one base
    decode and one pair of queries — the three columns of the video's stages 4–6."""
    base = _analysis_base(page)
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    _draw_gutters(d, db, page)
    rivers = Image.alpha_composite(base, ov)

    rows = _word_rows(db, page)
    _draw_word_outlines(d, rows)
    rarity = Image.alpha_composite(base, ov)

    _draw_candidates(d, rows, n_highlight)
    candidates = Image.alpha_composite(base, ov)

    return rivers.convert("RGB"), rarity.convert("RGB"), candidates.convert("RGB")


def analysis_overlay(db: sqlite3.Connection, page: int, n_highlight: int = 20) -> Image.Image:
    """Normalized page, faded, with the whitespace-graph gutters (stage 02) as a
    blue channel map, content words boxed and coloured by rarity (stage 01e),
    and the rarest few filled — the erasure-poetry candidates (the full stage 4)."""
    return analysis_stages(db, page, n_highlight)[2]


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


# --------------------------------------------------------------------------- #
# video: one page across all six pipeline stages, flipped through the book     #
# --------------------------------------------------------------------------- #

STAGE_COLS = 6                      # one column per pipeline stage
STAGE_CELL_W = 300
STAGE_CELL_H = round(STAGE_CELL_W * OUTPUT_HEIGHT / OUTPUT_WIDTH)   # 450, page 2:3
STAGE_GAP, STAGE_PAD = 14, 26
STAGE_TITLE_H, STAGE_HEAD_H = 34, 30
STAGE_BAR_GAP, STAGE_BAR_H = 14, 8

# column headers, left→right — the raw scan becoming an erasure-poetry candidate map
STAGE_LABELS = [
    "1  Raw scan",
    "2  Deskew & crop",
    "3  Normalize B&W",
    "4  Whitespace rivers",
    "5  Word rarity",
    "6  Erasure candidates",
]


def pipeline_stage_frame(db: sqlite3.Connection, page: int) -> Image.Image:
    """One slide: a single page shown across all six pipeline stages as columns,
    left (raw scan) to right (the erasure-candidate map). A warm progress bar
    tracks how far through the 367-page book this page sits."""
    rivers, rarity, candidates = analysis_stages(db, page)
    cells = [
        Image.open(DIR_PAGES / f"p{page:04d}.jpg").convert("RGB"),
        Image.open(DIR_PAGES_CORRECTED / f"p{page:04d}.jpg").convert("RGB"),
        Image.open(DIR_PAGES_NORMALIZED / f"p{page:04d}.jpg").convert("RGB"),
        rivers, rarity, candidates,
    ]

    n = STAGE_COLS
    frame_w = STAGE_PAD * 2 + n * STAGE_CELL_W + (n - 1) * STAGE_GAP
    frame_h = (STAGE_PAD * 2 + STAGE_TITLE_H + STAGE_HEAD_H + STAGE_CELL_H
               + STAGE_BAR_GAP + STAGE_BAR_H)
    frame = Image.new("RGB", (frame_w, frame_h), PAPER)
    draw = ImageDraw.Draw(frame)
    title_font, head_font = _font(22), _font(17)

    # title row: which page we're on
    title = f"A Human Document — page {page} of {PDF_CONTENT_END}"
    tb = draw.textbbox((0, 0), title, font=title_font)
    draw.text((STAGE_PAD, STAGE_PAD + (STAGE_TITLE_H - (tb[3] - tb[1])) // 2 - tb[1]),
              title, fill=INK, font=title_font)

    y_head = STAGE_PAD + STAGE_TITLE_H
    y_cell = y_head + STAGE_HEAD_H
    for c, (label, img) in enumerate(zip(STAGE_LABELS, cells)):
        x = STAGE_PAD + c * (STAGE_CELL_W + STAGE_GAP)
        lb = draw.textbbox((0, 0), label, font=head_font)
        draw.text((x + (STAGE_CELL_W - (lb[2] - lb[0])) // 2,
                   y_head + (STAGE_HEAD_H - (lb[3] - lb[1])) // 2 - lb[1]),
                  label, fill=(90, 90, 100), font=head_font)
        frame.paste(_contain(img, STAGE_CELL_W, STAGE_CELL_H), (x, y_cell))
        draw.rectangle([x, y_cell, x + STAGE_CELL_W - 1, y_cell + STAGE_CELL_H - 1],
                       outline=(225, 225, 230), width=1)

    # progress bar: fraction of the book reached by this page
    bx0, bx1 = STAGE_PAD, frame_w - STAGE_PAD
    by0 = y_cell + STAGE_CELL_H + STAGE_BAR_GAP
    by1 = by0 + STAGE_BAR_H
    draw.rectangle([bx0, by0, bx1, by1], fill=(235, 235, 238))
    draw.rectangle([bx0, by0, bx0 + round((bx1 - bx0) * page / PDF_CONTENT_END), by1],
                   fill=RARE)
    return frame


def render_pipeline_video(db: sqlite3.Connection, out_path: Path,
                          hold: float = 0.5, fps: int = 30, crf: int = 30) -> None:
    """Render every page's six-stage strip to a PNG frame, then mux them into an
    mp4 with ffmpeg, holding each page `hold` seconds (a hard cut between pages).

    Every page is a distinct dense-text frame, so the file is dominated by 367
    near-keyframes — `crf` is the size lever (18 ≈ 90 MB, 30 ≈ 35 MB, 34 ≈ 23 MB).
    Legibility of the tiny text is not the point; the stage-to-stage transformation
    is, so a lossy crf reads fine."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH — needed to encode the video")

    pages = list(range(1, PDF_CONTENT_END + 1))

    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for i, pn in enumerate(pages):
            pipeline_stage_frame(db, pn).save(tdp / f"frame_{i:05d}.png")
            if pn % 25 == 0 or pn == pages[-1]:
                print(f"  rendered page {pn}/{PDF_CONTENT_END}")
        print(f"rendered {len(pages)} frames ({STAGE_COLS} stages each); encoding…")

        # concat demuxer with an explicit hold per frame; the last entry is
        # repeated because the demuxer ignores the final `duration` line.
        listing = "".join(
            f"file '{tdp / f'frame_{i:05d}.png'}'\nduration {hold}\n"
            for i in range(len(pages))
        ) + f"file '{tdp / f'frame_{len(pages) - 1:05d}.png'}'\n"
        list_path = tdp / "frames.txt"
        list_path.write_text(listing)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
             "-fps_mode", "cfr", "-r", str(fps),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf),
             "-movflags", "+faststart", str(out_path)],
            check=True, capture_output=True, text=True,
        )
    size_mb = out_path.stat().st_size / 1e6
    print(f"wrote {out_path.name} "
          f"{pipeline_stage_frame(db, 1).size} "
          f"{len(pages)} pages × {hold}s ≈ {len(pages) * hold:.0f}s "
          f"(crf {crf}, {size_mb:.0f} MB)")


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", action="store_true",
                        help="render the six-stage flip-through mp4 instead of the JPEGs")
    parser.add_argument("--hold", type=float, default=0.5,
                        help="seconds each page is held on screen (default 0.5)")
    parser.add_argument("--fps", type=int, default=30,
                        help="output frame rate (default 30)")
    parser.add_argument("--crf", type=int, default=30,
                        help="x264 quality/size knob; lower = bigger (default 30 ≈ 35 MB)")
    parser.add_argument("--out", type=Path, default=ASSETS / "pipeline-stages.mp4",
                        help="output video path (default docs/assets/pipeline-stages.mp4)")
    args = parser.parse_args()

    if args.video:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        render_pipeline_video(db, args.out, hold=args.hold, fps=args.fps, crf=args.crf)
        db.close()
    else:
        main()
