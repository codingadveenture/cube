// build-printings.mjs: list every English paper Printing of every card in public/data/cards.json
// and write one file per card, public/data/printings/<oracle_id>.json, plus
// public/data/printings-meta.json, for the printing picker. One file per card means a phone
// loads only the cards it shows, never the whole index.
//
// Usage (from the repo root):
//   node scripts/build-printings.mjs [--refresh]
//
// For each oracle_id, GET https://api.scryfall.com/cards/search with
// q=oracleid:<id> game:paper lang:en, unique=prints, include_extras, include_variations,
// order=released, dir=desc, following has_more/next_page. A 404 means no printings; the card
// gets an empty list and is reported. Requests are at least 150 ms apart (after the previous
// response) and at least 750 ms apart start to start: Scryfall's hard limit for /cards/search is
// 2 per second, and one HTTP 429 locks the client out for 30 s, so the 2 s back-off used by
// build-cards.mjs is not enough here. On 429 the script waits for Retry-After (60 s if absent)
// plus 2 s, up to 3 times, then stops. Each card's pages are cached together under
// scripts/.cache/printings-<oracle_id>.json and reused unless --refresh is given, so a stopped
// run resumes where it left off.
//
// A Printing is kept when it is English, has "paper" in games, its set_type is not art_series,
// minigame or token, its border is not gold, it is not oversized, and its layout is not
// art_series, token, double_faced_token or emblem. set_type memorabilia is kept on purpose:
// Scryfall files the 30th Anniversary Edition (30a) there, and the Owner uses 30a Printings for
// Power and the dual lands. Printings are newest first.
//
// Output: {"name", "oracle_id", "printings": [...]} per card. image_small, image_png and
// back_image_png are not stored, to keep the files small. The client derives them from
// image_normal (back_image_normal for the back): small by replacing "/normal/" with "/small/",
// png by replacing "/normal/" with "/png/" and ".jpg" with ".png".
// Files in public/data/printings/ for cards no longer in cards.json are removed.
// Node 24, no npm dependencies.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = join(ROOT, 'public', 'data', 'cards.json');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const CARD_DIR = join(OUT_DIR, 'printings');
const REFRESH = process.argv.includes('--refresh');
const GAP_MS = 150;
const MIN_INTERVAL_MS = 750;
const MAX_429_RETRIES = 3;
const HEADERS = {
  'User-Agent': 'cube-app-build/0.1 (github.com/codingadveenture/cube)',
  Accept: 'application/json',
};

const SKIP_SET_TYPES = new Set(['art_series', 'minigame', 'token']);
const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let rateLimited = 0;
let lastStart = 0;
let lastEnd = 0;

