// build-art-catalog.mjs: build the closed art catalog the Scan page recognises slips against.
//
// Usage (from the repo root):
//   node scripts/build-art-catalog.mjs [--refresh] [--offline] [--no-self-embed]
//
// 1. Candidate cards: every card in public/data/cards.json plus every name in
//    data/extra-cards.txt (cards that may be in the box or the next Update but are not on the
//    List). An extra name is resolved with GET https://api.scryfall.com/cards/named?exact=<name>
//    (fuzzy= when exact finds nothing), cached under scripts/.cache/named-<name>.json. An extra
//    card without a printings file gets one, fetched exactly as build-printings.mjs does
//    (scripts/lib/scryfall.mjs: same search, spacing, cache and file shape). The extra cards are
//    written to public/data/extra-cards.json so the page can name them.
// 2. Every printing of every candidate is looked up in the CollectorVision hosted catalog v2
//    (scripts/lib/cv-catalog.mjs; downloaded once into scripts/.cache/cv-catalog/): the front
//    face, and the back face where the catalog has a row for it.
// 3. Printings the hosted catalog lacks are embedded here with Milo (scripts/lib/milo-node.mjs,
//    the page's own preprocessing) from the Scryfall "large" JPG, when Scryfall has an image.
//    The hosted catalog is paper-only, so this is how digital-only arts (for example VMA
//    Tropical Island) and brand-new printings get recognised. Scryfall's "large" image gave a
//    cosine of 0.999 or more against the hosted rows in a check of seven paper printings
//    (research/art-catalog-eval.md). Images are cached under scripts/.cache/art-images/ and
//    embeddings under scripts/.cache/art-self-embeddings.json; images are fetched 100 ms apart.
//    --no-self-embed skips this step.
// 4. Output, rows in one fixed order (cards by name, then each card's printings newest first,
//    front face before back face):
//    - public/data/art-catalog.bin: rows of 128 little-endian float16 values (256 bytes a row);
//    - public/data/art-catalog.json: the same rows as arrays, see `columns` in the file.
//    Ids missing from the hosted catalog go to scripts/.cache/art-catalog-missing.json.
//
// --refresh refetches the Scryfall caches; --offline reuses the cached catalog feed instead of
// checking for a newer version. Resumable: every network result is cached.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, loadCard, cardPrintings, pretty, stats, sleep, HEADERS } from './lib/scryfall.mjs';
import { loadHostedRows } from './lib/cv-catalog.mjs';
import { encodeFloat16, decodeFloat16 } from '../src/scan/vision/float16.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const CARD_DIR = join(DATA, 'printings');
const CACHE = join(ROOT, 'scripts', '.cache');
const IMAGE_CACHE = join(CACHE, 'art-images');
const SELF_CACHE = join(CACHE, 'art-self-embeddings.json');
const REFRESH = process.argv.includes('--refresh');
const OFFLINE = process.argv.includes('--offline');
const SELF_EMBED = !process.argv.includes('--no-self-embed');
const IMAGE_GAP_MS = 100;
const MODEL = {
  name: 'milo-1.0.0',
  file: 'models/milo-1.0.0.onnx',
  sha256: 'bd13d8d60383c69da04dce261f32e93fdaeaa8fd618fbc991e7385f71b3d45df',
};

const started = Date.now();
await mkdir(CACHE, { recursive: true });

// Copied from scripts/build-cards.mjs (colorCategory), which is a script, not a module.
function colorCategory(frontType, colors) {
  if (/\bLand\b/.test(frontType)) return 'L';
  if (colors.length > 1) return 'M';
  if (colors.length === 0) return 'C';
  return colors[0];
}

