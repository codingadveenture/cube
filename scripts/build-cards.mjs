// build-cards.mjs: turn data/cube-record.json into public/data/cards.json and meta.json.
//
// Usage (from the repo root):
//   node scripts/build-cards.mjs [--refresh]
//
// Collects every distinct Scryfall printing id from in_box and wanted, fetches them with
// POST https://api.scryfall.com/cards/collection (75 ids per request, 150 ms between requests,
// 2 s back-off on HTTP 429, up to 5 retries) and caches each response under
// scripts/.cache/collection-<n>.json. Cached responses are reused unless --refresh is given.
// Node 24, no npm dependencies.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = join(ROOT, 'data', 'cube-record.json');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const REFRESH = process.argv.includes('--refresh');
const BATCH = 75;
const GAP_MS = 150;
const HEADERS = {
  'User-Agent': 'cube-app-build/0.1 (github.com/codingadveenture/cube)',
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function fetchCollection(ids) {
  for (let attempt = 0; attempt <= 5; attempt++) {
    requests++;
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ identifiers: ids.map((id) => ({ id })) }),
    });
    if (res.status === 429) {
      if (attempt === 5) break;
      console.warn('429 from Scryfall, waiting 2 s');
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`Scryfall HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('Scryfall kept answering 429');
}

async function loadPrintings(ids) {
  await mkdir(CACHE, { recursive: true });
  const byId = new Map();
  const notFound = [];
  let fetched = false;
  for (let i = 0, n = 0; i < ids.length; i += BATCH, n++) {
    const chunk = ids.slice(i, i + BATCH);
    const file = join(CACHE, `collection-${n}.json`);
    let body = null;
    if (!REFRESH && existsSync(file)) {
      body = JSON.parse(await readFile(file, 'utf8'));
      // A cache made from a different id list is stale; refetch that chunk.
      const cachedIds = new Set([
        ...body.data.map((c) => c.id),
        ...(body.not_found || []).map((x) => x.id),
      ]);
      if (!chunk.every((id) => cachedIds.has(id))) body = null;
    }
    if (!body) {
      if (fetched) await sleep(GAP_MS);
      body = await fetchCollection(chunk);
      fetched = true;
      await writeFile(file, JSON.stringify(body));
    }
    for (const c of body.data) byId.set(c.id, c);
    for (const x of body.not_found || []) notFound.push(x.id);
  }
  return { byId, notFound };
}

const frontFace = (c) => (c.card_faces && c.card_faces.length ? c.card_faces[0] : c);

// recordName is the name printed on this Printing, from data/cube-record.json (in_box.name,
// wanted.name). It differs from the card name for Through the Omenpaths renames, whose paper
// Printings carry the Spider-Man names, and it includes the back face of double-faced cards.
function printingFields(sc, recordName) {
  const faces = sc.card_faces || [];
  const imgSrc = sc.image_uris || (faces[0] && faces[0].image_uris) || {};
  // back_* only when the second face has its own image (transform, modal_dfc,
  // double_faced_token, reversible_card).
  const back = faces[1] && faces[1].image_uris ? faces[1] : null;
  return {
    scryfall_id: sc.id,
    name: recordName || sc.name || null,
    set: sc.set,
    set_name: sc.set_name,
    collector_number: sc.collector_number,
    released_at: sc.released_at,
    lang: sc.lang,
    paper: (sc.games || []).includes('paper'),
    frame: sc.frame,
    border_color: sc.border_color,
    illustration_id: sc.illustration_id || (faces[0] && faces[0].illustration_id) || null,
    artist: sc.artist || (faces[0] && faces[0].artist) || null,
    image_small: imgSrc.small || null,
    image_normal: imgSrc.normal || null,
    image_png: imgSrc.png || null,
    back_name: back ? back.name : null,
    back_image_normal: back ? back.image_uris.normal : null,
    back_illustration_id: back ? back.illustration_id || null : null,
  };
}

function colorCategory(frontType, colors) {
  if (/\bLand\b/.test(frontType)) return 'L';
  if (colors.length > 1) return 'M';
  if (colors.length === 0) return 'C';
  return colors[0];
}

const TYPES = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];
function typeCategory(frontType) {
  return TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(frontType)) || 'Other';
}

const record = JSON.parse(await readFile(RECORD, 'utf8'));
const ids = [...new Set(record.cards.flatMap((c) => [c.in_box.scryfall_id, c.wanted.scryfall_id]))];
const scryfallFetchedAt = new Date().toISOString();
const { byId, notFound } = await loadPrintings(ids);
if (notFound.length) console.warn(`not_found: ${notFound.join(', ')}`);

const cards = record.cards.map((c) => {
  const box = byId.get(c.in_box.scryfall_id);
  const want = byId.get(c.wanted.scryfall_id);
  if (!box || !want) throw new Error(`missing Scryfall data for ${c.name}`);
  // Card-level (oracle) fields come from the Wanted Printing: it is a paper Printing with the
  // real card names, unlike some digital In-box Printings (Through the Omenpaths renames).
  const sc = want;
  const front = frontFace(sc);
  const frontType = front.type_line || sc.type_line || '';
  const colors = sc.colors || front.colors || [];
  return {
    name: c.name,
    front_name: c.name.split(' // ')[0].trim(),
    oracle_id: c.oracle_id,
    in_list: c.in_list,
    list_source: c.list_source,
    cubecobra_card_id: c.cubecobra_card_id,
    layout: sc.layout,
    type_line: sc.type_line,
    mana_cost: sc.mana_cost ?? front.mana_cost ?? '',
    cmc: sc.cmc ?? 0,
    colors,
    color_identity: sc.color_identity || [],
    color_category: colorCategory(frontType, colors),
    type_category: typeCategory(frontType),
    rarity: sc.rarity,
    keywords: sc.keywords || [],
    produces_tokens: (sc.all_parts || [])
      .filter((p) => p.component === 'token')
      .map((p) => ({ name: p.name, scryfall_id: p.id })),
    in_box: { ...printingFields(box, c.in_box.name), source: c.in_box.source, confidence: c.in_box.confidence },
    wanted: { ...printingFields(want, c.wanted.name), reason: c.wanted.reason },
    cycles: c.cycles,
    oracle_cycle_tags: c.oracle_cycle_tags,
    flags: c.flags,
  };
});
cards.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

const countBy = (key) => {
  const out = {};
  for (const c of cards) out[c[key]] = (out[c[key]] || 0) + 1;
  return out;
};
const meta = {
  cards: cards.length,
  by_color_category: countBy('color_category'),
  by_type_category: countBy('type_category'),
  cards_with_back_face: cards.filter((c) => c.in_box.back_image_normal).length,
  cards_with_tokens: cards.filter((c) => c.produces_tokens.length).length,
  in_box_not_paper: cards.filter((c) => !c.in_box.paper).length,
};

const out = {
  generated_at: new Date().toISOString(),
  source: { cube_record_generated_at: record.generated_at, scryfall_fetched_at: scryfallFetchedAt },
  cards,
};
// Pretty JSON with 1-space indent, except that short leaf values (arrays of strings,
// flat objects such as tokens, flags, in_box and wanted) stay on one line to keep the file
// under 1.2 MB.
function pretty(value, indent = '') {
  const flat = JSON.stringify(value);
  const isLeaf =
    value === null ||
    typeof value !== 'object' ||
    (Object.values(value).every((v) => v === null || typeof v !== 'object'));
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

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'cards.json'), pretty(out) + '\n');
await writeFile(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');

const size = async (f) => (await stat(join(OUT_DIR, f))).size;
console.log(`ids: ${ids.length}, Scryfall requests: ${requests}, not found: ${notFound.length}`);
console.log(JSON.stringify(meta, null, 1));
console.log(`cards.json ${await size('cards.json')} bytes, meta.json ${await size('meta.json')} bytes`);
