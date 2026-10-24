// What Apply Update will write, from a built preview: shown before Apply and used by Apply, so the
// preview says exactly what happens. Pure: no React, no storage, no network.
import { normalizeName } from '../lib/normalize';
import type { UpdateWrites } from '../store/types';
import type { Card } from '../types';
import { markApplied, type FeedItem } from './feed';
import type { ResolvedIn, ResolvedOut } from './resolveIn';
import { buildUpdateWrites } from './update';

export interface Preview {
  ins: ResolvedIn[];
  outs: ResolvedOut[];
  /** The accepted feed items the preview was built from. */
  items: FeedItem[];
  /** True when no feed item went in: the Update is by hand. */
  manual: boolean;
  /** The names typed under "Add cards by name" that went in. */
  manualNames: string[];
}

export interface ApplyPlan {
  writes: UpdateWrites;
  /** Rows with an error: skipped, and their decisions stay accepted. */
  errors: number;
  /** Rows without an error that change nothing (already on the List, or already off). */
  unchanged: number;
  toPrint: number;
  toPull: number;
  /** Typed names that failed to resolve: they stay in the text box for correction. */
  keepManual: string[];
}

export function planApply(p: Preview, cards: readonly Card[], now: string): ApplyPlan {
  const okIns = p.ins.filter((i) => !i.error);
  const okOuts = p.outs.filter((o) => !o.error && o.card);
  const okNames = new Set([...okIns.map((i) => normalizeName(i.name)), ...okOuts.map((o) => normalizeName(o.name))]);
  const decisions = markApplied(
    p.items.filter((i) => okNames.has(normalizeName(i.name))),
    now,
  );
  const writes = buildUpdateWrites({
    ins: okIns,
    outs: okOuts.map((o) => o.card!.oracle_id),
    cards,
    decisions,
    source: p.manual ? 'manual' : 'upstream',
    now,
  });
  const typed = new Set(p.manualNames.map(normalizeName));
  return {
    writes,
    errors: p.ins.length - okIns.length + (p.outs.length - okOuts.length),
    unchanged: okIns.length + okOuts.length - writes.history.in.length - writes.history.out.length,
    toPrint: okIns.filter((i) => i.action === 'new' || i.action === 'back').length,
    toPull: okOuts.filter((o) => o.card!.in_box).length,
    keepManual: p.ins.filter((i) => i.error && typed.has(normalizeName(i.name))).map((i) => i.name),
  };
}

/** True when Apply would write nothing at all. */
export function planIsEmpty(plan: ApplyPlan): boolean {
  return plan.writes.cards.length === 0 && Object.keys(plan.writes.decisions).length === 0;
}
