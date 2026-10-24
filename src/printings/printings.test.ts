/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardsFile } from '../types';
import { mergeCard, cardStateOf } from '../store/baseline';
import { cardBatches } from '../store/writes';
import { parseHash, printingsHash, cycleHash } from '../router';
import { defaultPrinting } from './defaultRule';
import { pngImage, smallImage } from './images';
import { artKey, runKey, runLabel } from './style';
import {
  candidateRuns,
  choosePrinting,
  cycleMembers,
  cycleStatus,
  cyclesOf,
  displayStatus,
  humanizeCycle,
  memberRun,
  planCycleApply,
  type MemberRun,
} from './cycles';
import { DEFAULT_FILTERS, badges, filterPrintings, groupByArt } from './picker';
import { wantedFromInBox, wantedFromPrinting } from './wanted';
import type { IndexPrinting, PrintingsFile } from './types';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const fileOf = (name: string): PrintingsFile => {
  const c = cards.find((x) => x.name === name)!;
  return JSON.parse(readFileSync(new URL(`public/data/printings/${c.oracle_id}.json`, root), 'utf8')) as PrintingsFile;
};
const NOW = '2026-10-24T12:00:00.000Z';
const TODAY = '2026-10-24';

let n = 0;
function pr(over: Partial<IndexPrinting>): IndexPrinting {
  n++;
  return {
    id: `id-${n}`,
    set: 'abc',
    set_name: 'Some Set',
    set_type: 'expansion',
    collector_number: String(n),
    released_at: '2020-01-01',
    frame: '2015',
    frame_effects: [],
    border_color: 'black',
    full_art: false,
    textless: false,
    promo: false,
    promo_types: [],
    finishes: ['nonfoil'],
    highres: true,
    illustration_id: `art-${n}`,
    artist: 'Someone',
    image_normal: `https://cards.scryfall.io/normal/front/a/b/id-${n}.jpg?123`,
    back_image_normal: null,
    back_illustration_id: null,
    security_stamp: null,
    reprint: true,
    variation: false,
    booster: true,
    digital: false,
    ...over,
  };
}

describe('default Printing rule', () => {
  it('picks the newest qualifying Printing', () => {
    const a = pr({ set: 'old', released_at: '2010-01-01' });
    const b = pr({ set: 'new', released_at: '2022-05-01' });
    expect(defaultPrinting([a, b], TODAY)?.set).toBe('new');
  });

  it('skips promos, Secret Lair, memorabilia, digital, textless and non-black borders', () => {
    const ok = pr({ set: 'ok', released_at: '2001-01-01' });
    const list = [
      pr({ promo: true, released_at: '2024-01-01' }),
      pr({ set: 'sld', released_at: '2024-01-02' }),
      pr({ set: '30a', set_type: 'memorabilia', released_at: '2024-01-03' }),
      pr({ digital: true, released_at: '2024-01-04' }),
      pr({ textless: true, released_at: '2024-01-05' }),
      pr({ border_color: 'borderless', released_at: '2024-01-06' }),
      pr({ border_color: 'white', released_at: '2024-01-07' }),
      ok,
    ];
    expect(defaultPrinting(list, TODAY)).toBe(ok);
  });

  it('skips The List, boxed products such as Secret Lair offshoots, and masterpiece sets', () => {
    const ok = pr({ set: 'clb', set_type: 'draft_innovation', released_at: '2022-06-10' });
    const list = [
      pr({ set: 'plst', set_type: 'masters', released_at: '2026-10-19' }),
      pr({ set: 'slz', set_type: 'box', released_at: '2025-01-01' }),
      pr({ set: 'mps', set_type: 'masterpiece', released_at: '2024-01-01' }),
      ok,
    ];
    expect(defaultPrinting(list, TODAY)).toBe(ok);
    expect(defaultPrinting(fileOf('Lightning Bolt').printings, TODAY)?.set).not.toBe('plst');
  });

  it('skips Printings from sets that are not out yet', () => {
    const out = pr({ set: 'out', released_at: '2026-09-01' });
    const soon = pr({ set: 'soon', released_at: '2026-11-13' });
    expect(defaultPrinting([soon, out], TODAY)).toBe(out);
    expect(defaultPrinting([soon, out], '2026-11-13')).toBe(soon);
    expect(defaultPrinting(fileOf('Watery Grave').printings, TODAY)!.released_at <= TODAY).toBe(true);
  });

  it('prefers high resolution within the same year, else newest', () => {
    const lowNew = pr({ set: 'low', released_at: '2020-11-01', highres: false });
    const highOld = pr({ set: 'high', released_at: '2020-02-01' });
    expect(defaultPrinting([lowNew, highOld], TODAY)?.set).toBe('high');
    const highPrevYear = pr({ set: 'prev', released_at: '2019-12-01' });
    expect(defaultPrinting([lowNew, highPrevYear], TODAY)?.set).toBe('low');
  });

  it('returns null when nothing qualifies (Gleemox)', () => {
    expect(defaultPrinting([], TODAY)).toBeNull();
    expect(defaultPrinting([pr({ promo: true })], TODAY)).toBeNull();
    expect(defaultPrinting(fileOf('Gleemox').printings, TODAY)).toBeNull();
  });

  it('does not pick 30th Anniversary for Power, and picks the main-set number on a shared day', () => {
    expect(defaultPrinting(fileOf('Mox Jet').printings, TODAY)?.set).toBe('leb');
    const delta = defaultPrinting(fileOf('Polluted Delta').printings, TODAY);
    expect([delta?.set, delta?.collector_number]).toEqual(['mh3', '224']);
  });
});

