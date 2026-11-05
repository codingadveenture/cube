/// <reference types="node" />
// The data-safety rules of the Update flow: sticky name matching, stale decisions and previews,
// what Apply writes, new-card guards, the history trim, snapshot sanity and CubeCobra errors.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardsFile } from '../types';
import type { CardFacts, CardPatchFor, Decision, WantedState } from '../store/types';
import { computeFeed, decide, groupFeed, looseName, markApplied, previewBasis, staleDecisions } from './feed';
import { keyOf, nameIndex, snapshotProblem } from './names';
import { cubecobraHttpError } from './net';
import { planApply, planIsEmpty, type Preview } from './plan';
import type { ResolvedIn, ResolvedOut } from './resolveIn';
import { guardNewCards, updateBatches } from './update';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const NOW = '2026-10-24T12:00:00.000Z';
const byName = (n: string) => cards.find((c) => c.name === n)!;
const index = nameIndex(cards);
const key = (n: string) => keyOf(index, n);

describe('sticky names', () => {
  it('compares loosely, without quotes and punctuation', () => {
    expect(looseName('"Name Sticker" Goblin')).toBe('name sticker goblin');
    expect(looseName('Name Sticker Goblin')).toBe('name sticker goblin');
    expect(looseName('Jace, the Mind Sculptor')).toBe('jace the mind sculptor');
  });

  it('applies a Ban logged without the quotes CubeCobra uses', () => {
    const feed = computeFeed({
      list: ['Lightning Bolt'],
      upstream: ['Lightning Bolt', '"Name Sticker" Goblin'],
      sticky: { adds: [], bans: ['Name Sticker Goblin'] },
      keyOf: key,
    });
    expect(feed.adds).toEqual([]);
    expect(feed.unresolvedSticky).toEqual([]);
  });

  it('protects a List card from a cut when its Winner’s Pick is spelled differently', () => {
    const feed = computeFeed({
      list: ['Lightning Bolt', 'Zzyx, the Pick'],
      upstream: ['Lightning Bolt'],
      sticky: { adds: ['Zzyx the Pick'], bans: [] },
      keyOf: key,
    });
    expect(feed.cuts).toEqual([]);
    expect(feed.adds).toEqual([]);
  });

  it('reports a sticky name that matches nothing', () => {
    const feed = computeFeed({
      list: ['Lightning Bolt'],
      upstream: ['Lightning Bolt'],
      sticky: { adds: ['Lightning Bolt', 'Nothing Like It'], bans: ['Also Nothing'] },
      keyOf: key,
    });
    expect(feed.unresolvedSticky).toEqual(['Also Nothing', 'Nothing Like It']);
  });

  it('resolves a sticky name through an oracle_id taught to the index', () => {
    const goblinId = 'goblin-oracle';
    const taught = nameIndex(cards, [['"Name Sticker" Goblin', goblinId]]);
    const k = (n: string) => keyOf(taught, n);
    const feed = computeFeed({ list: [], upstream: ['"Name Sticker" Goblin'], sticky: { adds: [], bans: ['"Name Sticker" Goblin'] }, keyOf: k });
    expect(feed.adds).toEqual([]);
    expect(feed.unresolvedSticky).toEqual([]);
  });
});

describe('stale decisions', () => {
  const d = (side: 'add' | 'cut', applied_at: string | null = null): Decision => ({ status: 'accepted', side, at: NOW, note: '', applied_at });

  it('drops decisions whose item left the feed, and keeps the rest', () => {
    const feed = computeFeed({ list: ['Lightning Bolt', 'Sol Ring'], upstream: ['Lightning Bolt', 'New Card'], sticky: { adds: [], bans: [] }, keyOf: key });
    const decisions = {
      'New Card': d('add', NOW),
      'Sol Ring': d('cut'),
      // Applied and pushed: no longer a change.
      'Old Card': d('cut', NOW),
      // Same name, other side: a stale cut decision must not attach to a later add.
      'new card': d('cut', NOW),
    };
    expect(staleDecisions(decisions, feed, key).sort()).toEqual(['Old Card', 'new card']);
  });

  it('lets the Owner decide again on an applied item that comes back', () => {
    // An applied add whose card is still not on the List shows under applied; deciding again
    // (Reject) replaces the decision.
    const feed = computeFeed({ list: [], upstream: ['New Card'], sticky: { adds: [], bans: [] }, keyOf: key, decisions: { 'New Card': d('add', NOW) } });
    expect(groupFeed(feed.adds).applied.map((i) => i.name)).toEqual(['New Card']);
    const again = decide(feed.adds, 'rejected', NOW);
    const after = computeFeed({ list: [], upstream: ['New Card'], sticky: { adds: [], bans: [] }, keyOf: key, decisions: again });
    expect(groupFeed(after.adds).rejected.map((i) => i.name)).toEqual(['New Card']);
  });
});

