// Accepting a Suggestion: what it changes in the card state, the overrides and the log.
// Pure: the caller writes the returned plan in one batch.
import type { AcceptPlan, CardState, LogEntryInput, Overrides, Suggestion } from './types';
import { listChangeFor } from './writes';

export interface ApplyContext {
  /** The card's current state (from the store, or built from cards.json), when the Suggestion names a card. */
  card: CardState | null;
  /** True when the card has a stored doc; false when ctx.card came from cards.json alone. */
  cardStored: boolean;
  /** Used only to match spellings; the List write itself is arrayUnion / arrayRemove. */
  overrides: Overrides;
  now: string;
  resolutionNote: string | null;
  /** Art and name of the suggested Printing, looked up before accepting a printing Suggestion. */
  printingDetails?: {
    scryfall_id: string | null;
    illustration_id: string | null;
    name: string | null;
    image_normal?: string | null;
  } | null;
}

export class ApplyError extends Error {}

export function applySuggestion(s: Suggestion, ctx: ApplyContext): AcceptPlan {
  const plan: AcceptPlan = {
    suggestionId: s.id,
    resolution_note: ctx.resolutionNote,
    card: null,
    list: null,
    log: null,
  };
  const date = ctx.now.slice(0, 10);
  const name = s.card_name.trim();

  switch (s.type) {
    case 'art_flag': {
      if (!s.oracle_id || !ctx.card) throw new ApplyError('An Art flag needs a card in the Cube.');
      const flag = { type: 'art', by: s.by, note: s.note, createdAt: ctx.now };
      plan.card = {
        oracle_id: s.oracle_id,
        patch: { kind: 'add_flag', flag, seedFlags: ctx.cardStored ? null : ctx.card.flags },
      };
      return plan;
    }
    case 'printing': {
      if (!s.oracle_id || !ctx.card) throw new ApplyError('A Printing change needs a card in the Cube.');
      const scryfallId = s.printing?.scryfall_id ?? ctx.printingDetails?.scryfall_id ?? null;
      if (!s.printing || !scryfallId) throw new ApplyError('The suggested Printing was not found on Scryfall.');
      plan.card = {
        oracle_id: s.oracle_id,
        patch: {
          kind: 'wanted',
          wanted: {
            scryfall_id: scryfallId,
            set: s.printing.set.toLowerCase(),
            collector_number: s.printing.collector_number,
            illustration_id: ctx.printingDetails?.illustration_id ?? null,
            name: ctx.printingDetails?.name ?? ctx.card.wanted.name,
            reason: s.note ? `Suggestion by ${s.by}: ${s.note}` : `Suggestion by ${s.by}`,
            // Always written: the merge write would otherwise keep an earlier Printing's image.
            image_normal: ctx.printingDetails?.image_normal ?? null,
          },
        },
      };
      return plan;
    }
    case 'add':
      if (!name) throw new ApplyError('The Suggestion has no card name.');
      plan.list = listChangeFor(ctx.overrides, 'adds', name);
      return plan;
    case 'ban': {
      if (!name) throw new ApplyError('The Suggestion has no card name.');
      plan.list = listChangeFor(ctx.overrides, 'bans', name);
      const log: LogEntryInput = { type: 'ban', card_name: name, by: s.by, date, cut: null, note: s.note };
      plan.log = log;
      return plan;
    }
    case 'winner_pick': {
      if (!name) throw new ApplyError('The Suggestion has no card name.');
      plan.list = listChangeFor(ctx.overrides, 'adds', name);
      const log: LogEntryInput = { type: 'winner_pick', card_name: name, by: s.by, date, cut: null, note: s.note };
      plan.log = log;
      return plan;
    }
    case 'other':
      return plan;
  }
}
