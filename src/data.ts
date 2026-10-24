import { useEffect, useState } from 'react';
import type { CardsFile } from './types';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: CardsFile };

let pending: Promise<CardsFile> | null = null;

function loadCards(): Promise<CardsFile> {
  pending ??= fetch(`${import.meta.env.BASE_URL}data/cards.json`).then((res) => {
    if (!res.ok) throw new Error(`cards.json: HTTP ${res.status}`);
    return res.json() as Promise<CardsFile>;
  });
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

export function useCards(): State {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    loadCards().then(
      (data) => alive && setState({ status: 'ready', data }),
      (e: unknown) => alive && setState({ status: 'error', message: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