// ---- 1. Candidate cards ----
const cardsFile = JSON.parse(await readFile(join(DATA, 'cards.json'), 'utf8'));
const candidates = cardsFile.cards.map((c) => ({ oracle_id: c.oracle_id, name: c.name, on_list: true }));
const known = new Map();
for (const c of cardsFile.cards) {
  known.set(c.name.toLowerCase(), c.oracle_id);
  known.set(c.front_name.toLowerCase(), c.oracle_id);
}
const extraNames = (await readFile(join(ROOT, 'data', 'extra-cards.txt'), 'utf8'))
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const safeName = (name) => name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();

async function resolveName(name) {
  const file = join(CACHE, `named-${safeName(name)}.json`);
  if (!REFRESH && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    if (cached.query === name) return cached;
  }
  const q = encodeURIComponent(name);
  let card = await getJson(`https://api.scryfall.com/cards/named?exact=${q}`);
  let mode = 'exact';
  if (!card) {
    card = await getJson(`https://api.scryfall.com/cards/named?fuzzy=${q}`);
    mode = 'fuzzy';
  }
  const out = { query: name, mode, fetched_at: new Date().toISOString(), card };
  await writeFile(file, JSON.stringify(out));
  return out;
}

const extras = [];
const unresolved = [];
const fuzzy = [];
const alreadyListed = [];
const seen = new Set(candidates.map((c) => c.oracle_id));
for (const name of extraNames) {
  if (known.has(name.toLowerCase())) {
    alreadyListed.push(name);
    continue;
  }
  const { mode, card } = await resolveName(name);
  if (!card) {
    unresolved.push(name);
    continue;
  }
  const faces = card.card_faces || [];
  const front = faces[0] || card;
  const oracleId = card.oracle_id || front.oracle_id;
  if (mode === 'fuzzy') fuzzy.push(`${name} -> ${card.name}`);
  if (seen.has(oracleId)) {
    alreadyListed.push(name);
    continue;
  }
  seen.add(oracleId);
  const frontType = front.type_line || card.type_line || '';
  const colors = card.colors || front.colors || [];
  extras.push({
    oracle_id: oracleId,
    name: card.name,
    front_name: card.name.split(' // ')[0].trim(),
    layout: card.layout,
    type_line: card.type_line || faces.map((f) => f.type_line).join(' // '),
    color_category: colorCategory(frontType, colors),
  });
}
extras.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
await writeFile(join(DATA, 'extra-cards.json'), pretty(extras) + '\n');
for (const e of extras) candidates.push({ oracle_id: e.oracle_id, name: e.name, on_list: false });
candidates.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

// Printings for each candidate: the existing file, or fetched and written like build-printings.
let printingFilesWritten = 0;
for (const c of candidates) {
  const file = join(CARD_DIR, `${c.oracle_id}.json`);
  if (existsSync(file) && !(REFRESH && !c.on_list)) {
    c.printings = JSON.parse(await readFile(file, 'utf8')).printings;
    continue;
  }
  const loaded = await loadCard(CACHE, c.oracle_id, REFRESH);
  c.printings = cardPrintings(loaded);
  await writeFile(file, pretty({ name: c.name, oracle_id: c.oracle_id, printings: c.printings }) + '\n');
  printingFilesWritten++;
}

// ---- 2. Wanted printing ids, and the hosted rows for them ----
const wanted = []; // { key, id, face, card, printing }
const wantedIds = new Set();
for (const c of candidates) {
  for (const p of c.printings) {
    wantedIds.add(p.id);
    wanted.push({ key: p.id, id: p.id, face: 0, card: c, printing: p });
  }
}
const { rows: hosted, info } = await loadHostedRows(CACHE, wantedIds, { offline: OFFLINE });
// Back faces: wherever the catalog has a row, plus wherever our file has a back image.
const front = new Map(wanted.map((w) => [w.id, w]));
for (const [key, row] of hosted) {
  if (row.face && front.has(row.id)) {
    const w = front.get(row.id);
    wanted.push({ key, id: row.id, face: row.face, card: w.card, printing: w.printing });
  }
}
for (const w of [...front.values()]) {
  const key = `${w.id}:face:1`;
  if (w.printing.back_image_normal && !hosted.has(key)) {
    wanted.push({ key, id: w.id, face: 1, card: w.card, printing: w.printing });
  }
}
const missing = wanted.filter((w) => !hosted.has(w.key));