describe('image URLs', () => {
  const normal = 'https://cards.scryfall.io/normal/front/1/2/abc.jpg?1783911060';
  it('derives the small and print-quality images', () => {
    expect(smallImage(normal)).toBe('https://cards.scryfall.io/small/front/1/2/abc.jpg?1783911060');
    expect(pngImage(normal)).toBe('https://cards.scryfall.io/png/front/1/2/abc.png?1783911060');
    expect(pngImage('https://cards.scryfall.io/normal/back/1/2/abc.jpg')).toBe('https://cards.scryfall.io/png/back/1/2/abc.png');
  });
});

describe('style key', () => {
  it('names the style of a Printing', () => {
    expect(runKey(pr({ set: 'mh3', frame: '1997' })).style).toBe('retro');
    expect(runKey(pr({ frame: '1993', border_color: 'white' })).style).toBe('retro');
    expect(runKey(pr({ border_color: 'borderless', frame_effects: ['extendedart'] })).style).toBe('borderless');
    expect(runKey(pr({ frame_effects: ['extendedart'] })).style).toBe('extended');
    expect(runKey(pr({ frame_effects: ['showcase'] })).style).toBe('showcase');
    expect(runKey(pr({ full_art: true })).style).toBe('fullart');
    expect(runKey(pr({})).style).toBe('regular');
  });

  it('labels a run', () => {
    expect(runLabel(runKey(pr({ set: 'mh3', frame: '1997' })))).toBe('MH3 · retro frame · black border');
    expect(runLabel(runKey(pr({ set: 'mh3', border_color: 'borderless' })))).toBe('MH3 · borderless');
    expect(runLabel(runKey(pr({ set: 'zen' })))).toBe('ZEN · regular frame · black border');
  });

  it('keys the art by illustration id', () => {
    expect(artKey(pr({ illustration_id: 'x' }))).toBe('x');
    expect(artKey(pr({ id: 'p1', illustration_id: null }))).toBe('printing:p1');
  });

  it('humanises Cycle names', () => {
    expect(humanizeCycle('fetchlands_allied')).toBe('Fetchlands allied');
    expect(humanizeCycle('moxen')).toBe('Moxen');
  });
});

function member(i: number, set: string, frame = '2015'): MemberRun {
  return {
    oracle_id: `o${i}`,
    name: `Card ${i}`,
    collector_number: String(i),
    run: { set, frame, border_color: 'black', style: frame === '1997' || frame === '1993' ? 'retro' : 'regular' },
  };
}

