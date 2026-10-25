// The photos of a shared camera pile, on the Scan tab: a review list with filters and a gallery.
// The pile's creator and the Owner decide doubtful slips here (pick a candidate, Search by name,
// Not a card); a decision updates the shot in its chunk and the pile's rows in one transaction,
// so the diff picks the new rows up through the live shared piles. Everyone else reads only.
import { useMemo, useState } from 'react';
import { errorText, PHOTOS_DENIED, useShotChunks, useStore } from '../store/context';
import {
  filterSharedShots,
  flattenChunks,
  photosComplete,
  refOfShared,
  sharedNeedsReview,
  sharedShotCounts,
  type SharedShotFilter,
} from '../store/shotChunks';
import type { SharedPile, SharedShot, SharedShotRef, ShotDecisionInput } from '../store/types';
import { NameSearch } from './camera/NameSearch';
import { ArtImage, score, setNumber } from './camera/parts';
import { LiveStatus } from './common';

const FILTERS: { id: SharedShotFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'review', label: 'To review' },
  { id: 'matched', label: 'Matched' },
  { id: 'unknown', label: 'Unknown' },
];

/** Shots shown at once in the review list; more on request, so a whole Cube does not load 540 rows of art. */
const PAGE = 30;

type Item = { chunk: number; shot: SharedShot };

const STATUS_WORD: Record<SharedShot['status'], string> = {
  match: 'Match',
  confirmed: 'Confirmed',
  review: 'Review',
  none: 'Unknown',
  skipped: 'Not a card',
};

const TONE: Record<SharedShot['status'], string> = {
  match: 'match',
  confirmed: 'confirmed',
  review: 'review',
  none: 'none',
  skipped: 'skipped',
};

function Pill({ shot }: { shot: SharedShot }) {
  return <span className={`shot-status tone-${TONE[shot.status]}`}>{STATUS_WORD[shot.status]}</span>;
}

function SharedPhoto({ shot, className }: { shot: SharedShot; className: string }) {
  return shot.thumb ? (
    <img className={className} src={`data:image/jpeg;base64,${shot.thumb}`} alt="Photo of the slip" decoding="async" />
  ) : (
    <span className={`${className} empty`} />
  );
}

/** The name under a photo: the chosen Printing, a guess with a question mark, or why there is none. */
function shownName(s: SharedShot): string {
  if (s.status === 'skipped') return 'Not a card';
  const c = s.chosen ?? s.candidates[0] ?? null;
  if (!c) return 'Not recognised';
  return sharedNeedsReview(s) ? `${c.name}?` : c.name;
}

