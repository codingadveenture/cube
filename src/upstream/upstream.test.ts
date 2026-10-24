/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, CardsFile } from '../types';
import { EMPTY_OVERRIDES, type CardFacts, type LogEntry, type WantedState } from '../store/types';
import { cardPatchWrite } from '../store/writes';
import { acceptRemaining, computeFeed, decide, groupFeed, markApplied, stickySets } from './feed';
import { keyOf, nameIndex, parseCubelist, parseNameLines } from './names';
import { buildUpdateWrites, inAction, updateBatches, type InCard } from './update';
import { CSV_COLUMNS, csvField, cubecobraCsv, cubecobraPaste, exportName, listBasics, pasteLine, upstreamPrintings } from './cubecobra';
import { colorCategory, factsFromScryfall, indexPrinting, keepPrinting, lookupName, typeCategory, type ScryfallCard } from './scryfall';
import { findUpstream, resolveOuts, upstreamWanted } from './resolveIn';
import { toUpdateHistory, toUpstreamMeta } from './meta';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const NOW = '2026-10-24T12:00:00.000Z';
const byName = (n: string) => cards.find((c) => c.name === n)!;

function logEntry(type: LogEntry['type'], card_name: string | null): LogEntry {
  return { id: card_name ?? 'x', type, card_name, by: 'A', date: '2026-01-01', cut: null, note: '', createdAt: NOW };
}

describe('sticky sets', () => {
  it('joins the overrides with the Log, without duplicates', () => {
    const s = stickySets({ adds: ['Embercleave'], bans: [], updatedAt: null }, [
      logEntry('winner_pick', 'Embercleave'),
      logEntry('winner_pick', 'Bazaar of Baghdad'),
      logEntry('winner_pick', null),
      logEntry('ban', '"Name Sticker" Goblin'),
    ]);
    expect(s.adds).toEqual(['Embercleave', 'Bazaar of Baghdad']);
    expect(s.bans).toEqual(['"Name Sticker" Goblin']);
  });
});

