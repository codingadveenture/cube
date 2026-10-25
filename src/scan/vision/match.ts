// match.ts: turn ranked catalog hits into a decision about one slip.
//
// Follows research/browser-scanner.md sections 4.2 and 4.3:
// - the name is accepted when the best score is at least `accept` and beats the best score of a
//   different card (oracle_id) by at least `margin`;
// - the Printing is decided separately, against the expected (In-box) Printing of the accepted
//   card: 'exact' when that Printing is the best hit of the card, 'same art' when the best hit
//   shares its illustration, 'other art' when another illustration wins by at least
//   `printingMargin`, 'ambiguous' otherwise;
// - printings sharing the best hit's illustration within `printingMargin` of it (a set's plain card,
//   its prerelease promo, The List reprint, a digital reprint) embed almost alike, so the top one
//   among them is arbitrary: the expected Printing wins if it is among them, else the plainest
//   paper one (plainnessRank), for the decision and for every candidate;
// - below `accept` (or without the margin) the slip goes to review with the top candidates, and
//   below `floor` the frame is treated as holding no card at all.
// The default thresholds came from the offline eval, research/art-catalog-eval.md; the rig run of
// real photos superseded them (DEFAULT_DECIDE_OPTIONS).
// Pure: no imports at run time, so node scripts can load this file directly.
import type { Hit } from './types';

export interface ExpectedPrinting {
  scryfall_id: string;
  illustration_id: string | null;
  back_illustration_id?: string | null;
}

export interface DecideOptions {
  /** Lowest best-hit score that can name a card. */
  accept: number;
  /** Lowest lead of the best hit over the best hit of any other card. */
  margin: number;
  /** Lowest lead of another illustration over the expected one before saying 'other art'. */
  printingMargin: number;
  /** Below this best-hit score the frame holds no recognisable card. */
  floor: number;
  /** The Printing the accepted card is expected to have, if any (the In-box Printing). */
  expected?: (oracleId: string) => ExpectedPrinting | null | undefined;
}

// From research/art-catalog-eval.md (60 slips, 20 impostors, clean, rig and refined inputs): the
// middle of the settings that name no wrong card and accept the most slips. A starting point,
// superseded by the rig run below.
export const DEFAULT_DECIDE_OPTIONS: DecideOptions = {
  // The eval (scripts/eval-art-catalog.mjs, 2026-10-25) chose accept 0.3, margin 0.18. The rig run
  // of 2026-10-25 (71 real slip photos, Owner-verified, top-1 right on 69) superseded it: real
  // photos score median 0.61 (p10 0.46) with a lead of median 0.23 (p10 0.08), so margin 0.18 sent
  // 22 of 71 to review for nothing. A wrong top-1 under a thumb scored 0.56 with a 0.13 lead, so no
  // threshold separates it; that is left to the same-slip rule (shots.ts) and to review.
  // The floor sits below every real input, so a slip is never dropped as "no card".
  accept: 0.45,
  margin: 0.08,
  printingMargin: 0.02,
  floor: 0.37,
};

export type Verdict = 'exact' | 'same art' | 'other art' | 'ambiguous' | 'no expected printing';

export interface Candidate {
  oracle_id: string;
  name: string;
  on_list: boolean;
  /** The row named for this card: among the rows sharing its best row's illustration within
   *  `printingMargin`, the expected Printing or else the plainest (choosePrinting). */
  printing: Hit;
  score: number;
}

export interface Decision {
  status: 'match' | 'review' | 'none';
  /** The accepted card; null unless status is 'match'. */
  card: { oracle_id: string; name: string; on_list: boolean } | null;
  /** The row named for the accepted card (choosePrinting); null unless status is 'match'. */
  printing: Hit | null;
  verdict: Verdict | null;
  /** The best score. */
  score: number;
  /** Lead of the best card over the next card (a lower bound when no other card is in the hits). */
  margin: number;
  /** The top 3 distinct cards with their named row and best score. */
  candidates: Candidate[];
}

/** Distinct cards in score order, each with its best hit. Hits must be sorted best first. */
export function groupByCard(hits: Hit[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const h of hits) {
    if (!seen.has(h.oracle_id)) {
      seen.set(h.oracle_id, { oracle_id: h.oracle_id, name: h.name, on_list: h.on_list, printing: h, score: h.score });
    }
  }
  return [...seen.values()];
}

/**
 * How far a Printing is from the plain paper card of its set, as a sort key (lower is plainer):
 * digital, then a set starting with 'p' (promos), then The List ('plst'), then a collector number
 * that is not only digits (a trailing 's' or 'p' and the like). Promo sets are 'p' plus a parent
 * code, four letters or more, so three-letter sets such as plc or pls are not promos. Ties go to
 * the oldest printing: the catalog lists each card's printings newest first, so the higher row.
 */
export function plainnessRank(h: Pick<Hit, 'digital' | 'set' | 'collector_number'>): [number, number, number, number] {
  const set = h.set.toLowerCase();
  const promo = set.startsWith('p') && set.length >= 4;
  return [h.digital ? 1 : 0, promo ? 1 : 0, set === 'plst' ? 1 : 0, /^\d+$/.test(h.collector_number) ? 0 : 1];
}

