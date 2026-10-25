// Review of a camera session: the shots with their photos, a detail view to pick the right
// Printing, skip or retake a slip, and the export to the Scan session as a Pile.
import { useEffect, useMemo, useState } from 'react';
import { normalizeName } from '../../lib/normalize';
import { addShotsToScan } from '../../scan/camera/exportPile';
import type { CameraSessionMeta } from '../../scan/camera/settings';
import {
  confirmShot,
  defaultPileLabel,
  filterShots,
  needsReview,
  nextToReview,
  shotCounts,
  shotsToRows,
  skipShot,
  type PrintingRef,
  type Shot,
  type ShotFilter,
} from '../../scan/camera/shots';
import { catalogUrls, parseCatalogJson, type CatalogJson } from '../../scan/vision/catalog';
import type { CatalogEntry } from '../../scan/vision/types';
import { ArtImage, score, setNumber, ShotPhoto, StatusPill } from './parts';

const FILTERS: { id: ShotFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'To review' },
  { id: 'matched', label: 'Matched' },
  { id: 'skipped', label: 'Skipped' },
];

export function CameraReview({
  shots,
  reading,
  meta,
  onSave,
  onRetake,
  onExported,
  onNewSession,
}: {
  shots: Shot[];
  reading: ReadonlySet<string>;
  meta: CameraSessionMeta;
  onSave: (s: Shot) => void;
  onRetake: (id: string) => void;
  onExported: (label: string, cards: number) => void;
  onNewSession: () => void;
}) {
  const counts = shotCounts(shots);
  const [filter, setFilter] = useState<ShotFilter>(() => (counts.toReview > 0 ? 'review' : 'all'));
  const [openId, setOpenId] = useState<string | null>(null);
  const list = filterShots(shots, filter);
  const open = shots.find((s) => s.id === openId) ?? null;

  /** After a decision, go on to the next shot that still needs review. */
  function decided(next: Shot) {
    onSave(next);
    const after = nextToReview(
      shots.map((s) => (s.id === next.id ? next : s)),
      next.id,
    );
    setOpenId(after?.id ?? null);
  }

  if (open) {
    return (
      <ShotDetail
        key={open.id}
        shot={open}
        reading={reading.has(open.id)}
        onPick={(c) => decided(confirmShot(open, c))}
        onSkip={() => decided(skipShot(open))}
        onRetake={() => {
          const after = nextToReview(shots, open.id);
          onRetake(open.id);
          setOpenId(after?.id ?? null);
        }}
        onClose={() => setOpenId(null)}
      />
    );
  }

  const countOf: Record<ShotFilter, number> = { all: counts.captured, review: counts.toReview, matched: counts.matched, skipped: counts.skipped };
  return (
    <section className="camera-review" aria-label="Review">
      <ExportPanel shots={shots} meta={meta} onExported={onExported} onNewSession={onNewSession} />
      <div className="chips review-filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className="filter-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label} <span className="num">{countOf[f.id]}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="status">{shots.length === 0 ? 'No photos in this session yet.' : 'Nothing here.'}</p>
      ) : (
        <ul className="shot-list">
          {list.map((s) => {
            const shown = s.chosen ?? s.candidates[0] ?? null;
            return (
              <li key={s.id}>
                <button type="button" className="shot-tile" onClick={() => setOpenId(s.id)}>
                  <ShotPhoto shot={s} className="shot-thumb" />
                  <span className="shot-tile-text">
                    <StatusPill shot={s} reading={reading.has(s.id)} />
                    <span className="shot-name">{shown ? (needsReview(s) ? `${shown.name}?` : shown.name) : 'Not recognised'}</span>
                    {shown && <span className="muted num">{setNumber(shown)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ShotDetail({
  shot,
  reading,
  onPick,
  onSkip,
  onRetake,
  onClose,
}: {
  shot: Shot;
  reading: boolean;
  onPick: (c: PrintingRef) => void;
  onSkip: () => void;
  onRetake: () => void;
  onClose: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [confirmRetake, setConfirmRetake] = useState(false);
  return (
    <section className="shot-detail" aria-label="Photo">
      <button type="button" className="link" onClick={onClose}>
        Back to the list
      </button>
      <div className="shot-detail-head">
        <StatusPill shot={shot} reading={reading} big />
        {shot.chosen && (
          <span>
            {shot.chosen.name} <span className="muted num">{setNumber(shot.chosen)}</span>
          </span>
        )}
      </div>
      <div className="shot-compare">
        <ShotPhoto shot={shot} className="shot-large" />
        <ol className="candidates">
          {shot.candidates.map((c) => {
            const chosen = shot.chosen?.scryfall_id === c.scryfall_id;
            return (
              <li key={c.oracle_id} className={chosen ? 'chosen' : undefined}>
                <button type="button" className="candidate" onClick={() => onPick(c)} aria-pressed={chosen}>
                  <ArtImage c={c} className="candidate-art" />
                  <span className="candidate-name">{c.name}</span>
                  <span className="muted num">
                    {setNumber(c)} · {score(c.score)}
                  </span>
                </button>
              </li>
            );
          })}
          {shot.candidates.length === 0 && <li className="muted">{reading ? 'Recognising…' : 'No candidates. Search by name.'}</li>}
        </ol>
      </div>
      <p className="muted">Tap the card that is in the photo.</p>
      <div className="actions">
        <button type="button" aria-expanded={searching} onClick={() => setSearching((v) => !v)}>
          Search by name
        </button>
        <button type="button" onClick={onSkip}>
          Not a card
        </button>
        {confirmRetake ? (
          <>
            <button type="button" className="danger" onClick={onRetake}>
              Delete this photo
            </button>
            <button type="button" onClick={() => setConfirmRetake(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirmRetake(true)}>
            Retake
          </button>
        )}
      </div>
      {confirmRetake && <p className="muted">The photo is deleted; slide the slip under the camera again.</p>}
      {searching && <NameSearch onPick={onPick} />}
    </section>
  );
}

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

function NameSearch({ onPick }: { onPick: (c: PrintingRef) => void }) {
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

function ExportPanel({
  shots,
  meta,
  onExported,
  onNewSession,
}: {
  shots: Shot[];
  meta: CameraSessionMeta;
  onExported: (label: string, cards: number) => void;
  onNewSession: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [label, setLabel] = useState(() => defaultPileLabel(new Date()));
  const [confirmNew, setConfirmNew] = useState(false);
  const counts = shotCounts(shots);
  const cards = shotsToRows(shots).reduce((n, r) => n + r.quantity, 0);

  function add() {
    const n = addShotsToScan(shots, label.trim() || defaultPileLabel(new Date()));
    onExported(label.trim() || defaultPileLabel(new Date()), n);
  }

  return (
    <div className="panel camera-export">
      {meta.exported && (
        <p className="muted">
          Added to Scan as {meta.exported.label} ({meta.exported.cards} {meta.exported.cards === 1 ? 'card' : 'cards'}).
        </p>
      )}
      {asking ? (
        <>
          <label className="field">
            <span>Pile name</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {counts.toReview > 0 && (
            <p className="status error">
              {counts.toReview} {counts.toReview === 1 ? 'photo is' : 'photos are'} still to review and will be left out.
            </p>
          )}
          <div className="actions">
            <button type="button" className="primary" onClick={add} disabled={cards === 0}>
              {counts.toReview > 0 ? `Leave them out and add ${cards}` : `Add ${cards}`} {cards === 1 ? 'card' : 'cards'}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="primary" onClick={() => setAsking(true)} disabled={cards === 0}>
            Add to Scan as a pile
          </button>
          {confirmNew ? (
            <>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setConfirmNew(false);
                  onNewSession();
                }}
              >
                Delete {counts.captured} {counts.captured === 1 ? 'photo' : 'photos'} and start again
              </button>
              <button type="button" onClick={() => setConfirmNew(false)}>
                Keep them
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmNew(true)} disabled={shots.length === 0}>
              Start a new session
            </button>
          )}
        </div>
      )}
      {confirmNew && !meta.exported && counts.matched > 0 && (
        <p className="status error">This session has not been added to Scan yet.</p>
      )}
    </div>
  );
}
