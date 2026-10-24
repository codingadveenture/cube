/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardsFile } from '../types';
import { cardStateOf, mergeCards } from './baseline';
import { cycleTagMap, deriveCycles, lifecycleOf, partitionCards, physicallyPresent, pullPatches } from './lifecycle';
import { cardPatchWrite } from './writes';
import type { CardFacts, CardState } from './types';
import { expectedCards } from '../scan/expected';
import { markPrintedPatches, newCardLines, reprintLines } from '../print/batch';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const NOW = '2026-10-24T12:00:00.000Z';
const byName = (n: string) => cards.find((c) => c.name === n)!;

const NEW_ID = '00000000-1111-2222-3333-444444444444';
const facts: CardFacts = {
  name: 'Marsh Flats Test',
  type_line: 'Land',
  mana_cost: '',
  cmc: 0,
  colors: [],
  color_identity: [],
  color_category: 'L',
  type_category: 'Land',
  layout: 'normal',
  rarity: 'rare',
  image_normal: 'https://cards.scryfall.io/normal/front/a/b/abc.jpg',
  back_name: null,
  back_image_normal: null,
  oracle_cycle_tags: ['cycle-zen-fetchland', 'cycle-land'],
  produces_tokens: [],
};

function newDoc(over: Partial<CardState> = {}): CardState {
  return {
    name: facts.name,
    in_box: null,
    wanted: {
      scryfall_id: 'abcdef12-0000-0000-0000-000000000000',
      set: 'zen',
      collector_number: '219',
      illustration_id: null,
      name: facts.name,
      reason: 'default-rule',
      image_normal: 'https://cards.scryfall.io/normal/front/a/b/abcdef12-0000-0000-0000-000000000000.jpg',
    },
    flags: [],
    in_list: true,
    list_source: 'upstream',
    facts,
    oracle_cycle_tags: facts.oracle_cycle_tags,
    retired_printing: null,
    added_at: NOW,
    retired_at: null,
    updatedAt: NOW,
    ...over,
  };
}

describe('lifecycleOf', () => {
  const box = cards[0]!.in_box;
  it('reads the four states from In-box and in_list', () => {
    expect(lifecycleOf({ in_box: box, in_list: true })).toBe('in_box');
    expect(lifecycleOf({ in_box: null, in_list: true })).toBe('to_print');
    expect(lifecycleOf({ in_box: box, in_list: false })).toBe('to_pull');
    expect(lifecycleOf({ in_box: null, in_list: false })).toBe('retired');
  });
});

