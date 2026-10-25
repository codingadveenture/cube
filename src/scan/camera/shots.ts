// shots.ts: the photos of one camera session and what became of them. Pure; db.ts stores them.
import type { ScannedRow } from '../parse';
import type { Orientation, RecogniseResult, ShotCandidate, ShotDecision } from '../vision/protocol';

export type ShotStatus = 'match' | 'review' | 'none' | 'confirmed' | 'skipped';

/** A Printing a shot was taken to be. */
export interface PrintingRef {
  scryfall_id: string;
  oracle_id: string;
  name: string;
  set: string;
  collector_number: string;
}

export interface Shot {
  id: string;
  /** ISO time of the capture. */
  at: string;
  /** JPEG of the crop, about 240x336. */
  thumb: Blob;
  /** Size of the crop that was recognised. */
  width: number;
  height: number;
  /** Null until recognition has answered (or when it failed). */
  decision: ShotDecision | null;
  /** The top three cards, best first. */
  candidates: ShotCandidate[];
  status: ShotStatus;
  chosen: PrintingRef | null;
  /** The orientation whose pass won; null until recognised. */
  orientation: Orientation | null;
  /** 'photo' for a picture added with Try a photo. */
  source: 'camera' | 'photo';
}

export function refOf(c: PrintingRef): PrintingRef {
  return { scryfall_id: c.scryfall_id, oracle_id: c.oracle_id, name: c.name, set: c.set, collector_number: c.collector_number };
}

/** A shot as captured, before recognition: kept as 'review' so a failed recognition still leaves the photo. */
export function newShot(fields: Pick<Shot, 'id' | 'at' | 'thumb' | 'width' | 'height' | 'source'>): Shot {
  return { ...fields, decision: null, candidates: [], status: 'review', chosen: null, orientation: null };
}

/**
 * Stores the recognition result on a shot. A match chooses the best Printing of the accepted
 * card. A shot the Owner has already confirmed or skipped keeps that choice.
 */
export function applyRecognition(shot: Shot, r: Pick<RecogniseResult, 'decision' | 'candidates' | 'orientation'>): Shot {
  const base = { ...shot, decision: r.decision, candidates: r.candidates.slice(0, 3), orientation: r.orientation };
  if (shot.status === 'confirmed' || shot.status === 'skipped') return base;
  const top = r.candidates[0];
  const status = r.decision.status;
  return { ...base, status, chosen: status === 'match' && top ? refOf(top) : null };
}

export function confirmShot(shot: Shot, choice: PrintingRef): Shot {
  return { ...shot, status: 'confirmed', chosen: refOf(choice) };
}

export function skipShot(shot: Shot): Shot {
  return { ...shot, status: 'skipped', chosen: null };
}

export function isMatched(s: Shot): boolean {
  return (s.status === 'match' || s.status === 'confirmed') && s.chosen !== null;
}

export function needsReview(s: Shot): boolean {
  return s.status === 'review' || s.status === 'none';
}

export interface ShotCounts {
  captured: number;
  matched: number;
  toReview: number;
  skipped: number;
}

export function shotCounts(shots: readonly Shot[]): ShotCounts {
  let matched = 0;
  let toReview = 0;
  let skipped = 0;
  for (const s of shots) {
    if (isMatched(s)) matched++;
    else if (needsReview(s)) toReview++;
    else if (s.status === 'skipped') skipped++;
  }
  return { captured: shots.length, matched, toReview, skipped };
}

export type ShotFilter = 'all' | 'review' | 'matched' | 'skipped';

export function filterShots(shots: readonly Shot[], f: ShotFilter): Shot[] {
  if (f === 'review') return shots.filter(needsReview);
  if (f === 'matched') return shots.filter(isMatched);
  if (f === 'skipped') return shots.filter((s) => s.status === 'skipped');
  return [...shots];
}

/** Newest first. */
export function sortShots(shots: readonly Shot[]): Shot[] {
  return [...shots].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/**
 * The matched and confirmed shots as Scan rows, one per Printing: identical Printings merge by
 * summing the quantity. Rows keep the order of the first shot of each Printing.
 */
export function shotsToRows(shots: readonly Shot[]): ScannedRow[] {
  const rows = new Map<string, ScannedRow>();
  const ordered = [...shots].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const s of ordered) {
    if (!isMatched(s)) continue;
    const c = s.chosen!;
    const key = c.scryfall_id || `${c.name}|${c.set}|${c.collector_number}`;
    const row = rows.get(key);
    if (row) row.quantity++;
    else {
      rows.set(key, {
        name: c.name,
        quantity: 1,
        scryfall_id: c.scryfall_id || null,
        set: c.set || null,
        collector_number: c.collector_number || null,
        foil: null,
        language: null,
      });
    }
  }
  return [...rows.values()];
}

/** The default label of the exported pile: "Camera 2026-10-25" in local time. */
export function defaultPileLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Camera ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The next shot after `id` in `list` that still needs review, or the first one before it. */
export function nextToReview(list: readonly Shot[], id: string): Shot | null {
  const i = list.findIndex((s) => s.id === id);
  const after = list.slice(i + 1).find(needsReview);
  return after ?? list.slice(0, Math.max(0, i)).find(needsReview) ?? null;
}

const STATUSES: readonly ShotStatus[] = ['match', 'review', 'none', 'confirmed', 'skipped'];

/** A record read back from IndexedDB, checked; null when it is not a shot. */
export function reviveShot(raw: unknown): Shot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Shot>;
  if (typeof r.id !== 'string' || typeof r.at !== 'string' || !r.thumb) return null;
  if (!STATUSES.includes(r.status as ShotStatus)) return null;
  return {
    id: r.id,
    at: r.at,
    thumb: r.thumb,
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
    decision: r.decision ?? null,
    candidates: Array.isArray(r.candidates) ? r.candidates : [],
    status: r.status as ShotStatus,
    chosen: r.chosen ?? null,
    orientation: r.orientation === 'upright' || r.orientation === 'rotated' ? r.orientation : null,
    source: r.source === 'photo' ? 'photo' : 'camera',
  };
}
