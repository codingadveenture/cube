// Per-device Scan preferences: which shared piles are ticked for the diff, which local
// piles this device has shared (local pile id -> shared pile id), and which of those still have
// photos to upload (local pile id -> shared pile id), so a stopped upload can be resumed, with the
// photo plan of each (which shot goes in which chunk, and how), so the resume writes exactly that.
import { parseSharedShot } from './shotChunks';
import type { SharedShot } from './types';

const INCLUDED_KEY = 'cube.scan-included.v1';
const SHARED_FROM_KEY = 'cube.scan-shared-from.v1';
const PHOTOS_PENDING_KEY = 'cube.scan-photos-pending.v1';
const PHOTO_PLANS_KEY = 'cube.scan-photo-plans.v1';

/** The chunks of a shared camera pile as planned when it was shared: the shots without thumbnails. */
export type PhotoPlan = Omit<SharedShot, 'thumb'>[][];

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A convenience only.
  }
}

export function loadIncluded(): string[] {
  const v = read<unknown>(INCLUDED_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function saveIncluded(ids: string[]): void {
  write(INCLUDED_KEY, ids);
}

export function loadSharedFrom(): Record<string, string> {
  const v = read<unknown>(SHARED_FROM_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

export function saveSharedFrom(map: Record<string, string>): void {
  write(SHARED_FROM_KEY, map);
}

function readMap(key: string): Record<string, string> {
  const v = read<unknown>(key, {});
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
}

/** Local camera piles whose photos have not all reached the shared pile yet. */
export function loadPhotosPending(): Record<string, string> {
  return readMap(PHOTOS_PENDING_KEY);
}

export function savePhotosPending(map: Record<string, string>): void {
  write(PHOTOS_PENDING_KEY, map);
}

/** Records that local pile `localId` was shared as `sharedId` (read, change, write: other views may have changed it). */
export function recordSharedFrom(localId: string, sharedId: string): void {
  saveSharedFrom({ ...loadSharedFrom(), [localId]: sharedId });
}

/** Clearing the pending upload (sharedId null) also forgets its photo plan. */
export function setPhotosPending(localId: string, sharedId: string | null): void {
  const m = loadPhotosPending();
  if (sharedId) m[localId] = sharedId;
  else delete m[localId];
  savePhotosPending(m);
  if (!sharedId) savePhotoPlan(localId, null);
}

function readPlans(): Record<string, unknown> {
  const v = read<unknown>(PHOTO_PLANS_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The photo plan of local pile `localId`, or null when none was kept (or it does not parse). */
export function loadPhotoPlan(localId: string): PhotoPlan | null {
  const v = readPlans()[localId];
  if (!Array.isArray(v) || v.length === 0) return null;
  const plan: PhotoPlan = [];
  for (const chunk of v) {
    if (!Array.isArray(chunk) || chunk.length === 0) return null;
    const part: Omit<SharedShot, 'thumb'>[] = [];
    for (const x of chunk) {
      const s = parseSharedShot(x && typeof x === 'object' ? { ...(x as object), thumb: '' } : null);
      if (!s) return null;
      const { thumb: _thumb, ...rest } = s;
      part.push(rest);
    }
    plan.push(part);
  }
  return plan;
}

/** Keeps (or with null forgets) the photo plan of local pile `localId`. A full storage just keeps none. */
export function savePhotoPlan(localId: string, plan: PhotoPlan | null): void {
  const m = readPlans();
  if (plan) m[localId] = plan;
  else if (localId in m) delete m[localId];
  else return;
  write(PHOTO_PLANS_KEY, m);
}
