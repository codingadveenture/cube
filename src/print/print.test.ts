/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Card, CardsFile } from '../types';
import { cardStateOf, mergeCards } from '../store/baseline';
import { parseHash } from '../router';
import { A4, CROP_LEN, CROP_WIDTH, MIN_MARGIN, blockSize, cropMarks, fits, labelPosition, sheetMargins, slipPages, slipRects, testPageGeometry, type Rect } from './layout';
import { calibrate } from './calibration';
import {
  backImage,
  composeSlips,
  frontImage,
  markPrintedPatches,
  printedHistoryNames,
  mtgprintList,
  proxyGeneratorList,
  reprintLines,
  type BatchLine,
} from './batch';
import { DEFAULT_SETTINGS, appendHistory, effectiveSettings, historyTrim, mergeSettings, parseSetting, toPrintMeta, type PrintSettings } from './settings';
import { fromScryfall, mergeExtras, resolveExtras, toExtras, type ExtraDeps } from './extras';
import { plainError } from './errors';
import { defaultFetch } from './pdf';
import { markPrintedWrites, MARK_PRINTED_MAX } from '../store/writes';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const byName = (n: string) => cards.find((c) => c.name === n)!;
const NOW = '2026-10-24T12:00:00.000Z';

const geo = (over: Partial<PrintSettings> = {}): PrintSettings => ({ ...DEFAULT_SETTINGS, ...over });

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('slip layout', () => {
  it('lays 9 slips of 63 x 88 mm without a gap, centred on A4', () => {
    const r = slipRects(geo());
    expect(r).toHaveLength(9);
    close(r[0]!.x, 10.5);
    close(r[0]!.y, 16.5);
    close(r[1]!.x, 73.5);
    close(r[2]!.x, 136.5);
    close(r[3]!.y, 104.5);
    close(r[8]!.x + r[8]!.w, 199.5);
    close(r[8]!.y + r[8]!.h, 280.5);
    for (const s of r) {
      close(s.w, 63);
      close(s.h, 88);
    }
  });

  it('adds the gap between slips and keeps the block centred', () => {
    const r = slipRects(geo({ gap: 2 }));
    close(r[0]!.x, 8.5);
    close(r[1]!.x, 8.5 + 65);
    close(r[0]!.y, 14.5);
    close(r[3]!.y, 14.5 + 90);
    close(210 - (r[2]!.x + r[2]!.w), r[0]!.x);
    close(297 - (r[8]!.y + r[8]!.h), r[0]!.y);
  });

  it('applies the printer factors to the slip size', () => {
    const r = slipRects(geo({ profile: { name: 'p', fx: 1.01, fy: 0.99 } }));
    close(r[0]!.w, 63.63);
    close(r[0]!.h, 87.12);
    close(r[0]!.x, (210 - 3 * 63.63) / 2);
    close(r[0]!.y, (297 - 3 * 87.12) / 2);
    close(r[4]!.x, r[0]!.x + 63.63);
  });
});

function insideAnySlip(m: { x1: number; y1: number; x2: number; y2: number }, slips: Rect[]): boolean {
  const half = CROP_WIDTH / 2;
  const x1 = Math.min(m.x1, m.x2) - (m.x1 === m.x2 ? half : 0);
  const x2 = Math.max(m.x1, m.x2) + (m.x1 === m.x2 ? half : 0);
  const y1 = Math.min(m.y1, m.y2) - (m.y1 === m.y2 ? half : 0);
  const y2 = Math.max(m.y1, m.y2) + (m.y1 === m.y2 ? half : 0);
  return slips.some((s) => Math.min(x2, s.x + s.w) - Math.max(x1, s.x) > 1e-9 && Math.min(y2, s.y + s.h) - Math.max(y1, s.y) > 1e-9);
}