// Returns the parsed body, or null on 404 (a search with no results).
async function getJson(url) {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const now = Date.now();
    const wait = Math.max(lastEnd + GAP_MS - now, lastStart + MIN_INTERVAL_MS - now, 0);
    if (lastStart && wait) await sleep(wait);
    lastStart = Date.now();
    requests++;
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    lastEnd = Date.now();
    if (res.status === 429) {
      rateLimited++;
      if (attempt === MAX_429_RETRIES) break;
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      console.warn(`429 from Scryfall, waiting ${retryAfter + 2} s`);
      await sleep((retryAfter + 2) * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Scryfall HTTP ${res.status} for ${url}: ${text}`);
    return JSON.parse(text);
  }
  throw new Error('Scryfall kept answering 429');
}

function searchUrl(oracleId) {
  const q = encodeURIComponent(`oracleid:${oracleId} game:paper lang:en`).replace(/%20/g, '+');
  return (
    `https://api.scryfall.com/cards/search?q=${q}&unique=prints&include_extras=true` +
    '&include_variations=true&order=released&dir=desc'
  );
}

// All Scryfall card objects for one oracle_id, from the cache or from the API.
async function loadCard(oracleId) {
  const file = join(CACHE, `printings-${oracleId}.json`);
  const url = searchUrl(oracleId);
  if (!REFRESH && existsSync(file)) {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    // A cache made with a different query is stale; refetch.
    if (cached.url === url) return cached;
  }
  const data = [];
  let next = url;
  let notFound = false;
  while (next) {
    const body = await getJson(next);
    if (!body) {
      notFound = true;
      break;
    }
    data.push(...body.data);
    next = body.has_more ? body.next_page : null;
  }
  const out = { url, fetched_at: new Date().toISOString(), not_found: notFound, data };
  await writeFile(file, JSON.stringify(out));
  return out;
}

function keep(sc) {
  return (
    sc.lang === 'en' &&
    (sc.games || []).includes('paper') &&
    !SKIP_SET_TYPES.has(sc.set_type) &&
    sc.border_color !== 'gold' &&
    !sc.oversized &&
    !SKIP_LAYOUTS.has(sc.layout)
  );
}

function printingFields(sc) {
  const faces = sc.card_faces || [];
  const imgSrc = sc.image_uris || (faces[0] && faces[0].image_uris) || {};
  // back_* only when the second face has its own image (transform, modal_dfc,
  // reversible_card).
  const back = faces[1] && faces[1].image_uris ? faces[1] : null;
  return {
    id: sc.id,
    set: sc.set,
    set_name: sc.set_name,
    set_type: sc.set_type,
    collector_number: sc.collector_number,
    released_at: sc.released_at,
    frame: sc.frame,
    frame_effects: sc.frame_effects || [],
    border_color: sc.border_color,
    full_art: !!sc.full_art,
    textless: !!sc.textless,
    promo: !!sc.promo,
    promo_types: sc.promo_types || [],
    finishes: sc.finishes || [],
    highres: sc.image_status === 'highres_scan',
    illustration_id: sc.illustration_id || (faces[0] && faces[0].illustration_id) || null,
    artist: sc.artist || (faces[0] && faces[0].artist) || null,
    image_normal: imgSrc.normal || null,
    back_image_normal: back ? back.image_uris.normal || null : null,
    back_illustration_id: back ? back.illustration_id || null : null,
    security_stamp: sc.security_stamp || null,
    reprint: !!sc.reprint,
    variation: !!sc.variation,
    booster: !!sc.booster,
    digital: !!sc.digital,
  };
}

const started = Date.now();
const cardsFile = JSON.parse(await readFile(CARDS, 'utf8'));
await mkdir(CACHE, { recursive: true });

const out = {};
const zero = [];
const missing = [];
for (const [i, c] of cardsFile.cards.entries()) {
  const loaded = await loadCard(c.oracle_id);
  // Newest first; the sort is stable, so Scryfall's order is kept within a release date.
  const printings = loaded.data
    .filter(keep)
    .map(printingFields)
    .sort((a, b) => (a.released_at < b.released_at ? 1 : a.released_at > b.released_at ? -1 : 0));
  if (!printings.length) zero.push(c.name);
  out[c.oracle_id] = { name: c.name, oracle_id: c.oracle_id, printings };
  const ids = new Set(printings.map((p) => p.id));
  for (const role of ['in_box', 'wanted']) {
    const p = c[role];
    if (!ids.has(p.scryfall_id)) {
      missing.push(`${c.name} ${role} ${p.set} ${p.collector_number} (paper: ${p.paper})`);
    }
  }
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${cardsFile.cards.length} cards, ${requests} requests`);
}
const generatedAt = new Date().toISOString();

// Pretty JSON with 1-space indent, except that leaf values (primitives, arrays of primitives,
// and flat objects whose values are primitives or arrays of primitives, such as a printing)
// stay on one line.
const isPrimitive = (v) => v === null || typeof v !== 'object';
function pretty(value, indent = '') {
  const flat = JSON.stringify(value);
  const isLeaf =
    isPrimitive(value) ||
    Object.values(value).every((v) => isPrimitive(v) || (Array.isArray(v) && v.every(isPrimitive)));
  if (isLeaf) return flat;
  const inner = indent + ' ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => inner + pretty(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n')}\n${indent}}`;
}

await mkdir(CARD_DIR, { recursive: true });
const fileBytes = {};
for (const [oracleId, card] of Object.entries(out)) {
  const text = pretty(card) + '\n';
  fileBytes[oracleId] = Buffer.byteLength(text);
  await writeFile(join(CARD_DIR, `${oracleId}.json`), text);
}
const stale = (await readdir(CARD_DIR)).filter((f) => f.endsWith('.json') && !out[f.slice(0, -5)]);
for (const f of stale) await rm(join(CARD_DIR, f));
if (stale.length) console.log(`removed ${stale.length} stale files: ${stale.join(', ')}`);
const [largestId, largestBytes] = Object.entries(fileBytes).sort((a, b) => b[1] - a[1])[0];

const all = Object.values(out).flatMap((c) => c.printings);
const counts = Object.values(out)
  .map((c) => c.printings.length)
  .sort((a, b) => a - b);
const median =
  counts.length % 2
    ? counts[(counts.length - 1) / 2]
    : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2;
const countBy = (key) => {
  const res = {};
  for (const p of all) res[String(p[key])] = (res[String(p[key])] || 0) + 1;
  return res;
};
const meta = {
  generated_at: generatedAt,
  cards: Object.keys(out).length,
  cards_with_zero_printings: zero,
  total_printings: all.length,
  printings_per_card: { min: counts[0], median, max: counts[counts.length - 1] },
  by_frame: countBy('frame'),
  by_border_color: countBy('border_color'),
  highres: countBy('highres'),
  promo: countBy('promo'),
  printings_30a: all.filter((p) => p.set === '30a').length,
  total_bytes: Object.values(fileBytes).reduce((a, b) => a + b, 0),
  largest_file: { oracle_id: largestId, name: out[largestId].name, bytes: largestBytes },
  largest: Object.values(out)
    .map((c) => ({ name: c.name, printings: c.printings.length }))
    .sort((a, b) => b.printings - a.printings || a.name.localeCompare(b.name))
    .slice(0, 20),
};
await writeFile(join(OUT_DIR, 'printings-meta.json'), JSON.stringify(meta, null, 1) + '\n');

console.log(JSON.stringify(meta, null, 1));
if (zero.length) console.warn(`cards with zero printings: ${zero.join(', ')}`);
if (missing.length) console.warn(`in_box/wanted printings not in the index:\n  ${missing.join('\n  ')}`);
console.log(`Scryfall requests: ${requests}, HTTP 429: ${rateLimited}, wall time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`${Object.keys(fileBytes).length} files in public/data/printings/, ${meta.total_bytes} bytes`);
