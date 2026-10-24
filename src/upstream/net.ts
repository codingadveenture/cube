// CubeCobra reads from the browser: public GETs with CORS and no auth (research/cubecobra.md).
import { parseCubelist } from './names';
import type { CubeJson } from './cubecobra';

export const LIST_ID = 'MTGVintageCube';
export const UPSTREAM_ID = 'modovintage';
const BASE = 'https://cubecobra.com/cube/api';

/** A plain message for a CubeCobra answer that is not ok. Retry-After is in seconds when numeric. */
export function cubecobraHttpError(status: number, retryAfter: string | null): string {
  if (status === 429) {
    const s = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    return s !== null && s > 0
      ? `CubeCobra says too many requests; try again in ${s} ${s === 1 ? 'second' : 'seconds'}.`
      : 'CubeCobra says too many requests; try again in a minute.';
  }
  return `CubeCobra is not answering (HTTP ${status}). Try again later.`;
}

export const NO_CONNECTION = 'No connection to CubeCobra. Check the network and try again.';

/** fetch, with a network failure (TypeError) and a non-ok answer turned into plain messages. */
async function get(url: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof TypeError) throw new Error(NO_CONNECTION);
    throw e;
  }
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

let upstreamJson: Promise<CubeJson> | null = null;

/** Upstream's cubeJSON (about 1.6 MB), fetched once per session and only when an Update is built. */
export function fetchUpstreamJson(signal?: AbortSignal): Promise<CubeJson> {
  upstreamJson ??= get(`${BASE}/cubeJSON/${UPSTREAM_ID}`, signal).then((res) => res.json() as Promise<CubeJson>);
  upstreamJson.catch(() => {
    upstreamJson = null;
  });
  return upstreamJson;
}