describe('crop marks', () => {
  for (const gap of [0, 1, 3]) {
    it(`never cross into a slip (gap ${gap} mm)`, () => {
      const slips = slipRects(geo({ gap }));
      const marks = cropMarks(slips);
      expect(marks.length).toBeGreaterThan(0);
      for (const m of marks) {
        expect(insideAnySlip(m, slips)).toBe(false);
        const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
        expect(len).toBeLessThanOrEqual(CROP_LEN + 1e-9);
        expect(len).toBeGreaterThanOrEqual(1);
        expect(m.x1 === m.x2 || m.y1 === m.y2).toBe(true);
        for (const v of [m.x1, m.x2]) expect(v >= 0 && v <= A4.w).toBe(true);
        for (const v of [m.y1, m.y2]) expect(v >= 0 && v <= A4.h).toBe(true);
      }
    });
  }

  it('without a gap leaves only the marks in the page margin, 4 mm long', () => {
    const slips = slipRects(geo());
    const marks = cropMarks(slips);
    expect(marks).toHaveLength(16);
    expect(marks).toContainEqual({ x1: 10.5, y1: 16.5, x2: 10.5, y2: 12.5 });
    expect(marks).toContainEqual({ x1: 10.5, y1: 16.5, x2: 6.5, y2: 16.5 });
    for (const m of marks) close(Math.hypot(m.x2 - m.x1, m.y2 - m.y1), 4);
  });

  it('with a gap puts two marks at every corner, cut at the next slip', () => {
    const slips = slipRects(geo({ gap: 3 }));
    const marks = cropMarks(slips);
    expect(marks).toHaveLength(72);
    // From the top right corner of the first slip, rightwards into the 3 mm gap only.
    const r0 = slips[0]!;
    expect(marks).toContainEqual({ x1: r0.x + r0.w, y1: r0.y, x2: r0.x + r0.w + 3, y2: r0.y });
  });

  it('puts the group label in the top margin above the marks', () => {
    const slips = slipRects(geo());
    const p = labelPosition(slips);
    expect(p.y).toBeLessThan(slips[0]!.y - CROP_LEN);
    expect(p.y).toBeGreaterThanOrEqual(4);
  });
});

describe('page grouping', () => {
  it('orders fronts, back pool, tokens, each from a new page', () => {
    const slips = [
      ...Array.from({ length: 10 }, (_, i) => ({ group: 'front' as const, id: `f${i}` })),
      { group: 'token' as const, id: 't0' },
      { group: 'back' as const, id: 'b0' },
      { group: 'token' as const, id: 't1' },
      { group: 'back' as const, id: 'b1' },
    ];
    const pages = slipPages(slips);
    expect(pages.map((p) => p.group)).toEqual(['front', 'front', 'back', 'token']);
    expect(pages.map((p) => p.items.length)).toEqual([9, 1, 2, 2]);
    expect(pages[0]!.label).toBe('Fronts, page 1 of 2');
    expect(pages[2]!.label).toBe('Back pool');
    expect(pages[3]!.items.map((s) => s.id)).toEqual(['t0', 't1']);
    expect(slipPages([])).toEqual([]);
  });
});

describe('test page', () => {
  it('draws a 180 mm and a 260 mm line on the page and one slip at the target size', () => {
    const g = testPageGeometry(geo({ profile: { name: 'p', fx: 1.01, fy: 1 } }));
    close(g.horizontal.x2 - g.horizontal.x1, 180);
    close(g.vertical.y2 - g.vertical.y1, 260);
    expect(g.horizontal.x1).toBeGreaterThanOrEqual(10);
    expect(g.horizontal.x2).toBeLessThanOrEqual(200);
    expect(g.vertical.y1).toBeGreaterThanOrEqual(10);
    expect(g.vertical.y2).toBeLessThanOrEqual(287);
    close(g.slip.w, 63.63);
    close(g.slip.h, 88);
  });
});

describe('calibration', () => {
  it('returns factors when both lines are within 2 percent', () => {
    expect(calibrate(180, 260)).toMatchObject({ kind: 'ok', fx: 1, fy: 1 });
    expect(calibrate(178.2, '262,6')).toMatchObject({ kind: 'ok', fx: 1.0101, fy: 0.9901 });
  });
  it('says the dialog is still scaling when a line is off by more than 2 percent', () => {
    expect(calibrate(170, 260).kind).toBe('still-scaling');
    expect(calibrate(180, 250).kind).toBe('still-scaling');
    // A4 shrunk to fit Letter is about 94 percent.
    expect(calibrate(169.2, 244.4).kind).toBe('still-scaling');
  });
  it('rejects missing or non-positive lengths', () => {
    expect(calibrate('', 260).kind).toBe('invalid');
    expect(calibrate(0, 260).kind).toBe('invalid');
    expect(calibrate('abc', 'def').kind).toBe('invalid');
  });
});

