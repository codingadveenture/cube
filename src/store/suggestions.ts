// Ordering of the Suggestions list: open first, then accepted, then rejected; newest first within.
import type { Suggestion } from './types';

const RANK = { open: 0, accepted: 1, rejected: 2 } as const;

export function sortSuggestions(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || b.createdAt.localeCompare(a.createdAt));
}
