// What a card or List write sends to Firestore, as plain data. firestore.ts turns `unionFlags`,
// `union` and `remove` into arrayUnion and arrayRemove; everything else is set with merge.
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { chunk, cardStateOf } from './baseline';
import type { CardPatch, CardPatchFor, FlagState, ListChange, Overrides } from './types';

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
      // Set with merge merges nested maps key by key, so image_normal is always written (null when
      // unknown); otherwise an earlier Printing's image would stay next to the new scryfall_id.
      return { fields: { wanted: { ...patch.wanted, image_normal: patch.wanted.image_normal ?? null }, updatedAt: now }, unionFlags: null };
    case 'clear_flags':
      return { fields: { flags: [], updatedAt: now }, unionFlags: null };
    case 'add_flag':
      return { fields: { updatedAt: now }, unionFlags: [...(patch.seedFlags ?? []), patch.flag] };
  }
}

/**
 * Several card writes split into writeBatches of at most `size` docs (default 400; Firestore allows 500).
 * A card named twice keeps only its last patch, so one batch never writes a doc twice.
 */
export function cardBatches(patches: CardPatchFor[], now: string, size?: number): { oracle_id: string; write: CardWrite }[][] {
  const last = new Map<string, CardPatch>();
  for (const p of patches) {
    last.delete(p.oracle_id);
    last.set(p.oracle_id, p.patch);
  }
  return chunk(
    [...last].map(([oracle_id, patch]) => ({ oracle_id, write: cardPatchWrite(patch, now) })),
    size,
  );
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
