/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CardsFile } from '../types';
import type { Pile } from '../scan/parse';
import { diffScan } from '../scan/diff';
import { expectedCards } from '../scan/expected';
import { mergedRows } from '../scan/session';
import { applySuggestion, ApplyError } from './apply';
import { BATCH_LIMIT, baselineDocs, cardStateOf, chunk, mergeCard, mergeCards, withoutExisting } from './baseline';
import { newLogEntries, parseLogFile, sortLog } from './logImport';
import { isOwnerUid, ownerFromDoc } from './owner';
import { addsText, bansText, cubecobraPasteText } from './paste';
import { pilesForDiff, sharedPileInput } from './piles';
import { singleFlight } from './signin';
import { sortSuggestions } from './suggestions';
import { addFlagPatch, cardPatchWrite, listChangeFor, listChangeWrite } from './writes';
import { EMPTY_OVERRIDES, type SharedPile, type Suggestion } from './types';

const root = new URL('../../', import.meta.url);
const cards = (JSON.parse(readFileSync(new URL('public/data/cards.json', root), 'utf8')) as CardsFile).cards;
const NOW = '2026-10-24T12:00:00.000Z';

function suggestion(over: Partial<Suggestion>): Suggestion {
  return {
    id: 's1',
    type: 'other',
    card_name: '',
    oracle_id: null,
    printing: null,
    by: 'Player A',
    note: '',
    status: 'open',
    createdAt: NOW,
    createdByUid: 'u1',
    resolvedAt: null,
    resolution_note: null,
    ...over,
  };
}

describe('applySuggestion', () => {
  const card = cards[0]!;
  const state = cardStateOf(card, NOW);
  const base = { overrides: EMPTY_OVERRIDES, now: NOW, resolutionNote: null };

  it('adds an Art flag to a stored card with arrayUnion only', () => {
    const s = suggestion({ type: 'art_flag', card_name: card.name, oracle_id: card.oracle_id, note: 'too dark' });
    const plan = applySuggestion(s, { ...base, card: state, cardStored: true });
    expect(plan.card?.oracle_id).toBe(card.oracle_id);
    const flag = { type: 'art', by: 'Player A', note: 'too dark', createdAt: NOW };
    expect(plan.card?.patch).toEqual({ kind: 'add_flag', flag, seedFlags: null });
    expect(cardPatchWrite(plan.card!.patch, NOW)).toEqual({ fields: { updatedAt: NOW }, unionFlags: [flag] });
    expect(plan.list).toBeNull();
    expect(plan.log).toBeNull();
  });

  it('keeps the cards.json flags when the card has no stored doc yet', () => {
    const s = suggestion({ type: 'art_flag', card_name: card.name, oracle_id: card.oracle_id });
    const plan = applySuggestion(s, { ...base, card: state, cardStored: false });
    const w = cardPatchWrite(plan.card!.patch, NOW);
    expect(w.unionFlags?.length).toBe(state.flags.length + 1);
    expect(w.fields).toEqual({ updatedAt: NOW });
  });

  it('writes only the Wanted Printing, never the In-box Printing', () => {
    const s = suggestion({
      type: 'printing',
      card_name: card.name,
      oracle_id: card.oracle_id,
      printing: { set: 'LEA', collector_number: '1', scryfall_id: 'abc' },
    });
    const plan = applySuggestion(s, {
      ...base,
      card: state,
      cardStored: true,
      printingDetails: { scryfall_id: 'abc', illustration_id: 'ill', name: 'Printed name' },
    });
    const w = cardPatchWrite(plan.card!.patch, NOW);
    expect(Object.keys(w.fields).sort()).toEqual(['updatedAt', 'wanted']);
    expect(w.fields.wanted).toMatchObject({ scryfall_id: 'abc', set: 'lea', collector_number: '1', illustration_id: 'ill' });
    expect(plan.card!.patch.kind === 'wanted' && plan.card!.patch.wanted.image_normal).toBeNull();
    expect(w.unionFlags).toBeNull();
  });

  it('refuses a Printing that was not found', () => {
    const s = suggestion({ type: 'printing', oracle_id: card.oracle_id, printing: { set: 'x', collector_number: '1', scryfall_id: null } });
    expect(() => applySuggestion(s, { ...base, card: state, cardStored: true })).toThrow(ApplyError);
  });

  it('puts an add on the pending List changes without a log entry', () => {
    const plan = applySuggestion(suggestion({ type: 'add', card_name: 'Black Lotus' }), {
      ...base,
      card: null,
      cardStored: false,
      overrides: { adds: [], bans: ['Black Lotus'], updatedAt: null },
    });
    expect(plan.list).toEqual({ field: 'adds', name: 'Black Lotus', drop: ['Black Lotus'] });
    expect(plan.log).toBeNull();
  });

  it('logs a Ban and puts it on the pending List changes', () => {
    const plan = applySuggestion(suggestion({ type: 'ban', card_name: 'Sol Ring', note: 'too strong' }), {
      ...base,
      card: null,
      cardStored: false,
      overrides: { adds: ['sol ring'], bans: [], updatedAt: null },
      resolutionNote: 'agreed',
    });
    expect(plan.list).toEqual({ field: 'bans', name: 'Sol Ring', drop: ['Sol Ring', 'sol ring'] });
    expect(plan.log).toEqual({ type: 'ban', card_name: 'Sol Ring', by: 'Player A', date: '2026-10-24', cut: null, note: 'too strong' });
    expect(plan.resolution_note).toBe('agreed');
  });

  it('logs a Winner\'s Pick and adds it', () => {
    const plan = applySuggestion(suggestion({ type: 'winner_pick', card_name: 'Time Walk' }), { ...base, card: null, cardStored: false });
    expect(plan.list?.field).toBe('adds');
    expect(plan.list?.name).toBe('Time Walk');
    expect(plan.log?.type).toBe('winner_pick');
    expect(plan.log?.card_name).toBe('Time Walk');
  });

  it('changes nothing for other', () => {
    const plan = applySuggestion(suggestion({ type: 'other' }), { ...base, card: null, cardStored: false });
    expect(plan).toMatchObject({ card: null, list: null, log: null });
  });

  it('does not duplicate a name already on the list', () => {
    const c = listChangeFor({ adds: ['Time Walk'], bans: [], updatedAt: null }, 'adds', 'time walk');
    expect(c.name).toBe('Time Walk');
  });

  it('never writes whole lists, so unloaded overrides cannot wipe earlier List changes', () => {
    // Accepting before the overrides snapshot arrived (EMPTY_OVERRIDES) only adds this name.
    const plan = applySuggestion(suggestion({ type: 'add', card_name: 'Mox Pearl' }), { ...base, card: null, cardStored: false });
    expect(listChangeWrite(plan.list!)).toEqual({
      union: { field: 'adds', values: ['Mox Pearl'] },
      remove: { field: 'bans', values: ['Mox Pearl'] },
    });
  });
});

