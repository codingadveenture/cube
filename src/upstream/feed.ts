// The Upstream feed: what Upstream (the MTGO Vintage Cube) would change in the List, after the
// group's sticky Winner's Picks and Bans. Pure: no React, no storage, no network.
import { normalizeName } from '../lib/normalize';
import type { Decision, DecisionStatus, LogEntry, Overrides } from '../store/types';

export interface StickySets {
  /** Winner's Picks and pending adds: they stay in the List even when Upstream cuts them. */
  adds: string[];
  /** Bans: they stay out even when Upstream adds them. */
  bans: string[];
}

function uniqueNames(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const k = normalizeName(name);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/** adds = overrides.adds + Winner's Picks in the Log; bans = overrides.bans + Bans in the Log. */
export function stickySets(overrides: Overrides, log: readonly LogEntry[]): StickySets {
  const picks = log.filter((e) => e.type === 'winner_pick' && e.card_name).map((e) => e.card_name!);
  const bans = log.filter((e) => e.type === 'ban' && e.card_name).map((e) => e.card_name!);
  return { adds: uniqueNames([...overrides.adds, ...picks]), bans: uniqueNames([...overrides.bans, ...bans]) };
}

export type FeedSide = 'add' | 'cut';

export interface FeedItem {
  name: string;
  /** oracle_id when known, else "n:" + normalised name. */
  key: string;
  side: FeedSide;
  /** A sticky add (a Winner's Pick) that is not on the List yet. */
  sticky: boolean;
  decision: Decision | null;
}

export interface FeedInput {
  list: readonly string[];
  upstream: readonly string[];
  sticky: StickySets;
  keyOf: (name: string) => string;
  decisions?: Readonly<Record<string, Decision>>;
}

export interface Feed {
  adds: FeedItem[];
  cuts: FeedItem[];
  /** How many cards the proposed List has. */
  proposed: number;
  /** Sticky names (Winner's Picks, Bans) that match no oracle_id and no List or Upstream name. */
  unresolvedSticky: string[];
}

/**
 * A looser comparison key for sticky names typed into the Log: normalizeName without quotes and
 * punctuation, so the Ban "Name Sticker Goblin" matches CubeCobra's '"Name Sticker" Goblin'.
 */
export function looseName(s: string): string {
  return normalizeName(s)
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function byKey(names: readonly string[], keyOf: (n: string) => string): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of names) {
    const k = keyOf(n);
    if (!m.has(k)) m.set(k, n);
  }
  return m;
}

/**
 * Proposed = (Upstream minus Bans) plus sticky adds. Upstream adds = proposed minus the List;
 * Upstream cuts = the List minus proposed (so a sticky add is never cut). Names are compared by
 * keyOf. Each item carries the decision stored under its name (or any name with the same key) for
 * the same side.
 */
export function computeFeed(input: FeedInput): Feed {
  const { keyOf } = input;
  const list = byKey(input.list, keyOf);
  // A sticky name resolves by its oracle_id; failing that, by a loose match on a List or Upstream name.
  const loose = new Map<string, string>();
  for (const n of [...input.list, ...input.upstream]) {
    const l = looseName(n);
    if (l && !loose.has(l)) loose.set(l, keyOf(n));
  }
  const unresolved = new Set<string>();
  const stickyKey = (n: string): string => {
    const k = keyOf(n);
    if (!k.startsWith('n:')) return k;
    const m = loose.get(looseName(n));
    if (m) return m;
    unresolved.add(n.trim());
    return k;
  };
  const bans = new Set(input.sticky.bans.map(stickyKey));
  const stickyAdds = byKey(input.sticky.adds, stickyKey);
  const proposed = new Map<string, string>();
  for (const [k, n] of byKey(input.upstream, keyOf)) if (!bans.has(k)) proposed.set(k, n);
  for (const [k, n] of stickyAdds) if (!proposed.has(k)) proposed.set(k, n);

  const decided = new Map<string, Decision>();
  for (const [name, d] of Object.entries(input.decisions ?? {})) {
    if (d && typeof d === 'object') decided.set(`${d.side}|${keyOf(name)}`, d);
  }
  const item = (name: string, key: string, side: FeedSide): FeedItem => ({
    name,
    key,
    side,
    sticky: side === 'add' && stickyAdds.has(key),
    decision: decided.get(`${side}|${key}`) ?? null,
  });
  const byName = (a: FeedItem, b: FeedItem) => a.name.localeCompare(b.name, 'en');
  const adds = [...proposed].filter(([k]) => !list.has(k)).map(([k, n]) => item(n, k, 'add')).sort(byName);
  const cuts = [...list].filter(([k]) => !proposed.has(k)).map(([k, n]) => item(n, k, 'cut')).sort(byName);
  return { adds, cuts, proposed: proposed.size, unresolvedSticky: [...unresolved].sort((a, b) => a.localeCompare(b, 'en')) };
}

/**
 * The names of stored decisions whose item is no longer in the feed (same side and key). They are
 * dropped when a Refresh is stored, so a decision from an earlier cycle never attaches to a later,
 * unrelated change of the same card, and the decisions map stays bounded.
 */
export function staleDecisions(decisions: Readonly<Record<string, Decision>>, feed: Pick<Feed, 'adds' | 'cuts'>, keyOf: (name: string) => string): string[] {
  const live = new Set([...feed.adds, ...feed.cuts].map((i) => `${i.side}|${i.key}`));
  return Object.entries(decisions)
    .filter(([name, d]) => !live.has(`${d.side}|${keyOf(name)}`))
    .map(([name]) => name);
}

/**
 * What a built preview depends on: the accepted adds and cuts (side, key, sticky) and the manual
 * names. When this changes after a build, the preview is stale and must not be applied.
 */
export function previewBasis(adds: readonly FeedItem[], cuts: readonly FeedItem[], manual: readonly string[]): string {
  return [
    ...[...adds, ...cuts].map((i) => `${i.side}|${i.key}|${i.sticky ? 's' : ''}`),
    ...manual.map((n) => `manual|${normalizeName(n)}`),
  ]
    .sort()
    .join('\n');
}

export type FeedGroup = 'open' | 'accepted' | 'applied' | 'later' | 'rejected';

export function groupOf(item: FeedItem): FeedGroup {
  const d = item.decision;
  if (!d) return 'open';
  if (d.applied_at) return 'applied';
  return d.status === 'accepted' ? 'accepted' : d.status;
}

export function groupFeed(items: readonly FeedItem[]): Record<FeedGroup, FeedItem[]> {
  const out: Record<FeedGroup, FeedItem[]> = { open: [], accepted: [], applied: [], later: [], rejected: [] };
  for (const i of items) out[groupOf(i)].push(i);
  return out;
}

/** Decisions to store for the given items, keyed by item name. */
export function decide(items: readonly FeedItem[], status: DecisionStatus, at: string, note = ''): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const i of items) out[i.name] = { status, side: i.side, at, note, applied_at: null };
  return out;
}

/** "Accept all remaining": every open item of one side. */
export function acceptRemaining(items: readonly FeedItem[], at: string): Record<string, Decision> {
  return decide(
    items.filter((i) => groupOf(i) === 'open'),
    'accepted',
    at,
  );
}

/** The decisions of the items that went into an applied Update, marked applied. */
export function markApplied(items: readonly FeedItem[], at: string): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const i of items) {
    if (!i.decision || i.decision.status !== 'accepted' || i.decision.applied_at) continue;
    out[i.name] = { ...i.decision, applied_at: at };
  }
  return out;
}
