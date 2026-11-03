// queue.ts: the order of the desk review (#/review), pure. Which pile opens, the queue of a pile's
// photos (to review first, in capture order), the next photo to decide, the position line, the
// tags on a candidate (in the box, another printing of an In-box card, already in this pile or
// in another), the photos to set aside as repeats in one go, and the order of a card's printings
// in the picker. ReviewView stays thin over these.
import { normalizeName } from '../lib/normalize';
import type { IndexPrinting } from '../printings/types';
import { sharedNeedsReview } from '../store/shotChunks';
import type { SharedPile, SharedShot, SharedShotRef } from '../store/types';
import type { Card } from '../types';

type PileLike = Pick<SharedPile, 'id' | 'createdAt' | 'to_review' | 'shot_count'>;
type ItemLike = { shot: Pick<SharedShot, 'id' | 'status'> };

/** Photos of the pile still to decide; a pile without the field has none. */
export const toReviewOf = (p: Pick<SharedPile, 'to_review'>): number => Math.max(0, p.to_review ?? 0);

/** The newest pile first; the id breaks a tie, so the order is total. */
export function pileOrder<T extends Pick<SharedPile, 'id' | 'createdAt'>>(piles: readonly T[]): T[] {
  return [...piles].sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The piles with camera photos: the only ones with anything to review. */
export function photoPiles<T extends Pick<SharedPile, 'shot_count'>>(piles: readonly T[]): T[] {
  return piles.filter((p) => (p.shot_count ?? 0) > 0);
}

/**
 * The pile the desk opens, from `piles` in pileOrder: the requested one when it exists, else the
 * newest with something to review, else the newest. Null without piles.
 */
export function openPileId(piles: readonly PileLike[], requested: string | null): string | null {
  if (requested && piles.some((p) => p.id === requested)) return requested;
  return (piles.find((p) => toReviewOf(p) > 0) ?? piles[0])?.id ?? null;
}

/** The pile to move on to from `openId`: the first other pile (in the given order) with something to review, or null. */
export function nextPileToReview<T extends PileLike>(piles: readonly T[], openId: string | null): T | null {
  return piles.find((p) => p.id !== openId && toReviewOf(p) > 0) ?? null;
}

/** Photos still to review in every pile but `openId`. */
export function otherToReview(piles: readonly PileLike[], openId: string | null): number {
  return piles.reduce((n, p) => (p.id === openId ? n : n + toReviewOf(p)), 0);
}

/** A pile's photos for the desk: those to review first, in capture order, then the rest in capture order. */
export function queueOrder<T extends ItemLike>(items: readonly T[]): T[] {
  return [...items.filter((x) => sharedNeedsReview(x.shot)), ...items.filter((x) => !sharedNeedsReview(x.shot))];
}

/**
 * The next photo to review after `afterId` in the queue, going round to the start; never the
 * `afterId` photo itself, so a photo just decided is not offered again even before the live
 * data has caught up. Null when nothing else is left. Without `afterId`: the first to review.
 */
export function nextToReview<T extends ItemLike>(queue: readonly T[], afterId: string | null): T | null {
  const i = afterId === null ? -1 : queue.findIndex((x) => x.shot.id === afterId);
  const n = queue.length;
  for (let k = 1; k <= n; k++) {
    const x = queue[(i + k) % n]!;
    if (x.shot.id === afterId) continue;
    if (sharedNeedsReview(x.shot)) return x;
  }
  return null;
}

/**
 * The position line: "Photo k of n to review in <label>" for a photo to review, "Photo i of N in
 * <label> · n to review" for one already decided, and the other piles' count after it.
 */
export function positionText(queue: readonly ItemLike[], currentId: string | null, label: string, others: number): string {
  const i = currentId === null ? -1 : queue.findIndex((x) => x.shot.id === currentId);
  const toReview = queue.filter((x) => sharedNeedsReview(x.shot)).length;
  const tail = others > 0 ? ` · ${others} more to review in other piles` : '';
  if (i < 0) return `No photos in ${label}${tail}`;
  const here = sharedNeedsReview(queue[i]!.shot)
    ? `Photo ${i + 1} of ${toReview} to review in ${label}`
    : `Photo ${i + 1} of ${queue.length} in ${label} · ${toReview} to review`;
  return here + tail;
}

/** The key a name is matched on: the front face, case and accents dropped (normalizeName, as the Scan diff). */
const nameKey = (name: string) => normalizeName(name);

/**
 * The names the rows of the piles other than `exceptId` hold, by name key, each with the label
 * of the first pile (in the given order) that holds it. Rows with nothing left in them do not count.
 */
export function namesInPiles(piles: readonly Pick<SharedPile, 'id' | 'label' | 'rows'>[], exceptId: string | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const p of piles) {
    if (p.id === exceptId) continue;
    for (const r of p.rows) {
      if (r.quantity <= 0) continue;
      const k = nameKey(r.name);
      if (!names.has(k)) names.set(k, p.label);
    }
  }
  return names;
}

