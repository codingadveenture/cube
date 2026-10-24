// Cycle analysis: whether a Cycle shares one Print run, and which Print runs could give it one.
// Pure: printings files are passed in by the caller.
import type { Card } from '../types';
import { runId, runKey, runLabel, runStyle, styleLabel, type RunKey, type RunStyle } from './style';
import { digitalOnly, isCollectors, type DigitalOnly, type IndexPrinting } from './types';

/** "fetchlands_allied" -> "Fetchlands allied". */
export function humanizeCycle(name: string): string {
  const s = name.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface CycleInfo {
  name: string;
  label: string;
  members: Card[];
}

function byName(a: Card, b: Card): number {
  return a.name.localeCompare(b.name, 'en');
}

/** Every Cycle named by the cards, with its members, sorted by label. */
export function cyclesOf(cards: readonly Card[]): CycleInfo[] {
  const map = new Map<string, Card[]>();
  for (const c of cards) for (const cy of c.cycles) map.set(cy, [...(map.get(cy) ?? []), c]);
  return [...map.entries()]
    .map(([name, members]) => ({ name, label: humanizeCycle(name), members: [...members].sort(byName) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

export function cycleMembers(cards: readonly Card[], cycle: string): Card[] {
  return cards.filter((c) => c.cycles.includes(cycle)).sort(byName);
}

/**
 * The run key of a card's Wanted Printing: from its printings file when the Printing is in it,
 * else from the frame and border cards.json knows (without frame effects), else null.
 */
export function wantedRunKey(card: Card, printings?: readonly IndexPrinting[] | null): RunKey | null {
  const w = card.wanted;
  const hit = printings?.find((p) => p.id === w.scryfall_id);
  if (hit) return runKey(hit);
  if (!w.frame || !w.border_color) return null;
  return runKey({ set: w.set, frame: w.frame, border_color: w.border_color, frame_effects: [], full_art: false });
}

export interface MemberRun {
  oracle_id: string;
  name: string;
  collector_number: string;
  run: RunKey | null;
}

export function memberRun(card: Card, printings?: readonly IndexPrinting[] | null): MemberRun {
  return {
    oracle_id: card.oracle_id,
    name: card.name,
    collector_number: card.wanted.collector_number,
    run: wantedRunKey(card, printings),
  };
}

export type CycleStatusKind = 'uniform' | 'styled' | 'split' | 'unknown';

export interface CycleStatus {
  kind: CycleStatusKind;
  /** For example "5 on ONS, 5 on ZEN". */
  summary: string;
  /** Identifies this exact arrangement of Wanted Printings; stored when the Owner accepts a split. */
  signature: string;
}

export const STATUS_LABEL: Record<CycleStatusKind | 'accepted', string> = {
  uniform: 'uniform',
  styled: 'styled',
  split: 'split',
  unknown: 'unknown',
  accepted: 'accepted split',
};

/**
 * The same for the same members on the same Print runs (set and style), in any order; a change
 * of Printing within a run, or of collector number, keeps it.
 */
export function cycleSignature(members: readonly MemberRun[]): string {
  return [...members]
    .sort((a, b) => a.oracle_id.localeCompare(b.oracle_id))
    .map((m) => `${m.oracle_id}=${m.run ? runId(m.run) : '?'}`)
    .join(',');
}

export function cycleStatus(members: readonly MemberRun[]): CycleStatus {
  const signature = cycleSignature(members);
  if (members.length === 0) return { kind: 'unknown', summary: 'No members.', signature };
  const unknown = members.filter((m) => !m.run);
  if (unknown.length > 0) {
    return { kind: 'unknown', summary: `Look not known for ${unknown.map((m) => m.name).join(', ')}.`, signature };
  }
  const runs = members.map((m) => m.run!);
  const groups = new Map<string, { key: RunKey; count: number }>();
  for (const k of runs) {
    const id = runId(k);
    const g = groups.get(id);
    if (g) g.count++;
    else groups.set(id, { key: k, count: 1 });
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count || a.key.set.localeCompare(b.key.set));
  if (list.length === 1) {
    return { kind: 'uniform', summary: `All ${members.length} on ${runLabel(list[0]!.key)}`, signature };
  }
  // Name the style only when one set appears with two styles.
  const withStyle = new Set(list.map((g) => g.key.set)).size < list.length;
  const summary = list.map((g) => `${g.count} on ${g.key.set.toUpperCase()}${withStyle ? ` ${styleLabel(g.key)}` : ''}`).join(', ');
  const first = runs[0]!;
  const sameLook = runs.every((k) => k.frame === first.frame && k.border_color === first.border_color && k.style === first.style);
  return { kind: sameLook ? 'styled' : 'split', summary, signature };
}

/** The chip to show: a split whose signature the Owner accepted is quiet. */
export function displayStatus(status: CycleStatus, ack: string | undefined): CycleStatusKind | 'accepted' {
  return status.kind === 'split' && ack === status.signature ? 'accepted' : status.kind;
}

/** Compare collector numbers naturally: 2 < 10 < 10a. */
function byCollector(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * The one Printing a member gets from a Print run: high resolution, paper over digital-only, not a
 * promo, lowest number.
 */
export function choosePrinting(printings: readonly IndexPrinting[]): IndexPrinting | null {
  const sorted = [...printings].sort(
    (a, b) =>
      Number(b.highres) - Number(a.highres) ||
      Number(a.digital) - Number(b.digital) ||
      Number(a.promo) - Number(b.promo) ||
      byCollector(a.collector_number, b.collector_number),
  );
  return sorted[0] ?? null;
}

export interface MemberRef {
  oracle_id: string;
  name: string;
}

export interface RunPick {
  oracle_id: string;
  name: string;
  printing: IndexPrinting;
}

export interface CandidateRun {
  id: string;
  set: string;
  set_name: string;
  style: RunStyle;
  frame: string;
  border_color: string;
  /** For example "VMA · retro frame · black border · MTGO-only art". */
  label: string;
  /**
   * "MTGO", "Arena" or "digital" when every pick is a digital-only Printing; null for a paper run
   * (a run mixing paper and digital counts as paper).
   */
  digitalOnly: DigitalOnly | null;
  complete: boolean;
  missing: MemberRef[];
  /** One Printing per member that has one in this run, in member order. */
  picks: RunPick[];
  highresCount: number;
  allHighres: boolean;
  anyPromo: boolean;
  released_at: string;
  /** True when the run's set is not out yet on the day given in RunOptions.today. */
  unreleased: boolean;
}

export interface RunOptions {
  includeCollectors?: boolean;
  /** Today as YYYY-MM-DD; runs released later are ranked last and marked unreleased. */
  today?: string;
}

function inRunId(p: IndexPrinting): string {
  return runId({ set: p.set, style: runStyle(p) });
}

/** " · MTGO-only art", " · Arena-only art" or " · digital-only art"; empty for a paper run. */
export function digitalOnlyLabel(d: DigitalOnly | null): string {
  return d ? ` · ${d}-only art` : '';
}

/**
 * Print runs that could cover a Cycle: complete runs (every member has a Printing) and
 * near-complete runs (exactly one member missing), digital-only Printings included. Runs not
 * released yet last; then complete first; then paper runs before digital-only runs of the same
 * completeness; then all high resolution, no promos, newest.
 */
export function candidateRuns(
  members: readonly MemberRef[],
  files: ReadonlyMap<string, readonly IndexPrinting[]>,
  opts: RunOptions = {},
): CandidateRun[] {
  const byRun = new Map<string, Map<string, IndexPrinting[]>>();
  for (const m of members) {
    for (const p of files.get(m.oracle_id) ?? []) {
      if (!opts.includeCollectors && isCollectors(p)) continue;
      const id = inRunId(p);
      let perMember = byRun.get(id);
      if (!perMember) byRun.set(id, (perMember = new Map()));
      perMember.set(m.oracle_id, [...(perMember.get(m.oracle_id) ?? []), p]);
    }
  }
  const out: CandidateRun[] = [];
  for (const [id, perMember] of byRun) {
    const missing = members.filter((m) => !perMember.has(m.oracle_id));
    if (missing.length > 1 || (missing.length === 1 && members.length < 2)) continue;
    const picks = members.flatMap((m) => {
      const printing = choosePrinting(perMember.get(m.oracle_id) ?? []);
      return printing ? [{ oracle_id: m.oracle_id, name: m.name, printing }] : [];
    });
    const first = picks[0]!.printing;
    const k = runKey(first);
    const highresCount = picks.filter((p) => p.printing.highres).length;
    const released_at = picks.reduce((max, p) => (p.printing.released_at > max ? p.printing.released_at : max), '');
    const digital = digitalOnly(picks.map((p) => p.printing));
    out.push({
      id,
      set: k.set,
      set_name: first.set_name,
      style: k.style,
      frame: k.frame,
      border_color: k.border_color,
      label: runLabel(k) + digitalOnlyLabel(digital),
      digitalOnly: digital,
      complete: missing.length === 0,
      missing: missing.map((m) => ({ oracle_id: m.oracle_id, name: m.name })),
      picks,
      highresCount,
      allHighres: highresCount === picks.length,
      anyPromo: picks.some((p) => p.printing.promo),
      released_at,
      unreleased: !!opts.today && released_at > opts.today,
    });
  }
  return out.sort(
    (a, b) =>
      Number(a.unreleased) - Number(b.unreleased) ||
      Number(b.complete) - Number(a.complete) ||
      Number(a.digitalOnly !== null) - Number(b.digitalOnly !== null) ||
      Number(b.allHighres) - Number(a.allHighres) ||
      Number(a.anyPromo) - Number(b.anyPromo) ||
      b.released_at.localeCompare(a.released_at) ||
      a.id.localeCompare(b.id),
  );
}

export interface CyclePlan {
  /** Members that get a Printing from the run. */
  matched: RunPick[];
  /** Members with no Printing in the run; their Wanted Printing is kept as is. */
  unmatched: MemberRef[];
}

/**
 * Apply one Print run (set and style) to a Cycle. `fixed` is the Printing the Owner picked for
 * one member; it is kept exactly, the others get choosePrinting's pick from the same run.
 */
export function planCycleApply(
  members: readonly MemberRef[],
  files: ReadonlyMap<string, readonly IndexPrinting[]>,
  target: { set: string; style: RunStyle },
  fixed?: { oracle_id: string; printing: IndexPrinting },
): CyclePlan {
  const id = runId(target);
  const plan: CyclePlan = { matched: [], unmatched: [] };
  for (const m of members) {
    const ref = { oracle_id: m.oracle_id, name: m.name };
    if (fixed && fixed.oracle_id === m.oracle_id) {
      plan.matched.push({ ...ref, printing: fixed.printing });
      continue;
    }
    const printing = choosePrinting((files.get(m.oracle_id) ?? []).filter((p) => inRunId(p) === id));
    if (printing) plan.matched.push({ ...ref, printing });
    else plan.unmatched.push(ref);
  }
  return plan;
}
