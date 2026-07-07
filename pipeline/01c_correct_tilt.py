"""Stage 1c — deskew, align, re-OCR, and save correction metadata.

Two-pass pipeline:
  Pass 1: process regular "A HUMAN DOCUMENT" pages (rotate + center title)
          record body text bboxes to derive target median extent
  Pass 2: process CHAPTER pages by translating so their body text bottom
          aligns with the target bottom from pass 1 (no scaling)

All outputs: data/pages_corrected/, DB tables pages/words/page_corrections.
"""

from __future__ import annotations

import argparse
import difflib
import math
import re
import sqlite3
import statistics

import numpy as np
from PIL import Image, ImageDraw

import ocr
from config import (
    DB_PATH, DIR_PAGES_CORRECTED,
    PDF_CONTENT_START, PDF_CONTENT_END,
    HEADER_TOP_FRAC, CHAPTER_PAGES,
    OUTPUT_WIDTH, OUTPUT_HEIGHT,
    page_img, page_img_corrected, parse_pages,
)


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def init_db(db):
    ocr.init_db(db)
    db.execute("""
        CREATE TABLE IF NOT EXISTS page_corrections (
            page_num  INTEGER PRIMARY KEY,
            angle     REAL,
            dx        REAL,
            dy        REAL,
            title_x0  INTEGER,
            title_y0  INTEGER,
            title_x1  INTEGER,
            title_y1  INTEGER,
            valid_x0  INTEGER,
            valid_y0  INTEGER,
            valid_x1  INTEGER,
            valid_y1  INTEGER,
            body_x0   INTEGER,
            body_y0   INTEGER,
            body_x1   INTEGER,
            body_y1   INTEGER
        )
    """)


# ---------------------------------------------------------------------------
# OCR data helpers
# ---------------------------------------------------------------------------

def load_page_words(db, page_num):
    rows = db.execute(
        "SELECT text, bbox_x0, bbox_y0, bbox_x1, bbox_y1, line_idx "
        "FROM words WHERE page_num = ? ORDER BY line_idx, bbox_x0",
        (page_num,),
    ).fetchall()
    return [{"text": r[0], "x0": r[1], "y0": r[2], "x1": r[3], "y1": r[4], "line_idx": r[5]}
            for r in rows]


def _title_kind(text):
    """Classify an OCR token as part of the 'A HUMAN DOCUMENT' running header.
    Fuzzy so OCR garbling ('HEMLY'→HUMAN, 'DOCEMENT'→DOCUMENT, 'À'→A) still
    matches. Returns 'A'/'HUMAN'/'DOCUMENT' or None."""
    n = re.sub(r"[^A-Z]", "", text.upper())
    if n == "A":
        return "A"
    if n and difflib.SequenceMatcher(None, n, "HUMAN").ratio() >= 0.6:
        return "HUMAN"
    if n and difflib.SequenceMatcher(None, n, "DOCUMENT").ratio() >= 0.6:
        return "DOCUMENT"
    return None


def find_title(words):
    """Return bbox of the 'A HUMAN DOCUMENT' running header, or None.

    In this single edition the header sits at the top of every page
    (including chapter openings, which add 'CHAPTER N' just below it). OCR
    noise and specks push the header down to as deep as line 4 and sometimes
    mangle the words, so we scan the first few short lines and fuzzy-match,
    requiring at least two distinct title words including HUMAN or DOCUMENT.
    The page-number digit on the same line is excluded from the bbox."""
    by_line = {}
    for w in words:
        by_line.setdefault(w["line_idx"], []).append(w)
    for li in range(5):
        lw = by_line.get(li)
        if not lw or len(lw) > 6:          # header line is short; skip body
            continue
        kinds = set()
        hits = []
        for w in lw:
            k = _title_kind(w["text"])
            if k:
                kinds.add(k)
                hits.append(w)
        if len(kinds) >= 2 and ({"HUMAN", "DOCUMENT"} & kinds):
            return (min(w["x0"] for w in hits), min(w["y0"] for w in hits),
                    max(w["x1"] for w in hits), max(w["y1"] for w in hits))
    return None


