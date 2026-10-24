// Wanted Printing writes built from the printings index or from the In-box Printing.
import type { Card } from '../types';
import type { WantedReason, WantedState } from '../store/types';
import type { IndexPrinting } from './types';

export function wantedFromPrinting(p: IndexPrinting, name: string | null, reason: WantedReason): WantedState {
  return {
    scryfall_id: p.id,
    set: p.set,
    collector_number: p.collector_number,
    illustration_id: p.illustration_id,
    name,
    reason,
    image_normal: p.image_normal,
  };
}

/** Reset Wanted to the In-box Printing; null for a card that is not in the box. */
export function wantedFromInBox(card: Card): WantedState | null {
  const b = card.in_box;
  if (!b) return null;
  return {
    scryfall_id: b.scryfall_id,
    set: b.set,
    collector_number: b.collector_number,
    illustration_id: b.illustration_id,
    name: b.name,
    reason: 'reset-to-box',
    image_normal: b.image_normal,
  };
}

const REASON_LABEL: Record<string, string> = {
  picked: 'picked by the Owner',
  cycle: 'set with its Cycle',
  'default-rule': 'default rule',
  'default-rule-unknown-box': 'default rule (In-box Printing unknown)',
  'same-as-box': 'same as the In-box Printing',
  'non-paper-replacement': 'replaces an In-box Printing that is not on paper',
  'unresolved-no-paper-printing': 'no paper Printing found',
  'reset-to-box': 'reset to the In-box Printing',
  'upstream-pick': 'the Printing Upstream uses',
};

export function reasonLabel(reason: string): string {
  return REASON_LABEL[reason] ?? reason;
}
