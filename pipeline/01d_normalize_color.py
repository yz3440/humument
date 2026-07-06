"""Stage 1d — B&W cleanup: shadow removal + heavy-contrast grayscale + crop.

Pipeline per page:
  1. Load corrected JPEG → grayscale (ITU-R 601 luma).
  2. Compute the text bbox (union of OCR word bboxes for the page) and
     intersect with `valid_*` from page_corrections; pad by TEXT_BBOX_MARGIN.
  3. Detect shadow edges: scan SHADOW_STRIP_PX-deep strips in each margin
     between the valid bbox and the text bbox, looking for a sharp dark→light
     gradient transition. Anything beyond a detected shadow edge gets marked
     as "shadow region" (to be whitewashed).
  4. Flat-field illumination correction: divide by a local-max paper estimate
     (max-filter then Gaussian blur) so within-page yellowing flattens.
  5. Local contrast stretch: per-pixel adaptive black/white points based on
     the local mean and stddev (wide window). Soft mid-tones survive; paper
     consistently saturates to 255 and ink saturates to 0.
  6. Whitewash everything outside the (text_bbox + margin) and inside any
     detected shadow region.
  7. Save as 8-bit grayscale JPEG.

Output: data/pages_normalized/p####.jpg.
"""

from __future__ import annotations

import argparse
import sqlite3

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter, uniform_filter

from config import (
    DB_PATH, DIR_PAGES_NORMALIZED,
    PDF_CONTENT_START, PDF_CONTENT_END,
    TEXT_BBOX_MARGIN, SHADOW_STRIP_PX, SHADOW_GRAD_THRESHOLD,
    STRETCH_WINDOW, STRETCH_WHITE_K, STRETCH_BLACK_K, STRETCH_MIN_SPAN,
    NORMALIZED_JPEG_Q,
    FLATFIELD_MAX_KERNEL as MAX_KERNEL,
    FLATFIELD_SMOOTH_SIGMA as SMOOTH_SIGMA,
    page_img_corrected, page_img_normalized, parse_pages,
)

# ITU-R 601 luma weights — the conventional "perceptual" grayscale.
LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


# ---------------------------------------------------------------------------
# DB lookups
# ---------------------------------------------------------------------------

def load_valid_bbox(db, page_num):
    row = db.execute(
        "SELECT valid_x0, valid_y0, valid_x1, valid_y1 "
        "FROM page_corrections WHERE page_num = ?",
        (page_num,),
    ).fetchone()
    return row if row else None


def load_body_bbox(db, page_num):
    row = db.execute(
        "SELECT body_x0, body_y0, body_x1, body_y1 "
        "FROM page_corrections WHERE page_num = ?",
        (page_num,),
    ).fetchone()
    if not row or row[0] is None:
        return None
    return row


def load_word_union_bbox(db, page_num):
    row = db.execute(
        "SELECT MIN(bbox_x0), MIN(bbox_y0), MAX(bbox_x1), MAX(bbox_y1) "
        "FROM words WHERE page_num = ?",
        (page_num,),
    ).fetchone()
    if not row or row[0] is None:
        return None
    return row


# ---------------------------------------------------------------------------
# Text bbox + clamping
# ---------------------------------------------------------------------------

def clamp_bbox(bbox, max_w, max_h):
    x0, y0, x1, y1 = bbox
    return (max(0, x0), max(0, y0), min(max_w, x1), min(max_h, y1))


def compute_text_bbox(db, page_num, valid, shape):
    """OCR word-bbox union, padded and clamped. Falls back gracefully."""
    H, W = shape
    src = "words"
    bbox = load_word_union_bbox(db, page_num)
    if bbox is None:
        bbox = load_body_bbox(db, page_num)
        src = "body" if bbox else src
    if bbox is None:
        bbox = valid
        src = "valid" if bbox else src
    if bbox is None:
        return (0, 0, W, H), "canvas"
    x0, y0, x1, y1 = bbox
    pad = TEXT_BBOX_MARGIN
    padded = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
    if valid:
        vx0, vy0, vx1, vy1 = valid
        padded = (max(padded[0], vx0), max(padded[1], vy0),
                  min(padded[2], vx1), min(padded[3], vy1))
    return clamp_bbox(padded, W, H), src


