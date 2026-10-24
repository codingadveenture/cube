// "Add more": extra batch lines from pasted text ("Name", "2 Name", "Name (SET) 123"), parsed with
// the Scan parser and resolved to a Printing: the card's Wanted Printing when the name is in the
// Cube, a set and number through the Scan resolver (cards.json, cache, Scryfall), else Scryfall's
// first hit for the name.
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { parsePlainText, type ScannedRow } from '../scan/parse';
import { knownPrintings } from '../scan/resolve';
import { lookupPrinting } from '../store/lookup';
import { scryfallImage } from '../store/baseline';
import type { ResolvedPrinting } from '../scan/diff';
import type { BatchLine } from './batch';
import { plainError } from './errors';

interface ScryfallFace {
  name: string;
  image_uris?: { normal?: string };
}

/** The part of a Scryfall card object an extra line needs. */
export interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  collector_number: string;
  illustration_id?: string;
  image_uris?: { normal?: string };
  card_faces?: (ScryfallFace & { illustration_id?: string })[];
}

export interface ExtraDeps {
  /** A set and number through the Scan resolver. */
  byPrinting(set: string, collector: string, cards: Card[]): Promise<ResolvedPrinting | null>;
  /** Scryfall's card for a name (first hit), or null when there is none. */
  byName(name: string, set: string | null): Promise<ScryfallCard | null>;
  /** Scryfall's card for an id, to find a back face. */
  byId(id: string): Promise<ScryfallCard | null>;
  newId(): string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scryfallGet(url: string): Promise<ScryfallCard | null> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Scryfall answered ${res.status}`);
  return (await res.json()) as ScryfallCard;
}

let counter = 0;

export const scryfallDeps: ExtraDeps = {
  byPrinting: (set, collector, cards) => lookupPrinting(set, collector, knownPrintings(cards)),
  async byName(name, set) {
    const q = `&exact=${encodeURIComponent(name)}${set ? `&set=${encodeURIComponent(set)}` : ''}`;
    const exact = await scryfallGet(`https://api.scryfall.com/cards/named?${q.slice(1)}`);
    if (exact) return exact;
    await sleep(100);
    return scryfallGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}${set ? `&set=${encodeURIComponent(set)}` : ''}`);
  },
  byId: (id) => scryfallGet(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`),
  newId: () => `${Date.now().toString(36)}-${(counter++).toString(36)}`,
};

function cubeCardFor(name: string, cards: Card[]): Card | undefined {
  const key = normalizeName(name);
  return cards.find((c) => normalizeName(c.name) === key || normalizeName(c.front_name) === key);
}

function fromWanted(card: Card, quantity: number, id: string): BatchLine {
  const w = card.wanted;
  return {
    key: `x:${id}`,
    source: 'extra',
    oracle_id: card.oracle_id,
    name: card.name,
    list_name: w.name ?? card.name,
    set: w.set,
    collector_number: w.collector_number,
    scryfall_id: w.scryfall_id,
    illustration_id: w.illustration_id,
    image_normal: w.image_normal,
    back_image_normal: w.back_image_normal,
    back_name: w.back_name,
    quantity,
  };
}

/** A line from a Scryfall card object; a card with faces but no top-level image is double-faced. */
export function fromScryfall(c: ScryfallCard, quantity: number, id: string, oracleId: string | null): BatchLine | null {
  const faces = c.card_faces ?? [];
  const front = c.image_uris?.normal ?? faces[0]?.image_uris?.normal;
  if (!front) return null;
  const doubleFaced = !c.image_uris?.normal && !!faces[1]?.image_uris?.normal;
  return {
    key: `x:${id}`,
    source: 'extra',
    oracle_id: oracleId,
    name: c.name,
    list_name: c.name,
    set: c.set,
    collector_number: c.collector_number,
    scryfall_id: c.id,
    illustration_id: c.illustration_id ?? faces[0]?.illustration_id ?? null,
    image_normal: front,
    back_image_normal: doubleFaced ? faces[1]!.image_uris!.normal! : null,
    back_name: doubleFaced ? faces[1]!.name : null,
    quantity,
  };
}