describe('merging lifecycle docs', () => {
  const bolt = byName('Lightning Bolt');
  const sol = byName('Sol Ring');
  const out = { ...cardStateOf(bolt, NOW), in_list: false };
  const pulled = { ...cardStateOf(sol, NOW), in_list: false, in_box: null, retired_printing: cardStateOf(sol, NOW).in_box, retired_at: NOW };
  const states = new Map<string, CardState>([
    [bolt.oracle_id, out],
    [sol.oracle_id, pulled],
    [NEW_ID, newDoc()],
  ]);
  const merged = mergeCards(cards, states);
  const get = (id: string) => merged.find((c) => c.oracle_id === id)!;

  it('keeps every cards.json card and adds the cards that exist only as docs with facts', () => {
    expect(merged.length).toBe(cards.length + 1);
    const n = get(NEW_ID);
    expect(n.name).toBe('Marsh Flats Test');
    expect(n.from_facts).toBe(true);
    expect(n.color_category).toBe('L');
    expect(n.wanted.set).toBe('zen');
    expect(n.wanted.image_small).toContain('/small/');
  });

  it('gives to print, to pull and retired', () => {
    expect(lifecycleOf(get(NEW_ID))).toBe('to_print');
    expect(lifecycleOf(get(bolt.oracle_id))).toBe('to_pull');
    expect(lifecycleOf(get(sol.oracle_id))).toBe('retired');
    expect(get(sol.oracle_id).retired_printing?.scryfall_id).toBe(sol.in_box!.scryfall_id);
    const p = partitionCards(merged);
    expect([p.toPrint.length, p.toPull.length, p.retired.length]).toEqual([1, 1, 1]);
    expect(p.inBox.length).toBe(cards.length - 2);
    expect(physicallyPresent(merged).length).toBe(cards.length - 1);
  });

  it('keeps the cards.json In-box for a doc without the field', () => {
    const partial = new Map<string, CardState>([[bolt.oracle_id, { in_list: false } as CardState]]);
    const m = mergeCards(cards, partial).find((c) => c.oracle_id === bolt.oracle_id)!;
    expect(m.in_box?.scryfall_id).toBe(bolt.in_box!.scryfall_id);
    expect(lifecycleOf(m)).toBe('to_pull');
  });

  it('skips a doc that is not in cards.json and has no facts', () => {
    const m = mergeCards(cards, new Map([[NEW_ID, newDoc({ facts: null })]]));
    expect(m.length).toBe(cards.length);
  });

  it('derives the Cycles of a new card from its oracle cycle tags', () => {
    expect(get(NEW_ID).cycles).toEqual(['fetchlands', 'fetchlands_enemy']);
  });

  it('puts a to-print card in the Print batch as a new slip and marks it printed', () => {
    const lines = newCardLines(merged);
    expect(lines.map((l) => l.oracle_id)).toEqual([NEW_ID]);
    expect(lines[0]!.source).toBe('new');
    expect(lines[0]!.key).toBe(`n:${NEW_ID}`);
    expect(lines[0]!.image_normal).toBe(newDoc().wanted.image_normal);
    // A card to pull or retired is never a reprint.
    expect(reprintLines(merged).some((l) => l.oracle_id === bolt.oracle_id || l.oracle_id === sol.oracle_id)).toBe(false);
    const patches = markPrintedPatches(merged, lines);
    expect(patches).toHaveLength(1);
    const p = patches[0]!.patch;
    expect(p.kind === 'in_box' && p.in_box.source).toBe('printed');
    // Once printed, the card is in the box.
    const printed = mergeCards(cards, new Map([[NEW_ID, newDoc({ in_box: p.kind === 'in_box' ? p.in_box : null })]]));
    expect(lifecycleOf(printed.find((c) => c.oracle_id === NEW_ID)!)).toBe('in_box');
  });

  it('makes the Scan expect exactly the cards with an In-box Printing', () => {
    const expected = new Set(expectedCards(merged).map((c) => c.oracle_id));
    expect(expected.size).toBe(cards.length - 1);
    expect(expected.has(bolt.oracle_id)).toBe(true); // to pull: still in the box
    expect(expected.has(sol.oracle_id)).toBe(false); // retired
    expect(expected.has(NEW_ID)).toBe(false); // to print
  });
});

describe('Mark pulled', () => {
  it('moves In-box to retired_printing and clears In-box, for cards to pull only', () => {
    const bolt = byName('Lightning Bolt');
    const toPull: Card = { ...bolt, in_list: false };
    const patches = pullPatches([toPull, bolt], NOW);
    expect(patches).toHaveLength(1);
    const w = cardPatchWrite(patches[0]!.patch, NOW);
    expect(w.fields.in_box).toBeNull();
    expect((w.fields.retired_printing as { scryfall_id: string }).scryfall_id).toBe(bolt.in_box!.scryfall_id);
    expect(w.fields.retired_at).toBe(NOW);
  });
});

describe('Cycle derivation from oracle cycle tags', () => {
  const map = cycleTagMap(cards);
  it('maps a tag to the Cycles every card with that tag is in', () => {
    expect(map.get('cycle-talisman')).toEqual(['talismans', 'talismans_in_cube_only']);
    expect(map.get('cycle-mh2-incarnation')).toEqual(['mh2_evoke_elementals']);
    expect(map.get('cycle-rav-shockland')).toEqual(['shocklands']);
  });
  it('maps a broad or mixed tag to nothing', () => {
    expect(map.has('cycle-land')).toBe(false);
    expect(map.has('cycle-lea-boon')).toBe(false);
    expect(map.has('cycle-mono-land')).toBe(false);
  });
  it('gives none for unknown tags', () => {
    expect(deriveCycles(['cycle-new-thing', 'cycle-land'], map)).toEqual([]);
    expect(deriveCycles([], map)).toEqual([]);
  });
});