def find_chapter_heading_line(words):
    """Return line_idx of the chapter heading line, or None.
    Matches 'CHAPTER' (regular chapters) or 'INTRODUCTION' (page 9)."""
    # 'CHAPTER' on top lines (regular chapter pages)
    ch = [w for w in words if w["text"] == "CHAPTER" and w["line_idx"] <= 1]
    if ch:
        return ch[0]["line_idx"]
    # 'INTRODUCTION' anywhere on page (page 9 has it on line 1, below the
    # big "A HUMAN DOCUMENT" on line 0)
    intro = [w for w in words if w["text"] == "INTRODUCTION"]
    if intro:
        return intro[0]["line_idx"]
    return None


# Minimum vertical gap (raw px) the watermark must sit below the body block.
WM_BODY_GAP = 40


def watermark_region_raw(words, page_h):
    """Union bbox (raw-image coords) of the 'Digitized by Google' scan stamp.

    Detection is sourced from the RAW page OCR (`words` here are the first-pass
    raw words), where the stamp is intact — the correction crop can slice the
    stamp into unrecognisable fragments, so detecting on the corrected image
    misses it. To rule out false positives, an accepted stamp line must both
    sit near the page bottom AND be clearly separated from the body block by a
    vertical gap, so a real word that merely resembles 'google' is never hit.
    Returns (x0, y0, x1, y1) or None.
    """
    by_line = {}
    for w in words:
        by_line.setdefault(w["line_idx"], []).append(w)
    lines = []
    for lw in by_line.values():
        lines.append({
            "txt": " ".join(x["text"] for x in lw), "ntok": len(lw),
            "x0": min(x["x0"] for x in lw), "y0": min(x["y0"] for x in lw),
            "x1": max(x["x1"] for x in lw), "y1": max(x["y1"] for x in lw),
        })
    cand = [L for L in lines
            if ocr.is_watermark_line(L["txt"], (L["x0"], L["y0"], L["x1"], L["y1"]), page_h)]
    if not cand:
        return None
    # Body block bottom = lowest substantial (>=5-token) non-stamp line.
    body_bottom = max((L["y1"] for L in lines if L["ntok"] >= 5 and L not in cand),
                      default=0)
    cand = [L for L in cand
            if L["y0"] >= body_bottom + WM_BODY_GAP and L["y0"] >= page_h * 0.80]
    if not cand:
        return None
    return (min(L["x0"] for L in cand), min(L["y0"] for L in cand),
            max(L["x1"] for L in cand), max(L["y1"] for L in cand))


def body_words_title_page(words):
    """Words excluding header and page number on 'A HUMAN DOCUMENT' pages."""
    header_lines = set()
    for w in words:
        if w["line_idx"] <= 1 and w["text"].isupper():
            line_words = [w2 for w2 in words if w2["line_idx"] == w["line_idx"]]
            if "HUMAN DOCUMENT" in " ".join(w2["text"] for w2 in line_words):
                header_lines.add(w["line_idx"])
    return [w for w in words
            if w["line_idx"] not in header_lines
            and not (w["text"].isdigit() and w["line_idx"] <= 1)]


def body_words_chapter_page(words):
    """Words below the CHAPTER heading line."""
    ch_line = find_chapter_heading_line(words)
    if ch_line is None:
        return []
    return [w for w in words if w["line_idx"] > ch_line]


def compute_body_bbox_in_corrected(db, page_num, is_chapter, padding=5):
    """After re-OCR, compute bbox of body text on the corrected page.

    For title pages: all text below HUMAN DOCUMENT header bottom.
    For chapter pages: all text below CHAPTER heading bottom.
    Returns (x0, y0, x1, y1) with padding, or None.
    """
    words = load_page_words(db, page_num)
    if not words:
        return None
    if is_chapter:
        ch_line = find_chapter_heading_line(words)
        if ch_line is None:
            return None
        ch_words = [w for w in words if w["line_idx"] == ch_line]
        if not ch_words:
            return None
        threshold_y = max(w["y1"] for w in ch_words)
    else:
        title = find_title(words)
        if not title:
            return None
        threshold_y = title[3]

    body = [w for w in words if w["y0"] >= threshold_y]
    if not body:
        return None
    return (
        min(w["x0"] for w in body) - padding,
        min(w["y0"] for w in body) - padding,
        max(w["x1"] for w in body) + padding,
        max(w["y1"] for w in body) + padding,
    )


# ---------------------------------------------------------------------------
# Tilt measurement
# ---------------------------------------------------------------------------

