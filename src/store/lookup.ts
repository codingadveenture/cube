// Look up one Printing by set and collector number (or Scryfall id) through the slice 1 resolver:
// cards.json first, then the local cache, then Scryfall.
import { printingKey, type ResolvedPrinting } from '../scan/diff';
import type { ScannedRow } from '../scan/parse';
import { resolvePrintings } from '../scan/resolve';

function row(set: string | null, collector: string | null, id: string | null): ScannedRow {
  return {
    name: '',
    quantity: 1,
    scryfall_id: id,
    set: set ? set.trim().toLowerCase() : null,
    collector_number: collector ? collector.trim() : null,
    foil: null,
    language: null,
  };
}

async function resolveOne(r: ScannedRow, known: ReadonlyMap<string, ResolvedPrinting>): Promise<ResolvedPrinting | null> {
  const key = printingKey(r);
  if (!key) return null;
  const result = await resolvePrintings([r], known);
  const hit = result.printings.get(key) ?? null;
  if (!hit && result.error) throw new Error(`Could not reach Scryfall: ${result.error}`);
  return hit;
}

export function lookupPrinting(set: string, collector: string, known: ReadonlyMap<string, ResolvedPrinting> = new Map()) {
  return resolveOne(row(set, collector, null), known);
}

export function lookupById(id: string, known: ReadonlyMap<string, ResolvedPrinting> = new Map()) {
  return resolveOne(row(null, null, id), known);
}
