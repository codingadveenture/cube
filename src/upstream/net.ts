// The two lists the Update page reads from the browser. The List comes from CubeCobra (public GETs
// with CORS and no auth, research/cubecobra.md). The Upstream comes from Scryfall's cube search,
// which lists the Arena Powered Cube as one card object per Printing, 175 a page, at the
// /cards/search rate limit (research/scryfall.md). CubeCobra also receives the CSV export.
import type { CubeJson, UpstreamPrinting } from './cubecobra';
import { uniqueNames } from './feed';
import { parseCubelist } from './names';
import { searchGap, type ScryfallCard } from './scryfall';

export const LIST_ID = 'MTGVintageCube';
/** Where the Upstream is published; `cube` is the slug Scryfall's cube: operator takes. */
export const UPSTREAM = { source: 'scryfall' as const, cube: 'apcube', label: 'Arena Powered Cube', url: 'https://scryfall.com/cubes/apcube' };
const BASE = 'https://cubecobra.com/cube/api';
const SCRYFALL = 'https://api.scryfall.com';

/** A plain message for an answer that is not ok. Retry-After is in seconds when numeric. */
function httpError(who: string, status: number, retryAfter: string | null): string {
  if (status === 429) {
    const s = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    return s !== null && s > 0
      ? `${who} says too many requests; try again in ${s} ${s === 1 ? 'second' : 'seconds'}.`
      : `${who} says too many requests; try again in a minute.`;
  }
  return `${who} is not answering (HTTP ${status}). Try again later.`;
}

export function cubecobraHttpError(status: number, retryAfter: string | null): string {
  return httpError('CubeCobra', status, retryAfter);
}

export function scryfallHttpError(status: number, retryAfter: string | null): string {
  return httpError('Scryfall', status, retryAfter);
}

export const NO_CONNECTION = 'No connection to CubeCobra. Check the network and try again.';
export const NO_SCRYFALL = 'No connection to Scryfall. Check the network and try again.';

/** fetch, with a network failure (TypeError) turned into `offline` and the rest left to the caller. */
async function request(url: string, offline: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(offline);
    throw e;
  }
}

// --- The List, on CubeCobra --------------------------------------------------------------------

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await request(url, NO_CONNECTION, { signal });
  if (!res.ok) throw new Error(cubecobraHttpError(res.status, res.headers.get('Retry-After')));
  return res;
}

export async function fetchCubelist(id: string, signal?: AbortSignal): Promise<string[]> {
  const res = await get(`${BASE}/cubelist/${encodeURIComponent(id)}`, signal);
  const type = res.headers.get('Content-Type') ?? '';
  // A maintenance or error page answers 200 with HTML; it is not a card list.
  if (type && !type.includes('text/plain')) throw new Error(`CubeCobra did not send a card list for ${id} (it sent ${type.split(';')[0]}); nothing was saved.`);
  return parseCubelist(await res.text());
}

/** The List's cubeJSON (about 1.6 MB), fetched fresh each time: the CSV export reads its basics board. */
export async function fetchListJson(signal?: AbortSignal): Promise<CubeJson> {
  const res = await get(`${BASE}/cubeJSON/${LIST_ID}`, signal);
  return (await res.json()) as CubeJson;
}

// --- The Upstream, on Scryfall -----------------------------------------------------------------

interface SearchPage {
  data?: ScryfallCard[];
  has_more?: boolean;
  next_page?: string;
}

export function cubeSearchUrl(cube: string): string {
  return `${SCRYFALL}/cards/search?q=${encodeURIComponent(`cube:${cube}`)}&unique=prints&order=name`;
}

/**
 * A card object of the cube search as the Upstream's Printing of that card. A two-faced card has
 * its images on the faces only. Scryfall's API has no Tagger tags, so cycle_tags stays empty.
 */
export function upstreamPrintingOf(sc: ScryfallCard): UpstreamPrinting {
  const front = sc.card_faces?.[0];
  return {
    oracle_id: sc.oracle_id ?? front?.oracle_id ?? null,
    name: sc.name,
    scryfall_id: sc.id,
    set: sc.set.toLowerCase(),
    collector_number: sc.collector_number,
    image_normal: sc.image_uris?.normal ?? front?.image_uris?.normal ?? null,
    cycle_tags: [],
  };
}

/** One page of the cube search, a search gap after the previous Scryfall search. */
async function cubePage(url: string, signal?: AbortSignal): Promise<SearchPage> {
  await searchGap(signal);
  const res = await request(url, NO_SCRYFALL, { headers: { Accept: 'application/json' }, signal });
  if (res.status === 404) {
    // Scryfall answers a search that finds nothing with an error object, not an empty list.
    const body = (await res.json().catch(() => null)) as { object?: string } | null;
    if (body?.object === 'error') throw new Error(`Scryfall has no cube called ${UPSTREAM.cube}.`);
  }
  if (!res.ok) throw new Error(scryfallHttpError(res.status, res.headers.get('Retry-After')));
  return (await res.json()) as SearchPage;
}

/** Every card of the Upstream as Scryfall lists it, page after page. */
async function searchUpstream(signal?: AbortSignal): Promise<UpstreamPrinting[]> {
  const out: UpstreamPrinting[] = [];
  let next: string | null = cubeSearchUrl(UPSTREAM.cube);
  while (next) {
    const page: SearchPage = await cubePage(next, signal);
    for (const sc of page.data ?? []) if (sc && sc.id) out.push(upstreamPrintingOf(sc));
    next = page.has_more && page.next_page ? page.next_page : null;
  }
  return out;
}

/** The names the feed compares: one per card, in the spelling Scryfall gives ("Fire // Ice", as CubeCobra's cubelist). */
export function upstreamNames(printings: readonly UpstreamPrinting[]): string[] {
  return uniqueNames(printings.map((p) => p.name));
}

let upstream: Promise<UpstreamPrinting[]> | null = null;

/** The search kept for the session; a failed one is forgotten so the next call asks again. */
function share(search: Promise<UpstreamPrinting[]>): Promise<UpstreamPrinting[]> {
  upstream = search;
  search.catch(() => {
    if (upstream === search) upstream = null;
  });
  return search;
}

/** The Upstream's names, read anew (a Refresh is a read); the Printings of that same search are kept for the session. */
export async function fetchUpstreamNames(signal?: AbortSignal): Promise<string[]> {
  return upstreamNames(await share(searchUpstream(signal)));
}

/** The Upstream's Printings: those of this session's last Refresh, else one search now. Only an Update build asks. */
export function fetchUpstreamPrintings(signal?: AbortSignal): Promise<UpstreamPrinting[]> {
  return upstream ?? share(searchUpstream(signal));
}
