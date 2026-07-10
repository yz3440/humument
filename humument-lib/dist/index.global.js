"use strict";
var HumumentLib = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    CDN_DATA_BASE: () => CDN_DATA_BASE,
    CDN_IMAGE_BASE: () => CDN_IMAGE_BASE,
    Humument: () => Humument,
    bannerPath: () => bannerPath,
    blobField: () => blobField,
    blobPath: () => blobPath,
    blobSpecFromWords: () => blobSpecFromWords
  });

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
    let p = pageCache.get(pageNum);
    if (!p) {
      const base = `${cfg.dataBase}/pages/p${String(pageNum).padStart(4, "0")}`;
      p = fetchPageJSON(base);
      pageCache.set(pageNum, p);
    }
    return p;
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
    const q = query.trim().replace(/\s+/g, " ").toLowerCase();
    if (!q) return [];
    const limit = opts.limit ?? 50;
    const terms = q.split(" ");
    return terms.length > 1 ? searchPhrase(q, terms, limit) : searchToken(q, limit);
  }
  async function searchToken(q, limit) {
    const index = await getSearchIndex();
    const hitsByPage = /* @__PURE__ */ new Map();
    for (const token in index) {
      if (!token.includes(q)) continue;
      for (const [page, count] of index[token]) {
        hitsByPage.set(page, (hitsByPage.get(page) ?? 0) + count);
      }
    }
    const ranked = [...hitsByPage.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit);
    return Promise.all(ranked.map(async ([pageNum, hits]) => {
      let snippet = "";
      try {
        snippet = matchOnPage((await getPageData(pageNum)).words, q).snippet;
      } catch {
      }
      return { pageNum, hits, snippet };
    }));
  }
  async function searchPhrase(q, terms, limit) {
    const index = await getSearchIndex();
    const perTerm = [];
    for (const term of terms) {
      const forTerm = /* @__PURE__ */ new Set();
      for (const token in index) {
        if (!token.includes(term)) continue;
        for (const [page] of index[token]) forTerm.add(page);
      }
      if (!forTerm.size) return [];
      perTerm.push(forTerm);
    }
    perTerm.sort((a, b) => a.size - b.size);
    const candidates = [];
    perTerm[0].forEach((page) => {
      if (perTerm.every((s) => s.has(page))) candidates.push(page);
    });
    if (!candidates.length) return [];
    const matched = await Promise.all(
      candidates.map(async (pageNum) => {
        try {
          const { hits, snippet } = matchOnPage((await getPageData(pageNum)).words, q);
          return hits ? { pageNum, hits, snippet } : null;
        } catch {
          return null;
        }
      })
    );
    return matched.filter((m) => m !== null).sort((a, b) => b.hits - a.hits || a.pageNum - b.pageNum).slice(0, limit);
  }
  function matchOnPage(words, q) {
    let hits = 0;
    let snippet = "";
    for (const line of groupByLine(words)) {
      const texts = line.map((w) => w.text.toLowerCase());
      const offsets = [];
      let pos = 0;
      for (const t of texts) {
        offsets.push(pos);
        pos += t.length + 1;
      }
      const joined = texts.join(" ");
      let at = joined.indexOf(q);
      while (at !== -1) {
        hits++;
        if (!snippet) {
          const endChar = at + q.length - 1;
          let startWord = 0, endWord = 0;
          for (let k = 0; k < offsets.length; k++) {
            if (offsets[k] <= at) startWord = k;
            if (offsets[k] <= endChar) endWord = k;
          }
          const from = Math.max(0, startWord - 3);
          const to = Math.min(line.length, endWord + 4);
          snippet = (from > 0 ? "\u2026 " : "") + line.slice(from, to).map((w) => w.text).join(" ") + (to < line.length ? " \u2026" : "");
        }
        at = joined.indexOf(q, at + q.length);
      }
    }
    return { hits, snippet };
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
    const p = w.pos ?? "";
    switch (p) {
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
        return p;
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
      if (picked.every((p) => Math.abs(c[0].lineIdx - p[0].lineIdx) >= minDist)) {
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
    if (pts.length < 2) return pts.map((p) => ({ p, gid: gutterIds[0] ?? -1 }));
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
  function bannerPath(bbox, opts = {}) {
    const pad = opts.pad ?? 6;
    const x0 = bbox.x0 - pad;
    const x1 = bbox.x1 + pad;
    const y0 = bbox.y0 - pad;
    const y1 = bbox.y1 + pad;
    const h = y1 - y0;
    const cy = (y0 + y1) / 2;
    const cx = (x0 + x1) / 2;
    const ends = opts.ends ?? "swallowtail";
    const [leftEnd, rightEnd] = Array.isArray(ends) ? ends : [ends, ends];
    const e = opts.endLength ?? 0.55 * h;
    const depth = (opts.notch ?? 0.65) * e;
    const skew = opts.skew ?? 0;
    const angle = opts.angle ?? 0;
    const wobble = opts.wobble ?? 1.2;
    const wobbleFreq = opts.wobbleFreq ?? 0.03;
    const step = opts.step ?? 4;
    const noise = makeNoise(opts.seed ?? 0);
    const rightRun = rightEnd === "square" ? [{ x: x1, y: y0 }, { x: x1, y: y1 }] : rightEnd === "point" ? [{ x: x1, y: y0 }, { x: x1 + e, y: cy }, { x: x1, y: y1 }] : [{ x: x1 + e, y: y0 }, { x: x1 + e - depth, y: cy }, { x: x1 + e, y: y1 }];
    const leftRun = leftEnd === "square" ? [{ x: x0, y: y1 }, { x: x0, y: y0 }] : leftEnd === "point" ? [{ x: x0, y: y1 }, { x: x0 - e, y: cy }, { x: x0, y: y0 }] : [{ x: x0 - e, y: y1 }, { x: x0 - e + depth, y: cy }, { x: x0 - e, y: y0 }];
    const edge = (ax, bx, y, phase) => {
      const out = [];
      const len = Math.abs(bx - ax);
      const n = Math.max(1, Math.round(len / step));
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = ax + (bx - ax) * t;
        out.push({ x, y: y + noise(Math.abs(x - x0) * wobbleFreq + phase) * wobble });
      }
      return out;
    };
    const topLeft = leftRun[leftRun.length - 1];
    const topRight = rightRun[0];
    const bottomRight = rightRun[rightRun.length - 1];
    const bottomLeft = leftRun[0];
    const pts = [
      ...leftRun,
      ...edge(topLeft.x, topRight.x, y0, 0),
      ...rightRun,
      ...edge(bottomRight.x, bottomLeft.x, y1, 100)
    ];
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    return pts.map((p) => {
      const sx = p.x + skew * ((p.y - cy) / h);
      if (!angle) return { x: sx, y: p.y };
      const dx = sx - cx;
      const dy = p.y - cy;
      return { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca };
    });
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

  // src/blob.ts
  function sdRect(x, y, p) {
    const qx = Math.abs(x - p.cx) - p.hx;
    const qy = Math.abs(y - p.cy) - p.hy;
    const ox = qx > 0 ? qx : 0;
    const oy = qy > 0 ? qy : 0;
    const outside = Math.sqrt(ox * ox + oy * oy);
    const inside = Math.min(Math.max(qx, qy), 0);
    return outside + inside - p.r;
  }
  function sdCapsule(x, y, c) {
    let best = Infinity;
    for (const s of c.segs) {
      const px = x - s.ax;
      const py = y - s.ay;
      let t = s.len2 > 0 ? (px * s.dx + py * s.dy) / s.len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = px - s.dx * t;
      const ey = py - s.dy * t;
      const d = Math.sqrt(ex * ex + ey * ey) - (s.ra + (s.rb - s.ra) * t);
      if (d < best) best = d;
    }
    return best;
  }
  function smin(a, b, k) {
    if (k <= 0) return Math.min(a, b);
    const h = Math.min(Math.max(0.5 + 0.5 * (b - a) / k, 0), 1);
    return b * (1 - h) + a * h - k * h * (1 - h);
  }
  function radiusAt(width, t) {
    if (typeof width === "number") {
      return radiusAt([width, width * 0.55, width], t);
    }
    const [w0, wm, w1] = width;
    const ss = (u) => u * u * (3 - 2 * u);
    if (t < 0.5) return (w0 + (wm - w0) * ss(t / 0.5)) / 2;
    return (wm + (w1 - wm) * ss((t - 0.5) / 0.5)) / 2;
  }
  function buildField(spec, pad, cornerRadius, blend, margin) {
    const rects = [];
    const caps = [];
    const off = pad + cornerRadius;
    let minCapWidth = Infinity;
    let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
    const grow = (x0, y0, x1, y1) => {
      if (x0 < wx0) wx0 = x0;
      if (y0 < wy0) wy0 = y0;
      if (x1 > wx1) wx1 = x1;
      if (y1 > wy1) wy1 = y1;
    };
    for (const b of spec.rects ?? []) {
      const hx = (b.x1 - b.x0) / 2 - cornerRadius;
      const hy = (b.y1 - b.y0) / 2 - cornerRadius;
      const p = {
        cx: (b.x0 + b.x1) / 2,
        cy: (b.y0 + b.y1) / 2,
        hx: Math.max(hx, 0.5),
        hy: Math.max(hy, 0.5),
        r: off,
        bx0: b.x0 - off - margin,
        by0: b.y0 - off - margin,
        bx1: b.x1 + off + margin,
        by1: b.y1 + off + margin
      };
      rects.push(p);
      grow(p.bx0, p.by0, p.bx1, p.by1);
    }
    for (const cap of spec.capsules ?? []) {
      if (!cap.points || cap.points.length < 2) continue;
      const w = cap.width;
      const wMax = typeof w === "number" ? w : Math.max(w[0], w[1], w[2]);
      const wMin = typeof w === "number" ? w * 0.55 : Math.min(w[0], w[1], w[2]);
      if (wMin < minCapWidth) minCapWidth = wMin;
      const spine = cap.points.length >= 3 ? catmullRom(cap.points, 1, 8) : cap.points;
      let arc = 0;
      const cum = [0];
      for (let i = 1; i < spine.length; i++) {
        arc += Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
        cum.push(arc);
      }
      if (arc <= 0) continue;
      const segs = [];
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let i = 1; i < spine.length; i++) {
        const a = spine[i - 1];
        const b = spine[i];
        const ta = cum[i - 1] / arc;
        const tb = cum[i] / arc;
        segs.push({
          ax: a.x,
          ay: a.y,
          dx: b.x - a.x,
          dy: b.y - a.y,
          len2: (b.x - a.x) ** 2 + (b.y - a.y) ** 2,
          ra: radiusAt(w, ta),
          rb: radiusAt(w, tb)
        });
        bx0 = Math.min(bx0, a.x, b.x);
        by0 = Math.min(by0, a.y, b.y);
        bx1 = Math.max(bx1, a.x, b.x);
        by1 = Math.max(by1, a.y, b.y);
      }
      const rr = wMax / 2 + margin;
      const prim = { segs, bx0: bx0 - rr, by0: by0 - rr, bx1: bx1 + rr, by1: by1 + rr };
      caps.push(prim);
      grow(prim.bx0, prim.by0, prim.bx1, prim.by1);
    }
    if (!rects.length && !caps.length) return null;
    const TILE = 64;
    const tw = Math.max(1, Math.ceil((wx1 - wx0) / TILE));
    const th = Math.max(1, Math.ceil((wy1 - wy0) / TILE));
    const buckets = new Array(tw * th);
    const bucketOf = (x, y) => {
      let i = Math.floor((x - wx0) / TILE);
      let j = Math.floor((y - wy0) / TILE);
      if (i < 0) i = 0;
      else if (i >= tw) i = tw - 1;
      if (j < 0) j = 0;
      else if (j >= th) j = th - 1;
      return j * tw + i;
    };
    const insert = (bx0, by0, bx1, by1, put) => {
      const i0 = Math.max(0, Math.floor((bx0 - wx0) / TILE));
      const j0 = Math.max(0, Math.floor((by0 - wy0) / TILE));
      const i1 = Math.min(tw - 1, Math.floor((bx1 - wx0) / TILE));
      const j1 = Math.min(th - 1, Math.floor((by1 - wy0) / TILE));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * tw + i;
          let b = buckets[k];
          if (!b) {
            b = { rects: [], caps: [] };
            buckets[k] = b;
          }
          put(b);
        }
      }
    };
    for (const p of rects) insert(p.bx0, p.by0, p.bx1, p.by1, (b) => b.rects.push(p));
    for (const c of caps) insert(c.bx0, c.by0, c.bx1, c.by1, (b) => b.caps.push(c));
    const FAR = margin + TILE;
    const evalAll = (x, y) => {
      const b = buckets[bucketOf(x, y)];
      if (!b) return FAR;
      let d = Infinity;
      for (const p of b.rects) {
        if (x < p.bx0 || x > p.bx1 || y < p.by0 || y > p.by1) continue;
        const v = sdRect(x, y, p);
        d = d === Infinity ? v : smin(d, v, blend);
        if (d < -margin) return d;
      }
      for (const c of b.caps) {
        if (x < c.bx0 || x > c.bx1 || y < c.by0 || y > c.by1) continue;
        const v = sdCapsule(x, y, c);
        d = d === Infinity ? v : smin(d, v, blend);
        if (d < -margin) return d;
      }
      return d === Infinity ? FAR : d;
    };
    return {
      eval: evalAll,
      window: { x0: wx0, y0: wy0, x1: wx1, y1: wy1 },
      minCapWidth
    };
  }
  var CASES = [
    /* 0  */
    [],
    /* 1  */
    [[3, 0]],
    /* 2  */
    [[0, 1]],
    /* 3  */
    [[3, 1]],
    /* 4  */
    [[1, 2]],
    /* 5  */
    [],
    // saddle — handled inline
    /* 6  */
    [[0, 2]],
    /* 7  */
    [[3, 2]],
    /* 8  */
    [[2, 3]],
    /* 9  */
    [[2, 0]],
    /* 10 */
    [],
    // saddle — handled inline
    /* 11 */
    [[2, 1]],
    /* 12 */
    [[1, 3]],
    /* 13 */
    [[1, 0]],
    /* 14 */
    [[0, 3]],
    /* 15 */
    []
  ];
  function marchingSquares(f, nx, ny, ox, oy, cell, centerEval) {
    const segs = /* @__PURE__ */ new Map();
    const val = (i, j) => f[j * nx + i];
    const cross = (fa, fb) => fa / (fa - fb);
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const tl = val(i, j);
        const tr = val(i + 1, j);
        const br = val(i + 1, j + 1);
        const bl = val(i, j + 1);
        let idx = 0;
        if (tl < 0) idx |= 1;
        if (tr < 0) idx |= 2;
        if (br < 0) idx |= 4;
        if (bl < 0) idx |= 8;
        if (idx === 0 || idx === 15) continue;
        const x = ox + i * cell;
        const y = oy + j * cell;
        const edgePt = (e) => {
          switch (e) {
            case 0: {
              const t = cross(tl, tr);
              return { key: (j * nx + i) * 2, px: x + t * cell, py: y };
            }
            case 1: {
              const t = cross(tr, br);
              return { key: (j * nx + (i + 1)) * 2 + 1, px: x + cell, py: y + t * cell };
            }
            case 2: {
              const t = cross(bl, br);
              return { key: ((j + 1) * nx + i) * 2, px: x + t * cell, py: y + cell };
            }
            default: {
              const t = cross(tl, bl);
              return { key: (j * nx + i) * 2 + 1, px: x, py: y + t * cell };
            }
          }
        };
        let pairs;
        if (idx === 5 || idx === 10) {
          const centerInside = centerEval(x + cell / 2, y + cell / 2) < 0;
          if (idx === 5) pairs = centerInside ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]];
          else pairs = centerInside ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]];
        } else {
          pairs = CASES[idx];
        }
        for (const [eFrom, eTo] of pairs) {
          const a = edgePt(eFrom);
          const b = edgePt(eTo);
          segs.set(a.key, { to: b.key, x: a.px, y: a.py });
        }
      }
    }
    const loops = [];
    while (segs.size) {
      const startKey = segs.keys().next().value;
      const loop = [];
      let k = startKey;
      for (; ; ) {
        const s = segs.get(k);
        if (!s) break;
        loop.push({ x: s.x, y: s.y });
        segs.delete(k);
        k = s.to;
        if (k === startKey) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return { loops };
  }
  function loopArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }
  function resampleClosed(pts, spacing) {
    let perim = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      perim += Math.hypot(q.x - p.x, q.y - p.y);
    }
    const count = Math.max(8, Math.round(perim / spacing));
    const step = perim / count;
    const out = [];
    let acc = 0;
    let target = 0;
    for (let i = 0; i < n && out.length < count; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      const seg = Math.hypot(q.x - p.x, q.y - p.y);
      while (target <= acc + seg && out.length < count) {
        const t = seg > 0 ? (target - acc) / seg : 0;
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        target += step;
      }
      acc += seg;
    }
    return out;
  }
  function smoothClosed(pts, passes) {
    let cur = pts;
    for (let p = 0; p < passes; p++) {
      const n = cur.length;
      const next = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = cur[(i - 1 + n) % n];
        const b = cur[i];
        const c = cur[(i + 1) % n];
        next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
      }
      cur = next;
    }
    return cur;
  }
  function wobbleAlongGradient(pts, field, amp, freq, seed) {
    if (amp <= 0) return pts;
    const noise = makeNoise(seed);
    const out = new Array(pts.length);
    let s = 0;
    const EPS = 1;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      const p = pts[i];
      const gx = field(p.x + EPS, p.y) - field(p.x - EPS, p.y);
      const gy = field(p.x, p.y + EPS) - field(p.x, p.y - EPS);
      const gl = Math.hypot(gx, gy) || 1;
      const d = noise(s * freq) * amp;
      out[i] = { x: p.x + gx / gl * d, y: p.y + gy / gl * d };
    }
    return out;
  }
  function blobField(spec, opts = {}) {
    const pad = opts.pad ?? 6;
    const cornerRadius = opts.cornerRadius ?? 0;
    const blend = opts.blend ?? 8;
    const wobble = opts.wobble ?? 2;
    const margin = blend + wobble + 8;
    const f = buildField(spec, pad, cornerRadius, blend, margin);
    return f ? f.eval : () => Infinity;
  }
  function blobPath(spec, opts = {}) {
    const pad = opts.pad ?? 6;
    const cornerRadius = opts.cornerRadius ?? 0;
    const blend = opts.blend ?? 8;
    const cellMax = opts.cell ?? 3;
    const spacing = opts.resample ?? 2.5;
    const smoothPasses = opts.smooth ?? 2;
    const wobble = opts.wobble ?? 2;
    const wobbleFreq = opts.wobbleFreq ?? 0.02;
    const seed = opts.seed ?? 0;
    const margin = blend + wobble + 8;
    const field = buildField(spec, pad, cornerRadius, blend, margin);
    if (!field) return [];
    const w = field.window;
    const maxDim = Math.max(w.x1 - w.x0, w.y1 - w.y0);
    let cell = Math.min(cellMax, Math.max(2, maxDim / 350));
    if (field.minCapWidth !== Infinity) cell = Math.min(cell, Math.max(1, field.minCapWidth / 4));
    const nx = Math.ceil((w.x1 - w.x0) / cell) + 2;
    const ny = Math.ceil((w.y1 - w.y0) / cell) + 2;
    const ox = w.x0;
    const oy = w.y0;
    const f = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const y = oy + j * cell;
      for (let i = 0; i < nx; i++) {
        f[j * nx + i] = field.eval(ox + i * cell, y);
      }
    }
    const { loops } = marchingSquares(f, nx, ny, ox, oy, cell, field.eval);
    loops.sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
    return loops.map((loop) => {
      let pts = resampleClosed(loop, spacing);
      pts = smoothClosed(pts, smoothPasses);
      pts = wobbleAlongGradient(pts, field.eval, wobble, wobbleFreq, seed);
      return pts;
    });
  }
  function blobSpecFromWords(groups, opts = {}) {
    const bow = opts.bow ?? 0.22;
    const noise = makeNoise((opts.seed ?? 0) + 31);
    const rects = [];
    for (const g of groups) for (const w of g) rects.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
    const capsules = [];
    for (let i = 0; i < groups.length - 1; i++) {
      const ga = groups[i];
      const gb = groups[i + 1];
      if (!ga.length || !gb.length) continue;
      const a = ga[ga.length - 1];
      const b = gb[0];
      const anchors = neckAnchors(a, b);
      if (!anchors) continue;
      const [pa, pb] = anchors;
      const chord = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      const side = noise(i * 3.7) >= 0 ? 1 : -1;
      const nx = -(pb.y - pa.y) / (chord || 1);
      const ny = (pb.x - pa.x) / (chord || 1);
      const mid = {
        x: (pa.x + pb.x) / 2 + nx * side * bow * chord,
        y: (pa.y + pb.y) / 2 + ny * side * bow * chord
      };
      const lineH = (a.y1 - a.y0 + (b.y1 - b.y0)) / 2;
      const dflt = [
        Math.max(10, 0.5 * lineH),
        Math.max(10, 0.28 * lineH),
        Math.max(10, 0.5 * lineH)
      ];
      capsules.push({ points: [pa, mid, pb], width: opts.neckWidth ?? dflt });
    }
    return { rects, capsules };
  }
  function neckAnchors(a, b) {
    const acx = (a.x0 + a.x1) / 2;
    const acy = (a.y0 + a.y1) / 2;
    const bcx = (b.x0 + b.x1) / 2;
    const bcy = (b.y0 + b.y1) / 2;
    const clamp = (v, lo, hi) => lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi);
    if (b.y0 - a.y1 >= -4) {
      return [
        { x: clamp(bcx, a.x0 + 4, a.x1 - 4), y: a.y1 },
        { x: clamp(acx, b.x0 + 4, b.x1 - 4), y: b.y0 }
      ];
    }
    if (a.y0 - b.y1 >= -4) {
      return [
        { x: clamp(bcx, a.x0 + 4, a.x1 - 4), y: a.y0 },
        { x: clamp(acx, b.x0 + 4, b.x1 - 4), y: b.y1 }
      ];
    }
    if (a.x1 <= b.x0) {
      return [
        { x: a.x1, y: clamp(bcy, a.y0 + 3, a.y1 - 3) },
        { x: b.x0, y: clamp(acy, b.y0 + 3, b.y1 - 3) }
      ];
    }
    return [
      { x: a.x0, y: clamp(bcy, a.y0 + 3, a.y1 - 3) },
      { x: b.x1, y: clamp(acy, b.y0 + 3, b.y1 - 3) }
    ];
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
        const p = i - 1 >> 1;
        if (this.a[p].cost <= this.a[i].cost) break;
        [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
        i = p;
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
    let p = { ...start };
    const startDist = Math.hypot(end.x - start.x, end.y - start.y);
    let bestDistSeen = startDist;
    let stallCount = 0;
    for (let iter = 0; iter < maxSteps; iter++) {
      const dxe = end.x - p.x;
      const dye = end.y - p.y;
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
        const nx = p.x + stepSize * cx;
        const ny = p.y + stepSize * cy;
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
      p = {
        x: p.x + stepSize * Math.cos(bestTheta),
        y: p.y + stepSize * Math.sin(bestTheta)
      };
      pts.push({ ...p });
    }
    pts.push({ ...end });
    return pts;
  }
  function obstaclesFrom(words, selectedIds, pad = 1) {
    const sel = new Set(selectedIds);
    return words.filter((w) => !sel.has(w.id)).map((w) => ({ x0: w.x0 - pad, y0: w.y0 - pad, x1: w.x1 + pad, y1: w.y1 + pad }));
  }

  // src/index.ts
  var Humument = {
    /**
     * Configure base URLs and warm the catalog. Call once before using
     * `catalog.*` from outside a sketch context. `load()` calls this internally.
     */
    init,
    /** Loaded data for a single page. The page image isn't preloaded — the
     *  caller loads `H.page.imageUrl` with its own renderer. */
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
          imageUrl
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
        geom: {
          balloon: balloonPath,
          channel: channelPath,
          catmullRom,
          blob: blobPath,
          blobSpec: blobSpecFromWords,
          blobField,
          banner: bannerPath
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
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=index.global.js.map