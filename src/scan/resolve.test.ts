import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPrinting } from './diff';
import type { ScannedRow } from './parse';
import { CACHE_KEY, loadCache, localPrintings, resolvePrintings, saveCache } from './resolve';

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

describe('saveCache', () => {
  it('merges with entries another run wrote meanwhile', () => {
    saveCache({ a: printing('a') });
    saveCache({ b: printing('b') });
    expect(Object.keys(loadCache()).sort()).toEqual(['a', 'b']);
    expect(localStorage.getItem(CACHE_KEY)).toContain('ill-a');
  });
});
