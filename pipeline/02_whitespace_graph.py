"""Stage 2c — whitespace navigation graph per page.

For each page, computes:
  - horizontal inter-line gutters and vertical inter-word slits → `page_gutters`
  - per-word docks (breathing dims, slack direction, 4 compass ports) → `word_docks`
  - navigable graph (nodes + adjacency) used by JS Dijkstra → `page_graph`

The graph is the backbone of Humument-style river rendering: channels between
selected words flow along gutter centerlines, never cutting across word bodies.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from statistics import median

from config import DB_PATH, parse_pages


# === schema ===================================================================

def init_db(db: sqlite3.Connection):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS page_gutters (
            page_num INTEGER NOT NULL,
            gutter_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            line_idx_a INTEGER,
            line_idx_b INTEGER,
            x0 REAL, y0 REAL, x1 REAL, y1 REAL,
            polyline_json TEXT,
            min_width REAL,
            river_score REAL DEFAULT 0,
            PRIMARY KEY (page_num, gutter_id)
        );
        CREATE TABLE IF NOT EXISTS word_docks (
            word_id INTEGER PRIMARY KEY REFERENCES words(id),
            dock_above INTEGER,
            dock_below INTEGER,
            dock_left INTEGER,
            dock_right INTEGER,
            breathing_top REAL,
            breathing_bottom REAL,
            breathing_left REAL,
            breathing_right REAL,
            slack_direction TEXT,
            ports_json TEXT
        );
        CREATE TABLE IF NOT EXISTS page_graph (
            page_num INTEGER NOT NULL,
            node_id INTEGER NOT NULL,
            x REAL, y REAL,
            kind TEXT,
            edges_json TEXT,
            PRIMARY KEY (page_num, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_graph_page ON page_graph(page_num);
    """)
    db.commit()


# === data types ===============================================================

@dataclass
class Gutter:
    gutter_id: int
    kind: str                       # 'h_line' or 'v_slit'
    line_idx_a: int | None
    line_idx_b: int | None
    x0: float
    y0: float
    x1: float
    y1: float
    polyline: list[tuple[float, float]]
    min_width: float
    river_score: float = 0.0


@dataclass
class Dock:
    word_id: int
    dock_above: int | None = None
    dock_below: int | None = None
    dock_left: int | None = None
    dock_right: int | None = None
    breathing_top: float = 0.0
    breathing_bottom: float = 0.0
    breathing_left: float = 0.0
    breathing_right: float = 0.0
    slack_direction: str = ''
    # Each port: {x, y, gutter_id, compass, node_id}
    ports: list[dict] = field(default_factory=list)


# === page loading =============================================================

def load_page(db: sqlite3.Connection, page_num: int):
    """Return (words, body_bbox) or (None, None) if no data for this page."""
    rows = db.execute(
        "SELECT id, text, bbox_x0, bbox_y0, bbox_x1, bbox_y1, line_idx "
        "FROM words WHERE page_num=? "
        "ORDER BY line_idx, bbox_x0",
        (page_num,),
    ).fetchall()
    if not rows:
        return None, None
    cols = ['id', 'text', 'bbox_x0', 'bbox_y0', 'bbox_x1', 'bbox_y1', 'line_idx']
    words = [dict(zip(cols, r)) for r in rows]

    br = db.execute(
        "SELECT body_x0, body_y0, body_x1, body_y1 FROM page_corrections "
        "WHERE page_num=?",
        (page_num,),
    ).fetchone()
    if br and all(v is not None for v in br):
        body = dict(x0=br[0], y0=br[1], x1=br[2], y1=br[3])
    else:
        # Fallback: derive body from word extents.
        body = dict(
            x0=min(w['bbox_x0'] for w in words),
            y0=min(w['bbox_y0'] for w in words),
            x1=max(w['bbox_x1'] for w in words),
            y1=max(w['bbox_y1'] for w in words),
        )
    return words, body


def group_lines(words):
    """line_idx -> words (sorted by x0)."""
    lines: dict[int, list] = defaultdict(list)
    for w in words:
        lines[w['line_idx']].append(w)
    for lw in lines.values():
        lw.sort(key=lambda w: w['bbox_x0'])
    # Skip empty/degenerate lines (shouldn't occur but defensive).
    return {k: v for k, v in sorted(lines.items()) if v}


# === gutter / slit construction ==============================================

