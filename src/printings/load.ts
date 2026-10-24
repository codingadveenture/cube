// Lazy loading of public/data/printings/<oracle_id>.json, cached in memory for the session. A card
// that came In with an Update has no file (the index covers the cards.json cards only); its
// Printings come from a Scryfall search instead.
import { useEffect, useMemo, useState } from 'react';
import type { IndexPrinting, PrintingsFile } from './types';

const cache = new Map<string, Promise<PrintingsFile>>();

export function printingsUrl(oracleId: string): string {
  return `${import.meta.env.BASE_URL}data/printings/${encodeURIComponent(oracleId)}.json`;
}

export function loadPrintings(oracleId: string): Promise<PrintingsFile> {
  let p = cache.get(oracleId);
  if (!p) {
    p = fetch(printingsUrl(oracleId)).then(async (res) => {
      if (res.status === 404) {
        const { searchPrintings } = await import('../upstream/scryfall');
        return { name: '', oracle_id: oracleId, printings: await searchPrintings(oracleId) };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<PrintingsFile>;
    });
    p.catch(() => cache.delete(oracleId));
    cache.set(oracleId, p);
  }
  return p;
}

/** Drop a cached printings file, so the next load fetches it again. */
export function forgetPrintings(oracleId: string): void {
  cache.delete(oracleId);
}

export type PrintingsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: PrintingsFile };

/** One printings file; bump `attempt` to load it again after an error. */
export function usePrintings(oracleId: string, attempt = 0): PrintingsState {
  const [state, setState] = useState<{ id: string; s: PrintingsState }>({ id: oracleId, s: { status: 'loading' } });
  useEffect(() => {
    let alive = true;
    setState({ id: oracleId, s: { status: 'loading' } });
    loadPrintings(oracleId).then(
      (file) => alive && setState({ id: oracleId, s: { status: 'ready', file } }),
      (e: unknown) =>
        alive && setState({ id: oracleId, s: { status: 'error', message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => {
      alive = false;
    };
  }, [oracleId, attempt]);
  return state.id === oracleId ? state.s : { status: 'loading' };
}

export interface ManyPrintings {
  files: Map<string, IndexPrinting[]>;
  loading: boolean;
  errors: string[];
}

interface ManyState {
  key: string;
  files: Map<string, IndexPrinting[]>;
  done: number;
  errors: string[];
}

/** Several printings files; `files` fills in as they arrive. */
export function useManyPrintings(oracleIds: readonly string[]): ManyPrintings {
  const key = [...new Set(oracleIds)].sort().join(',');
  const [state, setState] = useState<ManyState>({ key: '', files: new Map(), done: 0, errors: [] });
  useEffect(() => {
    let alive = true;
    const ids = key ? key.split(',') : [];
    setState({ key, files: new Map(), done: 0, errors: [] });
    for (const id of ids) {
      loadPrintings(id).then(
        (f) => {
          if (alive) setState((s) => (s.key === key ? { ...s, files: new Map(s.files).set(id, f.printings), done: s.done + 1 } : s));
        },
        (e: unknown) => {
          if (alive) setState((s) => (s.key === key ? { ...s, done: s.done + 1, errors: [...s.errors, `${id}: ${String(e)}`] } : s));
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [key]);
  const total = key ? key.split(',').length : 0;
  return useMemo(
    () =>
      state.key === key
        ? { files: state.files, loading: state.done < total, errors: state.errors }
        : { files: new Map<string, IndexPrinting[]>(), loading: total > 0, errors: [] },
    [state, key, total],
  );
}
