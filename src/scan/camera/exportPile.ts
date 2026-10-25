// exportPile.ts: hands the camera session to the Scan view as one Pile.
import { loadSession, makePile, saveSession } from '../session';
import { shotsToRows, type Shot } from './shots';

/** Appends the matched and confirmed shots to the Scan session as a Pile; returns the card count. */
export function addShotsToScan(shots: readonly Shot[], label: string): number {
  const rows = shotsToRows(shots);
  const session = loadSession();
  saveSession({ ...session, piles: [...session.piles, makePile(label, rows)] });
  return rows.reduce((n, r) => n + r.quantity, 0);
}
