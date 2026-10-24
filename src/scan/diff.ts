// The Scan diff: compare the List (expected cards) with what was scanned.
// Pure: no React, no storage, no network.
import { normalizeName } from '../lib/normalize';
import type { ScannedRow } from './parse';

/** What is known about a scanned Printing once resolved. */
export interface ResolvedPrinting {
  /** Scryfall id, when known. */
  scryfall_id?: string;
  illustration_id: string | null;
  name: string;
  set: string;
  collector_number: string;
  image_small: string | null;
}

export interface ExpectedCard {
  name: string;
  front_name: string;
  oracle_id: string;
  in_box: {
    illustration_id: string | null;
    set: string;
    collector_number: string;
    image_small: string;
  };
  /** Extra names the card may be scanned under (for example a paper printing name). */
  aliases?: string[];
  /** printingKey values of the In-box and Wanted Printings; a row whose name matches no card
   * is still attached to the card when its Printing is one of these. */
  printing_keys?: string[];
}

export type ArtVerdict = 'match' | 'same-art-other-set' | 'different-art' | 'unknown';

export interface ScannedRowWithPrinting extends ScannedRow {
  printing: ResolvedPrinting | null;
}

export interface CardResult {
  card: ExpectedCard;
  count: number;
  rows: ScannedRowWithPrinting[];
  verdict: ArtVerdict;
  /** The scanned Printing behind the verdict (null when unknown). */
  scanned: ResolvedPrinting | null;
}

export interface UnexpectedResult {
  name: string;
  count: number;
  rows: ScannedRowWithPrinting[];
}

export interface DiffTotals {
  expected: number;
  scannedRows: number;
  scannedUniqueNames: number;
  missing: number;
  unexpected: number;
  duplicates: number;
  differentArt: number;
  sameArtOtherSet: number;
  unknown: number;
}

export interface Diff {
  missing: ExpectedCard[];
  unexpected: UnexpectedResult[];
  duplicates: CardResult[];
  present: CardResult[];
  totals: DiffTotals;
}

/** Key of a scanned row's Printing in the resolver map: Scryfall id, else "set/number". */
export function printingKey(
  row: Pick<ScannedRow, 'scryfall_id' | 'set' | 'collector_number'>,
): string | null {
  if (row.scryfall_id) return row.scryfall_id.toLowerCase();
  if (row.set && row.collector_number) {
    return `${row.set.toLowerCase()}/${row.collector_number.toLowerCase()}`;
  }
  return null;
}

export function artVerdict(
  card: ExpectedCard,
  rows: ScannedRowWithPrinting[],
): { verdict: ArtVerdict; scanned: ResolvedPrinting | null } {
  const resolved = rows
    .map((r) => r.printing)
    .filter((p): p is ResolvedPrinting => p !== null && !!p.illustration_id);
  if (resolved.length === 0 || !card.in_box.illustration_id) {
    return { verdict: 'unknown', scanned: null };
  }
  // Any copy with other art wins, so a second copy with different art does not hide behind a
  // matching first copy.
  const otherArt = resolved.find((p) => p.illustration_id !== card.in_box.illustration_id);
  if (otherArt) return { verdict: 'different-art', scanned: otherArt };
  // Every resolved copy has the In-box art from here on.
  const exact = resolved.find(
    (p) =>
      p.set.toLowerCase() === card.in_box.set.toLowerCase() &&
      p.collector_number.toLowerCase() === card.in_box.collector_number.toLowerCase(),
  );
  if (exact) return { verdict: 'match', scanned: exact };
  return { verdict: 'same-art-other-set', scanned: resolved[0]! };
}

/** The distinct scanned Printings of a card's rows, as "SET 123", in scan order. */
export function scannedPrintings(rows: ScannedRowWithPrinting[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const p = r.printing;
    const label = p
      ? `${p.set.toUpperCase()} ${p.collector_number}`
      : r.set && r.collector_number
        ? `${r.set.toUpperCase()} ${r.collector_number}`
        : null;
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Index the expected cards by every name they may be scanned under. */
export function buildNameIndex(expected: ExpectedCard[]): Map<string, ExpectedCard> {
  const index = new Map<string, ExpectedCard>();
  for (const card of expected) {
    for (const n of [card.name, card.front_name, ...(card.aliases ?? [])]) {
      const key = normalizeName(n);
      if (key && !index.has(key)) index.set(key, card);
    }
  }
  return index;
}

/** Index the expected cards by the printingKey of their In-box and Wanted Printings. */
export function buildPrintingIndex(expected: ExpectedCard[]): Map<string, ExpectedCard> {
  const index = new Map<string, ExpectedCard>();
  for (const card of expected) {
    for (const k of card.printing_keys ?? []) {
      const key = k.toLowerCase();
      if (!index.has(key)) index.set(key, card);
    }
  }
  return index;
}

/**
 * Compare the expected cards with the scanned rows of all piles.
 * Quantities are summed per card. `printings` maps printingKey(row) to the resolved Printing.
 */
export function diffScan(
  expected: ExpectedCard[],
  rows: ScannedRow[],
  printings: ReadonlyMap<string, ResolvedPrinting> = new Map(),
): Diff {
  const index = buildNameIndex(expected);
  const byPrinting = buildPrintingIndex(expected);
  const byCard = new Map<string, ScannedRowWithPrinting[]>();
  const unexpected = new Map<string, UnexpectedResult>();
  const uniqueNames = new Set<string>();

  for (const row of rows) {
    const key = normalizeName(row.name);
    uniqueNames.add(key);
    const k = printingKey(row);
    const withPrinting: ScannedRowWithPrinting = {
      ...row,
      printing: (k ? printings.get(k) : undefined) ?? null,
    };
    const card = index.get(key) ?? (k ? byPrinting.get(k) : undefined);
    if (card) {
      const list = byCard.get(card.oracle_id) ?? [];
      list.push(withPrinting);
      byCard.set(card.oracle_id, list);
    } else {
      const u = unexpected.get(key) ?? { name: row.name, count: 0, rows: [] };
      u.count += row.quantity;
      u.rows.push(withPrinting);
      unexpected.set(key, u);
    }
  }

  const missing: ExpectedCard[] = [];
  const present: CardResult[] = [];
  const duplicates: CardResult[] = [];
  for (const card of expected) {
    const cardRows = byCard.get(card.oracle_id) ?? [];
    const count = cardRows.reduce((s, r) => s + r.quantity, 0);
    if (count === 0) {
      missing.push(card);
      continue;
    }
    const { verdict, scanned } = artVerdict(card, cardRows);
    const result: CardResult = { card, count, rows: cardRows, verdict, scanned };
    (count > 1 ? duplicates : present).push(result);
  }

  const withArt = [...present, ...duplicates];
  return {
    missing,
    unexpected: [...unexpected.values()],
    duplicates,
    present,
    totals: {
      expected: expected.length,
      scannedRows: rows.length,
      scannedUniqueNames: uniqueNames.size,
      missing: missing.length,
      unexpected: unexpected.size,
      duplicates: duplicates.length,
      differentArt: withArt.filter((r) => r.verdict === 'different-art').length,
      sameArtOtherSet: withArt.filter((r) => r.verdict === 'same-art-other-set').length,
      unknown: withArt.filter((r) => r.verdict === 'unknown').length,
    },
  };
}
