// Scryfall for the Update flow: card facts by name (POST /cards/collection, 75 names per request)
// and every paper Printing of a card (GET /cards/search on oracleid, at least 600 ms apart, with
// Retry-After honoured). The converters at the top are pure and tested.
import { normalizeName } from '../lib/normalize';
import type { ColorCategory, TypeCategory } from '../types';
import type { CardFacts } from '../store/types';
import type { IndexPrinting } from '../printings/types';

// --- Pure converters -------------------------------------------------------------------------

interface ScryfallFace {
  name?: string;
  type_line?: string;
  mana_cost?: string;
  colors?: string[];
  oracle_id?: string;
  illustration_id?: string;
  artist?: string;
  image_uris?: { normal?: string };
}

/** The fields of a Scryfall card object that the app reads. */
export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  lang?: string;
  layout?: string;
  type_line?: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  rarity?: string;
  games?: string[];
  set: string;
  set_name?: string;
  set_type?: string;
  collector_number: string;
  released_at?: string;
  frame?: string;
  frame_effects?: string[];
  border_color?: string;
  full_art?: boolean;
  textless?: boolean;
  promo?: boolean;
  promo_types?: string[];
  finishes?: string[];
  image_status?: string;
  illustration_id?: string;
  artist?: string;
  image_uris?: { normal?: string };
  card_faces?: ScryfallFace[];
  security_stamp?: string;
  reprint?: boolean;
  variation?: boolean;
  booster?: boolean;
  digital?: boolean;
  oversized?: boolean;
  all_parts?: { component: string; name: string; id: string }[];
}

const TYPES: TypeCategory[] = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Land'];

/** As scripts/build-cards.mjs: Land first, then multicolour, colourless, else the one colour. */
export function colorCategory(frontType: string, colors: readonly string[]): ColorCategory {
  if (/\bLand\b/.test(frontType)) return 'L';
  if (colors.length > 1) return 'M';
  if (colors.length === 0) return 'C';
  return colors[0] as ColorCategory;
}

export function typeCategory(frontType: string): TypeCategory {
  return TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(frontType)) ?? 'Other';
}

export interface FactsHit {
  oracle_id: string;
  facts: CardFacts;
  /** The Printing Scryfall answered with (not the Wanted one). */
  scryfall_id: string;
}

/** Card facts from a Scryfall card object; oracle cycle tags are not on Scryfall's API and come from cubeJSON. */
export function factsFromScryfall(sc: ScryfallCard): FactsHit | null {
  const faces = sc.card_faces ?? [];
  const front = faces[0] ?? sc;
  const oracleId = sc.oracle_id ?? faces[0]?.oracle_id;
  if (!oracleId) return null;
  const frontType = front.type_line ?? sc.type_line ?? '';
  const colors = sc.colors ?? front.colors ?? [];
  const back = faces[1]?.image_uris ? faces[1] : null;
  return {
    oracle_id: oracleId,
    scryfall_id: sc.id,
    facts: {
      name: sc.name,
      type_line: sc.type_line ?? frontType,
      mana_cost: sc.mana_cost ?? front.mana_cost ?? '',
      cmc: sc.cmc ?? 0,
      colors,
      color_identity: sc.color_identity ?? [],
      color_category: colorCategory(frontType, colors),
      type_category: typeCategory(frontType),
      layout: sc.layout ?? 'normal',
      rarity: sc.rarity ?? '',
      image_normal: sc.image_uris?.normal ?? faces[0]?.image_uris?.normal ?? null,
      back_name: back?.name ?? null,
      back_image_normal: back?.image_uris?.normal ?? null,
      oracle_cycle_tags: [],
      produces_tokens: (sc.all_parts ?? []).filter((p) => p.component === 'token').map((p) => ({ name: p.name, scryfall_id: p.id })),
    },
  };
}

const SKIP_SET_TYPES = new Set(['art_series', 'minigame', 'token']);
const SKIP_LAYOUTS = new Set(['art_series', 'token', 'double_faced_token', 'emblem']);

/**
 * English paper cards, no tokens or art cards: the Printings scripts/build-printings.mjs keeps,
 * except that the script also keeps digital-only ones.
 */