describe('the preview basis', () => {
  const base = { list: ['Lightning Bolt', 'Sol Ring'], upstream: ['Lightning Bolt', 'New Card', 'Other Card'], sticky: { adds: [], bans: [] }, keyOf: key };
  const accepted = (decisions: Record<string, Decision>) => {
    const f = computeFeed({ ...base, decisions });
    return [groupFeed(f.adds).accepted, groupFeed(f.cuts).accepted] as const;
  };

  it('changes when a decision or a typed name changes, and not otherwise', () => {
    const both = decide(computeFeed(base).adds, 'accepted', NOW);
    const [a1, c1] = accepted(both);
    const before = previewBasis(a1, c1, ['Typed Card']);
    expect(previewBasis(a1, c1, ['typed card'])).toBe(before);
    const [a2, c2] = accepted({ ...both, 'New Card': { ...both['New Card']!, status: 'rejected' } });
    expect(previewBasis(a2, c2, ['Typed Card'])).not.toBe(before);
    expect(previewBasis(a1, c1, [])).not.toBe(before);
  });
});

const facts: CardFacts = {
  name: 'New Card',
  type_line: 'Instant',
  mana_cost: '{U}',
  cmc: 1,
  colors: ['U'],
  color_identity: ['U'],
  color_category: 'U',
  type_category: 'Instant',
  layout: 'normal',
  image_normal: null,
  back_name: null,
  back_image_normal: null,
  oracle_cycle_tags: [],
  produces_tokens: [],
};
const wanted: WantedState = { scryfall_id: 'w1', set: 'abc', collector_number: '1', illustration_id: null, name: 'New Card', reason: 'default-rule' };

function resolved(over: Partial<ResolvedIn>): ResolvedIn {
  return {
    name: 'New Card',
    oracle_id: 'new-oracle',
    sticky: false,
    facts,
    wanted,
    cycle_tags: [],
    action: 'new',
    image: null,
    printing: 'ABC 1',
    error: null,
    ...over,
  };
}

describe('what Apply writes', () => {
  const bolt = byName('Lightning Bolt');
  const sol = byName('Sol Ring');
  const lotusOff: Card = { ...byName('Black Lotus'), in_list: false };

  it('counts only the rows that write, and keeps failed typed names', () => {
    const outs: ResolvedOut[] = [
      { name: 'Sol Ring', card: sol, error: null },
      { name: 'Black Lotus', card: lotusOff, error: 'Already off the List.' },
    ];
    const feed = computeFeed({ list: ['Sol Ring', 'Lightning Bolt'], upstream: ['Lightning Bolt', 'New Card'], sticky: { adds: [], bans: [] }, keyOf: key });
    const items = [...feed.adds, ...feed.cuts].map((i) => ({ ...i, decision: decide([i], 'accepted', NOW)[i.name]! }));
    const p: Preview = {
      ins: [
        resolved({}),
        resolved({ name: 'Lightning Bolt', oracle_id: bolt.oracle_id, facts: null, wanted: null, action: 'none' }),
        resolved({ name: 'Mispeled Pick', oracle_id: '', facts: null, wanted: null, error: 'Scryfall does not know this name. Check the spelling.' }),
      ],
      outs,
      items,
      manual: false,
      manualNames: ['Lightning Bolt', 'Mispeled Pick'],
    };
    const plan = planApply(p, cards, NOW);
    expect(plan.writes.history.in).toEqual(['New Card']);
    expect(plan.writes.history.out).toEqual(['Sol Ring']);
    expect(plan.errors).toBe(2);
    expect(plan.unchanged).toBe(1);
    expect(plan.keepManual).toEqual(['Mispeled Pick']);
    expect(plan.toPrint).toBe(1);
    expect(plan.toPull).toBe(1);
    expect(Object.keys(plan.writes.decisions).sort()).toEqual(['New Card', 'Sol Ring']);
    expect(planIsEmpty(plan)).toBe(false);
  });

  it('is empty when every row failed', () => {
    const p: Preview = { ins: [resolved({ error: 'x' })], outs: [], items: [], manual: true, manualNames: ['New Card'] };
    const plan = planApply(p, cards, NOW);
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.keepManual).toEqual(['New Card']);
  });

  it('matches markApplied for the items that went in', () => {
    const feed = computeFeed({ list: [], upstream: ['New Card'], sticky: { adds: [], bans: [] }, keyOf: key });
    const items = feed.adds.map((i) => ({ ...i, decision: decide([i], 'accepted', NOW)[i.name]! }));
    const plan = planApply({ ins: [resolved({})], outs: [], items, manual: false, manualNames: [] }, cards, NOW);
    expect(plan.writes.decisions).toEqual(markApplied(items, NOW));
  });
});

