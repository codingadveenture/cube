// Search by name: the catalog's cards (art-catalog.json) and their Printings, for a slip the
// recogniser got wrong. Used by the camera review and by the photo review on the Scan tab.
import { useEffect, useMemo, useState } from 'react';
import { normalizeName } from '../../lib/normalize';
import type { PrintingRef } from '../../scan/camera/shots';
import { catalogUrls, parseCatalogJson, type CatalogJson } from '../../scan/vision/catalog';
import type { CatalogEntry } from '../../scan/vision/types';
import { ArtImage, setNumber } from './parts';

interface CatalogCard {
  oracle_id: string;
  name: string;
  key: string;
  printings: CatalogEntry[];
}

let catalogCards: Promise<CatalogCard[]> | null = null;

/** The catalog's cards and their Printings (art-catalog.json only; the vectors stay in the worker). */
function loadCatalogCards(): Promise<CatalogCard[]> {
  if (!catalogCards) {
    catalogCards = fetch(catalogUrls().json)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CatalogJson>;
      })
      .then((json) => {
        const byCard = new Map<string, CatalogCard>();
        for (const e of parseCatalogJson(json)) {
          let c = byCard.get(e.oracle_id);
          if (!c) {
            c = { oracle_id: e.oracle_id, name: e.name, key: normalizeName(e.name), printings: [] };
            byCard.set(e.oracle_id, c);
          }
          // One entry per Printing, the front face when there is one.
          const i = c.printings.findIndex((p) => p.scryfall_id === e.scryfall_id);
          if (i < 0) c.printings.push(e);
          else if (e.face === 'front') c.printings[i] = e;
        }
        return [...byCard.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
    catalogCards.catch(() => {
      catalogCards = null;
    });
  }
  return catalogCards;
}

export function NameSearch({ onPick }: { onPick: (c: PrintingRef) => void }) {
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [card, setCard] = useState<CatalogCard | null>(null);
  useEffect(() => {
    let live = true;
    loadCatalogCards()
      .then((c) => live && setCards(c))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const key = normalizeName(q);
  const hits = useMemo(() => {
    if (!cards || key.length < 2) return [];
    const starts = cards.filter((c) => c.key.startsWith(key));
    const inside = cards.filter((c) => !c.key.startsWith(key) && c.key.includes(key));
    return [...starts, ...inside].slice(0, 12);
  }, [cards, key]);

  if (error) return <p className="status error">Could not load the card names ({error}).</p>;
  if (!cards) return <p className="status">Loading card names…</p>;
  if (card) {
    return (
      <div className="name-search">
        <button type="button" className="link" onClick={() => setCard(null)}>
          Other names
        </button>
        <p>
          Printings of <strong>{card.name}</strong>:
        </p>
        <ul className="printing-pick">
          {card.printings.map((p) => (
            <li key={p.scryfall_id}>
              <button type="button" className="candidate" onClick={() => onPick(p)}>
                <ArtImage c={p} className="candidate-art" />
                <span className="muted num">{setNumber(p)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="name-search">
      <label>
        <span className="visually-hidden">Card name</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Card name" autoFocus />
      </label>
      {key.length >= 2 && hits.length === 0 && <p className="status">No card by that name in the catalog.</p>}
      <ul className="name-hits">
        {hits.map((c) => (
          <li key={c.oracle_id}>
            <button type="button" className="link" onClick={() => (c.printings.length === 1 ? onPick(c.printings[0]!) : setCard(c))}>
              {c.name}
            </button>
            <span className="muted num"> {c.printings.length === 1 ? setNumber(c.printings[0]!) : `${c.printings.length} printings`}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