// ---- 3. Embed what the hosted catalog lacks ----
const imageUrl = (w) => {
  const normal = w.face ? w.printing.back_image_normal : w.printing.image_normal;
  return normal ? normal.replace('/normal/', '/large/') : null;
};
const selfCache = existsSync(SELF_CACHE) ? JSON.parse(await readFile(SELF_CACHE, 'utf8')) : {};
const self = new Map();
if (SELF_EMBED && missing.length) {
  const { decodeImage, embedImage } = await import('./lib/milo-node.mjs');
  await mkdir(IMAGE_CACHE, { recursive: true });
  let lastFetch = 0;
  let done = 0;
  let dirty = 0;
  for (const w of missing) {
    const url = imageUrl(w);
    if (!url) continue;
    const cached = selfCache[w.key];
    if (cached && cached.url === url && cached.model === MODEL.sha256) {
      self.set(w.key, cached.f16);
      continue;
    }
    const file = join(IMAGE_CACHE, `${w.key.replace(/:/g, '_')}.jpg`);
    let bytes;
    if (existsSync(file) && !REFRESH) {
      bytes = await readFile(file);
    } else {
      const wait = lastFetch + IMAGE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastFetch = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
      if (!res.ok) {
        console.warn(`image HTTP ${res.status} for ${url}`);
        continue;
      }
      bytes = Buffer.from(await res.arrayBuffer());
      await writeFile(file, bytes);
    }
    const embedding = await embedImage(await decodeImage(bytes));
    const f16 = Buffer.from(encodeFloat16(embedding)).toString('base64');
    selfCache[w.key] = { url, model: MODEL.sha256, f16 };
    self.set(w.key, f16);
    done++;
    if (++dirty >= 25) {
      await writeFile(SELF_CACHE, JSON.stringify(selfCache));
      dirty = 0;
    }
    if (done % 50 === 0) console.log(`embedded ${done} printings the hosted catalog lacks`);
  }
  await writeFile(SELF_CACHE, JSON.stringify(selfCache));
}

// ---- 4. Output ----
const columns = ['scryfall_id', 'card', 'set', 'collector_number', 'illustration_id', 'digital', 'face', 'source'];
const cardColumns = ['oracle_id', 'name', 'on_list'];
const cardIndex = new Map(candidates.map((c, i) => [c.oracle_id, i]));
const facesById = new Map();
for (const w of wanted) {
  if (!facesById.has(w.id)) facesById.set(w.id, []);
  facesById.get(w.id).push(w);
}
const order = [];
for (const c of candidates) {
  for (const p of c.printings) order.push(...(facesById.get(p.id) || []).sort((a, b) => a.face - b.face));
}
const rows = [];
const chunks = [];
for (const w of order) {
  let bytes;
  let source;
  if (hosted.has(w.key)) {
    bytes = hosted.get(w.key).embedding;
    source = 0;
  } else if (self.has(w.key)) {
    bytes = Buffer.from(self.get(w.key), 'base64');
    source = 1;
  } else continue;
  // A hosted back-face row whose face our file has no illustration for gets the front's.
  const illustration = w.face ? w.printing.back_illustration_id || w.printing.illustration_id : w.printing.illustration_id;
  rows.push([
    w.id,
    cardIndex.get(w.card.oracle_id),
    w.printing.set,
    w.printing.collector_number,
    illustration,
    w.printing.digital ? 1 : 0,
    w.face ? 1 : 0,
    source,
  ]);
  chunks.push(bytes);
}
const bin = Buffer.concat(chunks.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)));
if (bin.length !== rows.length * 256) throw new Error('catalog binary has the wrong length');
// Sanity check: every row decodes to a unit vector.
const decoded = decodeFloat16(bin);
for (let r = 0; r < rows.length; r++) {
  let s = 0;
  for (let i = 0; i < 128; i++) s += decoded[r * 128 + i] ** 2;
  if (Math.abs(Math.sqrt(s) - 1) > 0.01) throw new Error(`row ${r} (${rows[r][0]}) is not unit length`);
}