describe('Cycle status', () => {
  it('is uniform when all share set and style', () => {
    const s = cycleStatus([member(1, 'zen'), member(2, 'zen'), member(3, 'zen')]);
    expect(s.kind).toBe('uniform');
    expect(s.summary).toBe('All 3 on ZEN · regular frame · black border');
  });

  it('is styled when the look matches across sets', () => {
    const s = cycleStatus([member(1, 'ons', '1997'), member(2, 'mh3', '1997')]);
    expect(s.kind).toBe('styled');
  });

  it('is split otherwise, with a summary', () => {
    const ms = [1, 2, 3, 4, 5].map((i) => member(i, 'ons', '1997')).concat([6, 7, 8, 9, 10].map((i) => member(i, 'zen', '2003')));
    const s = cycleStatus(ms);
    expect(s.kind).toBe('split');
    expect(s.summary).toBe('5 on ONS, 5 on ZEN');
  });

  it('names the style when one set appears twice', () => {
    const s = cycleStatus([member(1, 'mh3', '1997'), member(2, 'mh3', '2015'), member(3, 'mh3', '2015')]);
    expect(s.summary).toBe('2 on MH3 regular frame · black border, 1 on MH3 retro frame · black border');
  });

  it('shows an accepted split quietly only while the signature matches', () => {
    const ms = [member(1, 'ons', '1997'), member(2, 'zen')];
    const s = cycleStatus(ms);
    expect(displayStatus(s, s.signature)).toBe('accepted');
    expect(displayStatus(s, 'something else')).toBe('split');
    const changed = cycleStatus([member(1, 'ons', '1997'), { ...member(2, 'ktk'), collector_number: '9' }]);
    expect(displayStatus(changed, s.signature)).toBe('split');
  });

  it('keeps the signature when a member changes Printing within the same Print run, in any order', () => {
    const ms = [member(1, 'lea', '1993'), member(2, 'lea', '1993'), member(3, '30a', '1993')];
    const s = cycleStatus(ms);
    const moved = [{ ...member(3, '30a', '1993'), collector_number: '999' }, { ...member(1, 'lea', '1993'), collector_number: '42' }, member(2, 'lea', '1993')];
    expect(cycleStatus(moved).signature).toBe(s.signature);
    expect(displayStatus(cycleStatus(moved), s.signature)).not.toBe('split');
    const restyled = [member(1, 'lea', '1993'), member(2, 'lea', '1993'), member(3, '30a', '2015')];
    expect(cycleStatus(restyled).signature).not.toBe(s.signature);
  });

  it('reads the Wanted run from the printings file, and from cards.json without it', () => {
    const delta = cards.find((c) => c.name === 'Polluted Delta')!;
    const file = fileOf('Polluted Delta').printings;
    const retro = file.find((p) => p.set === 'mh3' && p.frame === '1997')!;
    const card: Card = { ...delta, wanted: { ...delta.wanted, scryfall_id: retro.id, set: 'mh3', frame: '', border_color: '' } };
    expect(memberRun(card, file).run?.style).toBe('retro');
    expect(memberRun(card).run).toBeNull();
    expect(memberRun(delta).run?.set).toBe(delta.wanted.set);
  });

  it('lists Cycles from cards.json, nested ones included', () => {
    const all = cyclesOf(cards);
    expect(all.find((c) => c.name === 'fetchlands')?.members.length).toBe(10);
    expect(all.find((c) => c.name === 'fetchlands_allied')?.members.length).toBe(5);
    expect(cycleMembers(cards, 'moxen').map((c) => c.name)).toContain('Mox Jet');
  });
});