describe('the Upstream feed', () => {
  // The Cube knows Ademi of the Silkchutes, whose paper Printing is named Spectacular Spider-Man.
  const index = nameIndex(cards);
  const key = (n: string) => keyOf(index, n);
  const list = ['Ademi of the Silkchutes', 'Lightning Bolt', 'Embercleave', 'Sol Ring', 'Old Card'];
  const upstream = ['Spectacular Spider-Man', 'Lightning Bolt', 'Sol Ring', 'New Card', '"Name Sticker" Goblin', 'Another New Card'];
  const sticky = { adds: ['Embercleave', 'Booster Tutor'], bans: ['"Name Sticker" Goblin'] };

  it('compares by oracle_id when known, so a rename is neither an add nor a cut', () => {
    expect(key('Spectacular Spider-Man')).toBe(byName('Ademi of the Silkchutes').oracle_id);
    expect(key('ademi of the silkchutes')).toBe(byName('Ademi of the Silkchutes').oracle_id);
    expect(key('Unknown Thing')).toBe('n:unknown thing');
    const feed = computeFeed({ list, upstream, sticky, keyOf: key });
    const names = (xs: { name: string }[]) => xs.map((x) => x.name);
    expect(names(feed.adds)).toEqual(['Another New Card', 'Booster Tutor', 'New Card']);
    expect(names(feed.cuts)).toEqual(['Old Card']);
    expect(feed.adds.find((a) => a.name === 'Booster Tutor')!.sticky).toBe(true);
    expect(feed.adds.find((a) => a.name === 'New Card')!.sticky).toBe(false);
    // Proposed: Ademi, Bolt, Sol Ring, New Card, Another New Card, Embercleave, Booster Tutor.
    expect(feed.proposed).toBe(7);
  });

  it('falls back to the normalised name when no oracle_id is known', () => {
    const plain = (n: string) => `n:${n.toLowerCase()}`;
    const feed = computeFeed({ list: ['Ademi of the Silkchutes'], upstream: ['Spectacular Spider-Man'], sticky: { adds: [], bans: [] }, keyOf: plain });
    expect(feed.adds.map((a) => a.name)).toEqual(['Spectacular Spider-Man']);
    expect(feed.cuts.map((a) => a.name)).toEqual(['Ademi of the Silkchutes']);
  });

  it('keeps a Ban out and never cuts a sticky add', () => {
    const feed = computeFeed({ list, upstream, sticky, keyOf: key });
    expect(feed.adds.some((a) => a.name.includes('Name Sticker'))).toBe(false);
    expect(feed.cuts.some((c) => c.name === 'Embercleave')).toBe(false);
  });

  it('carries decisions for the same side, and groups them', () => {
    const decisions = {
      'New Card': { status: 'accepted' as const, side: 'add' as const, at: NOW, note: '', applied_at: null },
      'old card': { status: 'rejected' as const, side: 'cut' as const, at: NOW, note: '' },
      'Another New Card': { status: 'later' as const, side: 'cut' as const, at: NOW, note: '' },
    };
    const feed = computeFeed({ list, upstream, sticky, keyOf: key, decisions });
    const adds = groupFeed(feed.adds);
    expect(adds.accepted.map((i) => i.name)).toEqual(['New Card']);
    // The "later" was made on the cut side, so it does not count for the add.
    expect(adds.open.map((i) => i.name)).toEqual(['Another New Card', 'Booster Tutor']);
    expect(groupFeed(feed.cuts).rejected.map((i) => i.name)).toEqual(['Old Card']);
  });

  it('accepts all remaining, and marks accepted items applied', () => {
    const feed = computeFeed({ list, upstream, sticky, keyOf: key, decisions: decide([], 'accepted', NOW) });
    const later = decide([feed.adds[0]!], 'later', NOW);
    const withLater = computeFeed({ list, upstream, sticky, keyOf: key, decisions: later });
    const all = acceptRemaining(withLater.adds, NOW);
    expect(Object.keys(all).sort()).toEqual(['Booster Tutor', 'New Card']);
    expect(all['New Card']).toEqual({ status: 'accepted', side: 'add', at: NOW, note: '', applied_at: null });
    const accepted = computeFeed({ list, upstream, sticky, keyOf: key, decisions: all });
    const applied = markApplied(accepted.adds, '2026-10-25T00:00:00.000Z');
    expect(Object.keys(applied).sort()).toEqual(['Booster Tutor', 'New Card']);
    expect(applied['New Card']!.applied_at).toBe('2026-10-25T00:00:00.000Z');
    const after = computeFeed({ list, upstream, sticky, keyOf: key, decisions: { ...all, ...applied } });
    expect(groupFeed(after.adds).applied.map((i) => i.name)).toEqual(['Booster Tutor', 'New Card']);
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

function inCard(over: Partial<InCard>): InCard {
  return { name: 'New Card', oracle_id: 'new-oracle', sticky: false, facts, wanted, cycle_tags: ['cycle-x'], ...over };
}

describe('building an Update', () => {
  const bolt = byName('Lightning Bolt');
  const sol = byName('Sol Ring');
  const retired: Card = { ...byName('Black Lotus'), in_box: null, in_list: false };
  const toPull: Card = { ...byName('Time Walk'), in_list: false };
  const pool = [bolt, sol, retired, toPull];

  it('knows what happens to each In card', () => {
    expect(inAction(undefined)).toBe('new');
    expect(inAction(retired)).toBe('back');
    expect(inAction(toPull)).toBe('keep');
    expect(inAction(bolt)).toBe('none');
  });

  it('writes new docs, returns, cancelled pulls and Outs, and the history entry', () => {
    const w = buildUpdateWrites({
      ins: [
        inCard({}),
        inCard({ name: 'Black Lotus', oracle_id: retired.oracle_id, facts: null, wanted: null, sticky: true }),
        inCard({ name: 'Time Walk', oracle_id: toPull.oracle_id, facts: null, wanted: null }),
        inCard({ name: 'Lightning Bolt', oracle_id: bolt.oracle_id, facts: null, wanted: null }),
        inCard({ name: 'No Facts', oracle_id: 'nf', facts: null }),
      ],
      outs: [sol.oracle_id, retired.oracle_id],
      cards: pool,
      decisions: { 'New Card': { status: 'accepted', side: 'add', at: NOW, note: '', applied_at: NOW } },
      source: 'upstream',
      now: NOW,
    });
    expect(w.cards.map((c) => [c.oracle_id, c.patch.kind])).toEqual([
      ['new-oracle', 'new_card'],
      [toPull.oracle_id, 'list_in'],
      [sol.oracle_id, 'list_out'],
    ]);
    // Black Lotus is both In and Out: left alone. Lightning Bolt is already on the List.
    const doc = cardPatchWrite(w.cards[0]!.patch, NOW).fields;
    expect(doc).toMatchObject({ in_list: true, list_source: 'upstream', in_box: null, added_at: NOW, oracle_cycle_tags: ['cycle-x'] });
    expect((doc.wanted as WantedState).reason).toBe('default-rule');
    expect((doc.facts as CardFacts).oracle_cycle_tags).toEqual(['cycle-x']);
    expect(w.history).toEqual({ date: '2026-10-24', at: NOW, in: ['New Card', 'Time Walk'], out: ['Sol Ring'], source: 'upstream' });
    expect(Object.keys(w.decisions)).toEqual(['New Card']);
  });

  it('marks a sticky add as a Winner’s Pick and keeps the Wanted of a returning card unless given', () => {
    const w = buildUpdateWrites({
      ins: [inCard({ sticky: true }), inCard({ name: 'Black Lotus', oracle_id: retired.oracle_id, facts: null, wanted: null })],
      outs: [],
      cards: pool,
      decisions: {},
      source: 'manual',
      now: NOW,
    });
    expect(cardPatchWrite(w.cards[0]!.patch, NOW).fields.list_source).toBe('winner_pick');
    const back = cardPatchWrite(w.cards[1]!.patch, NOW).fields;
    expect(back).toEqual({ in_list: true, list_source: 'upstream', added_at: NOW, retired_at: null, updatedAt: NOW });
  });

  it('splits the writes into batches and puts the meta writes in the last one', () => {
    const many = (n: number) => ({
      cards: Array.from({ length: n }, (_, i) => ({ oracle_id: `id${i}`, patch: { kind: 'list_out' as const } })),
      decisions: {},
      history: { date: '', at: '', in: [], out: [], source: 'upstream' as const },
    });
    const sizes = (n: number, size: number) => updateBatches(many(n), NOW, size).map((b) => [b.cards.length, b.meta]);
    expect(sizes(5, 4)).toEqual([
      [4, false],
      [1, true],
    ]);
    expect(sizes(3, 4)).toEqual([
      [3, false],
      [0, true],
    ]);
    expect(sizes(2, 4)).toEqual([[2, true]]);
    expect(sizes(0, 400)).toEqual([[0, true]]);
    expect(sizes(800, 400)).toEqual([
      [400, false],
      [400, false],
      [0, true],
    ]);
    // A card named twice is written once.
    const dup = many(2);
    dup.cards.push({ oracle_id: 'id0', patch: { kind: 'list_out' } });
    expect(updateBatches(dup, NOW, 400)[0]!.cards.length).toBe(2);
  });

  it('resolves Out names to cards on the List', () => {
    const index = nameIndex(pool);
    const outs = resolveOuts(['Sol Ring', 'Black Lotus', 'Nothing Like It'], pool, index);
    expect(outs.map((o) => o.error === null)).toEqual([true, false, false]);
    expect(outs[0]!.card?.oracle_id).toBe(sol.oracle_id);
  });
});

describe('the CubeCobra export', () => {
  const fire = { ...byName('Fire // Ice') };
  const bolt = byName('Lightning Bolt');
  const goblin: Card = { ...bolt, name: '"Name Sticker" Goblin, the Test', wanted: { ...bolt.wanted, name: '"Name Sticker" Goblin, the Test' } };

  it('quotes per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField(null)).toBe('');
    expect(csvField(3)).toBe('3');
  });

  it('writes CubeCobra’s header and one Proxied row per card on the List, with the Wanted Printing', () => {
    const off: Card = { ...byName('Sol Ring'), in_list: false };
    const csv = cubecobraCsv([fire, goblin, off]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[0]).toBe(
      'name,CMC,Type,Color,Set,Collector Number,Rarity,Color Category,status,Finish,board,maybeboard,image URL,image Back URL,tags,Notes,MTGO ID,Custom,Voucher,Artist',
    );
    expect(lines.length).toBe(4); // header, two rows, final empty string after the last CRLF
    expect(lines[3]).toBe('');
    const row = lines.find((l) => l.startsWith('"""Name Sticker'))!;
    // Type (the third column) is empty, so CubeCobra stores no type-line override.
    expect(row.startsWith(`"""Name Sticker"" Goblin, the Test",1,,${bolt.colors.join('')},`)).toBe(true);
    const cells = row.split(',');
    expect(row).toContain(`,${goblin.wanted.set.toLowerCase()},${goblin.wanted.collector_number},`);
    expect(row).toContain(',Proxied,Non-foil,mainboard,false,');
    expect(cells.length).toBeGreaterThanOrEqual(CSV_COLUMNS.length);
    expect(csv).not.toContain('Sol Ring');
    const fireRow = lines.find((l) => l.startsWith('Fire // Ice,'))!;
    expect(fireRow.split(',')[2]).toBe('');
    expect(csv).not.toContain('—');
  });

  it('writes the Printing’s own name, so a renamed card reaches its paper Printing', () => {
    const ademi = byName('Ademi of the Silkchutes');
    expect(ademi.wanted.name).toBe('Spectacular Spider-Man');
    const fixture: Card = { ...ademi, wanted: { ...ademi.wanted, set: 'pspl', collector_number: '6' } };
    const row = cubecobraCsv([fixture]).split('\r\n')[1]!;
    expect(row.startsWith('Spectacular Spider-Man,')).toBe(true);
    expect(row).toContain(',pspl,6,');
    expect(row).not.toContain('Ademi');
    expect(pasteLine(fixture)).toBe('1 Spectacular Spider-Man [PSPL] 6');
    // Without a name on the Printing, the card's own name is used.
    expect(exportName({ name: 'Plain Card', wanted: { ...ademi.wanted, name: null } })).toBe('Plain Card');
  });

  it('keeps the basics board as rows of its own', () => {
    const json = {
      cards: {
        mainboard: [],
        basics: [
          { cardID: 'f1', name: 'Forest', status: 'Owned', details: { name: 'Forest', set: 'UNF', collector_number: '240' } },
          { cardID: 'i1', details: { name: 'Island', set: 'unf', collector_number: '236' } },
          { cardID: 'x' },
        ],
      },
    };
    const basics = listBasics(json);
    expect(basics).toHaveLength(2);
    expect(listBasics({})).toEqual([]);
    const lines = cubecobraCsv([fire], basics).split('\r\n');
    expect(lines).toHaveLength(5); // header, one List row, two basics, final empty string
    expect(lines[2]).toBe('Forest,,,,unf,240,,,Owned,Non-foil,basics,false,,,,,,false,false,');
    expect(lines[3]).toBe('Island,,,,unf,236,,,Not Owned,Non-foil,basics,false,,,,,,false,false,');
    expect(lines[1]!.split(',').length).toBe(CSV_COLUMNS.length);
  });

  it('writes "1 Name [SET] number" paste lines', () => {
    expect(pasteLine(fire)).toBe(`1 Fire // Ice [${fire.wanted.set.toUpperCase()}] ${fire.wanted.collector_number}`);
    expect(cubecobraPaste([fire, goblin]).split('\n')).toHaveLength(2);
  });

  it('reads Upstream Printings and cycle tags from cubeJSON', () => {
    const json = {
      cards: {
        mainboard: [
          { cardID: 'sid', details: { oracle_id: 'oid', name: 'Card', set: 'MH2', collector_number: '5', image_normal: 'img', oracle_tags: ['cycle-mh2-incarnation', 'removal'] } },
          { cardID: '' },
        ],
      },
    };
    const ps = upstreamPrintings(json);
    expect(ps).toEqual([{ oracle_id: 'oid', name: 'Card', scryfall_id: 'sid', set: 'mh2', collector_number: '5', image_normal: 'img', cycle_tags: ['cycle-mh2-incarnation'] }]);
    expect(findUpstream(ps, 'other', 'card')).toBe(ps[0]);
    expect(upstreamWanted(ps[0]!, 'Card')).toMatchObject({ scryfall_id: 'sid', reason: 'upstream-pick', image_normal: 'img' });
  });
});

describe('Scryfall facts', () => {
  const dfc: ScryfallCard = {
    id: 'p1',
    name: 'Delver of Secrets // Insectile Aberration',
    oracle_id: 'o1',
    layout: 'transform',
    cmc: 1,
    type_line: 'Creature — Human Wizard // Creature — Human Insect',
    color_identity: ['U'],
    set: 'isd',
    collector_number: '51',
    games: ['paper'],
    lang: 'en',
    border_color: 'black',
    card_faces: [
      { name: 'Delver of Secrets', type_line: 'Creature — Human Wizard', mana_cost: '{U}', colors: ['U'], image_uris: { normal: 'front.jpg' } },
      { name: 'Insectile Aberration', type_line: 'Creature — Human Insect', colors: ['U'], image_uris: { normal: 'back.jpg' } },
    ],
    all_parts: [{ component: 'token', name: 'Thing', id: 't1' }],
  };

  it('reads facts, faces and categories', () => {
    const hit = factsFromScryfall(dfc)!;
    expect(hit.oracle_id).toBe('o1');
    expect(hit.facts).toMatchObject({
      mana_cost: '{U}',
      colors: ['U'],
      color_category: 'U',
      type_category: 'Creature',
      image_normal: 'front.jpg',
      back_name: 'Insectile Aberration',
      back_image_normal: 'back.jpg',
      produces_tokens: [{ name: 'Thing', scryfall_id: 't1' }],
    });
    expect(colorCategory('Artifact Land', [])).toBe('L');
    expect(colorCategory('Instant', ['U', 'R'])).toBe('M');
    expect(colorCategory('Artifact', [])).toBe('C');
    expect(typeCategory('Legendary Planeswalker — Jace')).toBe('Planeswalker');
    expect(typeCategory('Kindred Instant')).toBe('Instant');
  });

  it('asks for split cards by their front face and keeps only paper Printings', () => {
    expect(lookupName('Fire // Ice')).toBe('Fire');
    expect(keepPrinting(dfc)).toBe(true);
    expect(keepPrinting({ ...dfc, games: ['mtgo'] })).toBe(false);
    expect(keepPrinting({ ...dfc, set_type: 'token' })).toBe(false);
    const p = indexPrinting(dfc);
    expect([p.id, p.image_normal, p.back_image_normal]).toEqual(['p1', 'front.jpg', 'back.jpg']);
  });
});

describe('small parsers', () => {
  it('parses cubelists and typed names', () => {
    expect(parseCubelist('A\r\nB\n\n C \n')).toEqual(['A', 'B', 'C']);
    expect(parseNameLines('1 Bazaar of Baghdad\n2x Embercleave\nembercleave\n\n')).toEqual(['Bazaar of Baghdad', 'Embercleave']);
  });

  it('reads meta/upstream and meta/updates defensively', () => {
    const m = toUpstreamMeta({
      fetched_at: NOW,
      list_names: ['A', 3],
      decisions: { A: { status: 'accepted', side: 'cut', at: NOW }, B: { status: 'odd' }, C: null },
    });
    expect(m.list_names).toEqual(['A']);
    expect(m.upstream_names).toEqual([]);
    expect(Object.keys(m.decisions)).toEqual(['A']);
    expect(m.decisions.A).toEqual({ status: 'accepted', side: 'cut', at: NOW, note: '', applied_at: null });
    expect(toUpstreamMeta(null)).toEqual({ fetched_at: null, list_names: [], upstream_names: [], decisions: {} });
    const h = toUpdateHistory({ history: [{ at: '1', in: ['A'] }, { at: '2', source: 'manual' }, 'x'] });
    expect(h.map((e) => [e.at, e.source])).toEqual([
      ['2', 'manual'],
      ['1', 'upstream'],
    ]);
  });

  it('starts from empty overrides', () => {
    expect(stickySets(EMPTY_OVERRIDES, [])).toEqual({ adds: [], bans: [] });
  });
});
