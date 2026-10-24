// "Import log from file": {"winner_picks":[{card,by,date,note}],"bans":[{card,by,date}]}.
import { normalizeName } from '../lib/normalize';
import type { LogEntryInput } from './types';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function dateOf(v: unknown): string | null {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function parseLogFile(json: unknown): LogEntryInput[] {
  if (!json || typeof json !== 'object') throw new Error('The file is not a JSON object.');
  const { winner_picks, bans } = json as { winner_picks?: unknown; bans?: unknown };
  if (!Array.isArray(winner_picks) && !Array.isArray(bans)) {
    throw new Error('The file has neither "winner_picks" nor "bans".');
  }
  const out: LogEntryInput[] = [];
  for (const raw of Array.isArray(winner_picks) ? winner_picks : []) {
    const e = (raw ?? {}) as Record<string, unknown>;
    out.push({ type: 'winner_pick', card_name: str(e.card) || null, by: str(e.by), date: dateOf(e.date), cut: null, note: str(e.note) });
  }
  for (const raw of Array.isArray(bans) ? bans : []) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const card = str(e.card);
    if (!card) continue;
    out.push({ type: 'ban', card_name: card, by: str(e.by), date: dateOf(e.date), cut: null, note: str(e.note) });
  }
  return out;
}

function keyOf(e: LogEntryInput): string {
  return [e.type, normalizeName(e.card_name ?? ''), e.by.toLowerCase(), e.date ?? ''].join('|');
}

/** Entries not already in the log (same type, card, by and date). */
export function newLogEntries(incoming: LogEntryInput[], existing: LogEntryInput[]): LogEntryInput[] {
  const seen = new Set(existing.map(keyOf));
  const out: LogEntryInput[] = [];
  for (const e of incoming) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Newest first; entries without a date (a pending pick) on top. */
export function sortLog<T extends LogEntryInput & { createdAt: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const da = a.date ?? '9999-99-99';
    const db = b.date ?? '9999-99-99';
    return db.localeCompare(da) || b.createdAt.localeCompare(a.createdAt);
  });
}
