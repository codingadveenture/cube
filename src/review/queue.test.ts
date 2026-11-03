import { describe, expect, it } from 'vitest';
import type { SharedPile, SharedShot } from '../store/types';
import {
  candidateTags,
  namesInPhotos,
  namesInPiles,
  nextPileToReview,
  nextToReview,
  openPileId,
  orderPrintings,
  otherToReview,
  photoPiles,
  pileOrder,
  positionText,
  queueOrder,
  repeatsInPile,
  tagText,
} from './queue';

const item = (id: string, status: SharedShot['status']) => ({ chunk: 0, shot: { id, status } });

const pile = (id: string, over: Partial<SharedPile> = {}): SharedPile => ({
  id,
  label: `Pile ${id}`,
  by: 'someone',
  rows: [],
  row_count: 0,
  createdAt: `2026-10-${id.padStart(2, '0')}T10:00:00Z`,
  createdByUid: 'u',
  shot_count: 5,
  to_review: 0,
  camera: true,
  ...over,
});

const row = (name: string, quantity = 1) => ({ name, quantity, scryfall_id: null, set: null, collector_number: null });

describe('pile order', () => {
  it('puts the newest pile first and breaks ties by id', () => {
    const same = { createdAt: '2026-10-05T10:00:00Z' };
    expect(pileOrder([pile('1'), pile('3'), pile('2'), pile('b', same), pile('a', same)]).map((p) => p.id)).toEqual(['a', 'b', '3', '2', '1']);
  });

  it('keeps only piles with photos', () => {
    expect(photoPiles([pile('1', { shot_count: 0 }), pile('2', { shot_count: undefined }), pile('3')]).map((p) => p.id)).toEqual(['3']);
  });

  it('opens the requested pile, else the newest with something to review, else the newest', () => {
    const piles = pileOrder([pile('1', { to_review: 2 }), pile('2', { to_review: 1 }), pile('3')]);
    expect(openPileId(piles, '1')).toBe('1');
    expect(openPileId(piles, 'gone')).toBe('2');
    expect(openPileId(piles, null)).toBe('2');
    expect(openPileId(pileOrder([pile('1'), pile('2')]), null)).toBe('2');
    expect(openPileId([], null)).toBe(null);
  });

  it('moves on to the first other pile with something to review and counts the rest', () => {
    const piles = pileOrder([pile('1', { to_review: 2 }), pile('2', { to_review: 1 }), pile('3'), pile('4', { to_review: undefined })]);
    expect(nextPileToReview(piles, '2')?.id).toBe('1');
    expect(nextPileToReview(piles, '1')?.id).toBe('2');
    expect(nextPileToReview(piles, null)?.id).toBe('2');
    expect(nextPileToReview([pile('3')], '3')).toBe(null);
    expect(otherToReview(piles, '2')).toBe(2);
    expect(otherToReview(piles, null)).toBe(3);
  });
});

describe('queue of a pile', () => {
  const items = [item('a', 'match'), item('b', 'review'), item('c', 'confirmed'), item('d', 'none'), item('e', 'skipped'), item('f', 'review')];

  it('puts the photos to review first, each group in capture order', () => {
    expect(queueOrder(items).map((x) => x.shot.id)).toEqual(['b', 'd', 'f', 'a', 'c', 'e']);
  });

  it('finds the next photo to review after one, going round, never the same one', () => {
    const q = queueOrder(items);
    expect(nextToReview(q, null)?.shot.id).toBe('b');
    expect(nextToReview(q, 'b')?.shot.id).toBe('d');
    expect(nextToReview(q, 'f')?.shot.id).toBe('b');
    expect(nextToReview(q, 'c')?.shot.id).toBe('b');
    expect(nextToReview([item('only', 'review')], 'only')).toBe(null);
    expect(nextToReview([item('a', 'match'), item('b', 'confirmed')], null)).toBe(null);
    expect(nextToReview([], 'x')).toBe(null);
  });

  it('skips a photo the live data still shows as to review when it was just decided', () => {
    // The decision is in; the chunk listener has not fired yet: 'b' must not come back.
    const q = queueOrder([item('b', 'review'), item('a', 'match')]);
    expect(nextToReview(q, 'b')).toBe(null);
  });

  it('writes the position line', () => {
    const q = queueOrder(items);
    expect(positionText(q, 'd', 'Stack 3', 0)).toBe('Photo 2 of 3 to review in Stack 3');
    expect(positionText(q, 'd', 'Stack 3', 4)).toBe('Photo 2 of 3 to review in Stack 3 · 4 more to review in other piles');
    expect(positionText(q, 'c', 'Stack 3', 0)).toBe('Photo 5 of 6 in Stack 3 · 3 to review');
    expect(positionText([], null, 'Stack 3', 1)).toBe('No photos in Stack 3 · 1 more to review in other piles');
  });
});

