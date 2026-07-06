"""Stage 03 — export the DB to static JSON consumed by humument.

Consumers are fully static (no sql.js): they fetch one small JSON per page on
demand, plus a catalog and a search index. This reads the volume-less DB and
writes, under output/db/ (published as the humument-data npm package):

    catalog.json          {pages:[…], chapters:[{pageNum,label,roman}]}
    pages/pNNNN.json      {meta, words[], gutters[], docks[], graph[]}
    search-index.json     {token: [[pageNum, count], …]}  (lowercased tokens)

JSON shapes match the humument types exactly (camelCase, parsed arrays), so
the runtime just JSON.parses. Run:  uv run python pipeline/03_export_web.py
"""

from __future__ import annotations

import gzip
import json
import re
import shutil
import sqlite3
from collections import defaultdict

from config import DB_PATH, REPO_ROOT

OUT = REPO_ROOT / "output" / "db"
ROMAN = re.compile(r"^CHAPTER\s+([IVXLCDM]+)\s*$", re.IGNORECASE)


def _bbox(vals):
    return None if vals[0] is None else dict(zip(("x0", "y0", "x1", "y1"), vals))


def ri(v):
    """Round to int (pixel coords); None passes through. Sub-pixel precision is
    visual noise for rivers/balloons and bloats the JSON, so we drop it."""
    return None if v is None else int(round(v))


def export_pages(db):
    (OUT / "pages").mkdir(parents=True, exist_ok=True)
    content = [r[0] for r in db.execute(
        "SELECT page_num FROM page_corrections ORDER BY page_num")]
    for pn in content:
        meta_row = db.execute(
            "SELECT p.width_px, p.height_px, "
            "c.body_x0,c.body_y0,c.body_x1,c.body_y1, "
            "c.valid_x0,c.valid_y0,c.valid_x1,c.valid_y1 "
            "FROM pages p LEFT JOIN page_corrections c ON c.page_num=p.page_num "
            "WHERE p.page_num=?", (pn,)).fetchone()
        meta = {
            "width": meta_row[0], "height": meta_row[1],
            "body": _bbox(meta_row[2:6]), "valid": _bbox(meta_row[6:10]),
        }
        words = [
            {"id": r[0], "text": r[1], "x0": r[2], "y0": r[3], "x1": r[4], "y1": r[5],
             "lineIdx": r[6], "conf": r[7], "prefix": r[8], "suffix": r[9],
             "pos": r[10], "lemma": r[11], "freq": r[12], "rarity": r[13],
             "isContent": r[14] or 0, "isConnective": r[15] or 0}
            for r in db.execute(
                "SELECT id,text,bbox_x0,bbox_y0,bbox_x1,bbox_y1,line_idx,conf,"
                "prefix,suffix,pos,lemma,frequency,rarity,is_content,is_connective "
                "FROM words WHERE page_num=? ORDER BY line_idx, bbox_x0", (pn,))
        ]
        gutters = [
            {"gutterId": r[0], "kind": r[1], "lineIdxA": r[2], "lineIdxB": r[3],
             "x0": ri(r[4]), "y0": ri(r[5]), "x1": ri(r[6]), "y1": ri(r[7]),
             "polyline": [[ri(x), ri(y)] for x, y in (json.loads(r[8]) if r[8] else [])],
             "minWidth": round(r[9], 1) if r[9] is not None else 0,
             "riverScore": round(r[10], 3) if r[10] else 0}
            for r in db.execute(
                "SELECT gutter_id,kind,line_idx_a,line_idx_b,x0,y0,x1,y1,"
                "polyline_json,min_width,river_score FROM page_gutters WHERE page_num=?",
                (pn,))
        ]
        docks = []
        for r in db.execute(
                "SELECT wd.word_id,wd.dock_above,wd.dock_below,wd.dock_left,wd.dock_right,"
                "wd.breathing_top,wd.breathing_bottom,wd.breathing_left,wd.breathing_right,"
                "wd.slack_direction,wd.ports_json FROM word_docks wd "
                "JOIN words w ON w.id=wd.word_id WHERE w.page_num=?", (pn,)):
            ports = [{"x": ri(p["x"]), "y": ri(p["y"]), "gutterId": p["gutter_id"],
                      "compass": p["compass"], "nodeId": p["node_id"]}
                     for p in (json.loads(r[10]) if r[10] else [])]
            docks.append({
                "wordId": r[0], "dockAbove": r[1], "dockBelow": r[2],
                "dockLeft": r[3], "dockRight": r[4],
                "breathingTop": ri(r[5]), "breathingBottom": ri(r[6]),
                "breathingLeft": ri(r[7]), "breathingRight": ri(r[8]),
                "slackDirection": r[9] or "", "ports": ports})
        # graph is the bulk of the payload — emit compact arrays [id,x,y,edges]
        # (drop the informational `kind`, round coords + edge costs).
        graph = [
            [r[0], ri(r[1]), ri(r[2]),
             [[e[0], round(e[1], 1), e[2]] for e in (json.loads(r[3]) if r[3] else [])]]
            for r in db.execute(
                "SELECT node_id,x,y,edges_json FROM page_graph WHERE page_num=?",
                (pn,))
        ]
        payload = {"meta": meta, "words": words, "gutters": gutters,
                   "docks": docks, "graph": graph}
        raw = json.dumps(payload, separators=(",", ":")).encode()
        (OUT / "pages" / f"p{pn:04d}.json").write_bytes(raw)
        # .gz twin ships in the humument-data npm package (jsDelivr refuses
        # >150MB unpacked; gzip brings the page set from ~159MB to ~25MB).
        # mtime=0 keeps the bytes deterministic across identical exports.
        (OUT / "pages" / f"p{pn:04d}.json.gz").write_bytes(
            gzip.compress(raw, 9, mtime=0))
    return content


