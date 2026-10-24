// Owner detection from the config/owner document.
import type { OwnerConfig } from './types';

/** The Owner from the raw config/owner data, or null when missing or malformed. */
export function ownerFromDoc(data: unknown): OwnerConfig | null {
  if (!data || typeof data !== 'object') return null;
  const uid = (data as { uid?: unknown }).uid;
  return typeof uid === 'string' && uid.length > 0 ? { uid } : null;
}

export function isOwnerUid(uid: string | null | undefined, owner: OwnerConfig | null): boolean {
  return !!uid && !!owner && owner.uid === uid;
}