describe('card writes', () => {
  const card = cards[0]!;
  const flag = { type: 'art', by: 'Owner', note: '', createdAt: NOW };

  it('writes only the In-box Printing', () => {
    const in_box = { ...cardStateOf(card, NOW).in_box!, scryfall_id: 'xyz' };
    expect(cardPatchWrite({ kind: 'in_box', in_box }, NOW)).toEqual({ fields: { in_box, updatedAt: NOW }, unionFlags: null });
  });

  it('always writes image_normal on a Wanted Printing, so a merge cannot keep a stale one', () => {
    const noImage = { ...cardStateOf(card, NOW).wanted, scryfall_id: 'new' };
    delete noImage.image_normal;
    const w = cardPatchWrite({ kind: 'wanted', wanted: noImage }, NOW);
    expect((w.fields.wanted as Record<string, unknown>).image_normal).toBeNull();
    // Firestore's set with merge merges nested maps key by key.
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...a };
      for (const [k, v] of Object.entries(b)) {
        const prev = out[k];
        out[k] =
          v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)
            ? merge(prev as Record<string, unknown>, v as Record<string, unknown>)
            : v;
      }
      return out;
    };
    const stored = { wanted: { ...noImage, scryfall_id: 'old', image_normal: 'https://cards.scryfall.io/normal/front/o/l/old.jpg' } };
    const after = merge(stored, w.fields) as { wanted: { scryfall_id: string; image_normal: string | null } };
    expect(after.wanted.scryfall_id).toBe('new');
    expect(after.wanted.image_normal).toBeNull();
    const withImage = cardPatchWrite({ kind: 'wanted', wanted: { ...noImage, image_normal: 'img' } }, NOW);
    expect((withImage.fields.wanted as Record<string, unknown>).image_normal).toBe('img');
  });

  it('clears flags without touching other fields', () => {
    expect(cardPatchWrite({ kind: 'clear_flags' }, NOW)).toEqual({ fields: { flags: [], updatedAt: NOW }, unionFlags: null });
  });

  it('seeds the cards.json flags only for a card without a stored doc', () => {
    expect(addFlagPatch(card, flag, true)).toEqual({ kind: 'add_flag', flag, seedFlags: null });
    const seeded = addFlagPatch(card, flag, false);
    expect(seeded.kind === 'add_flag' && seeded.seedFlags?.length).toBe(card.flags.length);
  });
});

