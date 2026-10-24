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
 * The CSV for CubeCobra's "Replace with CSV": one row per card on the List, with its Wanted
 * Printing (Set and Collector Number carry the Printing) and status "Proxied". Lines end in CRLF.
 */
export function cubecobraCsv(cards: readonly Card[]): string {
  const rows = listCards(cards).map((c) =>
    csvLine([
      c.name,
      c.cmc,
      c.type_line.replace(/ — /g, ' - '),
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
  return [csvLine(CSV_COLUMNS), ...rows].join('\r\n') + '\r\n';
}

/** One bulk-upload line, "1 Name [SET] number": CubeCobra adds exactly that Printing. */
export function pasteLine(c: Pick<Card, 'name' | 'wanted'>): string {
  return `1 ${c.name} [${c.wanted.set.toUpperCase()}] ${c.wanted.collector_number}`;
}

/** The bulk-upload text for the given cards (all on the List by default), one line per card. */
export function cubecobraPaste(cards: readonly Card[]): string {
  return listCards(cards).map(pasteLine).join('\n');
}

export function csvFileName(date: string): string {
  return `cubecobra-${date}.csv`;
}

// --- cubeJSON ---------------------------------------------------------------------------------

/** The part of a cubeJSON mainboard card the app reads. */
export interface CubeJsonCard {
  cardID: string;
  name?: string;
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
  cards?: { mainboard?: CubeJsonCard[] };
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