def build_horizontal_gutters(lines, body, start_id=0):
    """Gutters between consecutive lines + top/bottom body gutters."""
    out: list[Gutter] = []
    items = list(lines.items())
    gid = start_id

    def add(line_a, line_b, y_top, y_bot):
        nonlocal gid
        if y_bot <= y_top + 1:
            return
        cy = (y_top + y_bot) / 2
        out.append(Gutter(
            gutter_id=gid, kind='h_line',
            line_idx_a=line_a, line_idx_b=line_b,
            x0=body['x0'], y0=y_top, x1=body['x1'], y1=y_bot,
            polyline=[(body['x0'], cy), (body['x1'], cy)],
            min_width=y_bot - y_top,
        ))
        gid += 1

    if items:
        first_idx, first_words = items[0]
        add(None, first_idx, body['y0'], min(w['bbox_y0'] for w in first_words))

    for i in range(len(items) - 1):
        a_idx, a_words = items[i]
        b_idx, b_words = items[i + 1]
        add(a_idx, b_idx,
            max(w['bbox_y1'] for w in a_words),
            min(w['bbox_y0'] for w in b_words))

    if items:
        last_idx, last_words = items[-1]
        add(last_idx, None, max(w['bbox_y1'] for w in last_words), body['y1'])

    return out


def build_vertical_slits(lines, body, start_id):
    """Inter-word slits plus left-margin and right-margin slits per line."""
    out: list[Gutter] = []
    gid = start_id

    for line_idx, lw in lines.items():
        if not lw:
            continue
        y_top = min(w['bbox_y0'] for w in lw)
        y_bot = max(w['bbox_y1'] for w in lw)

        def add(x_left, x_right):
            nonlocal gid
            if x_right <= x_left + 1:
                return
            cx = (x_left + x_right) / 2
            out.append(Gutter(
                gutter_id=gid, kind='v_slit',
                line_idx_a=line_idx, line_idx_b=None,
                x0=x_left, y0=y_top, x1=x_right, y1=y_bot,
                polyline=[(cx, y_top), (cx, y_bot)],
                min_width=x_right - x_left,
            ))
            gid += 1

        first = lw[0]
        add(body['x0'], first['bbox_x0'])
        for i in range(len(lw) - 1):
            add(lw[i]['bbox_x1'], lw[i + 1]['bbox_x0'])
        last = lw[-1]
        add(last['bbox_x1'], body['x1'])

    return out


def score_printer_rivers(slits, words):
    """Mark vertical slits whose x-centers align across 3+ lines (printer's
    rivers). Score ∈ [0, 1] stored in place. Uses a tight pixel tolerance so
    only visually-stacked alignments are flagged, not every x-coincidence in
    justified text."""
    if not slits or not words:
        return
    tol = 4.0  # px — tight enough that only real vertical stacks count

    # For each slit, find all other slits within `tol` in x AND on a different
    # line — a mutual cluster. Score based on how many distinct lines the
    # cluster spans.
    xs = [(s.polyline[0][0], s) for s in slits]
    for ix, s in enumerate(xs):
        base_x, sl = s
        aligned_lines = {sl.line_idx_a}
        aligned_slits = [sl]
        for jx, t in enumerate(xs):
            if jx == ix:
                continue
            ox, ot = t
            if abs(ox - base_x) <= tol and ot.line_idx_a != sl.line_idx_a:
                aligned_lines.add(ot.line_idx_a)
                aligned_slits.append(ot)
        if len(aligned_lines) >= 3:
            score = min(1.0, (len(aligned_lines) - 2) / 4.0)  # 3 lines→0.25, 6+→1.0
            for a in aligned_slits:
                if score > a.river_score:
                    a.river_score = score


# === per-word docks ==========================================================

