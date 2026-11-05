// Comparing card names across the List, Upstream and the Cube. A name is compared by its
// oracle_id when one is known for it, else by normalizeName. This handles renames such as the
// Through the Omenpaths cards: the List says "Ademi of the Silkchutes" while Scryfall (and so
// possibly Upstream) says "Spectacular Spider-Man"; both names belong to one oracle_id.
import { normalizeName } from '../lib/normalize';
import type { Card } from '../types';

export type NameIndex = ReadonlyMap<string, string>;

/**
 * normalizeName -> oracle_id for every name a card goes by: its name, front face, and the names on
 * its In-box, Wanted and retired Printings, plus `extra` pairs (name, oracle_id) such as Scryfall
 * answers. A card's own name wins over another card's Printing name.
 */
export function nameIndex(cards: readonly Card[], extra: Iterable<readonly [string, string]> = []): Map<string, string> {
  const map = new Map<string, string>();
  const put = (name: string | null | undefined, id: string) => {
    if (!name) return;
    const k = normalizeName(name);
    if (k) map.set(k, id);
  };
  for (const [name, id] of extra) put(name, id);
  for (const c of cards) {
    put(c.in_box?.name, c.oracle_id);
    put(c.wanted.name, c.oracle_id);
    put(c.retired_printing?.name, c.oracle_id);
  }
  for (const c of cards) {
    put(c.front_name, c.oracle_id);
    put(c.name, c.oracle_id);
  }
  return map;
}

/** The comparison key of a name: its oracle_id when known, else "n:" + the normalised name. */
export function keyOf(index: NameIndex, name: string): string {
  const n = normalizeName(name);
  return index.get(n) ?? `n:${n}`;
}

/** Parse a cubelist response: one name per line, blank lines dropped. */
export function parseCubelist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Names from a text box: one per line, an optional leading count ("1 ", "2x ") dropped, duplicates removed. */
export function parseNameLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const name = raw.replace(/^\s*\d+x?\s+/i, '').trim();
    const k = normalizeName(name);
    if (!name || seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

/** A sane cubelist has this many names; anything outside is an outage page or a truncated answer. */
export const LIST_MIN = 300;
export const LIST_MAX = 600;

/**
 * Why a fetched List and Upstream pair must not be saved or used, or null when both look like a
 * Vintage Cube (between LIST_MIN and LIST_MAX names each).
 */
export function snapshotProblem(listCount: number, upstreamCount: number, listId: string, upstreamId: string): string | null {
  const bad = (n: number) => n < LIST_MIN || n > LIST_MAX;
  const parts: string[] = [];
  if (bad(listCount)) parts.push(`${listCount} names for ${listId}`);
  if (bad(upstreamCount)) parts.push(`${upstreamCount} names for ${upstreamId}`);
  if (parts.length === 0) return null;
  return `CubeCobra returned ${parts.join(' and ')}, which does not look like a whole cube (expected ${LIST_MIN} to ${LIST_MAX}); not used.`;
}
