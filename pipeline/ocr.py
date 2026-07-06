"""Shared OCR module — macOS Vision via ocrmac, per-word bboxes → SQLite.

Used by 01b (first pass on raw scans) and 01c (second pass on corrected
images). Handles merged-line repair, word segmentation within OCR lines,
dash splitting, and prefix/suffix punctuation separation.

Word segmentation: Vision line bboxes in this tightly-set edition are taller
than the ~40px line pitch, so each line crop contains ascender/descender tips
of the neighbouring lines. Segmentation therefore first isolates the line's
own core ink band, column-projects only that band into ink segments, and
groups segments into words with a small DP that matches group spans against
per-word glyph-width expectations (see `split_words`).
"""

from __future__ import annotations

import difflib
import re
import sqlite3

import numpy as np
from ocrmac import ocrmac
from PIL import Image


# --- scan watermark filter ---

def is_watermark_line(text, line_bbox_px, page_h):
    """True if an OCR line is the bottom-margin 'Digitized by Google' watermark.

    Google-scanned pages stamp this below the type block. It is reliably
    distinguished from real text by three things, all required: it sits in the
    bottom margin, it is a short isolated line (a real body line is ~8-12
    tokens), and it contains 'google'/'digitized' — words that never occur in
    the 1892 source. Fuzzy matching tolerates OCR noise (oogle, Digized, ...);
    the short-line + bottom-margin guards prevent flagging a real last line
    that merely contains a google-ish word (e.g. "good").
    """
    if line_bbox_px[1] < page_h * 0.72:          # lower margin only
        return False
    toks = [t.lower() for t in re.findall(r"[A-Za-z]+", text)]
    if len(toks) > 4:                            # the stamp is a short line
        return False
    for t in toks:
        if len(t) < 4:
            continue
        if (difflib.SequenceMatcher(None, t, "google").ratio() >= 0.7 or
                difflib.SequenceMatcher(None, t, "digitized").ratio() >= 0.7):
            return True
    return False


# --- DB ---

