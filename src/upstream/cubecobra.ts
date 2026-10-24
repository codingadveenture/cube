// What the Owner hands CubeCobra, which has no write API: a CSV for "Replace with CSV" and a
// paste text for the bulk upload. Formats from research/cubecobra.md section 4. Pure.
import { compareCards } from '../cube/order';
import type { Card } from '../types';

/** CubeCobra's CSV_HEADER (serverutils/cube.ts), in its order. */
export const CSV_COLUMNS = [
  'name',
  'CMC',
  'Type',
  'Color',
  'Set',
  'Collector Number',
  'Rarity',
  'Color Category',
  'status',
  'Finish',
  'board',
  'maybeboard',
  'image URL',
  'image Back URL',
  'tags',
  'Notes',
  'MTGO ID',
  'Custom',
  'Voucher',
  'Artist',
] as const;

/** RFC 4180: quote a field that holds a comma, a double quote, CR or LF; double the quotes inside. */
export function csvField(v: string | number | boolean | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(fields: readonly (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}

/** The cards on the List, in CubeCobra's default order. */
export function listCards(cards: readonly Card[]): Card[] {
  return cards.filter((c) => c.in_list).sort(compareCards);
}

/**
 * The name CubeCobra should look a row up by: the Printing's own name. CubeCobra finds the
 * printings by name first and only then picks set and collector number among them, and a Through
 * the Omenpaths name (Ademi of the Silkchutes) is filed only under its digital printing, while the
 * paper Spider-Man printing is filed under its own name (Spectacular Spider-Man).
 */
export function exportName(c: Pick<Card, 'name' | 'wanted'>): string {
  return c.wanted.name || c.name;
}

/** The board CubeCobra keeps a cube's basic lands on, as its CSV board column reads it. */
export const BASICS_BOARD = 'basics';

/**
 * The CSV for CubeCobra's "Replace with CSV": one row per card on the List, with its Wanted
 * Printing (Set and Collector Number carry the Printing), then one row per card of the cube's
 * basics board, since the replace empties every board the file leaves out. Type is left empty so
 * CubeCobra stores no type-line override. Status is "Proxied", which CubeCobra applies only to
 * rows whose Printing changes. Lines end in CRLF.
 */
export function cubecobraCsv(cards: readonly Card[], basics: readonly CubeJsonCard[] = []): string {
  const rows = listCards(cards).map((c) =>
    csvLine([
      exportName(c),
      c.cmc,
      '',
      c.colors.join(''),
      c.wanted.set.toLowerCase(),
      c.wanted.collector_number,
      c.rarity,
      '',
      'Proxied',
      'Non-foil',
      'mainboard',
      'false',
      '',
      '',
      '',
      '',
      '',
      'false',
      'false',
      c.wanted.artist,
    ]),
  );
  const basicRows = basics.map((b) =>
    csvLine([
      b.details?.name || b.name || '',
      '',
      '',
      '',
      (b.details?.set ?? '').toLowerCase(),
      b.details?.collector_number ?? '',
      '',
      '',
      b.status || 'Not Owned',
      b.finish || 'Non-foil',
      BASICS_BOARD,
      'false',
      '',
      '',
      '',
      '',
      '',
      'false',
      'false',
      '',
    ]),
  );
  return [csvLine(CSV_COLUMNS), ...rows, ...basicRows].join('\r\n') + '\r\n';
}

/** One bulk-upload line, "1 Name [SET] number": CubeCobra adds exactly that Printing. */
export function pasteLine(c: Pick<Card, 'name' | 'wanted'>): string {
  return `1 ${exportName(c)} [${c.wanted.set.toUpperCase()}] ${c.wanted.collector_number}`;
}

/** The bulk-upload text for the given cards (all on the List by default), one line per card. */
export function cubecobraPaste(cards: readonly Card[]): string {
  return listCards(cards).map(pasteLine).join('\n');
}

export function csvFileName(date: string): string {
  return `cubecobra-${date}.csv`;
}

// --- cubeJSON ---------------------------------------------------------------------------------

/** The part of a cubeJSON card the app reads. */
export interface CubeJsonCard {
  cardID: string;
  name?: string;
  status?: string;
  finish?: string;
  details?: {
    oracle_id?: string;
    name?: string;
    oracle_tags?: string[];
    set?: string;
    collector_number?: string;
    image_normal?: string;
    type?: string;
    colors?: string[];
    cmc?: number | string;
  };
}

export interface CubeJson {
  cards?: { mainboard?: CubeJsonCard[]; basics?: CubeJsonCard[] };
}

/** The cards on the cube's basics board that have a name to write. */
export function listBasics(json: CubeJson): CubeJsonCard[] {
  const basics = json.cards?.basics;
  return Array.isArray(basics) ? basics.filter((b) => !!b && !!(b.details?.name || b.name)) : [];
}

export interface UpstreamPrinting {
  oracle_id: string | null;
  name: string;
  scryfall_id: string;
  set: string;
  collector_number: string;
  image_normal: string | null;
  cycle_tags: string[];
}

/** Each mainboard card's Printing (cardID is the Scryfall id) and its cycle-* oracle tags. */
export function upstreamPrintings(json: CubeJson): UpstreamPrinting[] {
  return (json.cards?.mainboard ?? [])
    .filter((c) => c && c.cardID)
    .map((c) => ({
      oracle_id: c.details?.oracle_id ?? null,
      name: c.details?.name ?? c.name ?? '',
      scryfall_id: c.cardID,
      set: (c.details?.set ?? '').toLowerCase(),
      collector_number: c.details?.collector_number ?? '',
      image_normal: c.details?.image_normal ?? null,
      cycle_tags: (c.details?.oracle_tags ?? []).filter((t) => t.startsWith('cycle-')),
    }));
}
