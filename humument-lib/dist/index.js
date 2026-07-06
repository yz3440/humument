// src/data.ts
var CDN_DATA_BASE = "https://cdn.jsdelivr.net/npm/humument-data@0.1/db";
var CDN_IMAGE_BASE = "https://cdn.jsdelivr.net/npm/humument-images@0.1/pages";
var cfg = { dataBase: CDN_DATA_BASE, imageBase: CDN_IMAGE_BASE };
var catalogP = null;
var searchP = null;
var pageCache = /* @__PURE__ */ new Map();
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.json();
}
async function fetchPageJSON(base) {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const r = await fetch(`${base}.json.gz`);
      if (r.ok && r.body) {
        const gunzip = r.body.pipeThrough(new DecompressionStream("gzip"));
        return await new Response(gunzip).json();
      }
    } catch {
    }
  }
  return fetchJSON(`${base}.json`);
}
async function init(opts = {}) {
  cfg = {
    dataBase: (opts.dataBase ?? cfg.dataBase).replace(/\/$/, ""),
    imageBase: (opts.imageBase ?? cfg.imageBase).replace(/\/$/, "")
  };
  catalogP = null;
  searchP = null;
  pageCache.clear();
  await getCatalog();
}
function config() {
  return cfg;
}
function getCatalog() {
  return catalogP ??= fetchJSON(`${cfg.dataBase}/catalog.json`);
}
function getSearchIndex() {
  return searchP ??= fetchJSON(`${cfg.dataBase}/search-index.json`);
}
function getPageRaw(pageNum) {
  let p2 = pageCache.get(pageNum);
  if (!p2) {
    const base = `${cfg.dataBase}/pages/p${String(pageNum).padStart(4, "0")}`;
    p2 = fetchPageJSON(base);
    pageCache.set(pageNum, p2);
  }
  return p2;
}