# ---------------------------------------------------------------------------
# Shadow detection
# ---------------------------------------------------------------------------

def _shadow_edge_1d(profile, edge_is_low_index):
    """Given a 1-D mean-luma profile from page-edge → text-bbox, return the
    index of the gradient peak if it qualifies as a shadow boundary, else None.

    `edge_is_low_index`:
        True  → page edge at index 0  (left or top strip; brightness rises with index)
        False → page edge at end-1    (right or bottom strip; brightness falls with index)
    """
    if profile.size < 8:
        return None
    grad = np.diff(profile.astype(np.float32))
    # We want a positive gradient peak when moving from edge → text.
    if not edge_is_low_index:
        grad = -grad
    peak = int(np.argmax(grad))
    peak_val = float(grad[peak])
    if peak_val < SHADOW_GRAD_THRESHOLD:
        return None
    # Confirm the side closer to the page edge is darker than the side closer
    # to the text — guards against gradient peaks caused by isolated specks.
    left_mean = float(profile[:max(1, peak)].mean())
    right_mean = float(profile[peak + 1:].mean()) if peak + 1 < profile.size else left_mean + 1
    if not edge_is_low_index:
        # right_mean is closer to the page edge → it should be the dark side.
        if right_mean >= left_mean - 5:
            return None
    else:
        if left_mean >= right_mean - 5:
            return None
    # +1 to land just past the gradient peak — anything from there to the
    # page edge is shadow.
    return peak + 1


def detect_shadow_regions(gray, valid, text_bbox):
    """Return a list of (x0, y0, x1, y1) shadow rectangles to whitewash."""
    if valid is None:
        return []
    H, W = gray.shape
    vx0, vy0, vx1, vy1 = valid
    tx0, ty0, tx1, ty1 = text_bbox
    regions = []

    # Left strip: rows ty0..ty1, cols vx0..tx0
    if tx0 - vx0 > 8:
        strip_w = min(SHADOW_STRIP_PX, tx0 - vx0)
        strip = gray[ty0:ty1, tx0 - strip_w:tx0]   # depth-direction = x; index 0 = inner side
        if strip.size:
            profile = strip.mean(axis=0)            # 1-D over x
            # Profile runs inner → outer. We want edge_is_low_index relative
            # to "page edge first". Reverse so index 0 is the page edge.
            profile = profile[::-1]
            idx = _shadow_edge_1d(profile, edge_is_low_index=True)
            if idx is not None:
                # idx pixels in (from page edge) = shadow extends from
                # column tx0 - strip_w to tx0 - strip_w + idx
                x_cut = (tx0 - strip_w) + idx
                regions.append((vx0, ty0, x_cut, ty1))

    # Right strip
    if vx1 - tx1 > 8:
        strip_w = min(SHADOW_STRIP_PX, vx1 - tx1)
        strip = gray[ty0:ty1, tx1:tx1 + strip_w]
        if strip.size:
            profile = strip.mean(axis=0)            # index 0 = inner; end = page edge
            idx = _shadow_edge_1d(profile, edge_is_low_index=False)
            if idx is not None:
                x_cut = tx1 + idx
                regions.append((x_cut, ty0, vx1, ty1))

    # Top strip
    if ty0 - vy0 > 8:
        strip_h = min(SHADOW_STRIP_PX, ty0 - vy0)
        strip = gray[ty0 - strip_h:ty0, tx0:tx1]
        if strip.size:
            profile = strip.mean(axis=1)[::-1]      # reverse so index 0 = page edge
            idx = _shadow_edge_1d(profile, edge_is_low_index=True)
            if idx is not None:
                y_cut = (ty0 - strip_h) + idx
                regions.append((tx0, vy0, tx1, y_cut))

    # Bottom strip
    if vy1 - ty1 > 8:
        strip_h = min(SHADOW_STRIP_PX, vy1 - ty1)
        strip = gray[ty1:ty1 + strip_h, tx0:tx1]
        if strip.size:
            profile = strip.mean(axis=1)            # index 0 = inner; end = page edge
            idx = _shadow_edge_1d(profile, edge_is_low_index=False)
            if idx is not None:
                y_cut = ty1 + idx
                regions.append((tx0, y_cut, tx1, vy1))

    return regions