def breathing(word, words, body, direction):
    """Distance (px) from word edge to nearest obstacle (or body edge) along
    the word's perpendicular footprint in the given direction."""
    x0, y0, x1, y1 = word['bbox_x0'], word['bbox_y0'], word['bbox_x1'], word['bbox_y1']
    wid = word['id']
    if direction == 'top':
        d = y0 - body['y0']
        for w in words:
            if w['id'] == wid or w['bbox_x1'] < x0 or w['bbox_x0'] > x1:
                continue
            if w['bbox_y1'] <= y0:
                d = min(d, y0 - w['bbox_y1'])
    elif direction == 'bot':
        d = body['y1'] - y1
        for w in words:
            if w['id'] == wid or w['bbox_x1'] < x0 or w['bbox_x0'] > x1:
                continue
            if w['bbox_y0'] >= y1:
                d = min(d, w['bbox_y0'] - y1)
    elif direction == 'left':
        d = x0 - body['x0']
        for w in words:
            if w['id'] == wid or w['bbox_y1'] < y0 or w['bbox_y0'] > y1:
                continue
            if w['bbox_x1'] <= x0:
                d = min(d, x0 - w['bbox_x1'])
    else:  # right
        d = body['x1'] - x1
        for w in words:
            if w['id'] == wid or w['bbox_y1'] < y0 or w['bbox_y0'] > y1:
                continue
            if w['bbox_x0'] >= x1:
                d = min(d, w['bbox_x0'] - x1)
    return max(0.0, d)


def slack_direction(b_top, b_bot, b_left, b_right):
    arr = [('N', b_top), ('S', b_bot), ('W', b_left), ('E', b_right)]
    arr.sort(key=lambda t: -t[1])
    if arr[0][1] <= 0:
        return ''
    if len(arr) > 1 and arr[1][1] > 0 and arr[0][1] < 1.3 * arr[1][1]:
        return ''
    return arr[0][0]


def compute_docks(words, body, h_gutters, v_slits):
    """Per-word: breathing, dock gutter ids, ports, slack direction."""
    h_by_b = {g.line_idx_b: g for g in h_gutters if g.line_idx_b is not None}
    h_by_a = {g.line_idx_a: g for g in h_gutters if g.line_idx_a is not None}
    slits_by_line: dict[int, list[Gutter]] = defaultdict(list)
    for s in v_slits:
        slits_by_line[s.line_idx_a].append(s)

    docks: list[Dock] = []
    for w in words:
        x0, y0, x1, y1 = w['bbox_x0'], w['bbox_y0'], w['bbox_x1'], w['bbox_y1']
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        L = w['line_idx']

        bt = breathing(w, words, body, 'top')
        bb = breathing(w, words, body, 'bot')
        bl = breathing(w, words, body, 'left')
        br = breathing(w, words, body, 'right')

        d = Dock(word_id=w['id'],
                 breathing_top=bt, breathing_bottom=bb,
                 breathing_left=bl, breathing_right=br,
                 slack_direction=slack_direction(bt, bb, bl, br))

        g_above = h_by_b.get(L)
        g_below = h_by_a.get(L)
        d.dock_above = g_above.gutter_id if g_above else None
        d.dock_below = g_below.gutter_id if g_below else None

        left_slit = right_slit = None
        left_dx = right_dx = float('inf')
        for s in slits_by_line.get(L, []):
            if s.x1 <= x0 and (x0 - s.x1) < left_dx:
                left_slit, left_dx = s, x0 - s.x1
            if s.x0 >= x1 and (s.x0 - x1) < right_dx:
                right_slit, right_dx = s, s.x0 - x1
        d.dock_left = left_slit.gutter_id if left_slit else None
        d.dock_right = right_slit.gutter_id if right_slit else None

        # Ports placed half-breathing away, capped at 15 px, only if dock exists.
        def port(compass, gid, px, py):
            if gid is None:
                return
            d.ports.append({'x': px, 'y': py, 'gutter_id': gid, 'compass': compass})

        port('N', d.dock_above, cx, y0 - min(bt * 0.5, 15))
        port('S', d.dock_below, cx, y1 + min(bb * 0.5, 15))
        port('W', d.dock_left, x0 - min(bl * 0.5, 15), cy)
        port('E', d.dock_right, x1 + min(br * 0.5, 15), cy)

        docks.append(d)
    return docks


# === graph assembly ==========================================================

