// The baseline: card state documents built from cards.json, and the join back into Cards.
import type { Card, Flag, InBoxPrinting, PrintingBase, WantedPrinting } from '../types';
import type { CardState, CubeDoc, InBoxState, WantedState } from './types';
import { pngImage, smallImage } from '../printings/images';
import { cycleTagMap, deriveCycles } from './lifecycle';

/** Documents per writeBatch (Firestore allows 500). */
export const BATCH_LIMIT = 400;

export function chunk<T>(items: T[], size = BATCH_LIMIT): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The cubes/main fields an import writes (merged). baselineImportedAt records the first import
 * only: a top-up import, made while the server already holds card docs, leaves it alone.
 */
export function baselineCubeDoc(now: string, docsOnServer: number): Omit<CubeDoc, 'baselineImportedAt'> & Partial<Pick<CubeDoc, 'baselineImportedAt'>> {
  return {
    name: 'Vintage Cube',
    cubecobraId: 'MTGVintageCube',
    upstreamId: 'modovintage',
    ...(docsOnServer === 0 ? { baselineImportedAt: now } : {}),
    updatedAt: now,
  };
}

export function cardStateOf(card: Card, now: string): CardState {
  const b = card.in_box;
  const w = card.wanted;
  return {
    name: card.name,
    in_box: b
      ? {
          scryfall_id: b.scryfall_id,
          set: b.set,
          collector_number: b.collector_number,
          illustration_id: b.illustration_id,
          name: b.name,
          source: b.source,
          confidence: b.confidence,
        }
      : null,
    wanted: {
      scryfall_id: w.scryfall_id,
      set: w.set,
      collector_number: w.collector_number,
      illustration_id: w.illustration_id,
      name: w.name,
      reason: w.reason,
    },
    flags: card.flags.map((f) => ({ type: f.type, by: f.by, note: f.note ?? '', createdAt: f.createdAt ?? null })),
    in_list: card.in_list,
    list_source: card.list_source,
    updatedAt: now,
  };
}

/** Card docs to write for the baseline: every card of cards.json without a doc yet. */
export function baselineDocs(cards: Card[], existing: ReadonlySet<string>, now: string): [string, CardState][] {
  return cards.filter((c) => !existing.has(c.oracle_id)).map((c) => [c.oracle_id, cardStateOf(c, now)]);
}

/** The baseline docs left after dropping every id the server already has. */
export function withoutExisting(docs: [string, CardState][], existing: ReadonlySet<string>): [string, CardState][] {
  return docs.filter(([id]) => !existing.has(id));
}

/** Scryfall's image URL for a Printing id, the pattern cards.json uses. */
export function scryfallImage(id: string, size: 'small' | 'normal' | 'png', face: 'front' | 'back' = 'front'): string {
  const ext = size === 'png' ? 'png' : 'jpg';
  return `https://cards.scryfall.io/${size}/${face}/${id[0]}/${id[1]}/${id}.${ext}`;
}

/** A Printing known only by its stored fields: the images are derived from the Scryfall id. */
function derivedPrinting(s: InBoxState | WantedState, back: { has: boolean; name: string | null }): PrintingBase {
  // A Wanted Printing written from the printings index (or an In-box one marked as printed) carries its own image URL.
  // Only an image of this very Printing counts: a merge-write can leave an older Printing's image behind.
  const stored = 'image_normal' in s && s.image_normal && s.image_normal.includes(s.scryfall_id) ? s.image_normal : null;
  return {
    scryfall_id: s.scryfall_id,
    name: s.name,
    set: s.set,
    set_name: s.set.toUpperCase(),
    collector_number: s.collector_number,
    released_at: '',
    lang: 'en',
    paper: true,
    frame: '',
    border_color: '',
    illustration_id: s.illustration_id,
    artist: '',
    image_small: stored ? smallImage(stored) : scryfallImage(s.scryfall_id, 'small'),
    image_normal: stored ?? scryfallImage(s.scryfall_id, 'normal'),
    image_png: stored ? pngImage(stored) : scryfallImage(s.scryfall_id, 'png'),
    back_name: back.has ? back.name : null,
    back_image_normal: back.has ? scryfallImage(s.scryfall_id, 'normal', 'back') : null,
    back_illustration_id: null,
  };
}

