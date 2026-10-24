import { describe, expect, it } from 'vitest';
import { cellCaption, compareColumns, compareImage, currentCells, missingMarker, runCells } from './compare';

const NORMAL = 'https://cards.scryfall.io/normal/front/a/b/ab.jpg?1600000000';

const members = [
  { oracle_id: 'o1', name: 'Arid Mesa' },
  { oracle_id: 'o2', name: 'Marsh Flats' },
  { oracle_id: 'o3', name: 'Scalding Tarn' },
];

describe('compareColumns', () => {
  it('gives 2 columns below 600 px, 3 from 600 to 899 px and 5 from 900 px', () => {
    expect([320, 360, 599].map(compareColumns)).toEqual([2, 2, 2]);
    expect([600, 768, 899].map(compareColumns)).toEqual([3, 3, 3]);
    expect([900, 1366, 1920].map(compareColumns)).toEqual([5, 5, 5]);
  });
});

describe('compareImage', () => {
  it('uses the large image from 900 px and the normal image below', () => {
    expect(compareImage(NORMAL, 899)).toBe(NORMAL);
    expect(compareImage(NORMAL, 900)).toBe('https://cards.scryfall.io/large/front/a/b/ab.jpg?1600000000');
  });
});

describe('runCells', () => {
  const run = {
    set: 'zen',
    picks: [
      { oracle_id: 'o3', printing: { set: 'zen', collector_number: '223', image_normal: NORMAL } },
      { oracle_id: 'o1', printing: { set: 'zen', collector_number: '211', image_normal: NORMAL } },
    ],
  };

  it('gives one cell per member in member order, with the missing member marked', () => {
    const cells = runCells(run, members);
    expect(cells.map((c) => c.oracle_id)).toEqual(['o1', 'o2', 'o3']);
    expect(cells[0]).toEqual({ oracle_id: 'o1', name: 'Arid Mesa', set: 'ZEN', collector_number: '211', image_normal: NORMAL, missing: null });
    expect(cells[1]).toEqual({ oracle_id: 'o2', name: 'Marsh Flats', set: 'ZEN', collector_number: null, image_normal: null, missing: 'no printing in ZEN' });
    expect(cells.map(cellCaption)).toEqual(['ZEN 211', 'no printing in ZEN', 'ZEN 223']);
  });

  it('marks nobody on a complete run', () => {
    const complete = { ...run, picks: [...run.picks, { oracle_id: 'o2', printing: { set: 'zen', collector_number: '216', image_normal: NORMAL } }] };
    expect(runCells(complete, members).filter((c) => c.missing)).toEqual([]);
  });
});

describe('missingMarker and currentCells', () => {
  it('names the set in upper case', () => {
    expect(missingMarker('mh2')).toBe('no printing in MH2');
  });

  it('builds the cells from the Wanted Printings', () => {
    const cells = currentCells([{ ...members[0]!, wanted: { set: 'ons', collector_number: '313', image_normal: NORMAL } }]);
    expect(cells).toEqual([{ oracle_id: 'o1', name: 'Arid Mesa', set: 'ONS', collector_number: '313', image_normal: NORMAL, missing: null }]);
  });
});