function lineOf(card: Card): BatchLine {
  return {
    key: `r:${card.oracle_id}`,
    source: 'reprint',
    oracle_id: card.oracle_id,
    name: card.name,
    list_name: card.wanted.name ?? card.name,
    set: card.wanted.set,
    collector_number: card.wanted.collector_number,
    scryfall_id: card.wanted.scryfall_id,
    illustration_id: card.wanted.illustration_id,
    image_normal: card.wanted.image_normal,
    back_image_normal: card.wanted.back_image_normal,
    back_name: card.wanted.back_name,
    quantity: 1,
  };
}

describe('lists', () => {
  const normal = lineOf(byName('Fiery Islet'));
  const split = lineOf(byName('Fire // Ice'));
  const dfc = lineOf(byName('Aang, Swift Savior'));
  const leovold = lineOf(byName('Leovold, Emissary of Trest'));

  it('mtgprint: "1 Name (SET) number", set upper-case, number unchanged', () => {
    expect(mtgprintList([normal])).toBe(`1 Fiery Islet (${normal.set.toUpperCase()}) ${normal.collector_number}`);
    expect(mtgprintList([split])).toBe(`1 Fire // Ice (${split.set.toUpperCase()}) ${split.collector_number}`);
    expect(mtgprintList([dfc])).toBe(`1 Aang, Swift Savior // Aang and La, Ocean's Fury (${dfc.set.toUpperCase()}) ${dfc.collector_number}`);
    expect(mtgprintList([leovold])).toBe('1 Leovold, Emissary of Trest (PLST) CN2-77');
  });

  it('MTG Proxy Generator: "1 SET/number -cd"', () => {
    expect(proxyGeneratorList([normal, split, dfc])).toBe(
      [normal, split, dfc].map((l) => `1 ${l.set.toUpperCase()}/${l.collector_number} -cd`).join('\n'),
    );
    expect(proxyGeneratorList([leovold])).toBe('1 PLST/CN2-77 -cd');
  });

  it('leave out back faces and tokens', () => {
    const text = mtgprintList([dfc]);
    expect(text.split('\n')).toHaveLength(1);
    // The back face is only part of the full "Front // Back" name, never a line of its own.
    expect(text.startsWith(`1 ${dfc.back_name}`)).toBe(false);
  });

  it('use the full Printing name for extras too, but show the front name', async () => {
    const aang = byName('Aang, Swift Savior');
    const full = "Aang, Swift Savior // Aang and La, Ocean's Fury";
    const r = await resolveExtras('Aang, Swift Savior', cards, {
      byPrinting: async () => null,
      byName: async () => null,
      byId: async () => null,
      newId: () => 'a',
    });
    expect(r.lines[0]!.name).toBe('Aang, Swift Savior');
    expect(r.lines[0]!.list_name).toBe(full);
    expect(mtgprintList(r.lines)).toBe(`1 ${full} (${aang.wanted.set.toUpperCase()}) ${aang.wanted.collector_number}`);
    // Extras stored before list_name existed fall back to the display name.
    const old: Partial<BatchLine> = { ...lineOf(byName('Fiery Islet')), key: 'x:old', source: 'extra' };
    delete old.list_name;
    expect(toExtras([old])[0]!.list_name).toBe('Fiery Islet');
  });
});

