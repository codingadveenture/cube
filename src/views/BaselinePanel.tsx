// Owner: write the card state documents from cards.json (only the ones that do not exist yet).
import { useState } from 'react';
import type { Card } from '../types';
import { baselineDocs } from '../store/baseline';
import { useStore } from '../store/context';
import type { CardState } from '../store/types';

export function BaselinePanel({ base, existing, missing }: { base: Card[]; existing: ReadonlyMap<string, CardState>; missing: number }) {
  const { store, save } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!store) return null;
  const empty = existing.size === 0;
  return (
    <section className="panel">
      <h2>Import baseline</h2>
      <p className="muted">
        {empty
          ? `The shared card state is empty, so the Cube shows the built-in card data. Import it once to start keeping the In-box Printings, Wanted Printings and Art flags here (${missing} cards).`
          : `${missing} cards of the built-in card data have no shared state yet. Importing writes only those; nothing already stored is changed.`}
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          if (!navigator.onLine) {
            setError('Import baseline needs a connection to the server. Try again when online.');
            return;
          }
          setError(null);
          setBusy(true);
          // The store checks the server again and skips every doc that already exists there.
          const docs = baselineDocs(base, new Set(existing.keys()), new Date().toISOString());
          void save(() => store.importBaseline(docs), 'Baseline imported.').finally(() => setBusy(false));
        }}
      >
        {busy ? 'Importing…' : 'Import baseline'}
      </button>
      {error && <p className="status error">{error}</p>}
    </section>
  );
}