async function resolveRow(r: ScannedRow, cards: Card[], deps: ExtraDeps): Promise<BatchLine | null> {
  const card = cubeCardFor(r.name, cards);
  const id = deps.newId();
  if (!r.set || !r.collector_number) {
    if (card && !r.set) return fromWanted(card, r.quantity, id);
    const hit = await deps.byName(r.name, r.set);
    return hit ? fromScryfall(hit, r.quantity, id, card?.oracle_id ?? null) : null;
  }
  const set = r.set.toLowerCase();
  const num = r.collector_number;
  if (card && card.wanted.set.toLowerCase() === set && card.wanted.collector_number === num) return fromWanted(card, r.quantity, id);
  const p = await deps.byPrinting(set, num, cards);
  if (!p || !p.scryfall_id) return null;
  const owner = card ?? cubeCardFor(p.name, cards);
  if (owner || !p.name.includes(' // ')) {
    const doubleFaced = !!owner?.in_box.back_image_normal;
    return {
      key: `x:${id}`,
      source: 'extra',
      oracle_id: owner?.oracle_id ?? null,
      name: owner?.name ?? p.name,
      list_name: p.name,
      set: p.set,
      collector_number: p.collector_number,
      scryfall_id: p.scryfall_id,
      illustration_id: p.illustration_id,
      image_normal: p.image_small ? p.image_small.replace('/small/', '/normal/') : scryfallImage(p.scryfall_id, 'normal'),
      back_image_normal: doubleFaced ? scryfallImage(p.scryfall_id, 'normal', 'back') : null,
      back_name: doubleFaced ? owner!.in_box.back_name : null,
      quantity: r.quantity,
    };
  }
  // Not in the Cube and named "A // B": split or double-faced; ask Scryfall which.
  const full = await deps.byId(p.scryfall_id);
  return full ? fromScryfall(full, r.quantity, id, null) : null;
}

export interface ExtrasResult {
  lines: BatchLine[];
  /** The input lines that could not be resolved, with the reason. */
  failed: string[];
}

/** Resolve pasted text to extra batch lines, one lookup at a time. */
export async function resolveExtras(text: string, cards: Card[], deps: ExtraDeps = scryfallDeps): Promise<ExtrasResult> {
  const rows = parsePlainText(text);
  const lines: BatchLine[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    const label = `${r.quantity} ${r.name}${r.set ? ` (${r.set.toUpperCase()})${r.collector_number ? ` ${r.collector_number}` : ''}` : ''}`;
    try {
      const line = await resolveRow(r, cards, deps);
      if (line) lines.push(line);
      else failed.push(`${label}: not found`);
    } catch (e) {
      console.error(`Add more: ${label}`, e);
      failed.push(`${label}: ${plainError(e, 'scryfall')}`);
    }
  }
  return { lines, failed };
}

/** Extra lines from localStorage, keeping only well-formed ones. */
export function toExtras(v: unknown): BatchLine[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is BatchLine =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as BatchLine).key === 'string' &&
      typeof (x as BatchLine).name === 'string' &&
      typeof (x as BatchLine).image_normal === 'string' &&
      typeof (x as BatchLine).set === 'string',
  ).map((x) => ({
    ...x,
    list_name: typeof x.list_name === 'string' && x.list_name ? x.list_name : x.name,
    source: 'extra' as const,
    quantity: typeof x.quantity === 'number' && x.quantity > 0 ? x.quantity : 1,
  }));
}

/**
 * Add new extra lines to the existing ones. A line for the same Printing (same Scryfall id) as an
 * existing extra, or as an earlier new line, adds its quantity to that line instead of making a
 * second row, so every row keeps a unique key.
 */
export function mergeExtras(existing: BatchLine[], added: BatchLine[]): BatchLine[] {
  const out = existing.map((l) => ({ ...l }));
  const keys = new Set(out.map((l) => l.key));
  for (const a of added) {
    const same = a.scryfall_id ? out.find((l) => l.scryfall_id === a.scryfall_id) : undefined;
    if (same) {
      same.quantity += a.quantity;
      continue;
    }
    let key = a.key;
    for (let i = 2; keys.has(key); i++) key = `${a.key}-${i}`;
    keys.add(key);
    out.push({ ...a, key });
  }
  return out;
}
