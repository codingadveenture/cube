import { describe, expect, it } from 'vitest';
import { diffScan, printingKey, scannedPrintings, type ExpectedCard, type ResolvedPrinting, type ToPrintCard, pilesOf } from './diff';
import type { ScannedRow } from './parse';

function card(name: string, ill: string, set = 'lea', num = '1', front = name.split(' // ')[0]!): ExpectedCard {
  return {
    name,
    front_name: front,
    oracle_id: `oracle-${name}`,
    in_box: { illustration_id: ill, set, collector_number: num, image_small: `img-${name}` },
  };
}

function row(name: string, quantity = 1, scryfall_id: string | null = null): ScannedRow {
  return { name, quantity, scryfall_id, set: null, collector_number: null, foil: null, language: null };
}

function printing(ill: string, set: string, num: string, name = 'x'): ResolvedPrinting {
  return { illustration_id: ill, set, collector_number: num, name, image_small: `img-${set}-${num}` };
}

const EXPECTED = [
  card('Lightning Bolt', 'ill-bolt', 'lea', '161'),
  card('Fire // Ice', 'ill-fire', 'mh2', '290'),
  card('Black Lotus', 'ill-lotus', 'lea', '232'),
  card('Sol Ring', 'ill-ring', 'c21', '263'),
  card('Séance', 'ill-seance', 'drk', '50'),
];

describe('diffScan buckets', () => {
  it('finds missing, unexpected, present and duplicates; matches split names and diacritics', () => {
    const d = diffScan(EXPECTED, [
      row('lightning bolt'),
      row('Fire'),
      row('Sol Ring', 2),
      row('Seance'),
      row('Goblin Guide'),
      row('Goblin Guide'),
    ]);
    expect(d.missing.map((c) => c.name)).toEqual(['Black Lotus']);
    expect(d.unexpected).toHaveLength(1);
    expect(d.unexpected[0]).toMatchObject({ name: 'Goblin Guide', count: 2 });
    expect(d.unexpected[0]?.rows).toHaveLength(2);
    expect(d.present.map((r) => r.card.name)).toEqual(['Lightning Bolt', 'Fire // Ice', 'Séance']);
    expect(d.duplicates.map((r) => [r.card.name, r.count])).toEqual([['Sol Ring', 2]]);
  });

  it('sums quantities across piles into a duplicate', () => {
    const pileA = [row('Black Lotus')];
    const pileB = [row('BLACK LOTUS')];
    const d = diffScan(EXPECTED, [...pileA, ...pileB]);
    expect(d.duplicates.map((r) => [r.card.name, r.count])).toEqual([['Black Lotus', 2]]);
  });

  it('matches by aliases', () => {
    const alias = { ...card('Ademi of the Silkchutes', 'ill-ademi'), aliases: ['Spectacular Spider-Man'] };
    const d = diffScan([alias], [row('Spectacular Spider-Man')]);
    expect(d.missing).toHaveLength(0);
    expect(d.present).toHaveLength(1);
  });
});

describe('art verdicts', () => {
  const one = [card('Lightning Bolt', 'ill-bolt', 'lea', '161')];

  it('match when a row has the in-box illustration, set and number', () => {
    const p = new Map([['id-1', printing('ill-bolt', 'lea', '161')]]);
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-1')], p);
    expect(d.present[0]?.verdict).toBe('match');
  });

  it('a second copy with different art is not hidden by a matching first copy', () => {
    const p = new Map([
      ['id-2', printing('ill-bolt', 'lea', '161')],
      ['id-1', printing('ill-other', 'm10', '146')],
    ]);
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-2'), row('Lightning Bolt', 1, 'id-1')], p);
    expect(d.duplicates[0]?.verdict).toBe('different-art');
    expect(d.duplicates[0]?.scanned?.set).toBe('m10');
    expect(d.totals.differentArt).toBe(1);
    expect(scannedPrintings(d.duplicates[0]!.rows)).toEqual(['LEA 161', 'M10 146']);
  });

  it('match when every resolved copy matches', () => {
    const p = new Map([['id-2', printing('ill-bolt', 'lea', '161')]]);
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-2'), row('Lightning Bolt', 1, 'id-2')], p);
    expect(d.duplicates[0]?.verdict).toBe('match');
  });

  it('different-art when every resolved row has another illustration, keeping the scanned printing', () => {
    const p = new Map([['id-1', printing('ill-other', 'm10', '146')]]);
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-1'), row('Lightning Bolt', 1, 'unresolved')], p);
    const r = d.duplicates[0];
    expect(r?.verdict).toBe('different-art');
    expect(r?.scanned).toMatchObject({ set: 'm10', collector_number: '146', image_small: 'img-m10-146' });
  });

  it('same-art-other-set when the illustration matches but the printing differs; still present', () => {
    const p = new Map([['id-1', printing('ill-bolt', 'leb', '162')]]);
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-1')], p);
    expect(d.present[0]?.verdict).toBe('same-art-other-set');
    expect(d.present[0]?.scanned?.set).toBe('leb');
    expect(d.missing).toHaveLength(0);
  });

  it('unknown when no row could be resolved', () => {
    const d = diffScan(one, [row('Lightning Bolt', 1, 'id-1')], new Map());
    expect(d.present[0]?.verdict).toBe('unknown');
    expect(d.present[0]?.scanned).toBeNull();
  });

  it('resolves rows keyed by set and collector number', () => {
    const r: ScannedRow = { ...row('Lightning Bolt'), set: 'lea', collector_number: '161' };
    expect(printingKey(r)).toBe('lea/161');
    const d = diffScan(one, [r], new Map([['lea/161', printing('ill-bolt', 'lea', '161')]]));
    expect(d.present[0]?.verdict).toBe('match');
  });
});

