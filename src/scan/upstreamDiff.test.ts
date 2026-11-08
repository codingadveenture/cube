import { describe, expect, it } from 'vitest';
import { diffScan, type ExpectedCard, type ToPrintCard } from './diff';
import type { ScannedRow } from './parse';
import { boxAgainstUpstream, boxCards, scryfallByName } from './upstreamDiff';
import { proposedList } from '../upstream/feed';
import { normalizeName } from '../lib/normalize';

function card(name: string): ExpectedCard {
  return { name, front_name: name, oracle_id: `o-${name}`, in_box: { illustration_id: null, set: 'lea', collector_number: '1', image_small: `img-${name}` } };
}
function row(name: string, quantity = 1, pile?: string): ScannedRow {
  return { name, quantity, scryfall_id: null, set: null, collector_number: null, foil: null, language: null, ...(pile ? { pile } : {}) };
}
const toPrint: ToPrintCard[] = [{ name: 'Sol Ring', front_name: 'Sol Ring', oracle_id: 'o-Sol Ring' }];
// The record: Bolt and Lotus in the box, Sol Ring on the List but To print.
const expected = [card('Lightning Bolt'), card('Black Lotus')];
const known = new Map([...expected, ...toPrint].map((c) => [normalizeName(c.name), c.oracle_id]));
const keyOf = (n: string) => known.get(normalizeName(n)) ?? `n:${normalizeName(n)}`;

describe('the box against Upstream', () => {
  // The scan: Bolt (twice, two piles), Sol Ring (found although To print), Opt (unknown to the record). Lotus is missing.
  const rows = [row('Lightning Bolt', 1, 'A'), row('Lightning Bolt', 1, 'B'), row('Sol Ring', 1, 'A'), row('Opt', 1, 'B')];
  const diff = diffScan(expected, rows, new Map(), toPrint);

  it('lists every scanned card once, with its piles and count', () => {
    const box = boxCards(diff, keyOf);
    expect(box.map((c) => c.key).sort()).toEqual(['n:opt', 'o-Lightning Bolt', 'o-Sol Ring']);
    const bolt = box.find((c) => c.key === 'o-Lightning Bolt')!;
    expect(bolt.count).toBe(2);
    expect(bolt.piles).toEqual(['A', 'B']);
    expect(box.find((c) => c.key === 'n:opt')!.oracle_id).toBeNull();
  });

  it('pulls what Upstream does not want and prints what the box lacks, Bans out and Winner’s Picks kept', () => {
    // Upstream wants Bolt, Lotus, Opt and Ancestral Recall; the group bans Opt and keeps Sol Ring as a Winner's Pick.
    const { proposed } = proposedList({
      upstream: ['Lightning Bolt', 'Black Lotus', 'Opt', 'Ancestral Recall'],
      sticky: { adds: ['Sol Ring'], bans: ['Opt'] },
      keyOf,
    });
    const d = boxAgainstUpstream(diff, proposed, keyOf);
    expect(d.proposed).toBe(4);
    expect(d.pull.map((c) => c.name)).toEqual(['Opt']);
    expect(d.pull[0]!.piles).toEqual(['B']);
    expect(d.print.map((c) => c.name)).toEqual(['Ancestral Recall', 'Black Lotus']);
    expect(d.print.find((c) => c.name === 'Black Lotus')!.oracle_id).toBe('o-Black Lotus');
    expect(d.print.find((c) => c.name === 'Ancestral Recall')!.oracle_id).toBeNull();
  });

  it('compares by oracle_id, so a renamed Upstream card in the box is neither pulled nor printed', () => {
    const renamed = (n: string) => (normalizeName(n) === 'spectacular spider-man' ? 'o-Lightning Bolt' : keyOf(n));
    const { proposed } = proposedList({ upstream: ['Spectacular Spider-Man'], sticky: { adds: [], bans: [] }, keyOf: renamed });
    const d = boxAgainstUpstream(diff, proposed, renamed);
    expect(d.print).toEqual([]);
    expect(d.pull.map((c) => c.name)).toEqual(['Opt', 'Sol Ring']);
  });

  it('links an unknown card to its paper printings on Scryfall by exact front name', () => {
    expect(scryfallByName('Fire // Ice')).toBe('https://scryfall.com/search?q=!%22Fire%22+game%3Apaper&unique=prints&order=released');
  });
});
