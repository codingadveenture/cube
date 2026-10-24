/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CardsFile } from '../types';
import { diffScan } from './diff';
import { expectedCards } from './expected';
import { parseScanText } from './parse';
import { knownPrintings } from './resolve';

const root = new URL('../../', import.meta.url);
const cardsFile = JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile;

interface RecordPrinting {
  scryfall_id: string;
  name: string;
  set: string;
  collector_number: string;
}
const record = JSON.parse(readFileSync(new URL('data/cube-record.json', root), 'utf8')) as {
  cards: { name: string; in_box: RecordPrinting }[];
};

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

describe('a perfect Scan of the whole Cube', () => {
  // One ManaBox row per card, named as printed on the In-box Printing.
  const csv = [
    'Name,Set code,Collector number,Quantity,Scryfall ID',
    ...record.cards.map((c) =>
      [csvCell(c.in_box.name), c.in_box.set, c.in_box.collector_number, '1', c.in_box.scryfall_id].join(','),
    ),
  ].join('\n');
  const rows = parseScanText(csv);
  const cards = cardsFile.cards;

  it('has nothing missing or unexpected, including the Through the Omenpaths cards', () => {
    const d = diffScan(expectedCards(cards), rows, knownPrintings(cards));
    expect(rows.length).toBe(record.cards.length);
    expect(d.missing.map((c) => c.name)).toEqual([]);
    expect(d.unexpected.map((u) => u.name)).toEqual([]);
    expect(d.totals.differentArt).toBe(0);
  });

  it('matches the four Spider-Man paper names to their cards', () => {
    const d = diffScan(expectedCards(cards), rows, knownPrintings(cards));
    const present = new Map(d.present.map((r) => [r.card.name, r.rows[0]!.name]));
    expect(present.get('Ademi of the Silkchutes')).toBe('Spectacular Spider-Man');
    expect(present.get('Cren, Undercity Dreamer')).toBe('Miles Morales // Ultimate Spider-Man');
    expect(present.get('Goben, Gene-Splice Savant')).toBe('Norman Osborn // Green Goblin');
    expect(present.get('Spectral Restitching')).toBe('Hide on the Ceiling');
  });

  it('attaches a row by its Printing when the name is unknown', () => {
    const ademi = cards.find((c) => c.name === 'Ademi of the Silkchutes')!;
    const expected = expectedCards(cards).map((c) => ({ ...c, aliases: [] }));
    const d = diffScan(
      expected,
      [{ name: 'Some Scanner Typo', quantity: 1, scryfall_id: ademi.in_box.scryfall_id, set: null, collector_number: null, foil: null, language: null }],
      knownPrintings(cards),
    );
    expect(d.unexpected).toEqual([]);
    expect(d.present.map((r) => r.card.name)).toEqual(['Ademi of the Silkchutes']);
  });
});