describe('totals', () => {
  it('counts every bucket', () => {
    const p = new Map([
      ['bolt', printing('ill-bolt', 'lea', '161')],
      ['fire', printing('ill-other', 'apc', '128')],
      ['ring', printing('ill-ring', 'cmr', '472')],
    ]);
    const d = diffScan(EXPECTED, [
      row('Lightning Bolt', 1, 'bolt'),
      row('Fire // Ice', 1, 'fire'),
      row('Sol Ring', 1, 'ring'),
      row('Sol Ring', 1),
      row('Séance'),
      row('Goblin Guide', 3),
    ], p);
    expect(d.totals).toEqual({
      expected: 5,
      scannedRows: 6,
      scannedUniqueNames: 5,
      missing: 1,
      unexpected: 1,
      foundToPrint: 0,
      duplicates: 1,
      differentArt: 1,
      sameArtOtherSet: 1,
      unknown: 1,
    });
  });

  it('handles an empty scan', () => {
    const d = diffScan(EXPECTED, []);
    expect(d.totals.missing).toBe(5);
    expect(d.totals.scannedRows).toBe(0);
  });
});

describe('found, but marked To print', () => {
  const TO_PRINT: ToPrintCard[] = [
    { name: 'Goblin Guide', front_name: 'Goblin Guide', oracle_id: 'oracle-guide', printing_keys: ['zen/126', 'guide-id'] },
    { name: 'Ponder', front_name: 'Ponder', oracle_id: 'oracle-ponder', aliases: ['Ponder Alias'] },
  ];

  it('puts a row matching a To print card in foundToPrint, not in unexpected', () => {
    const d = diffScan(EXPECTED, [row('Goblin Guide', 2), row('Goblin Guide')], new Map(), TO_PRINT);
    expect(d.unexpected).toEqual([]);
    expect(d.foundToPrint).toHaveLength(1);
    expect(d.foundToPrint[0]!.card.oracle_id).toBe('oracle-guide');
    expect(d.foundToPrint[0]!.count).toBe(3);
    expect(d.foundToPrint[0]!.rows).toHaveLength(2);
    expect(d.totals.foundToPrint).toBe(1);
    expect(d.totals.unexpected).toBe(0);
  });

  it('matches a To print card by alias and by the printing key of its Wanted Printing', () => {
    const byKey: ScannedRow = { ...row('Some Other Name'), set: 'ZEN', collector_number: '126' };
    const d = diffScan(EXPECTED, [byKey, row('Ponder Alias'), row('Unknown', 1, 'guide-id')], new Map(), TO_PRINT);
    expect(d.unexpected).toEqual([]);
    expect(d.foundToPrint.map((f) => [f.card.oracle_id, f.count])).toEqual([
      ['oracle-guide', 2],
      ['oracle-ponder', 1],
    ]);
  });

  it('still puts a row matching an expected card in found', () => {
    const d = diffScan(EXPECTED, [row('Lightning Bolt')], new Map(), TO_PRINT);
    expect(d.foundToPrint).toEqual([]);
    expect(d.present.map((r) => r.card.name)).toEqual(['Lightning Bolt']);
  });

  it('keeps a row that matches nothing in unexpected', () => {
    const d = diffScan(EXPECTED, [row('Tarmogoyf')], new Map(), TO_PRINT);
    expect(d.foundToPrint).toEqual([]);
    expect(d.unexpected.map((u) => u.name)).toEqual(['Tarmogoyf']);
  });
});

describe('pilesOf', () => {
  it('lists the distinct pile labels of the rows in scan order, skipping rows without one', () => {
    const rows = [{ pile: 'Stack 2' }, { pile: 'Stack 1' }, {}, { pile: 'Stack 2' }];
    expect(pilesOf(rows)).toEqual(['Stack 2', 'Stack 1']);
    expect(pilesOf([{}])).toEqual([]);
  });
});
