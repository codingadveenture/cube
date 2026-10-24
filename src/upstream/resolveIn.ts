// Resolving the In and Out names of an Update to cards, facts and Wanted Printings. The default
// rule runs on a Scryfall search of each new card's Printings; when the search fails, the Printing
// Upstream uses (from its cubeJSON, fetched once and only here) is taken instead.
import { normalizeName } from '../lib/normalize';
import { defaultPrinting, todayIso } from '../printings/defaultRule';
import { wantedFromPrinting } from '../printings/wanted';
import type { WantedState } from '../store/types';
import type { Card } from '../types';
import { upstreamPrintings, type UpstreamPrinting } from './cubecobra';
import { keyOf, type NameIndex } from './names';
import { fetchUpstreamJson } from './net';
import { fetchFacts, isAborted, searchPrintings, type Progress } from './scryfall';
import { inAction, type InAction, type InCard } from './update';

export interface ResolvedIn extends InCard {
  action: InAction;
  /** The image of the Printing that will be printed (or is kept). */
  image: string | null;
  /** "SET 123", for the preview. */
  printing: string;
  error: string | null;
}

export interface ResolvedOut {
  name: string;
  card: Card | null;
  error: string | null;
}

/** The Wanted Printing taken from Upstream's cubeJSON. */
export function upstreamWanted(p: UpstreamPrinting, name: string): WantedState {
  return {
    scryfall_id: p.scryfall_id,
    set: p.set,
    collector_number: p.collector_number,
    illustration_id: null,
    name,
    reason: 'upstream-pick',
    image_normal: p.image_normal,
  };
}

/** Upstream's Printing of a card: by oracle_id, else by name. */
export function findUpstream(printings: readonly UpstreamPrinting[], oracleId: string, name: string): UpstreamPrinting | null {
  const n = normalizeName(name);
  return printings.find((p) => p.oracle_id === oracleId) ?? printings.find((p) => normalizeName(p.name) === n) ?? null;
}

export function resolveOuts(names: readonly string[], cards: readonly Card[], index: NameIndex): ResolvedOut[] {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return names.map((name) => {
    const card = byId.get(keyOf(index, name)) ?? null;
    if (!card) return { name, card: null, error: 'Not in the Cube record, so there is nothing to take out here.' };
    if (!card.in_list) return { name, card, error: 'Already off the List.' };
    return { name, card, error: null };
  });
}

const label = (w: { set: string; collector_number: string }) => `${w.set.toUpperCase()} ${w.collector_number}`;

export interface ResolveOptions {
  cards: readonly Card[];
  index: NameIndex;
  signal?: AbortSignal;
  onProgress?: (p: Progress & { what: string }) => void;
}

export async function resolveIns(items: readonly { name: string; sticky: boolean }[], o: ResolveOptions): Promise<ResolvedIn[]> {
  const byId = new Map(o.cards.map((c) => [c.oracle_id, c]));
  const known = (c: Card, name: string, sticky: boolean): ResolvedIn => {
    const action = inAction(c);
    return {
      name,
      oracle_id: c.oracle_id,
      sticky,
      facts: null,
      wanted: null,
      cycle_tags: c.oracle_cycle_tags,
      action,
      image: (c.in_box ?? c.wanted).image_normal,
      printing: label(c.in_box ?? c.wanted),
      error: null,
    };
  };
  const out: (ResolvedIn | null)[] = items.map((it) => {
    const c = byId.get(keyOf(o.index, it.name));
    return c ? known(c, it.name, it.sticky) : null;
  });
  const todo = items.map((it, i) => ({ ...it, i })).filter((it) => !out[it.i]);
  if (todo.length === 0) return out as ResolvedIn[];

  o.onProgress?.({ done: 0, total: todo.length, what: 'Card facts' });
  const facts = await fetchFacts(
    todo.map((t) => t.name),
    (p) => o.onProgress?.({ ...p, what: 'Card facts' }),
    o.signal,
  );
  let upstream: UpstreamPrinting[] | null = null;
  let upstreamError: string | null = null;
  try {
    upstream = upstreamPrintings(await fetchUpstreamJson(o.signal));
  } catch (e) {
    if (isAborted(e)) throw e;
    upstreamError = e instanceof Error ? e.message : String(e);
  }
  const today = todayIso();
  let done = 0;
  for (const t of todo) {
    o.onProgress?.({ done, total: todo.length, what: `Printings of ${t.name}` });
    const hit = facts.get(t.name) ?? null;
    const base: ResolvedIn = {
      name: t.name,
      oracle_id: hit?.oracle_id ?? '',
      sticky: t.sticky,
      facts: hit?.facts ?? null,
      wanted: null,
      cycle_tags: [],
      action: 'new',
      image: null,
      printing: '',
      error: null,
    };
    if (!hit) {
      out[t.i] = { ...base, error: 'Scryfall does not know this name. Check the spelling.' };
      done++;
      continue;
    }
    // A name the index did not know can still be a card the Cube has (another spelling or a rename).
    const already = byId.get(hit.oracle_id);
    if (already) {
      out[t.i] = known(already, t.name, t.sticky);
      done++;
      continue;
    }
    const up = upstream ? findUpstream(upstream, hit.oracle_id, hit.facts.name) : null;
    let wanted: WantedState | null = null;
    let searchError: string | null = null;
    try {
      const printings = await searchPrintings(hit.oracle_id, o.signal);
      const p = defaultPrinting(printings, today);
      if (p) wanted = wantedFromPrinting(p, hit.facts.name, 'default-rule');
      else searchError = 'no Printing qualifies for the default rule';
    } catch (e) {
      if (isAborted(e)) throw e;
      searchError = e instanceof Error ? e.message : String(e);
    }
    if (!wanted && up) wanted = upstreamWanted(up, hit.facts.name);
    done++;
    if (!wanted) {
      out[t.i] = {
        ...base,
        error: `No Printing found (${searchError ?? 'search failed'}${upstreamError ? `; Upstream: ${upstreamError}` : '; not in Upstream'}).`,
      };
      continue;
    }
    out[t.i] = {
      ...base,
      wanted,
      cycle_tags: up?.cycle_tags ?? [],
      image: wanted.image_normal ?? hit.facts.image_normal,
      printing: label(wanted),
    };
  }
  o.onProgress?.({ done, total: todo.length, what: 'Done' });
  return out as ResolvedIn[];
}