export type CandidateTag = { kind: 'inBox' } | { kind: 'inBoxOtherPrinting' } | { kind: 'alreadyIn'; label: string };

/**
 * What the desk says beside a candidate: it is the Printing in the box, or another printing of
 * the card whose In-box Printing differs; and that another shared pile already has the name.
 */
export function candidateTags(
  c: Pick<SharedShotRef, 'scryfall_id' | 'oracle_id' | 'name'>,
  cards: ReadonlyMap<string, Pick<Card, 'in_box'>> | null,
  names: ReadonlyMap<string, string>,
): CandidateTag[] {
  const tags: CandidateTag[] = [];
  const inBox = cards?.get(c.oracle_id)?.in_box ?? null;
  if (inBox) tags.push(inBox.scryfall_id === c.scryfall_id ? { kind: 'inBox' } : { kind: 'inBoxOtherPrinting' });
  const label = names.get(nameKey(c.name));
  if (label !== undefined) tags.push({ kind: 'alreadyIn', label });
  return tags;
}

export function tagText(t: CandidateTag): string {
  switch (t.kind) {
    case 'inBox':
      return 'in the box';
    case 'inBoxOtherPrinting':
      return 'In-box card, other printing';
    default:
      return `already in ${t.label}`;
  }
}

/**
 * A card's printings for the picker: the In-box Printing first, then those sharing the art of
 * `pickedId` (the candidate the picker opened from), then the rest; each group newest first.
 */
export function orderPrintings<T extends Pick<IndexPrinting, 'id' | 'illustration_id' | 'released_at'>>(
  printings: readonly T[],
  inBoxId: string | null,
  pickedId: string | null,
): T[] {
  const art = pickedId === null ? null : (printings.find((p) => p.id === pickedId)?.illustration_id ?? null);
  const rank = (p: T) => (p.id === inBoxId ? 0 : art !== null && p.illustration_id === art ? 1 : 2);
  return [...printings].sort((a, b) => rank(a) - rank(b) || (a.released_at > b.released_at ? -1 : a.released_at < b.released_at ? 1 : 0));
}

/** True when pile `a` was created before pile `b`: the pileOrder of the two, the other way round. */
function earlierPile(a: Pick<SharedPile, 'id' | 'createdAt'>, b: Pick<SharedPile, 'id' | 'createdAt'>): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

type KeptShot = Pick<SharedShot, 'id' | 'status' | 'chosen'>;

/** A photo that is in the pile's rows: a match, or the Owner's confirmation, of a Printing. */
const kept = (s: KeptShot): s is KeptShot & { chosen: SharedShotRef } => (s.status === 'match' || s.status === 'confirmed') && s.chosen !== null;

/**
 * The names the kept photos (match or confirmed) of the open pile hold, other than the photo
 * `exceptId`, each to the label 'this pile': so a candidate the pile already has is tagged
 * "already in this pile", as it is on the phone, and a click on it records a repeat.
 */
export function namesInPhotos(items: readonly { shot: KeptShot }[], exceptId: string | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const { shot } of items) {
    if (shot.id === exceptId || !kept(shot)) continue;
    const k = nameKey(shot.chosen.name);
    if (!names.has(k)) names.set(k, 'this pile');
  }
  return names;
}

/**
 * The photos of the open pile to set aside as repeats in one go: its kept photos (match or
 * confirmed; a doubtful photo is never touched) whose card's name a pile created earlier than
 * this one holds, or that are the second or later photo of their name within this pile, in the
 * given order (capture order, as the chunks hold the photos). Each comes with the card it is a
 * repeat of: its own chosen Printing.
 */
export function repeatsInPile<T extends { shot: KeptShot }>(
  pile: Pick<SharedPile, 'id' | 'createdAt'>,
  piles: readonly Pick<SharedPile, 'id' | 'label' | 'rows' | 'createdAt'>[],
  items: readonly T[],
): (T & { ref: SharedShotRef })[] {
  const earlier = namesInPiles(
    piles.filter((p) => p.id !== pile.id && earlierPile(p, pile)),
    null,
  );
  const seen = new Set<string>();
  const out: (T & { ref: SharedShotRef })[] = [];
  for (const item of items) {
    const { shot } = item;
    if (!kept(shot)) continue;
    const k = nameKey(shot.chosen.name);
    if (earlier.has(k) || seen.has(k)) out.push({ ...item, ref: shot.chosen });
    else seen.add(k);
  }
  return out;
}