describe('candidate tags', () => {
  const cards = new Map([
    ['o-bolt', { in_box: { scryfall_id: 'sf-bolt-box' } as never }],
    ['o-ponder', { in_box: null }],
  ]);
  const names = new Map([['lightning bolt', 'Stack 1']]);

  it('says in the box, or another printing of an In-box card', () => {
    expect(candidateTags({ scryfall_id: 'sf-bolt-box', oracle_id: 'o-bolt', name: 'Lightning Bolt' }, cards, new Map())).toEqual([{ kind: 'inBox' }]);
    expect(candidateTags({ scryfall_id: 'sf-bolt-m10', oracle_id: 'o-bolt', name: 'Lightning Bolt' }, cards, new Map())).toEqual([
      { kind: 'inBoxOtherPrinting' },
    ]);
    expect(candidateTags({ scryfall_id: 'sf-ponder', oracle_id: 'o-ponder', name: 'Ponder' }, cards, new Map())).toEqual([]);
    expect(candidateTags({ scryfall_id: 'sf-x', oracle_id: 'o-unknown', name: 'X' }, cards, new Map())).toEqual([]);
    expect(candidateTags({ scryfall_id: 'sf-x', oracle_id: 'o-bolt', name: 'X' }, null, new Map())).toEqual([]);
  });

  it('says which other pile already has the name, by the front face and without regard to case', () => {
    expect(candidateTags({ scryfall_id: 'sf-bolt-box', oracle_id: 'o-bolt', name: 'LIGHTNING BOLT' }, cards, names)).toEqual([
      { kind: 'inBox' },
      { kind: 'alreadyIn', label: 'Stack 1' },
    ]);
    const split = namesInPiles([pile('1', { rows: [row('Fire // Ice')] })], null);
    expect(candidateTags({ scryfall_id: 'sf-fire', oracle_id: 'o-fire', name: 'Fire' }, null, split)).toEqual([{ kind: 'alreadyIn', label: 'Pile 1' }]);
  });

  it('indexes the other piles only, skipping rows with nothing left, the first pile winning', () => {
    const piles = pileOrder([
      pile('1', { rows: [row('Ponder'), row('Brainstorm', 0)] }),
      pile('2', { rows: [row('Ponder'), row('Opt')] }),
      pile('3', { rows: [row('Counterspell')] }),
    ]);
    const names = namesInPiles(piles, '3');
    expect(names.get('ponder')).toBe('Pile 2');
    expect(names.get('opt')).toBe('Pile 2');
    expect(names.has('brainstorm')).toBe(false);
    expect(names.has('counterspell')).toBe(false);
  });

  it('has a word for every tag', () => {
    expect(tagText({ kind: 'inBox' })).toBe('in the box');
    expect(tagText({ kind: 'inBoxOtherPrinting' })).toBe('In-box card, other printing');
    expect(tagText({ kind: 'alreadyIn', label: 'Stack 1' })).toBe('already in Stack 1');
  });
});