def build_graph(h_gutters, v_slits, docks):
    """Returns (nodes, adjacency). Fills node_ids into each dock's ports."""
    nodes: list[dict] = []         # {x, y, kind}
    adj: dict[int, list] = defaultdict(list)  # nid -> [(nid, cost, gutter_id), ...]

    def add_node(x, y, kind):
        nid = len(nodes)
        nodes.append({'x': float(x), 'y': float(y), 'kind': kind})
        return nid

    gutter_nodes: dict[int, list[tuple[float, int]]] = defaultdict(list)
    slit_nodes: dict[int, list[tuple[float, int]]] = defaultdict(list)

    # 1. Gutter endpoints.
    for g in h_gutters:
        cy = g.polyline[0][1]
        nl = add_node(g.x0, cy, 'gutter_end')
        nr = add_node(g.x1, cy, 'gutter_end')
        gutter_nodes[g.gutter_id] = [(g.x0, nl), (g.x1, nr)]

    # 2. Slit intersection nodes (at the bordering gutters' centerline heights).
    h_by_b = {g.line_idx_b: g for g in h_gutters if g.line_idx_b is not None}
    h_by_a = {g.line_idx_a: g for g in h_gutters if g.line_idx_a is not None}

    for s in v_slits:
        L = s.line_idx_a
        slit_x = s.polyline[0][0]
        g_above = h_by_b.get(L)
        g_below = h_by_a.get(L)

        if g_above:
            top_y = g_above.polyline[0][1]
            nid = add_node(slit_x, top_y, 'intersection')
            gutter_nodes[g_above.gutter_id].append((slit_x, nid))
            slit_nodes[s.gutter_id].append((top_y, nid))
        else:
            nid = add_node(slit_x, s.y0, 'slit_end')
            slit_nodes[s.gutter_id].append((s.y0, nid))

        if g_below:
            bot_y = g_below.polyline[0][1]
            nid = add_node(slit_x, bot_y, 'intersection')
            gutter_nodes[g_below.gutter_id].append((slit_x, nid))
            slit_nodes[s.gutter_id].append((bot_y, nid))
        else:
            nid = add_node(slit_x, s.y1, 'slit_end')
            slit_nodes[s.gutter_id].append((s.y1, nid))

    # 3. Port injection. Each port gets its own node; we add an inject node on
    # its dock and link the two with a short edge. Inject nodes land on the
    # existing gutter/slit centerline so chain-linking in step 4/5 pulls them
    # into the main network.
    h_by_id = {g.gutter_id: g for g in h_gutters}
    s_by_id = {g.gutter_id: g for g in v_slits}

    for d in docks:
        for p in d.ports:
            gid = p['gutter_id']
            compass = p['compass']
            port_id = add_node(p['x'], p['y'], 'port')
            if compass in ('N', 'S'):
                g = h_by_id.get(gid)
                if not g:
                    p['node_id'] = port_id
                    continue
                cy = g.polyline[0][1]
                inj = add_node(p['x'], cy, 'inject')
                gutter_nodes[gid].append((p['x'], inj))
            else:
                g = s_by_id.get(gid)
                if not g:
                    p['node_id'] = port_id
                    continue
                cx = g.polyline[0][0]
                inj = add_node(cx, p['y'], 'inject')
                slit_nodes[gid].append((p['y'], inj))
            dist = ((nodes[inj]['x'] - p['x']) ** 2 + (nodes[inj]['y'] - p['y']) ** 2) ** 0.5
            adj[port_id].append((inj, float(dist), gid))
            adj[inj].append((port_id, float(dist), gid))
            p['node_id'] = port_id

    # 4. Chain-link each horizontal gutter (sorted by x, dedup within 1 px).
    for g in h_gutters:
        chain = sorted(gutter_nodes[g.gutter_id], key=lambda t: t[0])
        chain = _dedup_chain(chain, nodes, adj, g.gutter_id)
        mult = 1.0 - 0.4 * g.river_score
        for (xa, a), (xb, b) in zip(chain, chain[1:]):
            if a == b:
                continue
            cost = max(0.5, abs(xb - xa) * mult)
            adj[a].append((b, cost, g.gutter_id))
            adj[b].append((a, cost, g.gutter_id))

    # 5. Chain-link each slit.
    for s in v_slits:
        chain = sorted(slit_nodes[s.gutter_id], key=lambda t: t[0])
        chain = _dedup_chain(chain, nodes, adj, s.gutter_id)
        narrow = max(1.0, 8.0 / max(1.0, s.min_width))
        mult = narrow * (1.0 - 0.4 * s.river_score)
        for (ya, a), (yb, b) in zip(chain, chain[1:]):
            if a == b:
                continue
            cost = max(0.5, abs(yb - ya) * mult)
            adj[a].append((b, cost, s.gutter_id))
            adj[b].append((a, cost, s.gutter_id))

    return nodes, adj


