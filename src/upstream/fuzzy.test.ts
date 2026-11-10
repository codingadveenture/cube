import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFacts } from './scryfall';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function card(name: string, oracle_id: string) {
  return {
    id: `id-${oracle_id}`,
    name,
    oracle_id,
    layout: 'normal',
    cmc: 1,
    type_line: 'Creature — Goblin Guest',
    mana_cost: '{R}',
    colors: ['R'],
    color_identity: ['R'],
    set: 'unf',
    collector_number: '1',
    games: ['paper'],
    lang: 'en',
    border_color: 'black',
    image_uris: { normal: 'x.jpg' },
  };
}

/** /cards/collection finds nothing; /cards/named?fuzzy= answers `fuzzy` for every name. */
function stubFetch(fuzzy: ReturnType<typeof card> | null) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/cards/collection')) return new Response(JSON.stringify({ data: [], not_found: [{}] }), { status: 200 });
      if (!fuzzy) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(fuzzy), { status: 200 });
    }),
  );
  return urls;
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('a name /cards/collection does not find', () => {
  it('is found by the fuzzy lookup when it is the same name bar punctuation', async () => {
    const urls = stubFetch(card('"Name Sticker" Goblin', 'o-goblin'));
    const facts = await fetchFacts(['Name Sticker Goblin']);
    expect(facts.get('Name Sticker Goblin')?.oracle_id).toBe('o-goblin');
    expect(facts.get('Name Sticker Goblin')?.facts.name).toBe('"Name Sticker" Goblin');
    expect(urls.some((u) => u.includes('/cards/named?fuzzy=Name%20Sticker%20Goblin'))).toBe(true);
  });

  it('stays not found when the fuzzy answer is another name', async () => {
    stubFetch(card('Lightning Bolt', 'o-bolt'));
    const facts = await fetchFacts(['Lightnign Bolt']);
    expect(facts.get('Lightnign Bolt')).toBeNull();
  });

  it('stays not found when Scryfall has nothing close', async () => {
    stubFetch(null);
    const facts = await fetchFacts(['No Such Card Here']);
    expect(facts.get('No Such Card Here')).toBeNull();
  });
});
