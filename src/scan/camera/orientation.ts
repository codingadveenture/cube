// orientation.ts: which way round the slips come. The first captures run both passes (upright and
// rotated 180 degrees) and keep the better; once the last five matched captures all won the same
// way, only that pass runs, which halves the time per slip. A locked pass that does not give a
// match still tries the other one (recognise.ts), and when the other one then wins, the lock is
// dropped.
import type { Orientation } from '../vision/protocol';

export const LOCK_AFTER = 5;

export interface OrientationState {
  /** Winning orientations of the latest matched captures, oldest first (at most LOCK_AFTER). */
  recent: Orientation[];
  locked: Orientation | null;
}

export function initialOrientation(): OrientationState {
  return { recent: [], locked: null };
}

/** Records the winning orientation of a matched capture. */
export function recordOrientation(s: OrientationState, won: Orientation): OrientationState {
  if (s.locked) return s.locked === won ? s : { recent: [won], locked: null };
  const recent = [...s.recent, won].slice(-LOCK_AFTER);
  const locked = recent.length >= LOCK_AFTER && recent.every((o) => o === recent[0]) ? recent[0]! : null;
  return { recent, locked };
}

/** The passes to run for the next slip. */
export function passesFor(s: OrientationState): Orientation[] {
  return s.locked ? [s.locked] : ['upright', 'rotated'];
}

export function parseOrientation(raw: unknown): OrientationState {
  const ok = (o: unknown): o is Orientation => o === 'upright' || o === 'rotated';
  if (!raw || typeof raw !== 'object') return initialOrientation();
  const r = raw as { recent?: unknown; locked?: unknown };
  const recent = Array.isArray(r.recent) ? r.recent.filter(ok).slice(-LOCK_AFTER) : [];
  return { recent, locked: ok(r.locked) ? r.locked : null };
}
