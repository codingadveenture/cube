// scryfall.mjs: the Scryfall client and Printing fields shared by build-printings.mjs and
// build-art-catalog.mjs. Moved out of build-printings.mjs unchanged; see the comment at the top
// of build-printings.mjs for the request spacing, the 429 handling, the cache and the rules for
// which Printings are kept.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GAP_MS = 150;
const MIN_INTERVAL_MS = 750;
const MAX_429_RETRIES = 3;
export const HEADERS = {
  'User-Agent': 'cube-app-build/0.1 (github.com/codingadveenture/cube)',
  Accept: 'application/json',
};

const SKIP_SET_TYPES = new Set(['art_series', 'minigame', 'token']);
const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem']);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stats = { requests: 0, rateLimited: 0 };
let lastStart = 0;
let lastEnd = 0;

// Returns the parsed body, or null on 404 (a search with no results, or a name not found).
export async function getJson(url) {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const now = Date.now();
    const wait = Math.max(lastEnd + GAP_MS - now, lastStart + MIN_INTERVAL_MS - now, 0);
    if (lastStart && wait) await sleep(wait);
    lastStart = Date.now();
    stats.requests++;
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    lastEnd = Date.now();
    if (res.status === 429) {
      stats.rateLimited++;
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

export function searchUrl(oracleId) {
  const q = encodeURIComponent(`oracleid:${oracleId} lang:en`).replace(/%20/g, '+');
  return (
    `https://api.scryfall.com/cards/search?q=${q}&unique=prints&include_extras=true` +
    '&include_variations=true&order=released&dir=desc'
  );
}

// All Scryfall card objects for one oracle_id, from the cache or from the API.
export async function loadCard(cacheDir, oracleId, refresh = false) {
  const file = join(cacheDir, `printings-all-${oracleId}.json`);
  const url = searchUrl(oracleId);
  if (!refresh && existsSync(file)) {
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

export function keep(sc) {
  return (
    sc.lang === 'en' &&
    !SKIP_SET_TYPES.has(sc.set_type) &&
    sc.border_color !== 'gold' &&
    !sc.oversized &&
    !SKIP_LAYOUTS.has(sc.layout)
  );
}

export function printingFields(sc) {
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
    games: sc.games || [],
  };
}

// Kept Printings of one card, newest first; the sort is stable, so Scryfall's order is kept
// within a release date.
export function cardPrintings(loaded) {
  return loaded.data
    .filter(keep)
    .map(printingFields)
    .sort((a, b) => (a.released_at < b.released_at ? 1 : a.released_at > b.released_at ? -1 : 0));
}

// Pretty JSON with 1-space indent, except that leaf values (primitives, arrays of primitives,
// and flat objects whose values are primitives or arrays of primitives, such as a printing)
// stay on one line.
const isPrimitive = (v) => v === null || typeof v !== 'object';
export function pretty(value, indent = '') {
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