describe('sign-in retry', () => {
  it('shares one attempt between concurrent calls', async () => {
    let n = 0;
    const ensure = singleFlight(async () => {
      n++;
    });
    await Promise.all([ensure(), ensure(), ensure()]);
    expect(n).toBe(1);
  });

  it('tries again after a failed attempt', async () => {
    let n = 0;
    const ensure = singleFlight(async () => {
      n++;
      if (n === 1) throw new Error('auth/network-request-failed');
    });
    await expect(ensure()).rejects.toThrow('network');
    await expect(ensure()).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
});

describe('pilesForDiff', () => {
  const row = (name: string) => ({ name, quantity: 1, scryfall_id: null, set: null, collector_number: null, foil: null, language: null });
  const local: Pile[] = [{ id: 'l1', label: 'Box 1', rows: [row('Sol Ring')] }];
  const shared = (id: string, names: string[]): SharedPile => ({
    id,
    label: id,
    by: 'Player B',
    rows: names.map((n) => ({ name: n, quantity: 1, scryfall_id: null, set: null, collector_number: null })),
    row_count: names.length,
    createdAt: NOW,
    createdByUid: 'u2',
  });

  it('adds only the ticked shared piles', () => {
    const piles = pilesForDiff(local, [shared('a', ['Black Lotus']), shared('b', ['Time Walk'])], new Set(['a']));
    expect(piles.map((p) => p.label)).toEqual(['Box 1', 'a']);
    expect(mergedRows(piles).map((r) => r.name)).toEqual(['Sol Ring', 'Black Lotus']);
  });

  it('counts a pile shared from this device once', () => {
    const piles = pilesForDiff(local, [shared('a', ['Sol Ring'])], new Set(['a']), { l1: 'a' });
    expect(mergedRows(piles).length).toBe(1);
  });

  it('counts the shared copy when the local pile was removed', () => {
    const piles = pilesForDiff([], [shared('a', ['Sol Ring'])], new Set(['a']), { l1: 'a' });
    expect(mergedRows(piles).length).toBe(1);
  });

  it('feeds the slice 1 diff', () => {
    const all = cards.map((c) => c.name);
    const piles = pilesForDiff([], [shared('a', all.slice(0, 300)), shared('b', all.slice(300))], new Set(['a', 'b']));
    const d = diffScan(expectedCards(cards), mergedRows(piles));
    expect(d.missing).toEqual([]);
    expect(d.unexpected).toEqual([]);
  });

  it('drops foil and language when sharing', () => {
    const input = sharedPileInput({ id: 'x', label: 'L', rows: [{ ...row('Sol Ring'), foil: 'foil', language: 'en' }] }, 'Player A');
    expect(input.rows[0]).toEqual({ name: 'Sol Ring', quantity: 1, scryfall_id: null, set: null, collector_number: null });
  });
});

describe('CubeCobra paste text', () => {
  const o = { adds: ['Time Walk', 'Ancestral Recall', 'time walk', 'Sol Ring'], bans: ['Sol Ring'], updatedAt: null };

  it('lists adds sorted, once, without banned names', () => {
    expect(addsText(o)).toBe('Ancestral Recall\nTime Walk');
  });
  it('lists removals', () => {
    expect(bansText(o)).toBe('Sol Ring');
  });
  it('combines both', () => {
    expect(cubecobraPasteText(o)).toBe('Add:\nAncestral Recall\nTime Walk\n\nRemove:\nSol Ring');
    expect(cubecobraPasteText(EMPTY_OVERRIDES)).toBe('');
  });
});

describe('Owner detection', () => {
  it('reads the uid from config/owner', () => {
    expect(ownerFromDoc({ uid: 'abc' })).toEqual({ uid: 'abc' });
    expect(ownerFromDoc(undefined)).toBeNull();
    expect(ownerFromDoc({ uid: '' })).toBeNull();
    expect(ownerFromDoc({ uid: 3 })).toBeNull();
  });
  it('matches only the same uid', () => {
    expect(isOwnerUid('abc', { uid: 'abc' })).toBe(true);
    expect(isOwnerUid('xyz', { uid: 'abc' })).toBe(false);
    expect(isOwnerUid(null, { uid: 'abc' })).toBe(false);
    expect(isOwnerUid('abc', null)).toBe(false);
  });
});

describe('baseline import', () => {
  it('chunks into batches of at most 400', () => {
    const docs = baselineDocs(cards, new Set(), NOW);
    expect(docs.length).toBe(cards.length);
    const parts = chunk(docs);
    expect(parts.map((p) => p.length)).toEqual([BATCH_LIMIT, cards.length - BATCH_LIMIT]);
    expect(parts.flat().length).toBe(cards.length);
    expect(chunk([], 400)).toEqual([]);
  });

  it('writes only the cards without a doc', () => {
    const existing = new Set(cards.slice(0, 10).map((c) => c.oracle_id));
    expect(baselineDocs(cards, existing, NOW).length).toBe(cards.length - 10);
  });

  it('skips the docs the server has even when the local snapshot was empty', () => {
    // The cached snapshot said nothing exists; the server already holds 5 edited cards.
    const docs = baselineDocs(cards, new Set(), NOW);
    const onServer = new Set(cards.slice(0, 5).map((c) => c.oracle_id));
    const fresh = withoutExisting(docs, onServer);
    expect(fresh.length).toBe(cards.length - 5);
    expect(fresh.some(([id]) => onServer.has(id))).toBe(false);
  });

  it('round-trips through the merge', () => {
    const states = new Map(baselineDocs(cards, new Set(), NOW));
    const merged = mergeCards(cards, states);
    expect(merged.map((c) => c.in_box!.scryfall_id)).toEqual(cards.map((c) => c.in_box!.scryfall_id));
    expect(merged.map((c) => c.in_box!.image_small)).toEqual(cards.map((c) => c.in_box!.image_small));
    expect(merged.map((c) => c.flags.length)).toEqual(cards.map((c) => c.flags.length));
  });

  it('derives images for a Printing cards.json does not know', () => {
    const card = cards[1]!;
    const state = cardStateOf(card, NOW);
    state.in_box = { ...state.in_box!, scryfall_id: 'abcdef', set: 'lea', collector_number: '7' };
    const m = mergeCard(card, state);
    expect(m.in_box!.image_small).toBe('https://cards.scryfall.io/small/front/a/b/abcdef.jpg');
    expect(m.in_box!.set).toBe('lea');
    expect(m.wanted.scryfall_id).toBe(card.wanted.scryfall_id);
  });
});

describe('log import', () => {
  const file = {
    winner_picks: [
      { card: 'Time Walk', by: 'Player A', date: '2026-01-02', note: '' },
      { card: '', by: 'Player B', date: '2026-02-03' },
    ],
    bans: [{ card: 'Sol Ring', by: 'group', date: '2025-12-01' }],
  };

  it('reads picks, pending picks and bans', () => {
    const entries = parseLogFile(file);
    expect(entries.map((e) => [e.type, e.card_name])).toEqual([
      ['winner_pick', 'Time Walk'],
      ['winner_pick', null],
      ['ban', 'Sol Ring'],
    ]);
  });

  it('skips entries already in the log', () => {
    const entries = parseLogFile(file);
    expect(newLogEntries(entries, entries.slice(0, 1)).length).toBe(2);
  });

  it('rejects other shapes', () => {
    expect(() => parseLogFile([])).toThrow();
    expect(() => parseLogFile({ picks: [] })).toThrow();
  });

  it('sorts newest first with pending dates on top', () => {
    const sorted = sortLog(parseLogFile(file).map((e, i) => ({ ...e, date: i === 1 ? null : e.date, createdAt: NOW })));
    expect(sorted.map((e) => e.date)).toEqual([null, '2026-01-02', '2025-12-01']);
  });
});

describe('sortSuggestions', () => {
  it('puts open first, then accepted, then rejected, newest first', () => {
    const list = [
      suggestion({ id: 'a', status: 'rejected', createdAt: '2026-01-03' }),
      suggestion({ id: 'b', status: 'open', createdAt: '2026-01-01' }),
      suggestion({ id: 'c', status: 'accepted', createdAt: '2026-01-02' }),
      suggestion({ id: 'd', status: 'open', createdAt: '2026-01-04' }),
    ];
    expect(sortSuggestions(list).map((s) => s.id)).toEqual(['d', 'b', 'c', 'a']);
  });
});
