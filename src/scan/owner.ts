// The decisions behind the Scan tab's Owner actions. Pure apart from the lookups passed in.
import type { InBoxState } from '../store/types';
import type { PrintingBase } from '../types';
import type { ExpectedCard, ResolvedPrinting, ScannedRowWithPrinting } from './diff';

/** The two lookups a Printing can be found by (cards.json, the local cache, then Scryfall). */
export interface PrintingLookup {
  bySetNumber(set: string, collector: string): Promise<ResolvedPrinting | null>;
  byId(id: string): Promise<ResolvedPrinting | null>;
}

/**
 * The missing cards the bulk "not in the box" action writes: List cards only (a card that is To
 * pull cannot go to the print batch) that the Owner has not marked Resolved.
 */
export function notInBoxCandidates(
  missing: ExpectedCard[],
  inList: (oracle_id: string) => boolean,
  resolved: Record<string, boolean | undefined>,
): ExpectedCard[] {
  return missing.filter((c) => inList(c.oracle_id) && !resolved[`missing:${c.oracle_id}`]);
}

/**
 * The In-box Printing for a card marked To print that the scan found: the scanned Printing when one
 * can be found (confidence high), else the Wanted Printing (confidence medium). A failed lookup
 * throws, so nothing is written.
 */
export async function inBoxForToPrint(
  rows: ScannedRowWithPrinting[],
  wanted: Pick<PrintingBase, 'scryfall_id' | 'set' | 'collector_number' | 'illustration_id' | 'name'>,
  lookup: PrintingLookup,
): Promise<InBoxState> {
  const s = rows.find((x) => x.printing)?.printing ?? null;
  const raw = rows.find((x) => x.set && x.collector_number) ?? rows.find((x) => x.scryfall_id);
  if (s) {
    const id =
      s.scryfall_id ??
      rows.find((x) => x.printing === s && x.scryfall_id)?.scryfall_id ??
      (await lookup.bySetNumber(s.set, s.collector_number))?.scryfall_id;
    if (id) {
      return { scryfall_id: id, set: s.set, collector_number: s.collector_number, illustration_id: s.illustration_id, name: s.name, source: 'scan', confidence: 'high' };
    }
  } else if (raw) {
    const p =
      raw.set && raw.collector_number
        ? await lookup.bySetNumber(raw.set, raw.collector_number)
        : await lookup.byId(raw.scryfall_id!);
    if (p?.scryfall_id) {
      return { scryfall_id: p.scryfall_id, set: p.set, collector_number: p.collector_number, illustration_id: p.illustration_id, name: p.name, source: 'scan', confidence: 'high' };
    }
  }
  return {
    scryfall_id: wanted.scryfall_id,
    set: wanted.set,
    collector_number: wanted.collector_number,
    illustration_id: wanted.illustration_id,
    name: wanted.name,
    source: 'scan',
    confidence: 'medium',
  };
}
