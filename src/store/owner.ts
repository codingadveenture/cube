// Owner detection from the config/owner document.
import type { OwnerConfig } from './types';

/** The Owner from the raw config/owner data, or null when missing or malformed. */
export function ownerFromDoc(data: unknown): OwnerConfig | null {
  if (!data || typeof data !== 'object') return null;
  const uid = (data as { uid?: unknown }).uid;
  return typeof uid === 'string' && uid.length > 0 ? { uid } : null;
}

export interface OwnerState {
  /** True once config/owner was read from the server (not only from the local cache). */
  loaded: boolean;
  config: OwnerConfig | null;
}

/**
 * The Owner state after a config/owner snapshot. A snapshot served only from the cache shows
 * its Owner but does not count as loaded, so 'Nobody is the Owner yet' never rests on a stale
 * or empty cache. A failed subscription leaves the state as it was.
 */
export function nextOwnerState(prev: OwnerState, snap: { data: OwnerConfig | null; fromCache: boolean }): OwnerState {
  return { loaded: prev.loaded || !snap.fromCache, config: snap.data };
}

export function isOwnerUid(uid: string | null | undefined, owner: OwnerConfig | null): boolean {
  return !!uid && !!owner && owner.uid === uid;
}
