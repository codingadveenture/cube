// The piles the Scan diff runs on: this device's piles plus the shared piles ticked for the diff.
// A shared pile that was published from a local pile still on this device counts once.
import type { Pile, ScannedRow } from '../scan/parse';
import type { SharedPile, SharedPileInput, SharedPileRow } from './types';

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

export function fromShared(p: SharedPile): Pile {
  return {
    id: `shared:${p.id}`,
    label: p.label,
    rows: p.rows.map((r) => ({ ...r, foil: null, language: null })),
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
  const extra = shared.filter((p) => included.has(p.id) && !fromLocal.has(p.id)).map(fromShared);
  return [...local, ...extra];
}