# ---------------------------------------------------------------------------
# Image processing
# ---------------------------------------------------------------------------

def to_grayscale(arr_rgb):
    return arr_rgb.astype(np.float32) @ LUMA


def flat_field(gray):
    bg = maximum_filter(gray, size=MAX_KERNEL, mode="nearest")
    bg = gaussian_filter(bg, SMOOTH_SIGMA, mode="nearest")
    bg = np.maximum(bg, 1.0)
    return np.clip(gray / bg * 255.0, 0, 255)


def local_contrast_stretch(flat):
    mean = uniform_filter(flat, size=STRETCH_WINDOW, mode="reflect")
    sq_mean = uniform_filter(flat * flat, size=STRETCH_WINDOW, mode="reflect")
    std = np.sqrt(np.maximum(sq_mean - mean * mean, 0.0))
    white_pt = mean - STRETCH_WHITE_K * std
    black_pt = mean - STRETCH_BLACK_K * std
    # Floor the span so uniform-paper regions (low local std) don't have
    # their noise amplified across the full 0..255 range. When the span
    # is floored, we anchor it on white_pt so paper still saturates to 255.
    raw_span = white_pt - black_pt
    span = np.maximum(raw_span, STRETCH_MIN_SPAN)
    black_pt = white_pt - span
    return np.clip((flat - black_pt) * 255.0 / span, 0, 255)


def whitewash_outside(out, text_bbox, shadow_regions):
    H, W = out.shape
    tx0, ty0, tx1, ty1 = text_bbox
    if ty0 > 0: out[:ty0, :] = 255
    if ty1 < H: out[ty1:, :] = 255
    if tx0 > 0: out[:, :tx0] = 255
    if tx1 < W: out[:, tx1:] = 255
    for sx0, sy0, sx1, sy1 in shadow_regions:
        out[sy0:sy1, sx0:sx1] = 255
    return out


def normalize_page(arr_rgb, valid, text_bbox, shadow_regions):
    gray = to_grayscale(arr_rgb)
    flat = flat_field(gray)
    stretched = local_contrast_stretch(flat)
    out = stretched.astype(np.uint8)
    return whitewash_outside(out, text_bbox, shadow_regions)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Stage 1d: B&W + shadow + text-bbox cleanup")
    ap.add_argument("--pages", help="e.g. '193' or '9-285'. Default: all content pages.")
    a = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    DIR_PAGES_NORMALIZED.mkdir(parents=True, exist_ok=True)

    if a.pages:
        total = db.execute("SELECT MAX(page_num) FROM pages").fetchone()[0] or PDF_CONTENT_END
        page_nums = parse_pages(a.pages, total)
    else:
        page_nums = list(range(PDF_CONTENT_START, PDF_CONTENT_END + 1))

    print(f"B&W cleanup on {len(page_nums)} pages")
    print(f"  text_margin={TEXT_BBOX_MARGIN}  shadow_strip={SHADOW_STRIP_PX} "
          f"shadow_grad={SHADOW_GRAD_THRESHOLD}")
    print(f"  stretch_win={STRETCH_WINDOW}  white_k={STRETCH_WHITE_K} "
          f"black_k={STRETCH_BLACK_K}")

    for p in page_nums:
        src = page_img_corrected(p)
        if not src.exists():
            print(f"  page {p:4d}: [no corrected image]")
            continue

        arr = np.asarray(Image.open(src).convert("RGB"))
        H, W, _ = arr.shape

        valid = load_valid_bbox(db, p)
        text_bbox, src_kind = compute_text_bbox(db, p, valid, (H, W))
        gray_for_shadows = to_grayscale(arr)
        shadows = detect_shadow_regions(gray_for_shadows, valid, text_bbox)

        out = normalize_page(arr, valid, text_bbox, shadows)
        Image.fromarray(out, mode="L").save(page_img_normalized(p), quality=NORMALIZED_JPEG_Q)

        sh = ",".join(f"({sx0},{sy0},{sx1},{sy1})" for sx0, sy0, sx1, sy1 in shadows) or "—"
        print(f"  page {p:4d}: bbox={text_bbox} src={src_kind} shadows={sh}")

    db.close()


if __name__ == "__main__":
    main()
