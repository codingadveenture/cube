// The default Printing rule: the newest ordinary paper Printing with a black border that is out.
import type { IndexPrinting } from './types';

/**
 * Not ordinary paper Printings: memorabilia, Secret Lair and other boxed products ('box', for
 * example slz, slc) and masterpiece sets. Their release date is when the card joined the product,
 * so they would often count as newest.
 */
const EXCLUDED_SET_TYPES = ['memorabilia', 'box', 'masterpiece'];
/** Secret Lair Drop, and The List (set_type masters, but a reprint product). */
const EXCLUDED_SETS = ['sld', 'plst'];

/** Today's date as YYYY-MM-DD, the form released_at uses. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when the Printing's set is out on `today` (YYYY-MM-DD). */
export function isReleased(p: Pick<IndexPrinting, 'released_at'>, today: string): boolean {
  return !p.released_at || p.released_at <= today;
}

/** True when a Printing may be picked by the default rule. */
export function qualifiesForDefault(p: IndexPrinting): boolean {
  return (
    p.border_color === 'black' &&
    !p.promo &&
    !EXCLUDED_SET_TYPES.includes(p.set_type) &&
    !EXCLUDED_SETS.includes(p.set) &&
    !p.digital &&
    !p.textless
  );
}

/** Newest first; on the same day the main-set number (lowest collector number) first. */
function newestFirst(a: IndexPrinting, b: IndexPrinting): number {
  return b.released_at.localeCompare(a.released_at) || a.collector_number.localeCompare(b.collector_number, 'en', { numeric: true });
}

/**
 * The Printing the default rule picks, or null when none qualifies. Printings from sets not out
 * on `today` (YYYY-MM-DD) are skipped. Newest wins; when the newest two candidates came out in
 * the same year and only the second is high resolution, it wins.
 */
export function defaultPrinting(printings: readonly IndexPrinting[], today: string): IndexPrinting | null {
  const candidates = printings.filter((p) => qualifiesForDefault(p) && isReleased(p, today)).sort(newestFirst);
  const [first, second] = candidates;
  if (!first) return null;
  if (second && !first.highres && second.highres && first.released_at.slice(0, 4) === second.released_at.slice(0, 4)) {
    return second;
  }
  return first;
}