def init_db(db: sqlite3.Connection):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS pages (
            page_num INTEGER PRIMARY KEY,
            image_path TEXT,
            width_px INTEGER,
            height_px INTEGER
        );
        CREATE TABLE IF NOT EXISTS words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_num INTEGER NOT NULL,
            text TEXT NOT NULL,
            bbox_x0 INTEGER,
            bbox_y0 INTEGER,
            bbox_x1 INTEGER,
            bbox_y1 INTEGER,
            line_idx INTEGER,
            conf REAL,
            prefix TEXT,
            suffix TEXT,
            FOREIGN KEY (page_num) REFERENCES pages (page_num)
        );
        CREATE INDEX IF NOT EXISTS idx_words_page ON words (page_num);
    """)


# --- coordinate helpers ---

def vision_to_px(b, w, h):
    """Vision normalised (x, y, w, h) bottom-left → (x0, y0, x1, y1) top-left px."""
    x, y, bw, bh = b
    return (round(x * w), round((1 - y - bh) * h), round((x + bw) * w), round((1 - y) * h))


# --- word segmentation within a line ---

def split_proportional(words, x0, y0, x1, y1, space_w=0.4):
    """Divide a line bbox into per-word slices proportional to char count."""
    chars = sum(len(w) for w in words)
    if not chars:
        return []
    units = chars + max(0, len(words) - 1) * space_w
    px = (x1 - x0) / units
    out, c = [], float(x0)
    for i, w in enumerate(words):
        wx0 = round(c)
        c += len(w) * px
        out.append((w, (wx0, y0, round(c), y1)))
        if i < len(words) - 1:
            c += space_w * px
    return out


# Rough advance widths relative to a lowercase letter, used both to predict
# word spans for the segment-grouping DP and to sanity-check its output.
_WIDE_GLYPHS = set("mwMW—–")
_NARROW_GLYPHS = set("iljtfrI!.,;:'\"’‘“”()[]|")


def _glyph_weight(s):
    total = 0.0
    for c in s:
        if c in _WIDE_GLYPHS:
            total += 1.9
        elif c in _NARROW_GLYPHS:
            total += 0.55
        elif c.isupper() or c.isdigit():
            total += 1.25
        else:
            total += 1.0
    return total


def _ink_mask(arr):
    return arr < max(60, int(arr.mean() - arr.std() * 0.5))


def _core_band(ink):
    """Row range of this line's own text within the crop, or None.

    Neighbouring-line intrusions live in the top/bottom rows and touch few
    columns; the line's own x-height band inks many columns per row. Keep the
    longest contiguous run of high-ink rows.
    """
    rows = ink.sum(axis=1)
    hot_vals = rows[rows > 0]
    if hot_vals.size == 0:
        return None
    thresh = max(2.0, float(np.percentile(hot_vals, 90)) * 0.15)
    hot = rows >= thresh
    best = run_start = None
    best_len = 0
    for i, is_hot in enumerate(hot):
        if is_hot:
            if run_start is None:
                run_start = i
            if i - run_start + 1 > best_len:
                best, best_len = (run_start, i + 1), i - run_start + 1
        else:
            run_start = None
    if best is None or best_len < 3:
        return None
    return best


def _segments(band):
    """Maximal runs of inked columns; near-touching runs (<2px apart) merged."""
    col = band.sum(axis=0)
    tol = 1 if band.shape[0] >= 15 else 0   # single-pixel specks don't bridge gaps
    is_ink = col > tol
    segs = []
    i, n = 0, len(is_ink)
    while i < n:
        if is_ink[i]:
            j = i
            while j < n and is_ink[j]:
                j += 1
            if segs and i - segs[-1][1] < 2:
                segs[-1] = (segs[-1][0], j)
            else:
                segs.append((i, j))
            i = j
        else:
            i += 1
    return segs


def _group_segments(words, segs, ppc):
    """Partition consecutive ink segments into one group per word (DP).

    Cost of a group = |span − expected width from glyph weights| plus a
    penalty for each wide (word-space-sized) gap swallowed inside the group,
    so real spaces are preferred boundaries but a wide gap can still be
    absorbed when the transcript demands it. Returns per-word (first_seg,
    last_seg) index pairs, or None if infeasible.
    """
    n, m = len(words), len(segs)
    exp = [_glyph_weight(w) * ppc for w in words]
    pen = [0.0]                              # prefix sums of swallow penalties
    for i in range(m - 1):
        gap = segs[i + 1][0] - segs[i][1]
        pen.append(pen[-1] + 1.5 * max(0, gap - 4))
    inf = float("inf")
    dp = [[inf] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for k in range(1, n + 1):
        ek = exp[k - 1]
        for j in range(k, m - (n - k) + 1):
            seg_end = segs[j - 1][1]
            best, arg = inf, 0
            for i in range(k - 1, j):
                prev = dp[k - 1][i]
                if prev == inf:
                    continue
                span = seg_end - segs[i][0]
                c = prev + abs(span - ek) + (pen[j - 1] - pen[i])
                if c < best:
                    best, arg = c, i
            dp[k][j], back[k][j] = best, arg
    if dp[n][m] == inf:
        return None
    bounds, j = [None] * n, m
    for k in range(n, 0, -1):
        i = back[k][j]
        bounds[k - 1] = (i, j - 1)
        j = i
    return bounds


def _plausible(pairs, ppc):
    """Reject segmentations whose box widths defy the glyph-width expectation."""
    soft = 0
    for w, (x0, _, x1, _) in pairs:
        r = (x1 - x0) / max(2.0, _glyph_weight(w) * ppc)
        if r < 0.22 or r > 4.2:
            return False
        if r < 0.4 or r > 2.6:
            soft += 1
    return soft <= max(1, len(pairs) // 3)


def split_words(text, line_bbox, page):
    """Per-word bboxes for one Vision line observation.

    Core-band column projection → segment-grouping DP → width sanity check,
    falling back to char-proportional slicing (over the ink extent when
    known, else the raw bbox).
    """
    words = text.split()
    if not words:
        return []
    x0, y0, x1, y1 = line_bbox
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(page.width, x1), min(page.height, y1)
    if cx1 - cx0 < len(words) or cy1 - cy0 < 4:
        return split_proportional(words, *line_bbox)
    arr = np.asarray(page.crop((cx0, cy0, cx1, cy1)).convert("L"))
    band_range = _core_band(_ink_mask(arr))
    if band_range is None:
        return split_proportional(words, *line_bbox)
    segs = _segments(_ink_mask(arr)[band_range[0]:band_range[1]])
    if not segs:
        return split_proportional(words, *line_bbox)
    ink_x0, ink_x1 = cx0 + segs[0][0], cx0 + segs[-1][1]
    n = len(words)
    if n == 1:
        return [(words[0], (ink_x0, y0, ink_x1, y1))]
    total_weight = sum(_glyph_weight(w) for w in words)
    ppc = (segs[-1][1] - segs[0][0]) / max(1e-6, total_weight + 0.45 * (n - 1))
    if len(segs) >= n:
        bounds = _group_segments(words, segs, ppc)
        if bounds:
            out = [(w, (cx0 + segs[b0][0], y0, cx0 + segs[b1][1], y1))
                   for w, (b0, b1) in zip(words, bounds)]
            if _plausible(out, ppc):
                return out
    return split_proportional(words, ink_x0, y0, ink_x1, y1)


# --- merged-line repair ---

REOCR_PAD = 24     # white margin around re-OCR crops; Vision reads isolated
                   # strips poorly when the text touches the image edge


def _alnum_len(s):
    return sum(1 for c in s if c.isalnum())


def _obs_sort_key(o):
    return ((o[2][1] + o[2][3]) / 2.0, o[2][0])


def _reocr_region(page, bbox, level):
    """Re-OCR a page region on a padded white canvas; obs in page coords."""
    x0, y0 = max(0, bbox[0] - 6), max(0, bbox[1] - 2)
    x1, y1 = min(page.width, bbox[2] + 6), min(page.height, bbox[3] + 2)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return []
    crop = page.crop((x0, y0, x1, y1)).convert("RGB")
    canvas = Image.new("RGB", (crop.width + 2 * REOCR_PAD, crop.height + 2 * REOCR_PAD),
                       "white")
    canvas.paste(crop, (REOCR_PAD, REOCR_PAD))
    annots = ocrmac.OCR(canvas, recognition_level=level,
                        language_preference=["en-US"]).recognize()
    out = []
    for text, conf, b in annots:
        bx0, by0, bx1, by1 = vision_to_px(b, canvas.width, canvas.height)
        out.append((text, float(conf),
                    (max(0, x0 - REOCR_PAD + bx0),
                     max(0, y0 - REOCR_PAD + by0),
                     min(page.width, x0 - REOCR_PAD + bx1),
                     min(page.height, y0 - REOCR_PAD + by1))))
    out.sort(key=_obs_sort_key)
    return out


def _cut_strips(page, bbox, k):
    """Cut a k-line-tall region into k single-line strips at row-ink minima."""
    x0, y0, x1, y1 = bbox
    arr = np.asarray(page.crop((max(0, x0), max(0, y0),
                                min(page.width, x1), min(page.height, y1))).convert("L"))
    rows = _ink_mask(arr).sum(axis=1).astype(float)
    if len(rows) >= 5:
        rows = np.convolve(rows, np.ones(5) / 5.0, mode="same")
    h = len(rows)
    cuts = [0]
    for i in range(1, k):
        target = round(i * h / k)
        lo = max(cuts[-1] + 4, target - h // (2 * k))
        hi = min(h - 4, target + h // (2 * k))
        cuts.append(lo + int(np.argmin(rows[lo:hi])) if lo < hi else target)
    cuts.append(h)
    return [(x0, y0 + a, x1, y0 + b) for a, b in zip(cuts, cuts[1:]) if b - a >= 6]


def repair_merged_lines(obs, page, level):
    """Re-OCR observations that fused two printed lines or came back garbled.

    Vision on the full page occasionally fuses two adjacent printed lines of
    this worn letterpress into one tall observation, garbling the transcript
    and silently losing most of one line. On an isolated padded crop it
    nearly always reads the region correctly; if it still returns one tall
    observation, the region is cut into single-line strips at row-ink minima
    and each strip re-OCR'd separately. A repair is kept only when it retains
    at least half the original alphanumeric mass, so a bad crop read can
    never lose more text than the original.
    """
    body = [o for o in obs if len(o[0].split()) >= 3]
    heights = sorted(o[2][3] - o[2][1] for o in body)
    med_h = heights[len(heights) // 2] if heights else 40
    centers = sorted((o[2][1] + o[2][3]) / 2.0 for o in body)
    pitches = sorted(b - a for a, b in zip(centers, centers[1:]) if 10 < b - a < 200)
    pitch = pitches[len(pitches) // 2] if pitches else med_h
    out = []
    for text, conf, bb in obs:
        tall = bb[3] - bb[1] > 1.5 * med_h
        if len(text.split()) < 2 or not (tall or conf < 0.9):
            out.append((text, conf, bb))
            continue
        repl = _reocr_region(page, bb, level)
        if tall and (not repl or
                     any(r[2][3] - r[2][1] > 1.5 * med_h for r in repl)):
            k = max(2, round((bb[3] - bb[1]) / max(pitch, 1)))
            strips = []
            for sb in _cut_strips(page, bb, k):
                strips.extend(_reocr_region(page, sb, level))
            if (_alnum_len(" ".join(r[0] for r in strips)) >
                    _alnum_len(" ".join(r[0] for r in repl))):
                repl = strips
        if repl and (_alnum_len(" ".join(r[0] for r in repl)) >=
                     0.5 * _alnum_len(text)):
            out.extend(sorted(repl, key=_obs_sort_key))
        else:
            out.append((text, conf, bb))
    return out


def recover_gap_lines(obs, page, level):
    """Re-OCR vertical gaps where Vision silently dropped whole lines.

    Vision's full-page pass occasionally returns no observation at all for a
    band of printed text (no tall bbox, no low conf — invisible to
    `repair_merged_lines`). Detect: consecutive observations (sorted by
    y-center, running-header zone excluded) whose center distance exceeds
    1.7× the page's median line pitch. The interior strip between them is
    re-OCR'd in isolation; legitimate whitespace (chapter-heading margins,
    title pages) simply returns nothing. Recovered lines occasionally come
    back fused/garbled; the caller runs `repair_merged_lines` again after
    this to fix those. Limitation: no recovery above the first / below the
    last observation.
    """
    if len(obs) < 2:
        return obs
    order = sorted(range(len(obs)), key=lambda i: _obs_sort_key(obs[i]))
    centers = [(obs[i][2][1] + obs[i][2][3]) / 2.0 for i in order]
    diffs = sorted(b - a for a, b in zip(centers, centers[1:]) if 10 < b - a < 200)
    if len(diffs) < 5:
        return obs
    pitch = diffs[len(diffs) // 2]
    header_limit = page.height * 0.095
    inserts = {}                      # original obs index -> recovered lines
    for k in range(len(order) - 1):
        if centers[k] < header_limit:
            continue
        d = centers[k + 1] - centers[k]
        if not (1.7 * pitch < d < 8 * pitch):
            continue
        a, b = obs[order[k]][2], obs[order[k + 1]][2]
        # Vision garbles isolated thin strips but reads the same region
        # cleanly when surrounded by context lines — how much context it
        # needs varies run to run, so retry with growing context and keep
        # the best read. The centre filter drops the context re-reads (and
        # fusions with a neighbour) so they can't duplicate existing lines.
        best, best_score, misses = [], 0.0, 0
        for extra in (0.1, 1.0, 2.0):          # context beyond neighbours, in pitches
            pad = round(extra * pitch)
            strip = (min(a[0], b[0]) - 4, a[1] - pad,
                     max(a[2], b[2]) + 4, b[3] + pad)
            found = [r for r in _reocr_region(page, strip, level)
                     if _alnum_len(r[0]) and a[3] < (r[2][1] + r[2][3]) / 2.0 < b[1]]
            if not found:
                misses += 1
                if misses >= 2 and not best:   # genuinely blank gap
                    break
                continue
            # any single attempt may read only part of the region (truncated
            # or garbled) — score attempts and keep the strongest read
            score = sum(_alnum_len(r[0]) * (1.0 if r[1] >= 0.8 else 0.5)
                        for r in found)
            if score > best_score:
                best, best_score = found, score
        if best:
            inserts.setdefault(order[k], []).extend(sorted(best, key=_obs_sort_key))
    if not inserts:
        return obs
    out = []
    for i, o in enumerate(obs):
        out.append(o)
        out.extend(inserts.get(i, []))
    return out


# --- dash splitting ---

_DASH_SPLIT = re.compile(r"([—–])")
_CHAR_WEIGHT = {"—": 2.5, "–": 2.0}


def _char_width(s):
    return sum(_CHAR_WEIGHT.get(c, 1.0) for c in s)


def _proportional_bbox(parts, x0, y0, x1, y1):
    total = sum(_char_width(p) for p in parts)
    if total == 0:
        return [(x0, y0, x1, y1)] * len(parts)
    cx = float(x0)
    out = []
    for p in parts:
        nx = cx + (x1 - x0) * _char_width(p) / total
        out.append((round(cx), y0, round(nx), y1))
        cx = nx
    return out


def split_on_dashes(pairs):
    """Split tokens containing em/en dashes into sub-parts with proportional bboxes."""
    out = []
    for text, (x0, y0, x1, y1) in pairs:
        parts = _DASH_SPLIT.split(text)
        if len(parts) <= 1:
            out.append((text, (x0, y0, x1, y1)))
            continue
        bboxes = _proportional_bbox(parts, x0, y0, x1, y1)
        out.extend(zip(parts, bboxes))
    return out


# --- tokenization ---

def _is_core_char(c):
    # '&' counts as a word core: Vision reads this edition's worn 'a' as '&'
    # fairly often, and stripping it silently deleted real words.
    return c.isalnum() or c == "&"


def tokenize(raw_pairs, line_idx, conf):
    """Convert raw (text, bbox) pairs into word tuples for DB insertion.

    Strips leading/trailing punctuation into prefix/suffix fields. Dashes
    between words attach as suffix to the previous word (the bbox expands
    to include the dash) and prefix to the next word.
    """
    words = []
    prev_dash = None
    pairs = split_on_dashes(raw_pairs)

    for raw_text, raw_bbox in pairs:
        is_dash = raw_text in ("—", "–")
        if is_dash:
            if words:
                w = list(words[-1])
                w[3] = max(w[3], raw_bbox[2])  # extend bbox_x1 right
                w[8] = raw_text                # set suffix
                words[-1] = tuple(w)
            prev_dash = (raw_text, raw_bbox)
            continue

        lead_i = 0
        while lead_i < len(raw_text) and not _is_core_char(raw_text[lead_i]):
            lead_i += 1
        trail_i = len(raw_text)
        while trail_i > lead_i and not _is_core_char(raw_text[trail_i - 1]):
            trail_i -= 1

        prefix = raw_text[:lead_i] or None
        core = raw_text[lead_i:trail_i]
        suffix = raw_text[trail_i:] or None

        bbox = raw_bbox
        if prev_dash:
            dash_text, dash_bbox = prev_dash
            prefix = dash_text + (prefix or "")
            bbox = (min(raw_bbox[0], dash_bbox[0]), raw_bbox[1],
                    raw_bbox[2], raw_bbox[3])
            prev_dash = None

        if not core:
            continue

        # (text, bbox_x0, bbox_y0, bbox_x1, bbox_y1, line_idx, conf, prefix, suffix)
        words.append((core, bbox[0], bbox[1], bbox[2], bbox[3],
                      line_idx, conf, prefix, suffix))

    return words


# --- main entry point: OCR one page + write to DB ---

def extract_page(img_path, page_num, db, level="accurate"):
    """OCR a page image, write page + word rows to DB. Returns word count."""
    img = Image.open(img_path)
    img.load()
    w, h = img.size
    annots = ocrmac.OCR(img, recognition_level=level,
                        language_preference=["en-US"]).recognize()
    obs = [(text, float(conf), vision_to_px(b, w, h)) for text, conf, b in annots]
    obs = repair_merged_lines(obs, img, level)
    obs = recover_gap_lines(obs, img, level)
    # gap-recovered strips occasionally come back fused/garbled themselves;
    # a second repair pass strip-cuts and re-reads exactly those
    obs = repair_merged_lines(obs, img, level)

    db.execute("DELETE FROM words WHERE page_num = ?", (page_num,))
    db.execute("DELETE FROM pages WHERE page_num = ?", (page_num,))
    db.execute("INSERT INTO pages VALUES (?, ?, ?, ?)",
               (page_num, str(img_path), w, h))

    all_rows = []
    for li, (text, conf, lb) in enumerate(obs):
        raw_pairs = split_words(text, lb, img)
        all_rows.extend(tokenize(raw_pairs, li, conf))

    db.executemany(
        "INSERT INTO words (page_num, text, bbox_x0, bbox_y0, bbox_x1, bbox_y1, "
        "line_idx, conf, prefix, suffix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(page_num, *row) for row in all_rows],
    )
    db.commit()
    return len(all_rows)
