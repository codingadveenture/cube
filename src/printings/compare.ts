// The Compare grid's pure pieces: columns and image size by screen width, and one cell per Cycle
// member, from a candidate Print run or from the current Wanted Printings.
import type { Card } from '../types';
import { largeImage } from './images';
import type { IndexPrinting } from './types';

/** Screens this wide or wider get five columns and the large images. */
export const COMPARE_WIDE = 900;
/** Screens this wide or wider (and narrower than COMPARE_WIDE) get three columns. */
export const COMPARE_MEDIUM = 600;

/** Grid columns for a screen width in CSS px: 5 (two rows of a ten-card Cycle), 3, or 2 on phones. */
export function compareColumns(width: number): 2 | 3 | 5 {
  if (width >= COMPARE_WIDE) return 5;
  if (width >= COMPARE_MEDIUM) return 3;
  return 2;
}

/** A cell's image: large (672 x 936) on screens COMPARE_WIDE or wider, else normal (488 x 680). */
export function compareImage(normal: string, width: number): string {
  return width >= COMPARE_WIDE ? largeImage(normal) : normal;
}

/** The marker on a member that has no Printing in the run's set. */
export function missingMarker(set: string): string {
  return `no printing in ${set.toUpperCase()}`;
}

export interface CompareCell {
  oracle_id: string;
  name: string;
  /** Upper-case set code. */
  set: string;
  /** Null for a member with no Printing in the run. */
  collector_number: string | null;
  /** The "normal" image URL; null when there is no image to show. */
  image_normal: string | null;
  /** missingMarker(set) for a member with no Printing in the run, else null. */
  missing: string | null;
}

/** "SET number" under a cell, or its missing marker. */
export function cellCaption(cell: CompareCell): string {
  return cell.missing ?? `${cell.set} ${cell.collector_number ?? ''}`.trim();
}

type Member = Pick<Card, 'oracle_id' | 'name'>;

export interface RunForCells {
  set: string;
  picks: readonly { oracle_id: string; printing: Pick<IndexPrinting, 'set' | 'collector_number' | 'image_normal'> }[];
}

/** One cell per member, in member order: the run's pick, or a missing marker when it has none. */
export function runCells(run: RunForCells, members: readonly Member[]): CompareCell[] {
  const byId = new Map(run.picks.map((p) => [p.oracle_id, p.printing]));
  return members.map((m) => {
    const p = byId.get(m.oracle_id);
    if (!p) {
      return { oracle_id: m.oracle_id, name: m.name, set: run.set.toUpperCase(), collector_number: null, image_normal: null, missing: missingMarker(run.set) };
    }
    return { oracle_id: m.oracle_id, name: m.name, set: p.set.toUpperCase(), collector_number: p.collector_number, image_normal: p.image_normal || null, missing: null };
  });
}

/** One cell per member from its current Wanted Printing. */
export function currentCells(members: readonly (Member & { wanted: Pick<Card['wanted'], 'set' | 'collector_number' | 'image_normal'> })[]): CompareCell[] {
  return members.map((m) => ({
    oracle_id: m.oracle_id,
    name: m.name,
    set: m.wanted.set.toUpperCase(),
    collector_number: m.wanted.collector_number,
    image_normal: m.wanted.image_normal || null,
    missing: null,
  }));
}