export function keepPrinting(sc: ScryfallCard): boolean {
  return (
    (sc.lang ?? 'en') === 'en' &&
    (sc.games ?? []).includes('paper') &&
    !SKIP_SET_TYPES.has(sc.set_type ?? '') &&
    sc.border_color !== 'gold' &&
    !sc.oversized &&
    !SKIP_LAYOUTS.has(sc.layout ?? '')
  );
}

/** A Scryfall card object as an IndexPrinting, the shape of the printings files. */
export function indexPrinting(sc: ScryfallCard): IndexPrinting {
  const faces = sc.card_faces ?? [];
  const back = faces[1]?.image_uris ? faces[1] : null;
  return {
    id: sc.id,
    set: sc.set,
    set_name: sc.set_name ?? sc.set.toUpperCase(),
    set_type: sc.set_type ?? '',
    collector_number: sc.collector_number,
    released_at: sc.released_at ?? '',
    frame: sc.frame ?? '',
    frame_effects: sc.frame_effects ?? [],
    border_color: sc.border_color ?? '',
    full_art: !!sc.full_art,
    textless: !!sc.textless,
    promo: !!sc.promo,
    promo_types: sc.promo_types ?? [],
    finishes: sc.finishes ?? [],
    highres: sc.image_status === 'highres_scan',
    illustration_id: sc.illustration_id ?? faces[0]?.illustration_id ?? null,
    artist: sc.artist ?? faces[0]?.artist ?? '',
    image_normal: sc.image_uris?.normal ?? faces[0]?.image_uris?.normal ?? '',
    back_image_normal: back?.image_uris?.normal ?? null,
    back_illustration_id: back?.illustration_id ?? null,
    security_stamp: sc.security_stamp ?? null,
    reprint: !!sc.reprint,
    variation: !!sc.variation,
    booster: !!sc.booster,
    digital: !!sc.digital,
    games: sc.games ?? [],
  };
}

/** The name to ask /cards/collection for: the front face (Scryfall does not find "Fire // Ice", it finds "Fire"). */
export function lookupName(name: string): string {
  return (name.split(' // ')[0] ?? name).trim();
}

/** Every name a Scryfall answer can be matched back to, normalised. */
export function answerNames(sc: ScryfallCard): string[] {
  return [...new Set([sc.name, ...(sc.card_faces ?? []).map((f) => f.name ?? '')].filter(Boolean).map(normalizeName))];
}

// --- Network ---------------------------------------------------------------------------------

const API = 'https://api.scryfall.com';
const FACTS_KEY = 'cube.scryfall-facts.v1';
const FACTS_CAP = 1500;
const BATCH = 75;
const COLLECTION_GAP_MS = 150;
const SEARCH_GAP_MS = 600;

class Aborted extends Error {
  constructor() {
    super('Cancelled');
  }
}

