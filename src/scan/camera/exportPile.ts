// exportPile.ts: hands the camera session to the Scan view as one Pile.
import type { Pile } from '../parse';
import { loadSession, makePile, saveSession } from '../session';
import { shotsToRows, type Shot } from './shots';

/**
 * Appends the matched and confirmed shots to the Scan session as a Pile marked camera, with the
 * ids of every shot so its photos can be shared later; returns the pile and the card count.
 */
export function addShotsToScan(shots: readonly Shot[], label: string): { pile: Pile; cards: number } {
  const rows = shotsToRows(shots);
  const pile: Pile = { ...makePile(label, rows), camera: true, shotIds: shots.map((s) => s.id) };
  const session = loadSession();
  saveSession({ ...session, piles: [...session.piles, pile] });
  return { pile, cards: rows.reduce((n, r) => n + r.quantity, 0) };
}