describe('batch composition', () => {
  const aang = byName('Aang, Swift Savior');
  // Make Aang a reprint: the box holds another Printing than the Wanted one.
  const state = cardStateOf(aang, NOW);
  state.in_box = { ...state.in_box!, scryfall_id: '00000000-0000-0000-0000-000000000000', set: 'xxx', collector_number: '1' };
  const merged = mergeCards(cards, new Map([[aang.oracle_id, state]]));

  it('finds every card whose Wanted Printing differs from its In-box Printing', () => {
    const lines = reprintLines(merged);
    const expected = merged.filter((c) => c.wanted.scryfall_id !== c.in_box!.scryfall_id).map((c) => c.oracle_id);
    expect(lines.map((l) => l.oracle_id).sort()).toEqual([...expected].sort());
    expect(lines.length).toBe(cards.filter((c) => c.wanted.scryfall_id !== c.in_box!.scryfall_id).length + 1);
    expect(lines.every((l) => l.source === 'reprint' && l.quantity === 1)).toBe(true);
  });

  it('derives the large jpg (standard) or png (best) and the back face image', () => {
    const l = reprintLines(merged).find((x) => x.oracle_id === aang.oracle_id)!;
    expect(frontImage(l)).toContain('/large/front/');
    expect(frontImage(l)).toMatch(/\.jpg(\?|$)/);
    expect(frontImage(l, 'best')).toContain('/png/front/');
    expect(frontImage(l, 'best')).toMatch(/\.png(\?|$)/);
    expect(backImage(l)).toContain('/large/back/');
  });

  it('puts back faces in the Back pool after the fronts and expands tokens to N copies', () => {
    const lines = reprintLines(merged);
    const tokens = [{ key: 'treasure', name: 'Treasure', count: 3, image_png: 'https://cards.scryfall.io/png/front/6/9/x.png?1' }];
    const slips = composeSlips(lines, tokens, 'standard');
    const groups = slips.map((s) => s.group);
    expect(groups.filter((g) => g === 'front')).toHaveLength(lines.length);
    expect(groups.filter((g) => g === 'back')).toHaveLength(lines.filter((l) => l.back_image_normal).length);
    expect(groups.filter((g) => g === 'back').length).toBeGreaterThanOrEqual(1);
    expect(groups.lastIndexOf('front')).toBeLessThan(groups.indexOf('back'));
    expect(groups.lastIndexOf('back')).toBeLessThan(groups.indexOf('token'));
    const toks = slips.filter((s) => s.group === 'token');
    expect(toks).toHaveLength(3);
    expect(toks[0]!.url).toBe('https://cards.scryfall.io/large/front/6/9/x.jpg?1');
    const back = slips.find((s) => s.group === 'back')!;
    expect(back.name).toBe(aang.wanted.back_name);
  });

  it('gives a line with quantity 2 two fronts and two backs', () => {
    const l = { ...lineOf(aang), quantity: 2 };
    const slips = composeSlips([l], [], 'standard');
    expect(slips.map((s) => s.group)).toEqual(['front', 'front', 'back', 'back']);
  });

  it('marks reprints as printed: In-box := Wanted, source printed, confidence high', () => {
    const lines = reprintLines(merged);
    const extra: BatchLine = { ...lineOf(byName('Fiery Islet')), key: 'x:1', source: 'extra' };
    const patches = markPrintedPatches(merged, [...lines, extra]);
    expect(patches).toHaveLength(lines.length);
    // The history counts the reprints only, not the extra.
    const names = printedHistoryNames([...lines, extra], patches);
    expect(names).toEqual(lines.map((l) => l.name));
    expect(names).toHaveLength(patches.length);
    const p = patches.find((x) => x.oracle_id === aang.oracle_id)!;
    expect(p.patch).toEqual({
      kind: 'in_box',
      in_box: {
        scryfall_id: aang.wanted.scryfall_id,
        set: aang.wanted.set,
        collector_number: aang.wanted.collector_number,
        illustration_id: aang.wanted.illustration_id,
        name: aang.wanted.name,
        image_normal: aang.wanted.image_normal,
        source: 'printed',
        confidence: 'high',
      },
    });
    expect(p.patch.kind === 'in_box' && p.patch.in_box.name).toBe("Aang, Swift Savior // Aang and La, Ocean's Fury");
    // After the write the card is no longer a reprint.
    const after = cardStateOf(aang, NOW);
    if (p.patch.kind === 'in_box') after.in_box = p.patch.in_box;
    const again = mergeCards(cards, new Map([[aang.oracle_id, after]]));
    expect(reprintLines(again).some((l) => l.oracle_id === aang.oracle_id)).toBe(false);
  });

  it('marks the Printing that went on the sheet, even when Wanted changed since', () => {
    const line = reprintLines(merged).find((l) => l.oracle_id === aang.oracle_id)!;
    // Wanted moves to another Printing after the PDF was generated.
    const changed = merged.map((c) =>
      c.oracle_id === aang.oracle_id ? { ...c, wanted: { ...c.wanted, scryfall_id: 'other', set: 'zzz', collector_number: '7', image_normal: 'z.jpg' } } : c,
    );
    const [p] = markPrintedPatches(changed, [line]);
    expect(p!.patch.kind === 'in_box' && p!.patch.in_box).toMatchObject({
      scryfall_id: line.scryfall_id,
      set: line.set,
      collector_number: line.collector_number,
      illustration_id: line.illustration_id,
      image_normal: line.image_normal,
      name: line.list_name,
    });
  });
});

