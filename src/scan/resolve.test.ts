import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPrinting } from './diff';
import type { ScannedRow } from './parse';
import { CACHE_KEY, NOT_FOUND_TTL_MS, loadCache, localPrintings, matchCollection, notFoundFresh, resolvePrintings, saveCache } from './resolve';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function row(scryfall_id: string): ScannedRow {
  return { name: 'x', quantity: 1, scryfall_id, set: null, collector_number: null, foil: null, language: null };
}

function printing(id: string): ResolvedPrinting {
  return { illustration_id: `ill-${id}`, name: id, set: 'set', collector_number: id, image_small: null };
}

function scryfallCard(id: string) {
  return { id, name: id, set: 'zzz', collector_number: id, illustration_id: `ill-${id}` };
}

/** fetch stub: answers with the requested ids, or fails for any id in `failIds`. */
function stubFetch(failIds: string[] = []) {
  const calls: string[][] = [];
  const fn = vi.fn(async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    const ids = (JSON.parse(init.body) as { identifiers: { id: string }[] }).identifiers.map((x) => x.id);
    calls.push(ids);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (ids.some((id) => failIds.includes(id))) return new Response('oops', { status: 503 });
    return new Response(JSON.stringify({ data: ids.map(scryfallCard) }), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localPrintings', () => {
  it('settles keys from cards.json and the cache without the network', () => {
    const known = new Map([['a', printing('a')]]);
    const { printings, todo } = localPrintings([row('a'), row('b'), row('c')], known, { b: printing('b') });
    expect([...printings.keys()]).toEqual(['a', 'b']);
    expect([...todo.keys()]).toEqual(['c']);
  });

  it('ignores slice 1 cache entries, which lack scryfall_id', () => {
    localStorage.setItem('cube.scryfall-printings.v1', JSON.stringify({ 'lea/1': printing('old') }));
    const r: ScannedRow = { name: 'x', quantity: 1, scryfall_id: null, set: 'lea', collector_number: '1', foil: null, language: null };
    const { printings, todo } = localPrintings([r], new Map());
    expect(printings.size).toBe(0);
    expect(todo.get('lea/1')).toEqual({ set: 'lea', collector_number: '1' });
    saveCache({ b: printing('b') });
    expect(localStorage.getItem('cube.scryfall-printings.v1')).toBeNull();
    expect(CACHE_KEY).not.toBe('cube.scryfall-printings.v1');
  });
});

describe('resolvePrintings', () => {
  it('keeps the local and earlier results when a Scryfall request fails', async () => {
    // 80 unknown ids: the first batch of 75 succeeds, the second fails.
    const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
    stubFetch(['id79']);
    const known = new Map([['local', printing('local')]]);
    const result = await resolvePrintings([row('local'), ...ids.map(row)], known);
    expect(result.error).toContain('503');
    expect(result.aborted).toBe(false);
    expect(result.printings.has('local')).toBe(true);
    expect(result.printings.has('id0')).toBe(true);
    expect(result.printings.has('id79')).toBe(false);
  });

  it('returns the local results when offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const known = new Map([['local', printing('local')]]);
    const result = await resolvePrintings([row('local'), row('other')], known);
    expect(result.error).toContain('Failed to fetch');
    expect([...result.printings.keys()]).toEqual(['local']);
  });

  it('stops between batches once aborted', async () => {
    const ids = Array.from({ length: 160 }, (_, i) => `id${i}`);
    const calls = stubFetch();
    const controller = new AbortController();
    const result = await resolvePrintings(ids.map(row), new Map(), {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.done > 0) controller.abort();
      },
    });
    expect(result.aborted).toBe(true);
    expect(calls.length).toBe(1);
    expect(result.printings.size).toBe(75);
  });
});

describe('not found and renamed identifiers', () => {
  function setRow(set: string, collector_number: string): ScannedRow {
    return { name: 'x', quantity: 1, scryfall_id: null, set, collector_number, foil: null, language: null };
  }

  it('remembers not_found keys and maps a renumbered answer back to the typed key', async () => {
    const fn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'abc', name: 'Card', set: 'mh2', collector_number: '263', illustration_id: 'ill' }],
          not_found: [{ set: 'zzz', collector_number: '1' }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fn);
    const rows = [setRow('MH2', '0263'), setRow('zzz', '1')];
    const result = await resolvePrintings(rows, new Map());
    expect(result.printings.get('mh2/0263')?.illustration_id).toBe('ill');
    expect(result.printings.has('zzz/1')).toBe(false);
    expect(loadCache()['zzz/1']).toEqual({ not_found_at: expect.any(Number) });
    // Second run: both keys are settled from the cache, nothing is fetched.
    const { printings, todo } = localPrintings(rows, new Map());
    expect(todo.size).toBe(0);
    expect(printings.has('mh2/0263')).toBe(true);
    await resolvePrintings(rows, new Map());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('asks Scryfall again for a not_found key after 24 hours', async () => {
    const t0 = Date.parse('2026-10-24T12:00:00Z');
    const rows = [setRow('zzz', '1')];
    const entry = { not_found_at: t0 };
    expect(notFoundFresh(entry, t0 + NOT_FOUND_TTL_MS - 1)).toBe(true);
    expect(notFoundFresh(entry, t0 + NOT_FOUND_TTL_MS)).toBe(false);
    expect(notFoundFresh(null, t0)).toBe(false);
    // Within a day the key is settled; after a day, or for an old entry without a time, it is asked again.
    expect(localPrintings(rows, new Map(), { 'zzz/1': entry }, t0 + 60_000).todo.size).toBe(0);
    expect(localPrintings(rows, new Map(), { 'zzz/1': entry }, t0 + NOT_FOUND_TTL_MS + 1).todo.get('zzz/1')).toEqual({ set: 'zzz', collector_number: '1' });
    expect(localPrintings(rows, new Map(), { 'zzz/1': null }, t0).todo.size).toBe(1);
    // An expired entry is refetched, and the new answer replaces it.
    localStorage.setItem(CACHE_KEY, JSON.stringify({ 'zzz/1': { not_found_at: Date.now() - NOT_FOUND_TTL_MS - 1000 } }));
    const fn = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'z1', name: 'New', set: 'zzz', collector_number: '1' }], not_found: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fn);
    const result = await resolvePrintings(rows, new Map());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.printings.get('zzz/1')?.scryfall_id).toBe('z1');
    expect(loadCache()['zzz/1']).toMatchObject({ scryfall_id: 'z1' });
  });

  it('falls back to the card id and set/number when the counts disagree', () => {
    const card = { id: 'x1', name: 'x', set: 'lea', collector_number: '1' };
    const { found, missing } = matchCollection(
      [
        ['a', { id: 'x1' }],
        ['b', { id: 'x2' }],
      ],
      { data: [card], notFound: [] },
    );
    expect(found).toEqual([[null, card]]);
    expect(missing).toEqual([]);
  });
});

describe('saveCache', () => {
  it('merges with entries another run wrote meanwhile', () => {
    saveCache({ a: printing('a') });
    saveCache({ b: printing('b') });
    expect(Object.keys(loadCache()).sort()).toEqual(['a', 'b']);
    expect(localStorage.getItem(CACHE_KEY)).toContain('ill-a');
  });
});