export function SharedPhotoReview({ pile, canDecide, onClose }: { pile: SharedPile; canDecide: boolean; onClose: () => void }) {
  const live = useShotChunks(pile.id);
  const { store } = useStore();
  const items = useMemo(() => flattenChunks(live.data), [live.data]);
  const counts = useMemo(() => sharedShotCounts(items.map((x) => x.shot)), [items]);
  const [filter, setFilter] = useState<SharedShotFilter | null>(null);
  // To review first while there is something to review.
  const shownFilter: SharedShotFilter = filter ?? (counts.review > 0 ? 'review' : 'all');
  const [mode, setMode] = useState<'review' | 'gallery'>('review');
  const [openId, setOpenId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const list = filterSharedShots(items, shownFilter);
  const open = openId ? items.find((x) => x.shot.id === openId) ?? null : null;
  const shotCount = pile.shot_count ?? items.length;
  const arrived = items.length;

  async function decide(item: Item, decision: ShotDecisionInput) {
    if (!store) return;
    setBusyId(item.shot.id);
    setError(null);
    try {
      await store.decideShot(pile.id, item.chunk, item.shot.id, decision);
    } catch (e) {
      console.warn('Deciding the photo failed', e);
      setError({ id: item.shot.id, text: errorText(e, PHOTOS_DENIED) });
    } finally {
      setBusyId(null);
    }
  }

  const detail = (item: Item) => (
    <ShotItem
      key={item.shot.id}
      item={item}
      canDecide={canDecide && !!store}
      busy={busyId === item.shot.id}
      error={error?.id === item.shot.id ? error.text : null}
      onDecide={(d) => void decide(item, d)}
    />
  );

  return (
    <section className="panel photo-review" aria-labelledby="photo-review-head">
      <button type="button" className="link" onClick={onClose}>
        Back to the shared piles
      </button>
      <h2 id="photo-review-head">Photos of {pile.label}</h2>
      <p className="muted num">
        {shotCount} {shotCount === 1 ? 'photo' : 'photos'}, {counts.review} to review · {pile.by || 'someone'}
        {canDecide ? '' : ' · only the Owner and the person who shared the pile can change it'}
      </p>
      <LiveStatus live={live} what="photos" />
      {live.status === 'ready' && !photosComplete(shotCount, live.data) && (
        <p className="notice">
          {arrived} of {shotCount} photos have arrived. The rest are still uploading, or the upload stopped on the phone that shared
          the pile.
        </p>
      )}

      {open ? (
        <>
          <button type="button" className="link" onClick={() => setOpenId(null)}>
            Back to the {mode === 'gallery' ? 'gallery' : 'list'}
          </button>
          {detail(open)}
        </>
      ) : (
        <>
          <div className="chips review-filters" role="group" aria-label="View">
            <button type="button" className="filter-chip" aria-pressed={mode === 'review'} onClick={() => setMode('review')}>
              Review
            </button>
            <button type="button" className="filter-chip" aria-pressed={mode === 'gallery'} onClick={() => setMode('gallery')}>
              Gallery
            </button>
          </div>
          <div className="chips review-filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="filter-chip"
                aria-pressed={shownFilter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setLimit(PAGE);
                }}
              >
                {f.label} <span className="num">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          {live.status === 'ready' && list.length === 0 && (
            <p className="status">{items.length === 0 ? 'No photos have arrived yet.' : 'Nothing here.'}</p>
          )}
          {mode === 'gallery' ? (
            <ul className="shot-list photo-gallery">
              {list.map((x) => (
                <li key={x.shot.id}>
                  <button type="button" className="shot-tile" onClick={() => setOpenId(x.shot.id)}>
                    <SharedPhoto shot={x.shot} className="shot-thumb" />
                    <span className="shot-tile-text">
                      <span className="shot-name">{shownName(x.shot)}</span>
                      {x.shot.chosen && <span className="muted num">{setNumber(x.shot.chosen)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul className="shared-shots">{list.slice(0, limit).map((x) => <li key={x.shot.id}>{detail(x)}</li>)}</ul>
              {list.length > limit && (
                <button type="button" onClick={() => setLimit((n) => n + PAGE)}>
                  Show {Math.min(PAGE, list.length - limit)} more
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function ShotItem({
  item,
  canDecide,
  busy,
  error,
  onDecide,
}: {
  item: Item;
  canDecide: boolean;
  busy: boolean;
  error: string | null;
  onDecide: (d: ShotDecisionInput) => void;
}) {
  const s = item.shot;
  const [searching, setSearching] = useState(false);
  const pick = (ref: SharedShotRef) => {
    setSearching(false);
    onDecide({ kind: 'pick', ref: refOfShared(ref) });
  };
  const chosenOutside = s.chosen && !s.candidates.some((c) => c.scryfall_id === s.chosen!.scryfall_id) ? s.chosen : null;
  return (
    <article className="shared-shot" aria-busy={busy}>
      <SharedPhoto shot={s} className="shared-photo" />
      <div className="shared-shot-body">
        <div className="shot-detail-head">
          <Pill shot={s} />
          <span>{shownName(s)}</span>
          {s.score !== null && <span className="muted num">score {score(s.score)}</span>}
        </div>
        <ol className="candidates">
          {s.candidates.map((c) => {
            const chosen = s.chosen?.scryfall_id === c.scryfall_id;
            const body = (
              <>
                <ArtImage c={{ scryfall_id: c.scryfall_id, face: 'front' }} className="candidate-art" />
                <span className="candidate-name">{c.name}</span>
                <span className="muted num">
                  {setNumber(c)} · {score(c.score)}
                </span>
              </>
            );
            return (
              <li key={`${c.scryfall_id}-${c.oracle_id}`} className={chosen ? 'chosen' : undefined}>
                {canDecide ? (
                  <button type="button" className="candidate" onClick={() => pick(c)} aria-pressed={chosen} disabled={busy}>
                    {body}
                  </button>
                ) : (
                  <span className="candidate">{body}</span>
                )}
              </li>
            );
          })}
          {chosenOutside && (
            <li className="chosen">
              <span className="candidate">
                <ArtImage c={{ scryfall_id: chosenOutside.scryfall_id, face: 'front' }} className="candidate-art" />
                <span className="candidate-name">{chosenOutside.name}</span>
                <span className="muted num">{setNumber(chosenOutside)}</span>
              </span>
            </li>
          )}
          {s.candidates.length === 0 && !chosenOutside && <li className="muted">No candidates.</li>}
        </ol>
        {canDecide && (
          <>
            <div className="actions">
              <button type="button" aria-expanded={searching} onClick={() => setSearching((v) => !v)} disabled={busy}>
                Search by name
              </button>
              <button type="button" onClick={() => onDecide({ kind: 'not_a_card' })} disabled={busy || s.status === 'skipped'}>
                Not a card
              </button>
            </div>
            {searching && <NameSearch onPick={pick} />}
          </>
        )}
        {busy && <p className="status">Saving…</p>}
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
