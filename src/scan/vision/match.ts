// match.ts: turn ranked catalog hits into a decision about one slip.
//
// Follows research/browser-scanner.md sections 4.2 and 4.3:
// - the name is accepted when the best score is at least `accept` and beats the best score of a
//   different card (oracle_id) by at least `margin`;
// - the Printing is decided separately, against the expected (In-box) Printing of the accepted
//   card: 'exact' when that Printing is the best hit of the card, 'same art' when the best hit
//   shares its illustration, 'other art' when another illustration wins by at least
//   `printingMargin`, 'ambiguous' otherwise;
// - below `accept` (or without the margin) the slip goes to review with the top candidates, and
//   below `floor` the frame is treated as holding no card at all.
// The default thresholds come from the offline eval, research/art-catalog-eval.md.
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
// middle of the settings that name no wrong card and accept the most slips. A starting point, to
// be checked against photos from the real rig.
export const DEFAULT_DECIDE_OPTIONS: DecideOptions = {
  // From scripts/eval-art-catalog.mjs (research/art-catalog-eval.md, 2026-10-25): the setting that
  // names no wrong card on 400 test inputs and 20 impostors with the most slack to the nearest
  // wrong one. The floor sits below every real input, so a slip is never dropped as "no card".
  accept: 0.3,
  margin: 0.18,
  printingMargin: 0.02,
  floor: 0.37,
};

export type Verdict = 'exact' | 'same art' | 'other art' | 'ambiguous' | 'no expected printing';

export interface Candidate {
  oracle_id: string;
  name: string;
  on_list: boolean;
  /** The best-scoring row of this card. */
  printing: Hit;
  score: number;
}

export interface Decision {
  status: 'match' | 'review' | 'none';
  /** The accepted card; null unless status is 'match'. */
  card: { oracle_id: string; name: string; on_list: boolean } | null;
  /** The best-scoring row of the accepted card; null unless status is 'match'. */
  printing: Hit | null;
  verdict: Verdict | null;
  /** The best score. */
  score: number;
  /** Lead of the best card over the next card (a lower bound when no other card is in the hits). */
  margin: number;
  /** The top 3 distinct cards with their best row and score. */
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
  const cards = groupByCard(hits);
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
  const verdict = printingVerdict(cardHits, opts.expected?.(top.oracle_id), opts.printingMargin, lowest);
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
