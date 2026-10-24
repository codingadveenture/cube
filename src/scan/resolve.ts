// Resolve scanned Printings to their illustration_id.
// First from cards.json (In-box and Wanted Printings), then a localStorage cache, then
// Scryfall's POST /cards/collection (75 identifiers per request, 150 ms apart, back-off on 429).
import type { Card } from '../types';
import { printingKey, type ResolvedPrinting } from './diff';
import type { ScannedRow } from './parse';

export const CACHE_KEY = 'cube.scryfall-printings.v1';
export const CACHE_CAP = 2000;
const BATCH = 75;
const GAP_MS = 150;
const BACKOFF_MS = 2000;
const MAX_RETRIES = 5;

type Cache = Record<string, ResolvedPrinting>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Printings already known from cards.json, keyed by Scryfall id and by "set/number". */
export function knownPrintings(cards: Card[]): Map<string, ResolvedPrinting> {
  const map = new Map<string, ResolvedPrinting>();
  for (const c of cards) {
    for (const p of [c.in_box, c.wanted]) {
      const resolved: ResolvedPrinting = {
        illustration_id: p.illustration_id,
        name: c.name,
        set: p.set,
        collector_number: p.collector_number,
        image_small: p.image_small,
      };
      map.set(p.scryfall_id.toLowerCase(), resolved);
      map.set(`${p.set.toLowerCase()}/${p.collector_number.toLowerCase()}`, resolved);
    }
  }
  return map;
}

export function loadCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

/**
 * Merge new entries into the stored cache. The stored cache is read again here, so entries
 * written meanwhile by another resolve run are kept.
 */
export function saveCache(entries: Cache): void {
  const cache = loadCache();
  for (const [k, v] of Object.entries(entries)) {
    // Re-insert so the newest entries are last and survive trimming.
    delete cache[k];
    cache[k] = v;
  }
  const keys = Object.keys(cache);
  // Insertion order is kept by JS objects for string keys, so the oldest entries go first.
  const trimmed: Cache = {};
  for (const k of keys.slice(Math.max(0, keys.length - CACHE_CAP))) trimmed[k] = cache[k]!;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or blocked: the cache is a convenience only.
  }
}

interface ScryfallImageUris {
  small?: string;
}
interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  collector_number: string;
  illustration_id?: string;
  image_uris?: ScryfallImageUris;
  card_faces?: { illustration_id?: string; image_uris?: ScryfallImageUris }[];
}

function toResolved(c: ScryfallCard): ResolvedPrinting {
  const face = c.card_faces?.[0];
  return {
    illustration_id: c.illustration_id ?? face?.illustration_id ?? null,
    name: c.name,
    set: c.set,
    collector_number: c.collector_number,
    image_small: c.image_uris?.small ?? face?.image_uris?.small ?? null,
  };
}

type Identifier = { id: string } | { set: string; collector_number: string };

async function fetchCollection(identifiers: Identifier[], signal?: AbortSignal): Promise<ScryfallCard[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers }),
      signal,
    });
    if (res.status === 429) {
      await sleep(BACKOFF_MS * (attempt + 1));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      continue;
    }
    if (!res.ok) throw new Error(`Scryfall answered ${res.status}`);
    const body = (await res.json()) as { data?: ScryfallCard[] };
    return body.data ?? [];
  }
  throw new Error('Scryfall kept answering 429 (too many requests)');
}

export interface ResolveProgress {
  done: number;
  total: number;
}

export interface ResolveResult {
  /** printingKey -> ResolvedPrinting for every row resolved so far. */
  printings: Map<string, ResolvedPrinting>;
  /** Why the Scryfall lookup stopped early, or null. Printings found before that are kept. */
  error: string | null;
  /** True when the run was cancelled through its AbortSignal. */
  aborted: boolean;
}

/**
 * Resolve what can be resolved without the network: from cards.json and the localStorage cache.
 * Returns the resolved map and the identifiers still to fetch, keyed by printingKey.
 */
export function localPrintings(
  rows: ScannedRow[],
  known: ReadonlyMap<string, ResolvedPrinting>,
  cache: Cache = loadCache(),
): { printings: Map<string, ResolvedPrinting>; todo: Map<string, Identifier> } {
  const printings = new Map<string, ResolvedPrinting>();
  const todo = new Map<string, Identifier>();
  for (const r of rows) {
    const key = printingKey(r);
    if (!key || printings.has(key) || todo.has(key)) continue;
    const hit = known.get(key) ?? cache[key];
    if (hit) {
      printings.set(key, hit);
    } else if (r.scryfall_id) {
      todo.set(key, { id: r.scryfall_id });
    } else if (r.set && r.collector_number) {
      todo.set(key, { set: r.set, collector_number: r.collector_number });
    }
  }
  return { printings, todo };
}

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

/**
 * Resolve every scanned row that can be resolved. Unknown keys are fetched from Scryfall and
 * cached. Never throws: a failed request ends the lookup and is reported in `error`, with
 * everything resolved before it still returned. Aborting `signal` stops between batches and
 * cancels the request in flight.
 */
export async function resolvePrintings(
  rows: ScannedRow[],
  known: ReadonlyMap<string, ResolvedPrinting>,
  options: { onProgress?: (p: ResolveProgress) => void; signal?: AbortSignal } = {},
): Promise<ResolveResult> {
  const { onProgress, signal } = options;
  const { printings: out, todo } = localPrintings(rows, known);
  const entries = [...todo.entries()];
  onProgress?.({ done: 0, total: entries.length });
  for (let i = 0; i < entries.length; i += BATCH) {
    if (signal?.aborted) return { printings: out, error: null, aborted: true };
    try {
      if (i > 0) await sleep(GAP_MS);
      if (signal?.aborted) return { printings: out, error: null, aborted: true };
      const batch = entries.slice(i, i + BATCH);
      const cards = await fetchCollection(batch.map(([, ident]) => ident), signal);
      const fresh: Cache = {};
      for (const c of cards) {
        const resolved = toResolved(c);
        const byId = c.id.toLowerCase();
        const bySet = `${c.set.toLowerCase()}/${c.collector_number.toLowerCase()}`;
        for (const key of [byId, bySet]) {
          if (todo.has(key)) out.set(key, resolved);
          fresh[key] = resolved;
        }
      }
      saveCache(fresh);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) return { printings: out, error: null, aborted: true };
      return { printings: out, error: e instanceof Error ? e.message : String(e), aborted: false };
    }
    onProgress?.({ done: Math.min(i + BATCH, entries.length), total: entries.length });
  }
  return { printings: out, error: null, aborted: false };
}
