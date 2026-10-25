import { describe, expect, it, vi } from 'vitest';
import type { ExpectedCard, ResolvedPrinting, ScannedRowWithPrinting } from './diff';
import { inBoxForToPrint, notInBoxCandidates, type PrintingLookup } from './owner';

const wanted = { scryfall_id: 'w-id', set: 'm10', collector_number: '7', illustration_id: 'w-ill', name: null };

function row(over: Partial<ScannedRowWithPrinting> = {}): ScannedRowWithPrinting {
  return { name: 'Bolt', quantity: 1, scryfall_id: null, set: null, collector_number: null, foil: null, language: null, printing: null, ...over };
}

function printing(over: Partial<ResolvedPrinting> = {}): ResolvedPrinting {
  return { illustration_id: 'p-ill', name: 'Bolt', set: 'lea', collector_number: '161', image_small: null, ...over };
}

function lookup(over: Partial<PrintingLookup> = {}): PrintingLookup {
  return { bySetNumber: vi.fn(async () => null), byId: vi.fn(async () => null), ...over };
}

describe('inBoxForToPrint', () => {
  it('uses the scanned Printing at confidence high', async () => {
    const l = lookup();
    const r = await inBoxForToPrint([row({ printing: printing({ scryfall_id: 'p-id' }) })], wanted, l);
    expect(r).toEqual({ scryfall_id: 'p-id', set: 'lea', collector_number: '161', illustration_id: 'p-ill', name: 'Bolt', source: 'scan', confidence: 'high' });
    expect(l.bySetNumber).not.toHaveBeenCalled();
  });

  it('looks up the id of a scanned Printing without one by set and number', async () => {
    const l = lookup({ bySetNumber: vi.fn(async () => printing({ scryfall_id: 'looked-up' })) });
    const r = await inBoxForToPrint([row({ printing: printing() })], wanted, l);
    expect(l.bySetNumber).toHaveBeenCalledWith('lea', '161');
    expect(r.scryfall_id).toBe('looked-up');
    expect(r.confidence).toBe('high');
  });

  it('looks up a row with only a Scryfall id by id', async () => {
    const l = lookup({ byId: vi.fn(async () => printing({ scryfall_id: 'raw-id', set: '2ed' })) });
    const r = await inBoxForToPrint([row({ scryfall_id: 'raw-id' })], wanted, l);
    expect(l.byId).toHaveBeenCalledWith('raw-id');
    expect(l.bySetNumber).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scryfall_id: 'raw-id', set: '2ed', confidence: 'high' });
  });

  it('looks up a row with set and number by set and number', async () => {
    const l = lookup({ bySetNumber: vi.fn(async () => printing({ scryfall_id: 'sn-id' })) });
    const r = await inBoxForToPrint([row({ scryfall_id: 'x', set: 'lea', collector_number: '161' })], wanted, l);
    expect(l.bySetNumber).toHaveBeenCalledWith('lea', '161');
    expect(l.byId).not.toHaveBeenCalled();
    expect(r.scryfall_id).toBe('sn-id');
  });

  it('falls back to the Wanted Printing at confidence medium', async () => {
    const r = await inBoxForToPrint([row({ set: 'lea', collector_number: '999' })], wanted, lookup());
    expect(r).toEqual({ scryfall_id: 'w-id', set: 'm10', collector_number: '7', illustration_id: 'w-ill', name: null, source: 'scan', confidence: 'medium' });
    expect(await inBoxForToPrint([row()], wanted, lookup())).toMatchObject({ scryfall_id: 'w-id', confidence: 'medium' });
  });

  it('throws on a lookup error, so nothing is written', async () => {
    const l = lookup({ bySetNumber: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(inBoxForToPrint([row({ set: 'lea', collector_number: '161' })], wanted, l)).rejects.toThrow('offline');
  });
});

describe('notInBoxCandidates', () => {
  const c = (id: string): ExpectedCard => ({
    name: id,
    front_name: id,
    oracle_id: id,
    in_box: { illustration_id: null, set: 'lea', collector_number: '1', image_small: '' },
  });

  it('leaves out Resolved rows and cards that are not on the List', () => {
    const inList = (id: string) => id !== 'pull';
    const out = notInBoxCandidates([c('a'), c('pull'), c('done'), c('b')], inList, { 'missing:done': true, 'unexpected:a': true });
    expect(out.map((x) => x.oracle_id)).toEqual(['a', 'b']);
  });
});