describe('the new-card guard', () => {
  const newCard = (id: string): CardPatchFor => ({
    oracle_id: id,
    patch: {
      kind: 'new_card',
      state: {
        name: 'New Card',
        in_box: null,
        wanted,
        flags: [],
        in_list: true,
        list_source: 'winner_pick',
        facts,
        oracle_cycle_tags: [],
        retired_printing: null,
        added_at: NOW,
        retired_at: null,
      } as Extract<CardPatchFor['patch'], { kind: 'new_card' }>['state'],
    },
  });
  const inBox = byName('Lightning Bolt').in_box!;

  it('never writes a whole new doc over one the server has', () => {
    const existing = new Map([
      ['in-box-on-list', { in_box: inBox, in_list: true }],
      ['to-print', { in_box: null, in_list: true }],
      ['to-pull', { in_box: inBox, in_list: false }],
      ['retired', { in_box: null, in_list: false }],
    ]);
    const out = guardNewCards(
      [newCard('in-box-on-list'), newCard('to-print'), newCard('to-pull'), newCard('retired'), newCard('fresh'), { oracle_id: 'x', patch: { kind: 'list_out' } }],
      existing as never,
    );
    expect(out.map((p) => [p.oracle_id, p.patch.kind])).toEqual([
      ['to-pull', 'list_in'],
      ['retired', 'list_in'],
      ['fresh', 'new_card'],
      ['x', 'list_out'],
    ]);
    expect(out[0]!.patch).toEqual({ kind: 'list_in', list_source: 'winner_pick', added_at: NOW, wanted: null });
    expect(out[1]!.patch).toEqual({ kind: 'list_in', list_source: 'winner_pick', added_at: NOW, wanted });
  });
});

describe('the Update history trim', () => {
  const many = (n: number, trim?: unknown[]) => ({
    cards: Array.from({ length: n }, (_, i) => ({ oracle_id: `id${i}`, patch: { kind: 'list_out' as const } })),
    decisions: {},
    history: { date: '', at: '', in: [], out: [], source: 'upstream' as const },
    trim,
  });

  it('makes room for the third meta write when history is trimmed', () => {
    const sizes = (n: number, size: number, trim?: unknown[]) => updateBatches(many(n, trim), NOW, size).map((b) => [b.cards.length, b.meta]);
    expect(sizes(2, 4)).toEqual([[2, true]]);
    expect(sizes(2, 4, [{ at: 'old' }])).toEqual([
      [2, false],
      [0, true],
    ]);
    expect(sizes(1, 4, [{ at: 'old' }])).toEqual([[1, true]]);
    expect(sizes(1, 4, [])).toEqual([[1, true]]);
  });
});

describe('snapshot sanity', () => {
  it('rejects an empty, truncated or oversized cubelist', () => {
    expect(snapshotProblem(540, 540, 'L', 'U')).toBeNull();
    expect(snapshotProblem(300, 600, 'L', 'U')).toBeNull();
    expect(snapshotProblem(0, 540, 'L', 'U')).toContain('0 names for L');
    expect(snapshotProblem(540, 12, 'L', 'U')).toContain('12 names for U');
    expect(snapshotProblem(601, 299, 'L', 'U')).toMatch(/601 names for L and 299 names for U/);
  });
});

describe('CubeCobra errors', () => {
  it('words rate limits and outages plainly', () => {
    expect(cubecobraHttpError(429, null)).toBe('CubeCobra says too many requests; try again in a minute.');
    expect(cubecobraHttpError(429, '30')).toBe('CubeCobra says too many requests; try again in 30 seconds.');
    expect(cubecobraHttpError(429, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe('CubeCobra says too many requests; try again in a minute.');
    expect(cubecobraHttpError(503, null)).toBe('CubeCobra is not answering (HTTP 503). Try again later.');
  });
});