export function isAborted(e: unknown): boolean {
  return e instanceof Aborted || (e instanceof DOMException && e.name === 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type FactsCache = Record<string, FactsHit>;
const memory = new Map<string, FactsHit | null>();

function loadFactsCache(): FactsCache {
  try {
    const raw = localStorage.getItem(FACTS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as FactsCache) : {};
  } catch {
    return {};
  }
}

function saveFactsCache(entries: FactsCache): void {
  const cache = loadFactsCache();
  for (const [k, v] of Object.entries(entries)) {
    delete cache[k];
    cache[k] = v;
  }
  const keys = Object.keys(cache);
  const out: FactsCache = {};
  for (const k of keys.slice(Math.max(0, keys.length - FACTS_CAP))) out[k] = cache[k]!;
  try {
    localStorage.setItem(FACTS_KEY, JSON.stringify(out));
  } catch {
    // Full or blocked storage: the cache is a convenience only.
  }
}

/** The facts already known for a name (memory, then localStorage); undefined when never asked, null when not found. */
export function cachedFacts(name: string): FactsHit | null | undefined {
  const k = normalizeName(name);
  if (memory.has(k)) return memory.get(k);
  const hit = loadFactsCache()[k];
  if (hit) memory.set(k, hit);
  return hit;
}

interface CollectionBody {
  data?: ScryfallCard[];
  not_found?: unknown[];
}

export interface Progress {
  done: number;
  total: number;
}

/**
 * Facts for every name, from the caches or from /cards/collection in batches of 75. Names Scryfall
 * does not know map to null. Batches already answered stay cached when it is cancelled (it then
 * rejects) or a later request fails.
 */
export async function fetchFacts(
  names: readonly string[],
  onProgress?: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<Map<string, FactsHit | null>> {
  const out = new Map<string, FactsHit | null>();
  const todo: string[] = [];
  const cache = loadFactsCache();
  for (const name of names) {
    const k = normalizeName(name);
    if (memory.has(k)) out.set(name, memory.get(k)!);
    else if (cache[k]) {
      memory.set(k, cache[k]!);
      out.set(name, cache[k]!);
    } else todo.push(name);
  }
  const total = todo.length;
  onProgress?.({ done: 0, total });
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    if (i > 0) await sleep(COLLECTION_GAP_MS, signal);
    let body = null as CollectionBody | null;
    for (let attempt = 0; attempt < 4 && !body; attempt++) {
      const res = await fetch(`${API}/cards/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: part.map((n) => ({ name: lookupName(n) })) }),
        signal,
      });
      if (res.status === 429) {
        await sleep(retryAfterMs(res, 2000), signal);
        continue;
      }
      if (!res.ok) throw new Error(`Scryfall answered HTTP ${res.status}`);
      body = (await res.json()) as CollectionBody;
    }
    if (!body) throw new Error('Scryfall kept answering "too many requests". Try again in a minute.');
    const byName = new Map<string, FactsHit>();
    for (const sc of body.data ?? []) {
      const hit = factsFromScryfall(sc);
      if (hit) for (const n of answerNames(sc)) byName.set(n, hit);
    }
    const fresh: FactsCache = {};
    for (const name of part) {
      const hit = byName.get(normalizeName(name)) ?? byName.get(normalizeName(lookupName(name))) ?? null;
      memory.set(normalizeName(name), hit);
      if (hit) fresh[normalizeName(name)] = hit;
      out.set(name, hit);
    }
    saveFactsCache(fresh);
    onProgress?.({ done: Math.min(total, i + part.length), total });
  }
  return out;
}

function retryAfterMs(res: Response, fallback: number): number {
  const s = Number(res.headers.get('Retry-After'));
  return Number.isFinite(s) && s > 0 ? s * 1000 + 500 : fallback;
}

let lastSearchStart = 0;

/** One /cards/search GET, at least 600 ms after the previous one started, Retry-After honoured. */
async function searchGet(url: string, signal?: AbortSignal): Promise<{ data: ScryfallCard[]; has_more?: boolean; next_page?: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastSearchStart + SEARCH_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastSearchStart = Date.now();
    const res = await fetch(url, { signal });
    if (res.status === 404) return null;
    if (res.status === 429) {
      await sleep(retryAfterMs(res, 60_000), signal);
      continue;
    }
    if (!res.ok) throw new Error(`Scryfall answered HTTP ${res.status}`);
    return (await res.json()) as { data: ScryfallCard[]; has_more?: boolean; next_page?: string };
  }
  throw new Error('Scryfall kept answering "too many requests".');
}

export function searchUrl(oracleId: string): string {
  const q = encodeURIComponent(`oracleid:${oracleId} game:paper lang:en`).replace(/%20/g, '+');
  return `${API}/cards/search?q=${q}&unique=prints&include_extras=true&include_variations=true&order=released&dir=desc`;
}

/** Every English paper Printing of a card, newest first, as the printings files have them. */
export async function searchPrintings(oracleId: string, signal?: AbortSignal): Promise<IndexPrinting[]> {
  const out: IndexPrinting[] = [];
  let next: string | null = searchUrl(oracleId);
  while (next) {
    const body = await searchGet(next, signal);
    if (!body) break;
    for (const sc of body.data) if (keepPrinting(sc)) out.push(indexPrinting(sc));
    next = body.has_more && body.next_page ? body.next_page : null;
  }
  return out;
}
