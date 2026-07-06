// Populate the data packages from the canonical pipeline outputs.
// Run automatically by each package's prepublishOnly:
//   node sync.mjs data    → humument-data/db/   (gzipped pages + catalog + search index)
//   node sync.mjs images  → humument-images/pages/  (normalized page JPEGs)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

function die(msg) {
  console.error(`sync: ${msg}`);
  process.exit(1);
}

function syncData() {
  const src = join(repo, 'output', 'db');
  if (!existsSync(join(src, 'catalog.json'))) {
    die(`missing ${src}/catalog.json — run "uv run python pipeline/03_export_web.py" first`);
  }
  const dst = join(here, 'humument-data', 'db');
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(join(dst, 'pages'), { recursive: true });
  cpSync(join(src, 'catalog.json'), join(dst, 'catalog.json'));
  cpSync(join(src, 'search-index.json'), join(dst, 'search-index.json'));
  // ship only the gzipped pages — the plain .json twins would push the
  // package past jsDelivr's 150MB unpacked limit
  const pages = readdirSync(join(src, 'pages')).filter((f) => f.endsWith('.json.gz'));
  if (pages.length === 0) die('no .json.gz pages — re-run the export (03_export_web.py)');
  for (const f of pages) cpSync(join(src, 'pages', f), join(dst, 'pages', f));
  console.log(`sync data: ${pages.length} gzipped pages + catalog + search index → humument-data/db`);
}

function syncImages() {
  const src = join(repo, 'data', 'pages_normalized');
  if (!existsSync(src)) die(`missing ${src} — run the pipeline first`);
  const dst = join(here, 'humument-images', 'pages');
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  const jpgs = readdirSync(src).filter((f) => f.endsWith('.jpg'));
  if (jpgs.length === 0) die('no JPEGs in pages_normalized');
  for (const f of jpgs) cpSync(join(src, f), join(dst, f));
  console.log(`sync images: ${jpgs.length} JPEGs → humument-images/pages`);
}

const mode = process.argv[2];
if (mode === 'data') syncData();
else if (mode === 'images') syncImages();
else die(`usage: node sync.mjs data|images (got ${JSON.stringify(mode)})`);