describe('candidate Print runs', () => {
  const members = [1, 2, 3].map((i) => ({ oracle_id: `o${i}`, name: `Card ${i}` }));

  it('finds complete and near-complete runs and ranks them', () => {
    const files = new Map<string, IndexPrinting[]>([
      ['o1', [pr({ set: 'new', released_at: '2024-01-01' }), pr({ set: 'lowres', released_at: '2025-01-01', highres: false }), pr({ set: 'old', released_at: '2001-01-01' }), pr({ set: 'near', released_at: '2026-01-01' })]],
      ['o2', [pr({ set: 'new', released_at: '2024-01-01' }), pr({ set: 'lowres', released_at: '2025-01-01', highres: false }), pr({ set: 'old', released_at: '2001-01-01' }), pr({ set: 'near', released_at: '2026-01-01' })]],
      ['o3', [pr({ set: 'new', released_at: '2024-01-01' }), pr({ set: 'lowres', released_at: '2025-01-01' }), pr({ set: 'old', released_at: '2001-01-01' }), pr({ set: 'solo' })]],
    ]);
    const runs = candidateRuns(members, files);
    expect(runs.map((r) => r.set)).toEqual(['new', 'old', 'lowres', 'near']);
    expect(runs[0]!.complete).toBe(true);
    const near = runs.find((r) => r.set === 'near')!;
    expect(near.complete).toBe(false);
    expect(near.missing).toEqual([{ oracle_id: 'o3', name: 'Card 3' }]);
    expect(runs.find((r) => r.set === 'lowres')!.highresCount).toBe(1);
    expect(runs.some((r) => r.set === 'solo')).toBe(false);
  });

  it('ranks runs that are not released yet last and marks them', () => {
    const files = new Map<string, IndexPrinting[]>(
      members.map((m) => [m.oracle_id, [pr({ set: 'trk', released_at: '2026-11-13' }), pr({ set: 'old', released_at: '2010-01-01' })]]),
    );
    const runs = candidateRuns(members, files, { today: TODAY });
    expect(runs.map((r) => [r.set, r.unreleased])).toEqual([
      ['old', false],
      ['trk', true],
    ]);
    expect(candidateRuns(members, files).map((r) => r.set)).toEqual(['trk', 'old']);
  });

  it('ranks non-promo runs over promo runs', () => {
    const files = new Map<string, IndexPrinting[]>(
      members.map((m) => [m.oracle_id, [pr({ set: 'promo', promo: true, released_at: '2025-01-01' }), pr({ set: 'plain', released_at: '2010-01-01' })]]),
    );
    expect(candidateRuns(members, files).map((r) => r.set)).toEqual(['plain', 'promo']);
  });

  it('chooses one Printing per member: high resolution, not promo, lowest number', () => {
    const a = pr({ collector_number: '10', highres: false });
    const b = pr({ collector_number: '12', promo: true });
    const c = pr({ collector_number: '11' });
    const d = pr({ collector_number: '9' });
    expect(choosePrinting([a, b, c, d])).toBe(d);
    expect(choosePrinting([a, b, c])).toBe(c);
    expect(choosePrinting([a, b])).toBe(b);
    expect(choosePrinting([])).toBeNull();
  });

  it('leaves out collectors editions unless asked', () => {
    const files = new Map<string, IndexPrinting[]>(members.map((m) => [m.oracle_id, [pr({ set: 'ced', set_type: 'memorabilia', frame: '1993' })]]));
    expect(candidateRuns(members, files)).toEqual([]);
    expect(candidateRuns(members, files, { includeCollectors: true })).toHaveLength(1);
  });

  it('finds Alpha as near-complete for the duals (Volcanic Island is not in Alpha)', () => {
    const duals = cycleMembers(cards, 'original_duals');
    const files = new Map(duals.map((d) => [d.oracle_id, fileOf(d.name).printings]));
    const runs = candidateRuns(duals, files);
    const lea = runs.find((r) => r.set === 'lea')!;
    expect(lea.complete).toBe(false);
    expect(lea.missing.map((m) => m.name)).toEqual(['Volcanic Island']);
    expect(runs.find((r) => r.set === 'leb')?.complete).toBe(true);
    expect(runs.some((r) => r.set === 'ced')).toBe(false);
  });
});

describe('apply to a Cycle', () => {
  it('matches each member in the same set and style and lists the rest', () => {
    const members = [1, 2, 3].map((i) => ({ oracle_id: `o${i}`, name: `Card ${i}` }));
    const picked = pr({ set: 'mh3', frame: '1997', collector_number: '440' });
    const o2retro = pr({ set: 'mh3', frame: '1997', collector_number: '441' });
    const o2regular = pr({ set: 'mh3', collector_number: '220' });
    const o3other = pr({ set: 'ktk', frame: '1997' });
    const files = new Map<string, IndexPrinting[]>([
      ['o1', [picked, pr({ set: 'mh3', frame: '1997', collector_number: '1' })]],
      ['o2', [o2regular, o2retro]],
      ['o3', [o3other, pr({ set: 'mh3', collector_number: '222' })]],
    ]);
    const plan = planCycleApply(members, files, { set: 'mh3', style: 'retro' }, { oracle_id: 'o1', printing: picked });
    expect(plan.matched.map((m) => [m.oracle_id, m.printing.collector_number])).toEqual([
      ['o1', '440'],
      ['o2', '441'],
    ]);
    expect(plan.unmatched).toEqual([{ oracle_id: 'o3', name: 'Card 3' }]);
  });
});