describe('printing order in the picker', () => {
  const p = (id: string, illustration_id: string | null, released_at: string) => ({ id, illustration_id, released_at });
  const printings = [
    p('new-other', 'art-b', '2024-01-01'),
    p('old-same', 'art-a', '2010-01-01'),
    p('box', 'art-c', '2015-01-01'),
    p('picked', 'art-a', '2020-01-01'),
    p('old-other', null, '1993-08-05'),
  ];

  it('puts the In-box Printing first, the same art next, then the rest, each newest first', () => {
    expect(orderPrintings(printings, 'box', 'picked').map((x) => x.id)).toEqual(['box', 'picked', 'old-same', 'new-other', 'old-other']);
  });

  it('works without an In-box Printing or a picked one', () => {
    expect(orderPrintings(printings, null, null).map((x) => x.id)).toEqual(['new-other', 'picked', 'box', 'old-same', 'old-other']);
    expect(orderPrintings(printings, 'box', 'not-here').map((x) => x.id)).toEqual(['box', 'new-other', 'picked', 'old-same', 'old-other']);
  });

  it('does not group printings without an illustration', () => {
    const noArt = [p('a', null, '2020-01-01'), p('b', null, '2021-01-01')];
    expect(orderPrintings(noArt, null, 'a').map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('repeats of a pile', () => {
  const ref = (name: string) => ({ scryfall_id: `sf-${name}`, oracle_id: `o-${name}`, name, set: 'lea', collector_number: '1' });
  const kept = (id: string, name: string, status: 'match' | 'confirmed' = 'match') => ({ chunk: 0, shot: { id, status, chosen: ref(name) } });
  const doubt = (id: string, status: 'review' | 'none' | 'skipped' | 'repeat', name: string | null = null) => ({
    chunk: 0,
    shot: { id, status, chosen: name === null ? null : ref(name) },
  });

  it('indexes the names of the pile’s other kept photos as this pile', () => {
    const items = [kept('a', 'Ponder'), doubt('b', 'review'), kept('c', 'Opt', 'confirmed'), doubt('d', 'repeat', 'Brainstorm'), doubt('e', 'skipped')];
    const names = namesInPhotos(items, 'a');
    expect(names.get('opt')).toBe('this pile');
    // The current photo is not in the pile on its own account; a repeat and a doubtful photo are not in it at all.
    expect(names.has('ponder')).toBe(false);
    expect(names.has('brainstorm')).toBe(false);
    expect(namesInPhotos(items, null).get('ponder')).toBe('this pile');
    expect(candidateTags(ref('Opt'), null, new Map([...namesInPhotos(items, 'a')]))).toEqual([{ kind: 'alreadyIn', label: 'this pile' }]);
  });

  it('finds the kept photos whose card an earlier pile holds, in capture order, with the card they repeat', () => {
    const piles = pileOrder([
      pile('1', { rows: [row('Ponder'), row('Brainstorm', 0)] }),
      pile('3', { rows: [row('Opt')] }),
      pile('5', { rows: [row('Counterspell')] }),
    ]);
    const open = pile('3');
    const items = [kept('a', 'Counterspell'), kept('b', 'Ponder', 'confirmed'), kept('c', 'Brainstorm'), kept('d', 'PONDER')];
    const out = repeatsInPile(open, piles, items);
    // Pile 1 was created before pile 3; pile 5 after it, so its Counterspell does not count. The
    // row of Brainstorm with nothing left does not count either. A second Ponder within this pile
    // repeats the first, whatever its case.
    expect(out.map((x) => x.shot.id)).toEqual(['b', 'd']);
    expect(out[0]!.ref).toEqual(ref('Ponder'));
    expect(out[1]!.ref).toEqual(ref('PONDER'));
    expect(out[0]!.chunk).toBe(0);
  });

  it('takes the second and later photos of a name within the pile, never the first', () => {
    const items = [kept('a', 'Opt'), kept('b', 'Ponder'), kept('c', 'Opt', 'confirmed'), kept('d', 'Opt')];
    expect(repeatsInPile(pile('3'), [pile('3')], items).map((x) => x.shot.id)).toEqual(['c', 'd']);
    expect(repeatsInPile(pile('3'), [], [kept('a', 'Opt')])).toEqual([]);
  });

  it('never touches a doubtful photo, a repeat or a photo that is not a card', () => {
    const earlier = [pile('1', { rows: [row('Ponder'), row('Opt')] })];
    const items = [doubt('a', 'review'), doubt('b', 'none'), doubt('c', 'skipped'), doubt('d', 'repeat', 'Ponder'), kept('e', 'Opt')];
    expect(repeatsInPile(pile('3'), earlier, items).map((x) => x.shot.id)).toEqual(['e']);
    // A repeat already set aside does not make the next kept photo of its name the second one.
    expect(repeatsInPile(pile('3'), [], [doubt('d', 'repeat', 'Fog'), kept('f', 'Fog')])).toEqual([]);
  });

  it('breaks a tie on the creation time as pileOrder does', () => {
    const same = { createdAt: '2026-10-05T10:00:00Z', rows: [row('Ponder')] };
    const open = pile('b', same);
    // pileOrder puts 'a' before 'b' (newer), so 'c' is the earlier pile and 'a' is not.
    expect(repeatsInPile(open, [pile('a', same)], [kept('x', 'Ponder')])).toEqual([]);
    expect(repeatsInPile(open, [pile('c', same)], [kept('x', 'Ponder')]).map((x) => x.shot.id)).toEqual(['x']);
    expect(repeatsInPile(open, [open], [kept('x', 'Ponder')])).toEqual([]);
  });
});