def measure_tilt(words):
    """Median tilt from full-width body text lines."""
    body = body_words_title_page(words) or body_words_chapter_page(words)
    lines = {}
    for w in body:
        lines.setdefault(w["line_idx"], []).append(w)
    if not lines:
        return 0.0

    widths = {li: max(w["x1"] for w in lw) - min(w["x0"] for w in lw)
              for li, lw in lines.items() if len(lw) >= 4}
    if not widths:
        return 0.0
    median_w = statistics.median(widths.values())
    full_lines = {li: lines[li] for li, w in widths.items() if w >= median_w * 0.85}

    angles = []
    for lwords in full_lines.values():
        lwords.sort(key=lambda w: w["x0"])
        xs = np.array([(w["x0"] + w["x1"]) / 2 for w in lwords])
        ys = np.array([(w["y0"] + w["y1"]) / 2 for w in lwords])
        if xs.max() - xs.min() < 50:
            continue
        m, _ = np.polyfit(xs, ys, 1)
        angles.append(math.degrees(math.atan(m)))
    return statistics.median(angles) if angles else 0.0


# ---------------------------------------------------------------------------
# Rotation helpers
# ---------------------------------------------------------------------------

def rotate_image(img, angle):
    if abs(angle) < 0.005:
        return img
    bg = img.getpixel((5, 5))
    return img.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=bg)


def rotate_point(x, y, angle_rad, cx, cy):
    cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
    dx, dy = x - cx, y - cy
    return (cx + dx * cos_a + dy * sin_a, cy - dx * sin_a + dy * cos_a)


def rotate_bbox(bbox, angle_rad, cx, cy):
    corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]),
               (bbox[2], bbox[3]), (bbox[0], bbox[3])]
    rotated = [rotate_point(x, y, angle_rad, cx, cy) for x, y in corners]
    xs = [p[0] for p in rotated]
    ys = [p[1] for p in rotated]
    return (min(xs), min(ys), max(xs), max(ys))


# ---------------------------------------------------------------------------
# Image output (create output canvas + paste)
# ---------------------------------------------------------------------------

def make_output(img, dx, dy, out_h):
    """Paste img onto OUTPUT_WIDTH × out_h canvas at (dx, dy).
    Returns (canvas, valid_bbox) where valid_bbox is the region of the
    canvas covered by the source image (clipped to canvas bounds)."""
    bg = img.getpixel((5, 5))
    out = Image.new("RGB", (OUTPUT_WIDTH, out_h), bg)
    idx, idy = int(round(dx)), int(round(dy))
    out.paste(img, (idx, idy))
    valid = (
        max(0, idx),
        max(0, idy),
        min(OUTPUT_WIDTH, idx + img.width),
        min(out_h, idy + img.height),
    )
    return out, valid


# ---------------------------------------------------------------------------
# Pass 1: title page processing
# ---------------------------------------------------------------------------

def process_title_page(page_num, words, db):
    """Correct a regular title page. Return (image, body_bbox_in_output_coords)."""
    title = find_title(words)
    if not title:
        return None

    src_path = page_img(page_num)
    if not src_path.exists():
        return None

    img = Image.open(src_path)
    w, h = img.size
    out_h = OUTPUT_HEIGHT

    angle = measure_tilt(words)
    img = rotate_image(img, angle)
    if abs(angle) >= 0.005:
        title = rotate_bbox(title, math.radians(angle), w / 2, h / 2)

    # Translate: title center → OUTPUT_WIDTH/2, title top → HEADER_TOP_FRAC*out_h
    title_cx = (title[0] + title[2]) / 2
    dx = OUTPUT_WIDTH / 2 - title_cx
    dy = HEADER_TOP_FRAC * out_h - title[1]

    out, valid = make_output(img, dx, dy, out_h)

    # Whitewash the 'Digitized by Google' scan stamp BEFORE re-OCR, so the
    # re-OCR never sees it (no fragment words, no body-bbox inflation) and the
    # served image is clean. Detected from the raw words above (intact stamp),
    # then mapped into output coords via the same rotate+translate.
    wm = watermark_region_raw(words, h)
    if wm:
        if abs(angle) >= 0.005:
            wm = rotate_bbox(wm, math.radians(angle), w / 2, h / 2)
        wm_top = int(round(wm[1] + dy)) - 8        # small pad above the stamp
        if 0 < wm_top < out_h:
            ImageDraw.Draw(out).rectangle([0, wm_top, OUTPUT_WIDTH, out_h], fill="white")

    out.save(page_img_corrected(page_num), quality=80)

    # Re-OCR corrected image
    nw = ocr.extract_page(page_img_corrected(page_num), page_num, db, "accurate")

    # Compute body bbox from corrected image's OCR
    body_bbox = compute_body_bbox_in_corrected(db, page_num, is_chapter=False)
    body_cols = body_bbox if body_bbox else (None, None, None, None)

    # Save metadata
    t = (int(title[0]), int(title[1]), int(title[2]), int(title[3]))
    db.execute("DELETE FROM page_corrections WHERE page_num = ?",
               (page_num,))
    db.execute(
        "INSERT INTO page_corrections VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page_num, angle, dx, dy, *t, *valid, *body_cols),
    )
    db.commit()

    # Compute body bbox in OUTPUT coords (query re-OCR'd data)
    body = body_words_title_page(load_page_words(db, page_num))
    if not body:
        return {"nw": nw, "angle": angle}

    return {
        "nw": nw,
        "angle": angle,
        "body_left": min(w["x0"] for w in body),
        "body_right": max(w["x1"] for w in body),
        "body_bottom": max(w["y1"] for w in body),
    }


