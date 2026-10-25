// build-printings.mjs: list every English Printing (paper and digital-only) of every card in
// public/data/cards.json
// and write one file per card, public/data/printings/<oracle_id>.json, plus
// public/data/printings-meta.json, for the printing picker. One file per card means a phone
// loads only the cards it shows, never the whole index.
//
// Usage (from the repo root):
//   node scripts/build-printings.mjs [--refresh]
//
// For each oracle_id, GET https://api.scryfall.com/cards/search with
// q=oracleid:<id> lang:en, unique=prints, include_extras, include_variations,
// order=released, dir=desc, following has_more/next_page. A 404 means no printings; the card
// gets an empty list and is reported. Requests are at least 150 ms apart (after the previous
// response) and at least 750 ms apart start to start: Scryfall's hard limit for /cards/search is
// 2 per second, and one HTTP 429 locks the client out for 30 s, so the 2 s back-off used by
// build-cards.mjs is not enough here. On 429 the script waits for Retry-After (60 s if absent)
// plus 2 s, up to 3 times, then stops. Each card's pages are cached together under
// scripts/.cache/printings-all-<oracle_id>.json and reused unless --refresh is given, so a stopped
// run resumes where it left off. (The older printings-<oracle_id>.json files hold the paper-only
// search and are not read.)
//
// A Printing is kept when it is English, its set_type is not art_series, minigame or token, its border is not gold, it is not oversized, and its layout is not
// art_series, token, double_faced_token or emblem. set_type memorabilia is kept on purpose:
// Scryfall files the 30th Anniversary Edition (30a) there, and the Owner uses 30a Printings for
// Power and the dual lands. Digital-only Printings (MTGO and Arena sets such as vma, tpr, the
// Arena "ha" sets and the MTGO promos in prm) are kept too: every card in the Cube is a Proxy
// printed from Scryfall images, so a digital-only art is as printable as a paper one. Each record
// carries "digital" and "games" (for example ["mtgo"] or ["arena"]) so the client can tell them
// apart; the default rule never picks a digital Printing. Printings are newest first.
//
// Output: {"name", "oracle_id", "printings": [...]} per card. image_small, image_png and
// back_image_png are not stored, to keep the files small. The client derives them from
// image_normal (back_image_normal for the back): small by replacing "/normal/" with "/small/",
// png by replacing "/normal/" with "/png/" and ".jpg" with ".png".
// Files in public/data/printings/ for cards no longer in cards.json are removed, except those of
// the extra cards listed in public/data/extra-cards.json (see build-art-catalog.mjs).
// The Scryfall client and the Printing fields live in scripts/lib/scryfall.mjs.
// Node 24, no npm dependencies.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCard as loadCardFrom, cardPrintings, pretty, stats } from './lib/scryfall.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = join(ROOT, 'public', 'data', 'cards.json');
const EXTRA_CARDS = join(ROOT, 'public', 'data', 'extra-cards.json');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const CARD_DIR = join(OUT_DIR, 'printings');
const REFRESH = process.argv.includes('--refresh');

const loadCard = (oracleId) => loadCardFrom(CACHE, oracleId, REFRESH);

const started = Date.now();
const cardsFile = JSON.parse(await readFile(CARDS, 'utf8'));
await mkdir(CACHE, { recursive: true });

const out = {};
const zero = [];
const missing = [];
for (const [i, c] of cardsFile.cards.entries()) {
  const loaded = await loadCard(c.oracle_id);
  // Newest first; the sort is stable, so Scryfall's order is kept within a release date.
  const printings = cardPrintings(loaded);
  if (!printings.length) zero.push(c.name);
  out[c.oracle_id] = { name: c.name, oracle_id: c.oracle_id, printings };
  const ids = new Set(printings.map((p) => p.id));
  for (const role of ['in_box', 'wanted']) {
    const p = c[role];
    if (!ids.has(p.scryfall_id)) {
      missing.push(`${c.name} ${role} ${p.set} ${p.collector_number} (paper: ${p.paper})`);
    }
  }
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${cardsFile.cards.length} cards, ${stats.requests} requests`);
}
const generatedAt = new Date().toISOString();

await mkdir(CARD_DIR, { recursive: true });
const fileBytes = {};
for (const [oracleId, card] of Object.entries(out)) {
  const text = pretty(card) + '\n';
  fileBytes[oracleId] = Buffer.byteLength(text);
  await writeFile(join(CARD_DIR, `${oracleId}.json`), text);
}
// Files for the extra cards (public/data/extra-cards.json, written by build-art-catalog.mjs) are
// not stale.
const extraIds = new Set(
  existsSync(EXTRA_CARDS) ? JSON.parse(await readFile(EXTRA_CARDS, 'utf8')).map((c) => c.oracle_id) : [],
);
const stale = (await readdir(CARD_DIR)).filter(
  (f) => f.endsWith('.json') && !out[f.slice(0, -5)] && !extraIds.has(f.slice(0, -5)),
);
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
  digital: countBy('digital'),
  digital_by_game: all
    .filter((p) => p.digital)
    .reduce((res, p) => {
      const key = p.games.join('+') || 'none';
      res[key] = (res[key] || 0) + 1;
      return res;
    }, {}),
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
console.log(`Scryfall requests: ${stats.requests}, HTTP 429: ${stats.rateLimited}, wall time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`${Object.keys(fileBytes).length} files in public/data/printings/, ${meta.total_bytes} bytes`);
