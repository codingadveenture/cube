// Reading cubes/main/meta/upstream and cubes/main/meta/updates as stored. Pure.
import type { Decision, UpdateHistoryEntry, UpstreamMeta } from '../store/types';

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function toDecision(v: unknown): Decision | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (d.status !== 'accepted' && d.status !== 'rejected' && d.status !== 'later') return null;
  return {
    status: d.status,
    side: d.side === 'cut' ? 'cut' : 'add',
    at: typeof d.at === 'string' ? d.at : '',
    note: typeof d.note === 'string' ? d.note : '',
    applied_at: typeof d.applied_at === 'string' ? d.applied_at : null,
  };
}

export function toUpstreamMeta(raw: Record<string, unknown> | null): UpstreamMeta {
  const decisions: Record<string, Decision> = {};
  const rawDecisions = raw?.decisions;
  if (rawDecisions && typeof rawDecisions === 'object') {
    for (const [name, v] of Object.entries(rawDecisions as Record<string, unknown>)) {
      const d = toDecision(v);
      if (d) decisions[name] = d;
    }
  }
  return {
    fetched_at: typeof raw?.fetched_at === 'string' ? raw.fetched_at : null,
    list_names: strings(raw?.list_names),
    upstream_names: strings(raw?.upstream_names),
    decisions,
  };
}

/** The applied Updates, newest first. */
export function toUpdateHistory(raw: Record<string, unknown> | null): UpdateHistoryEntry[] {
  const list = Array.isArray(raw?.history) ? (raw.history as unknown[]) : [];
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      date: typeof e.date === 'string' ? e.date : '',
      at: typeof e.at === 'string' ? e.at : '',
      in: strings(e.in),
      out: strings(e.out),
      source: e.source === 'manual' ? ('manual' as const) : ('upstream' as const),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}