/** The full Printing for a stored one: reuse what the card already knows, else derive the images. */
function printingFor(card: Card, s: InBoxState | WantedState): PrintingBase {
  const known = [card.in_box, card.wanted].find((p) => p && p.scryfall_id === s.scryfall_id);
  if (known) return { ...known, illustration_id: s.illustration_id ?? known.illustration_id };
  const face = card.in_box ?? card.wanted;
  return derivedPrinting(s, { has: !!face.back_image_normal, name: face.back_name });
}

/** A Card from cards.json with its stored state laid over it. */
export function mergeCard(card: Card, state: CardState | undefined): Card {
  if (!state) return card;
  // A doc with in_box: null is a card not printed yet or pulled; a doc without the field keeps cards.json's.
  let in_box: InBoxPrinting | null = card.in_box;
  if (state.in_box === null) in_box = null;
  else if (state.in_box) in_box = { ...printingFor(card, state.in_box), source: state.in_box.source, confidence: state.in_box.confidence };
  const wanted: WantedPrinting = state.wanted
    ? { ...printingFor(card, state.wanted), reason: state.wanted.reason }
    : card.wanted;
  const flags: Flag[] = Array.isArray(state.flags) ? state.flags.map((f) => ({ ...f })) : card.flags;
  return {
    ...card,
    in_box,
    wanted,
    flags,
    in_list: typeof state.in_list === 'boolean' ? state.in_list : card.in_list,
    list_source: (state.list_source as Card['list_source'] | undefined) ?? card.list_source,
    retired_printing: state.retired_printing ?? card.retired_printing ?? null,
    added_at: state.added_at ?? card.added_at ?? null,
    retired_at: state.retired_at ?? card.retired_at ?? null,
  };
}

/**
 * A Card for a doc that is not in cards.json, drawn from the facts on the doc; null when the doc
 * has no facts or no Wanted Printing. Its Cycles come from its oracle cycle tags.
 */
export function cardFromFacts(oracleId: string, state: CardState, cycleMap: ReadonlyMap<string, string[]>): Card | null {
  const f = state.facts;
  if (!f || !state.wanted) return null;
  const tags = f.oracle_cycle_tags ?? state.oracle_cycle_tags ?? [];
  const back = { has: !!f.back_image_normal, name: f.back_name };
  const wanted = { ...derivedPrinting(state.wanted, back), reason: state.wanted.reason };
  const name = f.name || state.name;
  const base: Card = {
    name,
    front_name: name.split(' // ')[0]!.trim(),
    oracle_id: oracleId,
    in_list: state.in_list,
    list_source: (state.list_source as Card['list_source']) || 'upstream',
    cubecobra_card_id: null,
    layout: f.layout,
    type_line: f.type_line,
    mana_cost: f.mana_cost,
    cmc: f.cmc,
    colors: f.colors,
    color_identity: f.color_identity,
    color_category: f.color_category,
    type_category: f.type_category,
    rarity: f.rarity ?? '',
    keywords: [],
    produces_tokens: f.produces_tokens ?? [],
    in_box: null,
    wanted,
    cycles: deriveCycles(tags, cycleMap),
    oracle_cycle_tags: tags,
    flags: [],
    from_facts: true,
  };
  return mergeCard(base, state);
}

const tagMaps = new WeakMap<Card[], Map<string, string[]>>();
function tagMapOf(cards: Card[]): Map<string, string[]> {
  const hit = tagMaps.get(cards);
  if (hit) return hit;
  const m = cycleTagMap(cards);
  tagMaps.set(cards, m);
  return m;
}

/** cards.json with the stored state laid over it, plus every card that exists only as a doc with facts. */
export function mergeCards(cards: Card[], states: ReadonlyMap<string, CardState>): Card[] {
  if (states.size === 0) return cards;
  const known = new Set(cards.map((c) => c.oracle_id));
  const merged = cards.map((c) => mergeCard(c, states.get(c.oracle_id)));
  for (const [id, state] of states) {
    if (known.has(id)) continue;
    const c = cardFromFacts(id, state, tagMapOf(cards));
    if (c) merged.push(c);
  }
  return merged;
}
