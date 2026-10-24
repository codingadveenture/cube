// What a card or List write sends to Firestore, as plain data. firestore.ts turns `unionFlags`,
// `union` and `remove` into arrayUnion and arrayRemove; everything else is set with merge.
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { cardStateOf } from './baseline';
import type { CardPatch, FlagState, ListChange, Overrides } from './types';

export interface CardWrite {
  /** Fields set with merge. */
  fields: Record<string, unknown>;
  /** Flags added with arrayUnion, or null. */
  unionFlags: FlagState[] | null;
}

export function cardPatchWrite(patch: CardPatch, now: string): CardWrite {
  switch (patch.kind) {
    case 'in_box':
      return { fields: { in_box: patch.in_box, updatedAt: now }, unionFlags: null };
    case 'wanted':
      return { fields: { wanted: patch.wanted, updatedAt: now }, unionFlags: null };
    case 'clear_flags':
      return { fields: { flags: [], updatedAt: now }, unionFlags: null };
    case 'add_flag':
      return { fields: { updatedAt: now }, unionFlags: [...(patch.seedFlags ?? []), patch.flag] };
  }
}

/** Add an Art flag. A card without a stored doc keeps its cards.json flags as well. */
export function addFlagPatch(card: Card, flag: FlagState, stored: boolean): CardPatch {
  return { kind: 'add_flag', flag, seedFlags: stored ? null : cardStateOf(card, flag.createdAt ?? '').flags };
}

/**
 * Put a name on the adds (and off the bans), or the other way round. The cached overrides are
 * used only to reuse a spelling already on the list and to drop other spellings; the write
 * itself never replaces the lists.
 */
export function listChangeFor(o: Overrides, kind: 'adds' | 'bans', name: string): ListChange {
  const key = normalizeName(name);
  const other = kind === 'adds' ? 'bans' : 'adds';
  const existing = o[kind].find((n) => normalizeName(n) === key);
  const drop = [...new Set([name, ...o[other].filter((n) => normalizeName(n) === key)])];
  return { field: kind, name: existing ?? name, drop };
}

export interface ListWrite {
  union: { field: 'adds' | 'bans'; values: string[] };
  remove: { field: 'adds' | 'bans'; values: string[] };
}

export function listChangeWrite(c: ListChange): ListWrite {
  return {
    union: { field: c.field, values: [c.name] },
    remove: { field: c.field === 'adds' ? 'bans' : 'adds', values: c.drop },
  };
}