# ---------------------------------------------------------------------------
# Pass 2: chapter page processing
# ---------------------------------------------------------------------------

def process_chapter_page(page_num, words, targets, db):
    """Correct a chapter page by aligning body bottom + horizontal center
    to the median title-page targets."""
    src_path = page_img(page_num)
    if not src_path.exists():
        return None

    img = Image.open(src_path)
    w, h = img.size
    out_h = OUTPUT_HEIGHT

    angle = measure_tilt(words)
    img = rotate_image(img, angle)

    # Body words below CHAPTER heading, with coords rotated by angle
    body = body_words_chapter_page(words)
    if not body:
        return None

    cx_pg, cy_pg = w / 2, h / 2
    angle_rad = math.radians(angle)
    rot_bboxes = [rotate_bbox((bw["x0"], bw["y0"], bw["x1"], bw["y1"]),
                              angle_rad, cx_pg, cy_pg)
                  for bw in body]

    body_left = min(b[0] for b in rot_bboxes)
    body_right = max(b[2] for b in rot_bboxes)
    body_bottom = max(b[3] for b in rot_bboxes)
    body_cx = (body_left + body_right) / 2

    target_cx = (targets["left"] + targets["right"]) / 2
    dx = target_cx - body_cx
    dy = targets["bottom"] - body_bottom

    out, valid = make_output(img, dx, dy, out_h)
    out.save(page_img_corrected(page_num), quality=80)

    nw = ocr.extract_page(page_img_corrected(page_num), page_num, db, "accurate")

    body_bbox = compute_body_bbox_in_corrected(db, page_num, is_chapter=True)
    body_cols = body_bbox if body_bbox else (None, None, None, None)

    db.execute("DELETE FROM page_corrections WHERE page_num = ?",
               (page_num,))
    db.execute(
        "INSERT INTO page_corrections VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page_num, angle, dx, dy, None, None, None, None, *valid, *body_cols),
    )
    db.commit()

    return {"nw": nw, "angle": angle, "dx": dx, "dy": dy, "valid": valid}


# ---------------------------------------------------------------------------
# Deterministic bottom-align for already-corrected pages (no re-OCR)
# ---------------------------------------------------------------------------

def median_title_body_bottom(db):
    """Median body-bottom (corrected-space y) over the header-anchored title
    pages — the line every full page ends on, and the target CHAPTER_PAGES are
    aligned to. The chapter pages themselves are excluded so they never bias
    their own target."""
    ys = [y for (pn, y) in db.execute(
              "SELECT page_num, body_y1 FROM page_corrections "
              "WHERE body_y1 IS NOT NULL")
          if pn not in CHAPTER_PAGES]
    return statistics.median(ys) if ys else None