// src/words.ts
async function getPageData(pageNum) {
  const j = await getPageRaw(pageNum);
  const docks = /* @__PURE__ */ new Map();
  for (const d of j.docks) docks.set(d.wordId, d);
  const nodes = /* @__PURE__ */ new Map();
  for (const [id, x, y, edges] of j.graph) {
    nodes.set(id, { id, x, y, kind: "", edges });
  }
  return { meta: j.meta, words: j.words, gutters: j.gutters, docks, graph: { nodes } };
}
async function getWords(pageNum) {
  return (await getPageData(pageNum)).words;
}
async function listPages(_contentOnly = true) {
  return (await getCatalog()).pages;
}
async function listAllPageRefs() {
  return (await getCatalog()).pages.map((pageNum) => ({ pageNum }));
}
async function listChapters() {
  return (await getCatalog()).chapters.map((c) => ({ ...c }));
}
async function searchPages(query, opts = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 50;
  const index = await getSearchIndex();
  const hitsByPage = /* @__PURE__ */ new Map();
  for (const token in index) {
    if (!token.includes(q)) continue;
    for (const [page, count] of index[token]) {
      hitsByPage.set(page, (hitsByPage.get(page) ?? 0) + count);
    }
  }
  const ranked = [...hitsByPage.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit);
  if (!ranked.length) return [];
  return Promise.all(ranked.map(async ([pageNum, hits]) => {
    let snippet = "";
    try {
      const { words } = await getPageData(pageNum);
      const i = words.findIndex((w) => w.text.toLowerCase().includes(q));
      if (i >= 0) {
        const line = words.filter((w) => w.lineIdx === words[i].lineIdx);
        const at = line.indexOf(words[i]);
        const start = Math.max(0, at - 3);
        const end = Math.min(line.length, at + 4);
        snippet = (start > 0 ? "\u2026 " : "") + line.slice(start, end).map((w) => w.text).join(" ") + (end < line.length ? " \u2026" : "");
      }
    } catch {
    }
    return { pageNum, hits, snippet };
  }));
}
function groupByLine(words) {
  const out = [];
  let cur = [];
  let curLine = -1;
  for (const w of words) {
    if (w.lineIdx !== curLine) {
      if (cur.length) out.push(cur);
      cur = [w];
      curLine = w.lineIdx;
    } else {
      cur.push(w);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function bboxOf(words) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const w of words) {
    any = true;
    if (w.x0 < x0) x0 = w.x0;
    if (w.y0 < y0) y0 = w.y0;
    if (w.x1 > x1) x1 = w.x1;
    if (w.y1 > y1) y1 = w.y1;
  }
  if (!any) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}
function pageImageUrl(pageNum) {
  return `${config().imageBase}/p${String(pageNum).padStart(4, "0")}.jpg`;
}

// src/noise.ts
function makeNoise(seed) {
  const mul = 73244475;
  return (x) => {
    const xi = Math.floor(x);
    const xf = x - xi;
    const h = (i) => {
      let n = (i ^ seed) * mul >>> 0;
      n = (n ^ n >>> 16) * mul >>> 0;
      n = (n ^ n >>> 16) >>> 0;
      return (n & 65535) / 65535;
    };
    const a = h(xi);
    const b = h(xi + 1);
    const t = xf * xf * (3 - 2 * xf);
    return (a * (1 - t) + b * t) * 2 - 1;
  };
}
function makeNoise2D(seed) {
  const hash = (i, j) => {
    let n = ((i | 0) * 374761393 + (j | 0) * 668265263 + seed) * 1274126177 >>> 0;
    n = (n ^ n >>> 13) * 1274126177 >>> 0;
    n = (n ^ n >>> 16) >>> 0;
    return (n & 16777215) / 16777215 * 2 - 1;
  };
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = t + 1831565813 >>> 0;
    let r = t;
    r = Math.imul(r ^ r >>> 15, r | 1);
    r ^= r + Math.imul(r ^ r >>> 7, r | 61);
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}

// src/chunks.ts
var PLOT_NAME_BLOCKLIST = /* @__PURE__ */ new Set(["grenville"]);
var BANNED_CLICHES = /* @__PURE__ */ new Set([
  "heart",
  "soul",
  "love",
  "dream",
  "hope",
  "darkness",
  "light",
  "shadow"
]);
function detectHeaderLines(words) {
  const lineWords = /* @__PURE__ */ new Map();
  for (const w of words) {
    if (!lineWords.has(w.lineIdx)) lineWords.set(w.lineIdx, []);
    lineWords.get(w.lineIdx).push(w);
  }
  const out = /* @__PURE__ */ new Set();
  for (const [lineIdx, ws] of lineWords) {
    if (lineIdx > 1) continue;
    const allUpper = ws.every((w) => w.text === w.text.toUpperCase());
    const text = ws.map((w) => w.text).join(" ");
    if (allUpper && text.includes("HUMAN DOCUMENT")) out.add(lineIdx);
  }
  return out;
}
function isHeaderOrPagenum(w) {
  return /^\d+$/.test(w.text) && w.lineIdx <= 1;
}
function passesCandidacy(w, headerLines) {
  const lower = w.text.toLowerCase();
  if (PLOT_NAME_BLOCKLIST.has(lower)) return false;
  if (w.conf < 0.7) return false;
  if (w.text.length === 1 && !["I", "a", "O"].includes(w.text)) return false;
  if (isHeaderOrPagenum(w)) return false;
  if (headerLines.has(w.lineIdx)) return false;
  return true;
}
function tag(w) {
  const p2 = w.pos ?? "";
  switch (p2) {
    case "ADP":
    case "DET":
    case "PRON":
    case "ADJ":
    case "ADV":
    case "NUM":
    case "NOUN":
    case "PROPN":
    case "VERB":
    case "AUX":
    case "PART":
    case "CCONJ":
    case "SCONJ":
      return p2;
    default:
      return "OTHER";
  }
}
var isHead = (t) => t === "NOUN" || t === "PROPN";
var isMod = (t) => t === "ADJ" || t === "NUM" || t === "ADV";
var isDet = (t) => t === "DET" || t === "PRON";
function adjacent(a, b) {
  return Math.abs(b.lineIdx - a.lineIdx) <= 1;
}
function tryMatchNP(run, start, maxLen) {
  let i = start;
  if (i < run.length && tag(run[i]) === "ADP") i++;
  if (i < run.length && (isDet(tag(run[i])) || tag(run[i]) === "VERB")) i++;
  while (i < run.length && isMod(tag(run[i]))) i++;
  let hadHead = false;
  while (i < run.length && isHead(tag(run[i]))) {
    hadHead = true;
    i++;
  }
  if (!hadHead) return start;
  if (i - start > maxLen) return start + maxLen;
  return i;
}
function tryMatchVP(run, start, maxLen) {
  let i = start;
  while (i < run.length && tag(run[i]) === "ADV") i++;
  if (i >= run.length || tag(run[i]) !== "VERB" && tag(run[i]) !== "AUX") return start;
  i++;
  while (i < run.length && (isMod(tag(run[i])) || tag(run[i]) === "AUX" || tag(run[i]) === "PART")) i++;
  if (i === start) return start;
  if (i - start > maxLen) return start + maxLen;
  return i;
}
function chunks(words, opts = {}) {
  const maxLen = opts.maxLen ?? 4;
  const candidates = opts.candidates ?? defaultCandidates(words);
  const sorted = candidates.slice().sort((a, b) => a.lineIdx - b.lineIdx || a.x0 - b.x0);
  const runs = [];
  let cur = [];
  for (const w of sorted) {
    if (!cur.length || adjacent(cur[cur.length - 1], w)) {
      cur.push(w);
    } else {
      if (cur.length) runs.push(cur);
      cur = [w];
    }
  }
  if (cur.length) runs.push(cur);
  const out = [];
  for (const run of runs) {
    let i = 0;
    while (i < run.length) {
      const npEnd = tryMatchNP(run, i, maxLen);
      const vpEnd = tryMatchVP(run, i, maxLen);
      const end = Math.max(npEnd, vpEnd);
      if (end > i) {
        out.push(run.slice(i, end));
        i = end;
      } else {
        i++;
      }
    }
  }
  return out;
}
function defaultCandidates(words) {
  const headers = detectHeaderLines(words);
  return words.filter((w) => passesCandidacy(w, headers));
}
function chunkScore(chunk) {
  let s = 0;
  let hasContent = false;
  for (const w of chunk) {
    s += (w.rarity ?? 0) * 1;
    if (w.isContent) {
      s += 0.4;
      hasContent = true;
    }
    if (BANNED_CLICHES.has(w.text.toLowerCase())) s -= 0.4;
  }
  if (!hasContent) return -999;
  const len = chunk.length;
  if (len === 1) s += 0;
  else if (len === 2) s += 0.7;
  else if (len === 3) s += 0.6;
  else if (len === 4) s += 0.2;
  else s -= 0.4;
  const last = chunk[chunk.length - 1];
  if (last.pos === "NOUN" || last.pos === "PROPN") s += 0.4;
  return s;
}
function selectChunks(words, opts = {}) {
  const all = chunks(words, opts);
  if (!all.length) return [];
  const nSeeds = opts.nSeeds ?? 3;
  const minDist = opts.minLineDist ?? 2;
  const variation = opts.variation ?? 0;
  const rng = mulberry32((opts.seed ?? 42) * 1e3);
  const scored = all.map((c) => ({ c, s: chunkScore(c) })).filter((x) => x.s > -100).sort((a, b) => b.s - a.s);
  let pool;
  if (variation === 0) pool = scored;
  else if (variation === 1) {
    pool = scored.slice(0, Math.max(nSeeds * 4, 12));
    shuffle(pool, rng);
  } else {
    pool = scored.slice(0, Math.max(nSeeds * 6, 18));
    shuffle(pool, rng);
  }
  const picked = [];
  for (const { c } of pool) {
    if (picked.every((p2) => Math.abs(c[0].lineIdx - p2[0].lineIdx) >= minDist)) {
      picked.push(c);
      if (picked.length >= nSeeds) break;
    }
  }
  picked.sort((a, b) => a[0].lineIdx - b[0].lineIdx || a[0].x0 - b[0].x0);
  return picked;
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// src/geometry.ts
function balloonPath(bbox, opts = {}) {
  const pad = opts.pad ?? 6;
  const wobble = opts.wobble ?? 0.12;
  const wobbleFreq = opts.wobbleFreq ?? 0.45;
  const samples = opts.samples ?? 32;
  const seed = opts.seed ?? 0;
  const noise = makeNoise(seed);
  const cx = (bbox.x0 + bbox.x1) / 2;
  const cy = (bbox.y0 + bbox.y1) / 2;
  const rxBase = (bbox.x1 - bbox.x0) / 2 + pad;
  const ryBase = (bbox.y1 - bbox.y0) / 2 + pad;
  const out = [];
  for (let i = 0; i < samples; i++) {
    const t = i / samples * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const n = noise(i * wobbleFreq);
    const n2 = noise(i * wobbleFreq * 2.3 + 100) * 0.5;
    const mod = 1 + (n + n2) * wobble;
    out.push({ x: cx + ct * rxBase * mod, y: cy + st * ryBase * mod });
  }
  return out;
}
function channelPath(seg, opts = {}) {
  const halfWidth = opts.halfWidth ?? 4;
  const jitter = opts.jitter ?? 1.4;
  const jitterFreq = opts.jitterFreq ?? 0.09;
  const meander = opts.meander ?? 0.55;
  const meanderFreq = opts.meanderFreq ?? 0.018;
  const widthMod = opts.widthMod ?? 0.4;
  const widthModFreq = opts.widthModFreq ?? 0.035;
  const sampleStep = opts.sampleStep ?? 1.6;
  const seed = opts.seed ?? 0;
  const gutterById = opts.gutterById;
  const noise = makeNoise(seed);
  const dense = sampleCatmullRomWithGutter(seg.points, seg.gutterIds, sampleStep);
  if (dense.length < 2) return [];
  const top = [];
  const bot = [];
  for (let i = 0; i < dense.length; i++) {
    const q = dense[i].p;
    const gid = dense[i].gid;
    const g = gutterById?.get(gid);
    const gutterHalf = g ? Math.max(1, g.minWidth / 2) : 6;
    const prev = dense[Math.max(0, i - 1)].p;
    const next = dense[Math.min(dense.length - 1, i + 1)].p;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const wobble = noise(i * jitterFreq) * jitter;
    const meanderMax = Math.max(0, gutterHalf - halfWidth - 0.5);
    const meanderOff = noise(i * meanderFreq + 50) * meander * meanderMax;
    const widthN = noise(i * widthModFreq + 200);
    const hwFrac = 1 + widthN * widthMod;
    const hw = Math.min(gutterHalf - 0.3, Math.max(0.6, halfWidth * hwFrac));
    const cx = q.x + nx * (wobble + meanderOff);
    const cy = q.y + ny * (wobble + meanderOff);
    top.push({ x: cx + nx * hw, y: cy + ny * hw });
    bot.push({ x: cx - nx * hw, y: cy - ny * hw });
  }
  return [...top, ...bot.reverse()];
}
function sampleCatmullRomWithGutter(pts, gutterIds, step) {
  if (pts.length < 2) return pts.map((p2) => ({ p: p2, gid: gutterIds[0] ?? -1 }));
  if (pts.length === 2) {
    const gid = gutterIds[0] ?? -1;
    const out2 = [];
    const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const n = Math.max(2, Math.ceil(d / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out2.push({
        p: { x: pts[0].x + (pts[1].x - pts[0].x) * t, y: pts[0].y + (pts[1].y - pts[0].y) * t },
        gid
      });
    }
    return out2;
  }
  const padded = [
    { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y },
    ...pts,
    {
      x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x,
      y: 2 * pts[pts.length - 1].y - pts[pts.length - 2].y
    }
  ];
  const out = [];
  for (let i = 1; i < padded.length - 2; i++) {
    const segIdx = i - 1;
    const gid = gutterIds[segIdx] ?? gutterIds[gutterIds.length - 1] ?? -1;
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const nSteps = Math.max(2, Math.ceil(segLen / step));
    for (let k = 0; k < nSteps; k++) {
      const t = k / nSteps;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ p: { x, y }, gid });
    }
  }
  out.push({ p: pts[pts.length - 1], gid: gutterIds[gutterIds.length - 1] ?? -1 });
  return out;
}
function catmullRom(points, tension = 0.5, samplesPerSegment = 12) {
  if (points.length < 3) return points.slice();
  const padded = [
    { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y },
    ...points,
    {
      x: 2 * points[points.length - 1].x - points[points.length - 2].x,
      y: 2 * points[points.length - 1].y - points[points.length - 2].y
    }
  ];
  const out = [points[0]];
  for (let i = 1; i < padded.length - 2; i++) {
    const p0 = padded[i - 1];
    const p1 = padded[i];
    const p2 = padded[i + 1];
    const p3 = padded[i + 2];
    for (let k = 1; k <= samplesPerSegment; k++) {
      const t = k / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t * tension + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t * tension + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y });
    }
  }
  return out;
}

