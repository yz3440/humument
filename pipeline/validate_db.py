"""Read-only validation of the pipeline DB against the editor data contract.

Run as the gate after a full pipeline run (or future PDF swap):

    uv run python pipeline/validate_db.py
    uv run python pipeline/validate_db.py --expected-pages 367

Every check the editor (humument + editor-frontend) relies on is asserted
here. Exits non-zero if any check fails, so it doubles as a CI/pytest gate.

The core invariants:
  * page_corrections.page_num is exactly the contiguous content range — this is
    what makes printedPage() the identity (page_num == printed == A Humument page).
  * pages.width_px/height_px == the normalized canvas == the actual JPEG dims —
    the word-overlay alignment in the editor depends on this.
  * NLP columns, graph, gutters, docks are all populated and JSON-parseable.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys

from PIL import Image

from config import (
    DB_PATH, PDF_CONTENT_START, PDF_CONTENT_END,
    OUTPUT_WIDTH, OUTPUT_HEIGHT, page_img_normalized,
)


class Validator:
    def __init__(self, db, lo, hi):
        self.db = db
        self.lo = lo
        self.hi = hi
        self.expected = set(range(lo, hi + 1))
        self.failures = 0
        self.checks = 0

    def _q(self, sql, params=()):
        return self.db.execute(sql, params).fetchall()

    def check(self, name, ok, detail=""):
        self.checks += 1
        mark = "PASS" if ok else "FAIL"
        if not ok:
            self.failures += 1
        line = f"  [{mark}] {name}"
        if detail:
            line += f" — {detail}"
        print(line)

    # --- individual checks --------------------------------------------------

    def page_range(self):
        nums = sorted(r[0] for r in self._q(
            "SELECT page_num FROM page_corrections"))
        present = set(nums)
        missing = sorted(self.expected - present)
        extra = sorted(present - self.expected)
        ok = present == self.expected
        self.check(
            f"page_corrections page_num == contiguous {self.lo}..{self.hi}",
            ok,
            f"count={len(nums)} missing={missing[:10]} extra={extra[:10]}")

    def pages_exist_and_dims(self):
        # every corrected page must have a pages row of the canonical size
        rows = self._q(
            "SELECT pc.page_num, p.width_px, p.height_px "
            "FROM page_corrections pc LEFT JOIN pages p "
            "  ON p.page_num=pc.page_num")
        missing = [r[0] for r in rows if r[1] is None]
        baddim = [(r[0], r[1], r[2]) for r in rows
                  if r[1] is not None and (r[1] != OUTPUT_WIDTH or r[2] != OUTPUT_HEIGHT)]
        self.check("every content page has a pages row", not missing,
                   f"missing: {missing[:10]}")
        self.check(f"content pages are {OUTPUT_WIDTH}x{OUTPUT_HEIGHT}", not baddim,
                   f"off-size: {baddim[:5]}")

    def jpeg_dims_match(self):
        rows = self._q(
            "SELECT page_num, width_px, height_px FROM pages "
            "WHERE page_num BETWEEN ? AND ?",
            (self.lo, self.hi))
        bad, missing = [], []
        for pn, w, h in rows:
            path = page_img_normalized(pn)
            if not path.exists():
                missing.append(pn)
                continue
            iw, ih = Image.open(path).size
            if (iw, ih) != (w, h):
                bad.append((pn, (iw, ih), (w, h)))
        self.check("normalized JPEG exists for every content page", not missing,
                   f"missing files: {missing[:10]}")
        self.check("normalized JPEG dims == pages dims", not bad,
                   f"mismatches: {bad[:5]}")

    def words_integrity(self):
        orphan = self._q(
            "SELECT COUNT(*) FROM words w LEFT JOIN pages p "
            "  ON p.page_num=w.page_num "
            "WHERE p.page_num IS NULL")[0][0]
        self.check("every word's page_num exists in pages", orphan == 0,
                   f"orphans: {orphan}")

    def nlp_complete(self):
        n = self._q(
            "SELECT COUNT(*) FROM words WHERE "
            "pos IS NULL OR lemma IS NULL OR frequency IS NULL OR rarity IS NULL "
            "OR is_content IS NULL OR is_connective IS NULL")[0][0]
        self.check("no null NLP columns (01y ran on every word)", n == 0,
                   f"null rows: {n}")

    def bbox_bounds(self):
        bad = self._q(
            "SELECT COUNT(*) FROM words w JOIN pages p "
            "  ON p.page_num=w.page_num "
            "WHERE w.bbox_x0<0 OR w.bbox_y0<0 "
            "OR w.bbox_x1>p.width_px OR w.bbox_y1>p.height_px "
            "OR w.bbox_x1<=w.bbox_x0 OR w.bbox_y1<=w.bbox_y0")[0][0]
        self.check("word bboxes within page bounds and well-formed", bad == 0,
                   f"violations: {bad}")

    def graph_present(self):
        missing = self._q(
            "SELECT pc.page_num FROM page_corrections pc LEFT JOIN "
            "  (SELECT DISTINCT page_num FROM page_graph) g "
            "  ON g.page_num=pc.page_num "
            "WHERE g.page_num IS NULL")
        self.check("every content page has graph nodes", not missing,
                   f"pages w/o graph: {[r[0] for r in missing][:10]}")
        dead = self._q(
            "SELECT page_num FROM page_graph "
            "GROUP BY page_num HAVING SUM(edges_json='[]')=COUNT(*)")
        self.check("every page graph has at least one edge", not dead,
                   f"edgeless pages: {[r[0] for r in dead][:10]}")

    def docks_present(self):
        missing = self._q(
            "SELECT pc.page_num FROM page_corrections pc WHERE "
            "NOT EXISTS (SELECT 1 FROM word_docks wd JOIN words w ON w.id=wd.word_id "
            "  WHERE w.page_num=pc.page_num)")
        self.check("every content page has word_docks", not missing,
                   f"pages w/o docks: {[r[0] for r in missing][:10]}")

    def json_parses(self):
        bad = []
        for tbl, col, key in (("page_graph", "edges_json", None),
                              ("page_gutters", "polyline_json", None),
                              ("word_docks", "ports_json", "node_id")):
            rows = self._q(
                f"SELECT {col} FROM {tbl} WHERE {col} IS NOT NULL")
            for (raw,) in rows:
                try:
                    obj = json.loads(raw)
                except Exception:
                    bad.append((tbl, col, "parse error"))
                    break
                if key and isinstance(obj, list):
                    for item in obj:
                        if isinstance(item, dict) and key not in item:
                            bad.append((tbl, col, f"missing {key}"))
                            break
        self.check("graph/gutter/dock JSON parses and ports carry node_id",
                   not bad, f"issues: {bad[:5]}")

    def page_correspondence(self):
        """The page number printed in the running header should equal page_num —
        objective proof that page_num == printed page == A Humument page."""
        rows = self._q(
            "SELECT page_num, GROUP_CONCAT(text,' ') FROM words "
            "WHERE line_idx<=2 GROUP BY page_num")
        numbered = matched = 0
        misses = []
        for pn, head in rows:
            nums = re.findall(r"\d+", head or "")
            if not nums:
                continue
            numbered += 1
            if str(pn) in nums:
                matched += 1
            else:
                misses.append((pn, nums[:4]))
        rate = matched / numbered if numbered else 0.0
        self.check("running-header page number matches page_num (>=85%)",
                   rate >= 0.85,
                   f"{matched}/{numbered} ({rate:.0%}) e.g. {misses[:5]}")

    def run(self):
        print(f"Validating pages {self.lo}..{self.hi}\n")
        self.page_range()
        self.pages_exist_and_dims()
        self.jpeg_dims_match()
        self.words_integrity()
        self.nlp_complete()
        self.bbox_bounds()
        self.graph_present()
        self.docks_present()
        self.json_parses()
        self.page_correspondence()
        print(f"\n{self.checks - self.failures}/{self.checks} checks passed.")
        return self.failures == 0


def main():
    ap = argparse.ArgumentParser(description="Validate the pipeline DB contract.")
    ap.add_argument("--expected-pages", type=int, default=None,
                    help="content page count; default from config content range")
    a = ap.parse_args()

    lo = PDF_CONTENT_START
    hi = PDF_CONTENT_END if a.expected_pages is None else lo + a.expected_pages - 1

    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    ok = Validator(db, lo, hi).run()
    db.close()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