describe('Wanted writes', () => {
  it('carry the image so the Cube view needs no index', () => {
    const p = pr({ set: 'mh3', collector_number: '224' });
    const w = wantedFromPrinting(p, 'Polluted Delta', 'cycle');
    expect(w).toEqual({
      scryfall_id: p.id,
      set: 'mh3',
      collector_number: '224',
      illustration_id: p.illustration_id,
      name: 'Polluted Delta',
      reason: 'cycle',
      image_normal: p.image_normal,
    });
    const card = cards[0]!;
    const merged = mergeCard(card, { ...cardStateOf(card, NOW), wanted: w });
    expect(merged.wanted.image_normal).toBe(p.image_normal);
    expect(merged.wanted.image_small).toBe(smallImage(p.image_normal));
    expect(merged.in_box.scryfall_id).toBe(card.in_box.scryfall_id);
  });

  it('reset to In-box copies the In-box Printing', () => {
    const card = cards[0]!;
    const w = wantedFromInBox(card);
    expect([w.scryfall_id, w.reason]).toEqual([card.in_box.scryfall_id, 'reset-to-box']);
  });

  it('batch several cards in chunks of 400, one write per card', () => {
    const w = wantedFromPrinting(pr({}), null, 'cycle');
    const patches = Array.from({ length: 850 }, (_, i) => ({ oracle_id: `o${i}`, patch: { kind: 'wanted' as const, wanted: w } }));
    const batches = cardBatches(patches, NOW);
    expect(batches.map((b) => b.length)).toEqual([400, 400, 50]);
    expect(batches[0]![0]!.write).toEqual({ fields: { wanted: w, updatedAt: NOW }, unionFlags: null });
    const twice = cardBatches([patches[0]!, patches[1]!, { ...patches[0]!, patch: { kind: 'clear_flags' } }], NOW);
    expect(twice.flat().map((b) => b.oracle_id)).toEqual(['o1', 'o0']);
    expect(cardBatches([], NOW)).toEqual([]);
  });
});

describe('picker', () => {
  it('filters promos and collectors editions by default but keeps Wanted and In-box', () => {
    const promo = pr({ promo: true });
    const ced = pr({ set: 'ced' });
    const plain = pr({});
    expect(filterPrintings([promo, ced, plain], DEFAULT_FILTERS)).toEqual([plain]);
    expect(filterPrintings([promo, ced, plain], DEFAULT_FILTERS, new Set([promo.id]))).toEqual([promo, plain]);
    expect(filterPrintings([pr({ frame: '1993' }), plain], { ...DEFAULT_FILTERS, frame: 'old' })).toHaveLength(1);
    expect(filterPrintings([pr({ highres: false }), plain], { ...DEFAULT_FILTERS, highresOnly: true })).toEqual([plain]);
  });

  it('groups by art, pinned art first, then newest', () => {
    const a1 = pr({ illustration_id: 'A', released_at: '2001-01-01' });
    const a2 = pr({ illustration_id: 'A', released_at: '2021-01-01' });
    const b = pr({ illustration_id: 'B', released_at: '2024-01-01' });
    const g = groupByArt([a1, a2, b]);
    expect(g.map((x) => x.key)).toEqual(['B', 'A']);
    expect(g[1]!.cover).toBe(a2);
    const pinned = groupByArt([a1, a2, b], new Set([a1.id]));
    expect(pinned.map((x) => x.key)).toEqual(['A', 'B']);
    expect(pinned[0]!.printings[0]).toBe(a1);
  });

  it('badges', () => {
    expect(badges(pr({ set: '30a', frame: '1997', highres: false }))).toEqual(['30A', 'retro', 'low-res']);
    expect(badges(pr({ set: 'sld', border_color: 'borderless', promo: true }))).toEqual(['borderless', 'promo', 'Secret Lair']);
    expect(badges(pr({ set: 'cei' }))).toEqual(["collectors' edition"]);
  });

  it('has its own routes', () => {
    expect(parseHash(printingsHash('abc'))).toEqual({ view: 'printings', oracleId: 'abc' });
    expect(parseHash(cycleHash('fetchlands_allied'))).toEqual({ view: 'cycles', cycle: 'fetchlands_allied' });
    expect(parseHash('#/cycles')).toEqual({ view: 'cycles', cycle: null });
    expect(parseHash('#/cube/abc').view).toBe('cube');
  });
});
