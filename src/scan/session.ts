// A Scan session: the imported piles and the Resolved marks. Kept in localStorage.
import type { Pile, ScannedRow } from './parse';

export const SESSION_KEY = 'cube.scan-session.v1';

export interface ScanSession {
  started_at: string;
  piles: Pile[];
  /** Item keys the Owner has ticked off, for example "missing:<oracle_id>". */
  resolved: Record<string, true>;
}

export function emptySession(): ScanSession {
  return { started_at: new Date().toISOString(), piles: [], resolved: {} };
}

export function loadSession(): ScanSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return emptySession();
    const s = JSON.parse(raw) as Partial<ScanSession>;
    if (!Array.isArray(s.piles)) return emptySession();
    return {
      started_at: s.started_at ?? new Date().toISOString(),
      piles: s.piles,
      resolved: s.resolved ?? {},
    };
  } catch {
    return emptySession();
  }
}

export function saveSession(s: ScanSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: the session still works until the page is closed.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

let counter = 0;
export function makePile(label: string, rows: ScannedRow[]): Pile {
  counter++;
  return { id: `${Date.now().toString(36)}-${counter}`, label, rows };
}

export function mergedRows(piles: Pile[]): ScannedRow[] {
  return piles.flatMap((p) => p.rows);
}
