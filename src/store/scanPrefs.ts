// Per-device Scan preferences: which shared piles are ticked for the diff, and which local
// piles this device has shared (local pile id -> shared pile id).
const INCLUDED_KEY = 'cube.scan-included.v1';
const SHARED_FROM_KEY = 'cube.scan-shared-from.v1';

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