// src/rivers.ts
function compassVec(c) {
  switch (c) {
    case "N":
      return { x: 0, y: -1 };
    case "S":
      return { x: 0, y: 1 };
    case "E":
      return { x: 1, y: 0 };
    case "W":
      return { x: -1, y: 0 };
  }
}
function bboxCenter(b) {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}
function pickPorts(a, b, wA, wB) {
  if (!a.ports.length || !b.ports.length) return null;
  const ca = bboxCenter(wA);
  const cb = bboxCenter(wB);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  let best = null;
  let bestScore = Infinity;
  for (const pa of a.ports) {
    for (const pb of b.ports) {
      const aDir = compassVec(pa.compass);
      const bDir = compassVec(pb.compass);
      const forward = dx * aDir.x + dy * aDir.y;
      const backward = -dx * bDir.x + -dy * bDir.y;
      const dd = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const score = dd - 0.5 * forward - 0.5 * backward;
      if (score < bestScore) {
        bestScore = score;
        best = [pa, pb];
      }
    }
  }
  return best;
}
var MinHeap = class {
  a = [];
  size() {
    return this.a.length;
  }
  push(e) {
    this.a.push(e);
    let i = this.a.length - 1;
    while (i > 0) {
      const p2 = i - 1 >> 1;
      if (this.a[p2].cost <= this.a[i].cost) break;
      [this.a[p2], this.a[i]] = [this.a[i], this.a[p2]];
      i = p2;
    }
  }
  pop() {
    if (!this.a.length) return void 0;
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      const n = this.a.length;
      for (; ; ) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.a[l].cost < this.a[smallest].cost) smallest = l;
        if (r < n && this.a[r].cost < this.a[smallest].cost) smallest = r;
        if (smallest === i) break;
        [this.a[smallest], this.a[i]] = [this.a[i], this.a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
};
function dijkstra(graph, start, end) {
  if (start === end) return { nodeIds: [start], gutterIds: [] };
  const dist = /* @__PURE__ */ new Map();
  const prev = /* @__PURE__ */ new Map();
  const prevGutter = /* @__PURE__ */ new Map();
  dist.set(start, 0);
  const heap = new MinHeap();
  heap.push({ cost: 0, id: start });
  while (heap.size()) {
    const cur2 = heap.pop();
    if (cur2.id === end) break;
    if (cur2.cost > (dist.get(cur2.id) ?? Infinity)) continue;
    const node = graph.nodes.get(cur2.id);
    if (!node) continue;
    for (const [nb, cost, gid] of node.edges) {
      const nd = cur2.cost + cost;
      if (nd < (dist.get(nb) ?? Infinity)) {
        dist.set(nb, nd);
        prev.set(nb, cur2.id);
        prevGutter.set(nb, gid);
        heap.push({ cost: nd, id: nb });
      }
    }
  }
  if (!dist.has(end)) return { nodeIds: [], gutterIds: [] };
  const nodeIds = [];
  const gutterIds = [];
  let cur = end;
  while (cur !== void 0) {
    nodeIds.push(cur);
    const g = prevGutter.get(cur);
    if (g !== void 0) gutterIds.push(g);
    cur = prev.get(cur);
  }
  nodeIds.reverse();
  gutterIds.reverse();
  return { nodeIds, gutterIds };
}
function penalizeBorders(graph, body, margin = 30, penalty = 30) {
  const out = /* @__PURE__ */ new Map();
  graph.nodes.forEach((node, id) => {
    const modEdges = node.edges.map(([neigh, cost, gid]) => {
      const n2 = graph.nodes.get(neigh);
      if (!n2) return [neigh, cost, gid];
      const nearTop = node.y <= body.y0 + margin && n2.y <= body.y0 + margin;
      const nearBot = node.y >= body.y1 - margin && n2.y >= body.y1 - margin;
      const nearLft = node.x <= body.x0 + margin && n2.x <= body.x0 + margin;
      const nearRgt = node.x >= body.x1 - margin && n2.x >= body.x1 - margin;
      if (nearTop || nearBot || nearLft || nearRgt) return [neigh, cost * penalty, gid];
      return [neigh, cost, gid];
    });
    out.set(id, { ...node, edges: modEdges });
  });
  return { nodes: out };
}
function between(wordA, wordB, graph, docks) {
  const da = docks.get(wordA.id);
  const db = docks.get(wordB.id);
  if (!da || !db) return null;
  const picked = pickPorts(da, db, wordA, wordB);
  if (!picked) return null;
  const [pa, pb] = picked;
  const { nodeIds, gutterIds } = dijkstra(graph, pa.nodeId, pb.nodeId);
  if (nodeIds.length < 2) return null;
  const pts = nodeIds.map((nid) => graph.nodes.get(nid)).filter((n) => !!n).map((n) => ({ x: n.x, y: n.y }));
  return { points: pts, gutterIds };
}
function insideRect(x, y, r) {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}
function flow(start, end, opts) {
  const seed = opts.seed ?? 0;
  const stepSize = opts.stepSize ?? 2.5;
  const maxSteps = opts.maxSteps ?? 600;
  const noiseFreq = opts.noiseFreq ?? 7e-3;
  const targetWeight = opts.targetWeight ?? 0.45;
  const candidateCount = opts.candidateCount ?? 24;
  const obstacles = opts.obstacles ?? [];
  const noise2 = makeNoise2D(seed);
  const pts = [{ ...start }];
  let p2 = { ...start };
  const startDist = Math.hypot(end.x - start.x, end.y - start.y);
  let bestDistSeen = startDist;
  let stallCount = 0;
  for (let iter = 0; iter < maxSteps; iter++) {
    const dxe = end.x - p2.x;
    const dye = end.y - p2.y;
    const dist = Math.hypot(dxe, dye);
    if (dist < stepSize * 1.5) break;
    const toTX = dxe / dist;
    const toTY = dye / dist;
    if (dist < bestDistSeen - 1) {
      bestDistSeen = dist;
      stallCount = 0;
    } else {
      stallCount++;
    }
    const stallBoost = Math.min(3, stallCount / 15);
    let bestTheta = Math.atan2(dye, dxe);
    let bestScore = Infinity;
    let foundValid = false;
    for (let k = 0; k < candidateCount; k++) {
      const theta = k / candidateCount * 2 * Math.PI;
      const cx = Math.cos(theta);
      const cy = Math.sin(theta);
      const nx = p2.x + stepSize * cx;
      const ny = p2.y + stepSize * cy;
      if (nx < opts.body.x0 || nx > opts.body.x1 || ny < opts.body.y0 || ny > opts.body.y1) continue;
      let blocked = false;
      for (const r of obstacles) {
        if (insideRect(nx, ny, r)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const nval = noise2(nx * noiseFreq, ny * noiseFreq);
      const towardTarget = 1 - (cx * toTX + cy * toTY);
      const effectiveTW = targetWeight * (1 + stallBoost);
      const score = nval * 0.7 + towardTarget * effectiveTW;
      if (score < bestScore) {
        bestScore = score;
        bestTheta = theta;
        foundValid = true;
      }
    }
    if (!foundValid) break;
    p2 = {
      x: p2.x + stepSize * Math.cos(bestTheta),
      y: p2.y + stepSize * Math.sin(bestTheta)
    };
    pts.push({ ...p2 });
  }
  pts.push({ ...end });
  return pts;
}
function obstaclesFrom(words, selectedIds, pad = 1) {
  const sel = new Set(selectedIds);
  return words.filter((w) => !sel.has(w.id)).map((w) => ({ x0: w.x0 - pad, y0: w.y0 - pad, x1: w.x1 + pad, y1: w.y1 + pad }));
}

// src/draw.ts
function p(g) {
  if (g) return g;
  if (typeof window !== "undefined") return window;
  throw new Error("No p5 instance provided and no window global available");
}
function drawBalloon(words, opts = {}, pInst) {
  if (!words.length) return;
  const g = p(pInst);
  const pts = balloonPath(bboxOf(words), opts);
  g.beginShape();
  g.curveVertex(pts[pts.length - 1].x, pts[pts.length - 1].y);
  for (const pt of pts) g.curveVertex(pt.x, pt.y);
  g.curveVertex(pts[0].x, pts[0].y);
  g.curveVertex(pts[1].x, pts[1].y);
  g.endShape(g.CLOSE);
}
function drawRiver(segment, opts = {}, pInst) {
  if (!segment || segment.points.length < 2) return;
  const g = p(pInst);
  const ring = channelPath(segment, opts);
  if (!ring.length) return;
  g.beginShape();
  for (const pt of ring) g.vertex(pt.x, pt.y);
  g.endShape(g.CLOSE);
}
function drawWord(word, pageImage, pInst) {
  const g = p(pInst);
  const w = word.x1 - word.x0;
  const h = word.y1 - word.y0;
  if (w <= 0 || h <= 0) return;
  g.image(pageImage, word.x0, word.y0, w, h, word.x0, word.y0, w, h);
}
function drawImage(pageImage, pInst) {
  const g = p(pInst);
  g.image(pageImage, 0, 0);
}

// src/index.ts
var Humument = {
  /**
   * Configure base URLs and warm the catalog. Call once before using
   * `catalog.*` from outside a sketch context. `load()` calls this internally.
   */
  init,
  /** Loaded data for a single page. The page image isn't preloaded — the
   *  caller assigns `H.page.image` after `loadImage(H.page.imageUrl)`. */
  async load(opts) {
    await init({ dataBase: opts.dataBase, imageBase: opts.imageBase });
    const { meta, words, gutters, docks, graph } = await getPageData(opts.page);
    const lines = groupByLine(words);
    const wordIndex = new Map(words.map((w) => [w.id, w]));
    const imageUrl = pageImageUrl(opts.page);
    const inst = {
      page: {
        number: opts.page,
        width: meta.width,
        height: meta.height,
        body: meta.body,
        valid: meta.valid,
        imageUrl,
        image: null
      },
      words,
      lines,
      wordById: (id) => wordIndex.get(id),
      bboxOf,
      gutters,
      docks,
      graph,
      chunks: (o) => chunks(words, o),
      selectChunks: (o) => selectChunks(words, o),
      chunkScore,
      passesCandidacy: (w, h) => passesCandidacy(w, h ?? /* @__PURE__ */ new Set()),
      river: {
        between: (a, b) => between(a, b, graph, docks),
        flow: (a, b, o) => flow(a, b, { ...o, body: o.body ?? meta.body ?? { x0: 0, y0: 0, x1: meta.width, y1: meta.height } }),
        pickPorts: (a, b) => {
          const da = docks.get(a.id);
          const db = docks.get(b.id);
          if (!da || !db) return null;
          return pickPorts(da, db, a, b);
        },
        penalizeBorders: (margin, penalty) => penalizeBorders(graph, meta.body ?? { x0: 0, y0: 0, x1: meta.width, y1: meta.height }, margin, penalty),
        dijkstra,
        obstaclesFrom
      },
      draw: {
        balloon: (words_, o, p2) => drawBalloon(words_, o, p2),
        river: (seg, o, p2) => drawRiver(seg, o, p2),
        word: (w, p2) => {
          if (inst.page.image) drawWord(w, inst.page.image, p2);
        },
        image: (p2) => {
          if (inst.page.image) drawImage(inst.page.image, p2);
        }
      },
      geom: {
        balloon: balloonPath,
        channel: channelPath,
        catmullRom
      },
      noise: makeNoise,
      noise2D: makeNoise2D,
      random: mulberry32,
      POS: {
        NOUN: "NOUN",
        VERB: "VERB",
        ADJ: "ADJ",
        ADV: "ADV",
        ADP: "ADP",
        DET: "DET",
        PRON: "PRON",
        NUM: "NUM",
        PROPN: "PROPN",
        AUX: "AUX",
        PART: "PART",
        CCONJ: "CCONJ",
        SCONJ: "SCONJ"
      },
      HEAD: (w) => w.pos === "NOUN" || w.pos === "PROPN",
      MOD: (w) => w.pos === "ADJ" || w.pos === "ADV" || w.pos === "NUM"
    };
    return inst;
  },
  /** List metadata helpers — usable before `load` for catalog UIs. All async. */
  catalog: {
    listPages,
    listAllPageRefs,
    listChapters,
    searchPages,
    getWords,
    pageImageUrl
  }
};
export {
  CDN_DATA_BASE,
  CDN_IMAGE_BASE,
  Humument
};
//# sourceMappingURL=index.js.map