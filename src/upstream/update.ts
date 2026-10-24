// Building an Update: from the In and Out names to the card writes, the decisions and the history
// entry, and how they split into writeBatches. Pure: no React, no storage, no network.
import type { Card } from '../types';
import { lifecycleOf } from '../store/lifecycle';
import { chunk, BATCH_LIMIT } from '../store/baseline';
import { cardBatches, type CardWrite } from '../store/writes';
import type { CardFacts, CardPatchFor, CardState, Decision, UpdateHistoryEntry, UpdateWrites, WantedState } from '../store/types';

/** What happens to a card that comes In. */
export type InAction =
  /** No doc and not in cards.json: a new card doc, to print. */
  | 'new'
  /** Retired (pulled earlier): back on the List, to print. */
  | 'back'
  /** Still in the box, waiting to be pulled: back on the List, nothing to print. */
  | 'keep'
  /** Already on the List. */
  | 'none';

export interface InCard {
  /** The name as accepted (from the feed or typed). */
  name: string;
  oracle_id: string;
  /** A sticky add (Winner's Pick): list_source "winner_pick". */
  sticky: boolean;
  /** For a new card: its facts. */
  facts: CardFacts | null;
  /** For a new or returning card: the Wanted Printing; null keeps the card's Wanted. */
  wanted: WantedState | null;
  cycle_tags: string[];
}

export function inAction(card: Card | undefined): InAction {
  if (!card) return 'new';
  const l = lifecycleOf(card);
  if (l === 'retired') return 'back';
  if (l === 'to_pull') return 'keep';
  return 'none';
}

/** The card write for one In card, or null when nothing changes (or a new card lacks facts or Wanted). */
export function inPatch(card: Card | undefined, c: InCard, now: string): CardPatchFor | null {
  const list_source = c.sticky ? 'winner_pick' : 'upstream';
  const action = inAction(card);
  if (action === 'none') return null;
  if (action === 'new') {
    if (!c.facts || !c.wanted) return null;
    return {
      oracle_id: c.oracle_id,
      patch: {
        kind: 'new_card',
        state: {
          name: c.facts.name || c.name,
          in_box: null,
          wanted: c.wanted,
          flags: [],
          in_list: true,
          list_source,
          facts: { ...c.facts, oracle_cycle_tags: c.cycle_tags },
          oracle_cycle_tags: c.cycle_tags,
          retired_printing: null,
          added_at: now,
          retired_at: null,
        },
      },
    };
  }
  return { oracle_id: c.oracle_id, patch: { kind: 'list_in', list_source, added_at: now, wanted: action === 'back' ? c.wanted : null } };
}

/** The card write for one Out card: off the List (it stays in the box until pulled); null when already off. */
export function outPatch(card: Card): CardPatchFor | null {
  if (!card.in_list) return null;
  return { oracle_id: card.oracle_id, patch: { kind: 'list_out' } };
}

export interface UpdateInput {
  ins: InCard[];
  /** oracle_ids of the cards going Out. */
  outs: string[];
  cards: readonly Card[];
  /** Decisions to store with the Update (the applied ones). */
  decisions: Record<string, Decision>;
  source: UpdateHistoryEntry['source'];
  now: string;
}

/** Everything one Update writes. A card both In and Out is left alone. */
export function buildUpdateWrites(u: UpdateInput): UpdateWrites {
  const byId = new Map(u.cards.map((c) => [c.oracle_id, c]));
  const outIds = new Set(u.outs);
  const inIds = new Set(u.ins.map((c) => c.oracle_id));
  const patches: CardPatchFor[] = [];
  const inNames: string[] = [];
  const outNames: string[] = [];
  for (const c of u.ins) {
    if (outIds.has(c.oracle_id)) continue;
    const p = inPatch(byId.get(c.oracle_id), c, u.now);
    if (!p) continue;
    patches.push(p);
    inNames.push(byId.get(c.oracle_id)?.name ?? c.facts?.name ?? c.name);
  }
  for (const id of u.outs) {
    const card = byId.get(id);
    if (!card || inIds.has(id)) continue;
    const p = outPatch(card);
    if (!p) continue;
    patches.push(p);
    outNames.push(card.name);
  }
  return {
    cards: patches,
    decisions: u.decisions,
    history: { date: u.now.slice(0, 10), at: u.now, in: inNames, out: outNames, source: u.source },
  };
}

export interface UpdateBatch {
  cards: { oracle_id: string; write: CardWrite }[];
  /** The last batch also writes the decisions and the history entry (two meta writes). */
  meta: boolean;
}

/** Meta writes that ride in the last batch (decisions and history; a third when history is trimmed). */
export const META_WRITES = 2;

export function metaWrites(w: Pick<UpdateWrites, 'trim'>): number {
  return META_WRITES + (w.trim?.length ? 1 : 0);
}

/**
 * The writeBatches of an Update: card writes in chunks of at most `size` docs, and the two meta
 * writes in the last batch, which gets a batch of its own when the last chunk is full.
 */
export function updateBatches(w: UpdateWrites, now: string, size: number = BATCH_LIMIT): UpdateBatch[] {
  const meta = metaWrites(w);
  if (size <= meta) throw new Error('batch size too small');
  const flat = cardBatches(w.cards, now, Number.MAX_SAFE_INTEGER)[0] ?? [];
  const parts = chunk(flat, size);
  const out: UpdateBatch[] = parts.map((cards) => ({ cards, meta: false }));
  const last = out[out.length - 1];
  if (last && last.cards.length + meta <= size) last.meta = true;
  else out.push({ cards: [], meta: true });
  return out;
}

/**
 * A new_card write must never land on a doc that already exists (a card the client did not see,
 * for example from a stale cache): that would reset its In-box and flags. Given the docs the server
 * has, each such write becomes what an existing card would get: nothing when it is already on the
 * List, a list_in that keeps its Wanted when it is still in the box, a list_in with the new Wanted
 * when it is retired. Other writes pass unchanged.
 */
export function guardNewCards(patches: readonly CardPatchFor[], existing: ReadonlyMap<string, Pick<CardState, 'in_box' | 'in_list'>>): CardPatchFor[] {
  const out: CardPatchFor[] = [];
  for (const p of patches) {
    const doc = existing.get(p.oracle_id);
    if (p.patch.kind !== 'new_card' || !doc) {
      out.push(p);
      continue;
    }
    const st = p.patch.state;
    const life = lifecycleOf({ in_box: doc.in_box ? (doc.in_box as Card['in_box']) : null, in_list: doc.in_list });
    if (life === 'in_box' || life === 'to_print') continue;
    const action: InAction = life === 'retired' ? 'back' : 'keep';
    out.push({
      oracle_id: p.oracle_id,
      patch: { kind: 'list_in', list_source: st.list_source ?? 'upstream', added_at: st.added_at ?? '', wanted: action === 'back' ? st.wanted : null },
    });
  }
  return out;
}

/** Reprints already waiting: cards in the box and on the List whose Wanted differs from In-box. */
export function pendingReprints(cards: readonly Card[]): number {
  return cards.filter((c) => c.in_list && c.in_box && c.in_box.scryfall_id !== c.wanted.scryfall_id).length;
}