def _dedup_chain(chain, nodes, adj, gutter_id, tol=1.0):
    """Merge chain entries within `tol` along the axis by redirecting later
    ids to the first (zero-length edge introduces no cost)."""
    if not chain:
        return chain
    out = [chain[0]]
    for coord, nid in chain[1:]:
        pcoord, pnid = out[-1]
        if abs(coord - pcoord) <= tol:
            adj[pnid].append((nid, 0.0, gutter_id))
            adj[nid].append((pnid, 0.0, gutter_id))
        out.append((coord, nid))
    return out


# === persistence ==============================================================

def persist(db, page_num, gutters, docks, nodes, adj):
    db.execute("DELETE FROM page_gutters WHERE page_num=?", (page_num,))
    db.execute("DELETE FROM page_graph WHERE page_num=?", (page_num,))
    db.execute(
        "DELETE FROM word_docks WHERE word_id IN "
        "(SELECT id FROM words WHERE page_num=?)",
        (page_num,),
    )

    db.executemany(
        "INSERT INTO page_gutters "
        "(page_num, gutter_id, kind, line_idx_a, line_idx_b, "
        " x0, y0, x1, y1, polyline_json, min_width, river_score) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(page_num, g.gutter_id, g.kind, g.line_idx_a, g.line_idx_b,
          g.x0, g.y0, g.x1, g.y1, json.dumps(g.polyline),
          g.min_width, g.river_score) for g in gutters],
    )

    db.executemany(
        "INSERT INTO word_docks "
        "(word_id, dock_above, dock_below, dock_left, dock_right, "
        " breathing_top, breathing_bottom, breathing_left, breathing_right, "
        " slack_direction, ports_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(d.word_id, d.dock_above, d.dock_below, d.dock_left, d.dock_right,
          d.breathing_top, d.breathing_bottom, d.breathing_left, d.breathing_right,
          d.slack_direction, json.dumps(d.ports)) for d in docks],
    )

    rows = []
    for nid, n in enumerate(nodes):
        rows.append((page_num, nid, n['x'], n['y'], n['kind'],
                     json.dumps(adj.get(nid, []))))
    db.executemany(
        "INSERT INTO page_graph (page_num, node_id, x, y, kind, edges_json) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    db.commit()


# === orchestration ===========================================================

def process_page(db, page_num):
    words, body = load_page(db, page_num)
    if not words:
        return None

    lines = group_lines(words)
    if not lines:
        return None

    h_gutters = build_horizontal_gutters(lines, body, start_id=0)
    v_slits = build_vertical_slits(lines, body, start_id=len(h_gutters))
    score_printer_rivers(v_slits, words)

    all_gutters = h_gutters + v_slits
    docks = compute_docks(words, body, h_gutters, v_slits)
    nodes, adj = build_graph(h_gutters, v_slits, docks)

    persist(db, page_num, all_gutters, docks, nodes, adj)
    return {
        'n_h_gutters': len(h_gutters),
        'n_v_slits': len(v_slits),
        'n_docks': len(docks),
        'n_nodes': len(nodes),
        'n_edges': sum(len(v) for v in adj.values()) // 2,
        'n_printer_rivers': sum(1 for s in v_slits if s.river_score > 0),
    }


def main():
    ap = argparse.ArgumentParser(description="Stage 2c: whitespace navigation graph")
    ap.add_argument("--pages", help="e.g. '15' or '1,3,5-10'. Default: all pages.")
    a = ap.parse_args()

    db = sqlite3.connect(DB_PATH)
    init_db(db)

    if a.pages:
        total = db.execute("SELECT MAX(page_num) FROM pages").fetchone()[0] or 0
        page_nums = parse_pages(a.pages, total)
    else:
        page_nums = [r[0] for r in db.execute(
            "SELECT page_num FROM pages ORDER BY page_num",
        ).fetchall()]

    print(f"pages: {len(page_nums)}")
    skipped = 0
    for p in page_nums:
        info = process_page(db, p)
        if info is None:
            skipped += 1
            print(f"  p{p:4d}: [skip]")
        else:
            print(f"  p{p:4d}: gutters h={info['n_h_gutters']} v={info['n_v_slits']}  "
                  f"docks={info['n_docks']}  nodes={info['n_nodes']}  "
                  f"edges={info['n_edges']}  rivers={info['n_printer_rivers']}")
    print(f"\n  {len(page_nums) - skipped} pages processed, {skipped} skipped")
    db.close()


if __name__ == "__main__":
    main()