def realign_bottom(db, page_num, target_bottom):
    """Translate an already-corrected page — its image and OCR coordinates in
    lockstep — so the body bottom rests on target_bottom. A pure vertical shift
    of committed data: deterministic and NOT a re-OCR (Apple Vision is
    nondeterministic and the DB is a versioned artifact, so the geometry Pass 2
    would produce is reproduced by translation instead). Returns the applied
    dy in px, or 0 if there is nothing to move."""
    row = db.execute(
        "SELECT body_y1 FROM page_corrections WHERE page_num = ?",
        (page_num,)).fetchone()
    if not row or row[0] is None:
        return 0
    delta = int(round(target_bottom - row[0]))
    if delta == 0:
        return 0

    # image: shift content down by delta — expose paper-white at the top, clip
    # the (blank) overflow off the bottom. Same size in/out.
    path = page_img_corrected(page_num)
    src = Image.open(path).convert("RGB")
    shifted = Image.new("RGB", src.size, (255, 255, 255))
    shifted.paste(src, (0, delta))
    shifted.save(path, quality=80)

    # coordinates move with the pixels. NULL title/body fields (true chapter
    # pages) stay NULL under +delta; valid_* is re-clipped to the canvas.
    db.execute(
        "UPDATE words SET bbox_y0 = bbox_y0 + ?, bbox_y1 = bbox_y1 + ? "
        "WHERE page_num = ?", (delta, delta, page_num))
    db.execute(
        "UPDATE page_corrections SET dy = dy + ?, "
        "title_y0 = title_y0 + ?, title_y1 = title_y1 + ?, "
        "body_y0 = body_y0 + ?, body_y1 = body_y1 + ?, "
        "valid_y0 = MAX(0, valid_y0 + ?), valid_y1 = MIN(?, valid_y1 + ?) "
        "WHERE page_num = ?",
        (delta, delta, delta, delta, delta, delta, src.height, delta, page_num))
    db.commit()
    return delta


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Stage 1c: two-pass correction")
    ap.add_argument("--pages", help="e.g. '28' or '9-285'. Default: all content pages.")
    ap.add_argument("--realign", action="store_true",
                    help="Deterministically bottom-align CHAPTER_PAGES from the "
                         "committed corrected images + OCR (no re-OCR), then exit. "
                         "Run 01d/02/03 afterwards to propagate downstream.")
    a = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    init_db(db)
    DIR_PAGES_CORRECTED.mkdir(parents=True, exist_ok=True)

    if a.realign:
        target = median_title_body_bottom(db)
        if target is None:
            print("No title-page body bottoms — nothing to align against")
            db.close()
            return
        print(f"Realign target (median title body bottom): {target:.0f}")
        for p in sorted(CHAPTER_PAGES):
            dy = realign_bottom(db, p, target)
            print(f"  page {p:4d}: dy={dy:+d}")
        db.close()
        return

    if a.pages:
        total = db.execute("SELECT MAX(page_num) FROM pages").fetchone()[0] or PDF_CONTENT_END
        page_nums = parse_pages(a.pages, total)
    else:
        page_nums = list(range(PDF_CONTENT_START, PDF_CONTENT_END + 1))

    title_pages = [p for p in page_nums if p not in CHAPTER_PAGES]
    chapter_pages = [p for p in page_nums if p in CHAPTER_PAGES]

    # Pass 1: title pages
    body_bboxes = []
    print(f"Pass 1: {len(title_pages)} title pages")
    for p in title_pages:
        words = load_page_words(db, p)
        r = process_title_page(p, words, db)
        if r is None:
            print(f"  page {p:4d}: [skip]")
            continue
        if "body_left" in r:
            body_bboxes.append((r["body_left"], r["body_right"], r["body_bottom"]))
        print(f"  page {p:4d}: {r['angle']:+.3f}° {r['nw']}w")

    if not body_bboxes:
        print("No title page body bboxes — cannot align chapter pages")
        db.close()
        return

    targets = {
        "left":   statistics.median(b[0] for b in body_bboxes),
        "right":  statistics.median(b[1] for b in body_bboxes),
        "bottom": statistics.median(b[2] for b in body_bboxes),
    }
    print(f"\nTargets from title pages: left={targets['left']:.0f} "
          f"right={targets['right']:.0f} bottom={targets['bottom']:.0f}")

    # Pass 2: chapter pages
    print(f"\nPass 2: {len(chapter_pages)} chapter pages")
    for p in chapter_pages:
        words = load_page_words(db, p)
        r = process_chapter_page(p, words, targets, db)
        if r is None:
            print(f"  page {p:4d}: [skip]")
            continue
        print(f"  page {p:4d}: {r['angle']:+.3f}° dx={r['dx']:+.0f} dy={r['dy']:+.0f} {r['nw']}w")

    db.close()


if __name__ == "__main__":
    main()
