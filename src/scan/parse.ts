// Parsing of scanner exports: ManaBox CSV (by header name) and plain text lists.
import Papa from 'papaparse';

export interface ScannedRow {
  name: string;
  quantity: number;
  scryfall_id: string | null;
  set: string | null;
  collector_number: string | null;
  foil: string | null;
  language: string | null;
}

export interface Pile {
  id: string;
  label: string;
  rows: ScannedRow[];
}

/** Header names per field, lower-cased; ManaBox first, then Delver Lens and common exports. */
const COLUMNS: Record<'name' | 'quantity' | 'scryfall_id' | 'set' | 'collector_number' | 'foil' | 'language', string[]> = {
  name: ['name', 'card name', 'card'],
  quantity: ['quantity', 'qty', 'count'],
  scryfall_id: ['scryfall id', 'scryfall_id', 'scryfallid'],
  set: ['set code', 'edition code', 'set', 'edition', 'set_code'],
  collector_number: ['collector number', "collector's number", 'collector_number', 'collector no', 'number'],
  foil: ['foil', 'finish'],
  language: ['language', 'lang'],
};

function field(r: Record<string, string>, names: string[]): unknown {
  for (const n of names) if (n in r) return r[n];
  return undefined;
}

const HEADER_SEPARATORS = [',', ';', '\t'];

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function parseQuantity(v: unknown): number {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** True when the first line looks like a CSV header with a Name column. */
export function looksLikeCsv(text: string): boolean {
  const first = text.replace(/^\ufeff/, '').split(/\r?\n/, 1)[0] ?? '';
  const sep = HEADER_SEPARATORS.find((c) => first.includes(c));
  if (!sep) return false;
  const heads = first.split(sep).map((h) => h.replace(/"/g, '').trim().toLowerCase());
  return COLUMNS.name.some((n) => heads.includes(n));
}

/** Scanner CSV (ManaBox, Delver Lens and similar): columns found by header name, case-insensitive, any common separator; unknown columns are ignored. */
export function parseManabox(text: string): ScannedRow[] {
  const result = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const rows: ScannedRow[] = [];
  for (const r of result.data) {
    const name = clean(field(r, COLUMNS.name));
    if (!name) continue;
    rows.push({
      name,
      quantity: parseQuantity(field(r, COLUMNS.quantity)),
      scryfall_id: clean(field(r, COLUMNS.scryfall_id))?.toLowerCase() ?? null,
      set: clean(field(r, COLUMNS.set))?.toLowerCase() ?? null,
      collector_number: clean(field(r, COLUMNS.collector_number)),
      foil: clean(field(r, COLUMNS.foil)),
      language: clean(field(r, COLUMNS.language)),
    });
  }
  return rows;
}

const LINE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]+)\)(?:\s+(\S+))?)?$/;

/** Plain text list, one card per line: "Name", "2 Name", "2x Name", "Name (SET) 123". */
export function parsePlainText(text: string): ScannedRow[] {
  const rows: ScannedRow[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const name = (m[2] ?? '').trim();
    if (!name) continue;
    rows.push({
      name,
      quantity: m[1] ? parseQuantity(m[1]) : 1,
      scryfall_id: null,
      set: m[3]?.toLowerCase() ?? null,
      collector_number: m[4] ?? null,
      foil: null,
      language: null,
    });
  }
  return rows;
}

/** ManaBox CSV when the first line is a header with a Name column, otherwise a plain text list. */
export function parseScanText(text: string): ScannedRow[] {
  return looksLikeCsv(text) ? parseManabox(text) : parsePlainText(text);
}