def export_catalog(db, content):
    # chapters: lines (line_idx<=3) reading "CHAPTER <Roman>" — replicate
    # humument listChapters, building line text in Python (sqlite 3.43 has
    # no ORDER BY in GROUP_CONCAT).
    lines = defaultdict(list)
    for pn, li, text, x0 in db.execute(
            "SELECT page_num, line_idx, text, bbox_x0 FROM words "
            "WHERE line_idx<=3 ORDER BY page_num, line_idx, bbox_x0"):
        lines[(pn, li)].append(text)
    chapters, seen = [], set()
    for (pn, li), toks in lines.items():
        m = ROMAN.match(" ".join(toks).strip())
        if not m or pn in seen:
            continue
        seen.add(pn)
        roman = m.group(1).upper()
        chapters.append({"pageNum": pn, "label": f"CHAPTER {roman}", "roman": roman})
    chapters.sort(key=lambda c: c["pageNum"])
    (OUT / "catalog.json").write_text(json.dumps(
        {"pages": content, "chapters": chapters}, separators=(",", ":")))
    return len(chapters)


def export_search_index(db):
    idx = defaultdict(lambda: defaultdict(int))
    for text, pn in db.execute("SELECT text, page_num FROM words"):
        idx[text.lower()][pn] += 1
    out = {tok: sorted(pages.items(), key=lambda kv: (-kv[1], kv[0]))
           for tok, pages in idx.items()}
    (OUT / "search-index.json").write_text(json.dumps(out, separators=(",", ":")))
    return len(out)


def main():
    if OUT.exists():
        shutil.rmtree(OUT / "pages", ignore_errors=True)
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = None
    content = export_pages(db)
    n_ch = export_catalog(db, content)
    n_tok = export_search_index(db)
    db.close()
    print(f"exported {len(content)} pages, {n_ch} chapters, {n_tok} search tokens → {OUT}")


if __name__ == "__main__":
    main()