const catalog = {
  format: 1,
  generated_at: new Date().toISOString(),
  dims: 128,
  dtype: 'float16',
  byte_order: 'little',
  model: MODEL,
  hosted_catalog: info,
  sources: ['hosted', 'self'],
  card_columns: cardColumns,
  cards: candidates.map((c) => [c.oracle_id, c.name, c.on_list ? 1 : 0]),
  columns,
  rows,
};
// One row per line keeps the file readable in diffs at almost no cost.
const json =
  JSON.stringify({ ...catalog, cards: [], rows: [] })
    .replace('"cards":[]', `"cards":[\n${catalog.cards.map((c) => JSON.stringify(c)).join(',\n')}\n]`)
    .replace('"rows":[]', `"rows":[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`) + '\n';
await writeFile(join(DATA, 'art-catalog.bin'), bin);
await writeFile(join(DATA, 'art-catalog.json'), json);

const stillMissing = missing.filter((w) => !self.has(w.key));
const describe = (w) => ({
  key: w.key,
  scryfall_id: w.id,
  face: w.face ? 'back' : 'front',
  name: w.card.name,
  set: w.printing.set,
  collector_number: w.printing.collector_number,
  digital: w.printing.digital,
  released_at: w.printing.released_at,
  embedded_here: self.has(w.key),
});
await writeFile(
  join(CACHE, 'art-catalog-missing.json'),
  JSON.stringify(
    {
      generated_at: catalog.generated_at,
      hosted_catalog: info,
      missing_from_hosted: missing.length,
      embedded_here: missing.length - stillMissing.length,
      still_missing: stillMissing.map(describe),
      missing: missing.map(describe),
    },
    null,
    1,
  ) + '\n',
);

const size = async (f) => (await stat(join(DATA, f))).size;
const digitalMissing = missing.filter((w) => w.printing.digital).length;
console.log(`candidate cards: ${candidates.length} (${cardsFile.cards.length} on the List, ${extras.length} extra)`);
console.log(`extra names: ${extraNames.length}, already on the List: ${alreadyListed.length}, unresolved: ${unresolved.length}${unresolved.length ? ` (${unresolved.join(', ')})` : ''}`);
if (fuzzy.length) console.log(`resolved by fuzzy match: ${fuzzy.join('; ')}`);
console.log(`printings files written for extra cards: ${printingFilesWritten}`);
console.log(`printing ids wanted: ${wantedIds.size} (${wanted.length} faces)`);
console.log(`rows found in the hosted catalog v${info.current_version}: ${wanted.length - missing.length}`);
console.log(`missing from the hosted catalog: ${missing.length} (${digitalMissing} digital-only), embedded here: ${missing.length - stillMissing.length}, still missing: ${stillMissing.length}`);
console.log(`examples: ${missing.slice(0, 5).map((w) => `${w.card.name} ${w.printing.set} ${w.printing.collector_number}${w.face ? ' (back)' : ''}`).join('; ')}`);
if (stillMissing.length) console.log(`still missing: ${stillMissing.slice(0, 5).map((w) => `${w.card.name} ${w.printing.set} ${w.printing.collector_number}`).join('; ')}`);
console.log(`catalog rows: ${rows.length} (${rows.filter((r) => r[7] === 1).length} embedded here, ${rows.filter((r) => r[6] === 1).length} back faces)`);
console.log(`art-catalog.bin ${await size('art-catalog.bin')} bytes, art-catalog.json ${await size('art-catalog.json')} bytes`);
console.log(`Scryfall API requests: ${stats.requests}, HTTP 429: ${stats.rateLimited}, wall time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