describe('sheet fit', () => {
  it('measures the block and its margins', () => {
    expect(blockSize(geo())).toEqual({ w: 189, h: 264 });
    const m = sheetMargins(geo());
    close(m.x, 10.5);
    close(m.y, 16.5);
    expect(fits(geo())).toBe(true);
    expect(fits(geo({ gap: 2 }))).toBe(true);
  });

  it('refuses a block that leaves less than 5 mm on any side', () => {
    expect(MIN_MARGIN).toBe(5);
    expect(fits(geo({ slipW: 70, slipH: 95 }))).toBe(false); // 210 x 285: no side margin
    expect(fits(geo({ slipW: 72 }))).toBe(false); // wider than the paper
    expect(fits(geo({ slipW: 66, slipH: 95, gap: 3 }))).toBe(false);
    expect(fits(geo({ slipH: 93 }))).toBe(true); // 279 high: 9 mm top and bottom
    expect(fits(geo({ slipH: 93, profile: { name: 'p', fx: 1, fy: 1.05 } }))).toBe(false); // 293 high with the factor
    // Exactly 5 mm still fits: (210 - 200) / 2.
    expect(fits(geo({ slipW: 200 / 3 }))).toBe(true);
  });
});

describe('extras', () => {
  const deps = (over: Partial<ExtraDeps> = {}): ExtraDeps => {
    let i = 0;
    return {
      byPrinting: async () => null,
      byName: async () => null,
      byId: async () => null,
      newId: () => `id${i++}`,
      ...over,
    };
  };

  it('uses the Wanted Printing for a Cube card named without a set', async () => {
    const r = await resolveExtras('2 Fire // Ice\nAang, Swift Savior', cards, deps());
    expect(r.failed).toEqual([]);
    expect(r.lines.map((l) => [l.name, l.set, l.quantity, l.source])).toEqual([
      ['Fire // Ice', byName('Fire // Ice').wanted.set, 2, 'extra'],
      ['Aang, Swift Savior', byName('Aang, Swift Savior').wanted.set, 1, 'extra'],
    ]);
    expect(r.lines[1]!.back_image_normal).toBe(byName('Aang, Swift Savior').wanted.back_image_normal);
  });

  it('takes the first Scryfall hit for a name outside the Cube, and reports misses', async () => {
    const r = await resolveExtras(
      'Delver of Secrets\nNo Such Card',
      cards,
      deps({
        byName: async (name) =>
          name === 'Delver of Secrets'
            ? {
                id: 'd1',
                name: 'Delver of Secrets // Insectile Aberration',
                set: 'isd',
                collector_number: '51',
                card_faces: [
                  { name: 'Delver of Secrets', image_uris: { normal: 'https://cards.scryfall.io/normal/front/d/1/d1.jpg' } },
                  { name: 'Insectile Aberration', image_uris: { normal: 'https://cards.scryfall.io/normal/back/d/1/d1.jpg' } },
                ],
              }
            : null,
      }),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.back_name).toBe('Insectile Aberration');
    expect(r.lines[0]!.list_name).toBe('Delver of Secrets // Insectile Aberration');
    expect(r.failed).toEqual(['1 No Such Card: not found']);
  });

  it('reports lookup failures in plain words', async () => {
    const r = await resolveExtras(
      'Delver of Secrets\nGrizzly Bears',
      cards,
      deps({
        byName: async (name) => {
          if (name === 'Delver of Secrets') throw new TypeError('Failed to fetch');
          throw new Error('Scryfall answered 429');
        },
      }),
    );
    expect(r.failed).toEqual([
      '1 Delver of Secrets: Could not reach Scryfall; check the connection and try again.',
      '1 Grizzly Bears: Scryfall is busy; wait a minute and try again.',
    ]);
  });

  it('merges a card added twice into one line with both quantities', () => {
    const bolt = (key: string, quantity: number): BatchLine => ({ ...lineOf(byName('Fiery Islet')), key, source: 'extra', quantity });
    const once = mergeExtras([], [bolt('x:a', 1), bolt('x:b', 2)]);
    expect(once).toHaveLength(1);
    expect(once[0]!.quantity).toBe(3);
    const twice = mergeExtras(once, [bolt('x:c', 1)]);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.quantity).toBe(4);
    expect(once[0]!.quantity).toBe(3); // the old list is not changed in place
    // Different Printings under a key already used get a fresh key.
    const other: BatchLine = { ...lineOf(byName('Fire // Ice')), key: 'x:a', source: 'extra' };
    const both = mergeExtras(once, [{ ...other, scryfall_id: 'different' }]);
    expect(both).toHaveLength(2);
    expect(new Set(both.map((l) => l.key)).size).toBe(2);
  });

  it('resolves "Name (SET) 123" through the printing lookup', async () => {
    const r = await resolveExtras(
      'Grizzly Bears (LEA) 205',
      cards,
      deps({
        byPrinting: async (set, num) => ({
          scryfall_id: 'b1',
          illustration_id: 'a1',
          name: 'Grizzly Bears',
          set,
          collector_number: num,
          image_small: 'https://cards.scryfall.io/small/front/b/1/b1.jpg',
        }),
      }),
    );
    expect(r.lines[0]).toMatchObject({ set: 'lea', collector_number: '205', image_normal: 'https://cards.scryfall.io/normal/front/b/1/b1.jpg', back_image_normal: null });
  });

  it('treats a split card from Scryfall as one face', () => {
    const l = fromScryfall(
      { id: 's', name: 'Fire // Ice', set: 'apc', collector_number: '128', image_uris: { normal: 'n.jpg' }, card_faces: [{ name: 'Fire' }, { name: 'Ice' }] },
      1,
      'x',
      null,
    );
    expect(l?.back_image_normal).toBeNull();
  });
});