/** Orders hits plainest first (plainnessRank), then oldest first (higher catalog row). */
export function comparePlainness(a: Hit, b: Hit): number {
  const ra = plainnessRank(a);
  const rb = plainnessRank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
  return b.row - a.row;
}

/**
 * The Printing to name among one card's hits (best first): of the hits sharing the best hit's
 * illustration within `printingMargin` of it, the expected Printing if present, else the plainest.
 */
export function choosePrinting(cardHits: Hit[], expected: ExpectedPrinting | null | undefined, printingMargin: number): Hit {
  const best = cardHits[0]!;
  const twins = cardHits.filter(
    (h) => h === best || (best.illustration_id !== null && h.illustration_id === best.illustration_id && best.score - h.score <= printingMargin),
  );
  const exp = expected ? twins.find((h) => h.scryfall_id === expected.scryfall_id) : undefined;
  return exp ?? [...twins].sort(comparePlainness)[0]!;
}

const sortHits = (hits: Hit[]) => [...hits].sort((a, b) => b.score - a.score);

/** Decides the Printing verdict for the accepted card, given its hits (best first). */
export function printingVerdict(
  cardHits: Hit[],
  expected: ExpectedPrinting | null | undefined,
  printingMargin: number,
  lowestScore: number,
): Verdict {
  if (!expected) return 'no expected printing';
  const best = cardHits[0];
  if (best.scryfall_id === expected.scryfall_id) return 'exact';
  const arts = [expected.illustration_id, expected.back_illustration_id].filter((a): a is string => !!a);
  const isExpectedArt = (h: Hit) =>
    h.scryfall_id === expected.scryfall_id || (h.illustration_id !== null && arts.includes(h.illustration_id));
  if (isExpectedArt(best)) return 'same art';
  const expectedHit = cardHits.find(isExpectedArt);
  // When the expected art is not among the hits, its score is at most the lowest hit score.
  const expectedScore = expectedHit ? expectedHit.score : lowestScore;
  return best.score - expectedScore >= printingMargin ? 'other art' : 'ambiguous';
}

export function decide(hitsIn: Hit[], options: Partial<DecideOptions> = {}): Decision {
  const opts = { ...DEFAULT_DECIDE_OPTIONS, ...options };
  const hits = sortHits(hitsIn);
  const cards = groupByCard(hits).map((c) => ({
    ...c,
    printing: choosePrinting(
      hits.filter((h) => h.oracle_id === c.oracle_id),
      opts.expected?.(c.oracle_id),
      opts.printingMargin,
    ),
  }));
  const candidates = cards.slice(0, 3);
  if (!hits.length) {
    return { status: 'none', card: null, printing: null, verdict: null, score: 0, margin: 0, candidates };
  }
  const top = cards[0];
  const lowest = hits[hits.length - 1].score;
  // Without a second card in the hits, its score is at most the lowest hit score.
  const runnerUp = cards.length > 1 ? cards[1].score : lowest;
  const margin = top.score - runnerUp;
  const base = { score: top.score, margin, candidates };
  if (top.score < opts.floor) {
    return { status: 'none', card: null, printing: null, verdict: null, ...base };
  }
  if (top.score < opts.accept || margin < opts.margin) {
    return { status: 'review', card: null, printing: null, verdict: null, ...base };
  }
  const cardHits = hits.filter((h) => h.oracle_id === top.oracle_id);
  const expected = opts.expected?.(top.oracle_id);
  const verdict =
    expected && top.printing.scryfall_id === expected.scryfall_id
      ? 'exact'
      : printingVerdict(cardHits, expected, opts.printingMargin, lowest);
  return {
    status: 'match',
    card: { oracle_id: top.oracle_id, name: top.name, on_list: top.on_list },
    printing: top.printing,
    verdict,
    ...base,
  };
}

export interface VotedHit extends Hit {
  /** Sum of this row's scores over the frames. */
  total: number;
  /** Frames in which this row was among the hits. */
  frames: number;
}

/**
 * Multi-frame vote (research/browser-scanner.md 4.2, point 4): sums each row's score over the
 * frames, keyed by Printing and face. `score` is the sum divided by the number of frames, so a
 * row missing from a frame counts 0 there and the decide() thresholds still apply.
 */
export function votes(frames: Hit[][]): VotedHit[] {
  const byKey = new Map<string, VotedHit>();
  for (const hits of frames) {
    for (const h of hits) {
      const key = `${h.scryfall_id}:${h.face}`;
      const v = byKey.get(key);
      if (v) {
        v.total += h.score;
        v.frames++;
      } else {
        byKey.set(key, { ...h, total: h.score, frames: 1 });
      }
    }
  }
  const n = Math.max(frames.length, 1);
  return [...byKey.values()]
    .map((v) => ({ ...v, score: v.total / n }))
    .sort((a, b) => b.score - a.score || a.row - b.row);
}
