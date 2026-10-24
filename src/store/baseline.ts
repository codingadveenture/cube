// The baseline: card state documents built from cards.json, and the join back into Cards.
import type { Card, Flag, InBoxPrinting, PrintingBase, WantedPrinting } from '../types';
import type { CardState, InBoxState, WantedState } from './types';
import { pngImage, smallImage } from '../printings/images';

/** Documents per writeBatch (Firestore allows 500). */
export const BATCH_LIMIT = 400;

export function chunk<T>(items: T[], size = BATCH_LIMIT): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function cardStateOf(card: Card, now: string): CardState {
  const b = card.in_box;
  const w = card.wanted;
  return {
    name: card.name,
    in_box: {
      scryfall_id: b.scryfall_id,
      set: b.set,
      collector_number: b.collector_number,
      illustration_id: b.illustration_id,
      name: b.name,
      source: b.source,
      confidence: b.confidence,
    },
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

/** The full Printing for a stored one: reuse what cards.json knows, else derive the images. */
function printingFor(card: Card, s: InBoxState | WantedState): PrintingBase {
  const known = [card.in_box, card.wanted].find((p) => p.scryfall_id === s.scryfall_id);
  if (known) return { ...known, illustration_id: s.illustration_id ?? known.illustration_id };
  const hasBack = !!card.in_box.back_image_normal;
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
    back_name: hasBack ? card.in_box.back_name : null,
    back_image_normal: hasBack ? scryfallImage(s.scryfall_id, 'normal', 'back') : null,
    back_illustration_id: null,
  };
}

/** A Card from cards.json with its stored state laid over it. */
export function mergeCard(card: Card, state: CardState | undefined): Card {
  if (!state) return card;
  const in_box: InBoxPrinting = state.in_box
    ? { ...printingFor(card, state.in_box), source: state.in_box.source, confidence: state.in_box.confidence }
    : card.in_box;
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
  };
}

export function mergeCards(cards: Card[], states: ReadonlyMap<string, CardState>): Card[] {
  if (states.size === 0) return cards;
  return cards.map((c) => mergeCard(c, states.get(c.oracle_id)));
}