describe('print settings', () => {
  it('falls back to the defaults field by field', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ gap: 2, quality: 'ultra', slipW: '62.5', cropMarks: 'yes' })).toEqual({ ...DEFAULT_SETTINGS, gap: 2, slipW: 62.5 });
    expect(mergeSettings({ profile: { name: 'Canon', fx: 1.004, fy: 0.998 } }).profile).toEqual({ name: 'Canon', fx: 1.004, fy: 0.998 });
    expect(mergeSettings({ profile: { name: 'Bad', fx: 3, fy: 1 } }).profile).toEqual(DEFAULT_SETTINGS.profile);
    expect(DEFAULT_SETTINGS).toMatchObject({ slipW: 63, slipH: 88, gap: 0, cropMarks: true, quality: 'standard', profile: { fx: 1, fy: 1 } });
  });

  it('lays a visitor\'s own settings over the Owner\'s shared ones', () => {
    const shared = { slipW: 62, gap: 1 };
    expect(effectiveSettings(shared, { gap: 0.5 }, false)).toMatchObject({ slipW: 62, gap: 0.5, slipH: 88 });
    expect(effectiveSettings(shared, { gap: 0.5 }, true)).toMatchObject({ slipW: 62, gap: 1 });
    expect(effectiveSettings(null, null, false)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the last 50 history entries and reads the meta doc defensively', () => {
    let h = [] as ReturnType<typeof appendHistory>;
    for (let i = 0; i < 55; i++) h = appendHistory(h, { date: `d${i}`, count: 1, printer: 'p', names: ['x'] });
    expect(h).toHaveLength(50);
    expect(h[0]!.date).toBe('d5');
    expect(toPrintMeta(null)).toEqual({ settings: null, profiles: {}, history: [] });
    const m = toPrintMeta({ profiles: { Canon: { fx: 1.01, fy: 0.99 }, Broken: { fx: 'x' } }, history: [{ date: '2026-10-24', count: 2 }, 5] });
    expect(m.profiles).toEqual({ Canon: { name: 'Canon', fx: 1.01, fy: 0.99 } });
    expect(m.history).toEqual([{ date: '2026-10-24', count: 2, printer: '', names: [] }]);
  });

  it('trims only the oldest stored entries, as stored, and never from nothing', () => {
    const stored = Array.from({ length: 50 }, (_, i) => ({ date: `d${i}`, count: 1, printer: 'p', names: [], at: `t${i}` }));
    // 50 stored + 1 new: the oldest one goes.
    expect(historyTrim(stored)).toEqual([stored[0]]);
    expect(historyTrim(stored.slice(0, 49))).toEqual([]);
    expect(historyTrim([...stored, { date: 'x' }, { date: 'y' }])).toEqual(stored.slice(0, 3));
    // A missing or damaged history (not loaded yet) removes nothing.
    expect(historyTrim(undefined)).toEqual([]);
    expect(historyTrim({ 0: 'a' })).toEqual([]);
    // Reading keeps the last 50 and the write time.
    const read = toPrintMeta({ history: [...stored, { date: 'new', count: 2, printer: 'p', names: ['a'], at: 'tn' }] }).history;
    expect(read).toHaveLength(50);
    expect(read[0]!.date).toBe('d1');
    expect(read[49]).toEqual({ date: 'new', count: 2, printer: 'p', names: ['a'], at: 'tn' });
  });

  it('parses a typed setting with a comma or a point, and refuses anything out of range', () => {
    expect(parseSetting('63,5', 30, 100)).toBe(63.5);
    expect(parseSetting(' 63.5 ', 30, 100)).toBe(63.5);
    expect(parseSetting('630', 30, 100)).toBeNull();
    expect(parseSetting('1.3', 0.8, 1.25)).toBeNull();
    expect(parseSetting('1,004', 0.8, 1.25)).toBe(1.004);
    expect(parseSetting('', 0, 10)).toBeNull();
    expect(parseSetting('63mm', 30, 100)).toBeNull();
    expect(parseSetting('-1', 0, 10)).toBeNull();
    expect(parseSetting('0', 0, 10)).toBe(0);
  });
});

