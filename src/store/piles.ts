// The piles the Scan diff runs on: this device's piles plus the shared piles ticked for the diff.
// A shared pile that was published from a local pile still on this device counts once.
import type { Pile, ScannedRow } from '../scan/parse';
import type { SharedPile, SharedPileInput, SharedPileRow } from './types';

/** The document written for a new shared pile; the optional camera fields only when set. */
export function scanPileDoc(input: SharedPileInput, uid: string, t: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    label: input.label,
    by: input.by.trim(),
    rows: input.rows,
    row_count: input.rows.length,
    createdAt: t,
    createdByUid: uid,
  };
  if (input.shot_count !== undefined) data.shot_count = input.shot_count;
  if (input.to_review !== undefined) data.to_review = input.to_review;
  if (input.camera) data.camera = true;
  return data;
}

export const MAX_PILE_ROWS = 2000;

export function toSharedRows(rows: ScannedRow[]): SharedPileRow[] {
  return rows.map((r) => ({
    name: r.name,
    quantity: r.quantity,
    scryfall_id: r.scryfall_id,
    set: r.set,
    collector_number: r.collector_number,
  }));
}

export function sharedPileInput(pile: Pile, by: string): SharedPileInput {
  return { label: pile.label, by, rows: toSharedRows(pile.rows) };
}

/** A shared pile as a Pile for the diff. Rows a photo review took down to quantity 0 are left out. */
export function fromShared(p: SharedPile): Pile {
  return {
    id: `shared:${p.id}`,
    label: p.label,
    rows: p.rows.filter((r) => r.quantity > 0).map((r) => ({ ...r, foil: null, language: null })),
  };
}

/**
 * The piles for the diff.
 * @param sharedFrom local pile id -> id of the shared pile published from it.
 */
export function pilesForDiff(
  local: Pile[],
  shared: SharedPile[],
  included: ReadonlySet<string>,
  sharedFrom: Readonly<Record<string, string>> = {},
): Pile[] {
  const localIds = new Set(local.map((p) => p.id));
  const fromLocal = new Set(
    Object.entries(sharedFrom)
      .filter(([localId]) => localIds.has(localId))
      .map(([, sharedId]) => sharedId),
  );
  // A local pile whose shared copy a photo review has changed counts with the shared rows.
  const byId = new Map(shared.map((p) => [p.id, p]));
  const mine = local.map((p) => {
    const s = sharedFrom[p.id] ? byId.get(sharedFrom[p.id]!) : undefined;
    return s?.updatedAt ? { ...p, rows: fromShared(s).rows } : p;
  });
  const extra = shared.filter((p) => included.has(p.id) && !fromLocal.has(p.id)).map(fromShared);
  return [...mine, ...extra];
}
