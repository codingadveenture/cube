// The card lifecycle: to print, in the box, to pull, retired. Pure: no React, no storage.
import type { Card, Lifecycle } from '../types';
import type { CardPatchFor } from './types';

/** Where a card stands, from whether it is in the box and whether it is on the List. */
export function lifecycleOf(card: Pick<Card, 'in_box' | 'in_list'>): Lifecycle {
  if (card.in_box) return card.in_list ? 'in_box' : 'to_pull';
  return card.in_list ? 'to_print' : 'retired';
}

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  in_box: 'In the Cube',
  to_print: 'To print',
  to_pull: 'To pull',
  retired: 'Retired',
};

export interface Partition {
  /** In the box and on the List: the Cube's sections. */
  inBox: Card[];
  toPrint: Card[];
  toPull: Card[];
  retired: Card[];
}

export function partitionCards(cards: readonly Card[]): Partition {
  const p: Partition = { inBox: [], toPrint: [], toPull: [], retired: [] };
  for (const c of cards) {
    const l = lifecycleOf(c);
    if (l === 'in_box') p.inBox.push(c);
    else if (l === 'to_print') p.toPrint.push(c);
    else if (l === 'to_pull') p.toPull.push(c);
    else p.retired.push(c);
  }
  return p;
}

/** Cards physically in the box (on the List or waiting to be pulled). */
export function physicallyPresent(cards: readonly Card[]): Card[] {
  return cards.filter((c) => c.in_box !== null);
}

/**
 * The Cycles each oracle cycle tag stands for, as observed on the cards that have both: a tag
 * maps to a Cycle when every card carrying the tag is in that Cycle. A broad tag such as
 * cycle-land, carried by cards of many Cycles, maps to none.
 */
export function cycleTagMap(cards: readonly Pick<Card, 'cycles' | 'oracle_cycle_tags'>[]): Map<string, string[]> {
  const seen = new Map<string, { count: number; cycles: Map<string, number> }>();
  for (const c of cards) {
    for (const tag of new Set(c.oracle_cycle_tags)) {
      let s = seen.get(tag);
      if (!s) seen.set(tag, (s = { count: 0, cycles: new Map() }));
      s.count++;
      for (const cy of new Set(c.cycles)) s.cycles.set(cy, (s.cycles.get(cy) ?? 0) + 1);
    }
  }
  const out = new Map<string, string[]>();
  for (const [tag, s] of seen) {
    const all = [...s.cycles].filter(([, n]) => n === s.count).map(([cy]) => cy).sort();
    if (all.length) out.set(tag, all);
  }
  return out;
}

/** The Cycles of a card that is not in cards.json, from its oracle cycle tags; none when no tag maps. */
export function deriveCycles(tags: readonly string[], map: ReadonlyMap<string, string[]>): string[] {
  const out = new Set<string>();
  for (const t of tags) for (const cy of map.get(t) ?? []) out.add(cy);
  return [...out].sort();
}

/** Mark pulled: In-box goes to retired_printing, In-box becomes null. Only cards to pull. */
export function pullPatches(cards: readonly Card[], now: string): CardPatchFor[] {
  const out: CardPatchFor[] = [];
  for (const c of cards) {
    if (lifecycleOf(c) !== 'to_pull' || !c.in_box) continue;
    const b = c.in_box;
    out.push({
      oracle_id: c.oracle_id,
      patch: {
        kind: 'pull',
        at: now,
        retired_printing: {
          scryfall_id: b.scryfall_id,
          set: b.set,
          collector_number: b.collector_number,
          illustration_id: b.illustration_id,
          name: b.name,
          source: b.source,
          confidence: b.confidence,
          image_normal: b.image_normal,
        },
      },
    });
  }
  return out;
}

/** The Printing to show for a card: In-box when it is in the box, else Wanted. */
export function shownPrinting(card: Card) {
  return card.in_box ?? card.wanted;
}