describe('mark as printed write', () => {
  it('puts every card in one batch, the last patch per card, and refuses one too big for a batch', () => {
    const patch = (id: string, set: string) => ({
      oracle_id: id,
      patch: { kind: 'in_box' as const, in_box: { scryfall_id: 's', set, collector_number: '1', illustration_id: null, name: 'n', source: 'printed', confidence: 'high' } },
    });
    const w = markPrintedWrites([patch('a', 'one'), patch('b', 'two'), patch('a', 'three')], NOW);
    expect(w.map((x) => x.oracle_id)).toEqual(['b', 'a']);
    expect((w[1]!.write.fields.in_box as { set: string }).set).toBe('three');
    expect(markPrintedWrites([], NOW)).toEqual([]);
    const many = Array.from({ length: MARK_PRINTED_MAX + 1 }, (_, i) => patch(`c${i}`, 'x'));
    expect(() => markPrintedWrites(many, NOW)).toThrow(/Too many cards/);
    expect(markPrintedWrites(many.slice(1), NOW)).toHaveLength(MARK_PRINTED_MAX);
  });
});

describe('image fetch timeout', () => {
  it('gives up on a hung request after the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
      ),
    );
    try {
      await expect(defaultFetch('https://x/img.jpg', undefined, 20)).rejects.toBeTruthy();
      const user = new AbortController();
      const pending = defaultFetch('https://x/img.jpg', user.signal, 60_000);
      user.abort();
      await expect(pending).rejects.toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('error text', () => {
  it('maps raw errors to one plain sentence', () => {
    expect(plainError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/pdf-abc.js'), 'pdf')).toBe('The app was updated; reload the page.');
    expect(plainError(new TypeError('Failed to fetch'), 'tokens')).toBe('Could not load the tokens; check the connection and try again.');
    expect(plainError(new Error('tokens.json: HTTP 404'), 'tokens')).toBe('The app was updated; reload the page.');
    expect(plainError(new TypeError('NetworkError when attempting to fetch resource.'), 'scryfall')).toBe(
      'Could not reach Scryfall; check the connection and try again.',
    );
    expect(plainError(new Error('Scryfall answered 503'), 'scryfall')).toBe('Scryfall did not answer properly; try again later.');
    expect(plainError(new Error('jsPDF exploded'), 'pdf')).toBe('Could not build the PDF; try again, or reload the page.');
    for (const ctx of ['pdf', 'tokens', 'scryfall'] as const) expect(plainError('weird', ctx)).not.toMatch(/Error|weird/);
  });
});

describe('route', () => {
  it('parses #/print and its Tokens section', () => {
    const r = parseHash('#/print?section=tokens');
    expect(r.view).toBe('print');
    if (r.view === 'print') expect(r.query.get('section')).toBe('tokens');
    expect(parseHash('#/about').view).toBe('about');
  });
});
