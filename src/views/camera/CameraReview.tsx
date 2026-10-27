// Review of a camera session: the shots with their photos, a detail view to pick the right
// Printing, skip or retake a slip, and the export to the Scan session as a Pile.
import { useState } from 'react';
import { addShotsToScan } from '../../scan/camera/exportPile';
import { progressText, resumeCameraPhotos, shareCameraPile, type UploadProgress } from '../../scan/camera/sharePhotos';
import type { Pile } from '../../scan/parse';
import { errorText, PHOTOS_DENIED, useStore } from '../../store/context';
import { recordSharedFrom, setPhotosPending } from '../../store/scanPrefs';
import { NameField, useDisplayName } from '../common';
import type { CameraSessionMeta } from '../../scan/camera/settings';
import {
  alreadyInPile,
  confirmShot,
  defaultPileLabel,
  filterShots,
  isSameSlip,
  keepSecondCopy,
  needsReview,
  nextToReview,
  shotCounts,
  shotsToRows,
  skipAsRepeat,
  skipShot,
  type PrintingLike,
  type PrintingRef,
  type Shot,
  type ShotFilter,
} from '../../scan/camera/shots';
import { NameSearch } from './NameSearch';
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
  onDone,
  onNewSession,
}: {
  shots: Shot[];
  reading: ReadonlySet<string>;
  meta: CameraSessionMeta;
  onSave: (s: Shot) => void;
  onRetake: (id: string) => void;
  /** The pile is in the Scan session (its photos may still be uploading). */
  onExported: (label: string, cards: number) => void;
  /** Go on to the Scan tab. */
  onDone: () => void;
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
        shots={shots}
        reading={reading.has(open.id)}
        onPick={(c) => decided(confirmShot(open, c))}
        onSkip={() => decided(skipShot(open))}
        onRepeat={() => decided(skipAsRepeat(open))}
        onRetake={() => {
          const after = nextToReview(shots, open.id);
          onRetake(open.id);
          setOpenId(after?.id ?? null);
        }}
        onClose={() => setOpenId(null)}
      />
    );
  }

  const countOf: Record<ShotFilter, number> = { all: shots.length, review: counts.toReview, matched: counts.matched, skipped: counts.skipped };
  return (
    <section className="camera-review" aria-label="Review">
      <ExportPanel shots={shots} meta={meta} onExported={onExported} onDone={onDone} onNewSession={onNewSession} />
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
            const same = isSameSlip(s);
            return (
              <li key={s.id}>
                <button type="button" className="shot-tile" onClick={() => setOpenId(s.id)}>
                  <ShotPhoto shot={s} className="shot-thumb" />
                  <span className="shot-tile-text">
                    <StatusPill shot={s} reading={reading.has(s.id)} />
                    <span className="shot-name">{shown ? (needsReview(s) ? `${shown.name}?` : shown.name) : 'Not recognised'}</span>
                    {shown && <span className="muted num">{setNumber(shown)}</span>}
                    {s.reason && <span className="muted">{s.reason[0]!.toUpperCase() + s.reason.slice(1)}.</span>}
                  </span>
                </button>
                {same && (
                  <button type="button" className="shot-keep" onClick={() => onSave(keepSecondCopy(s))}>
                    Keep as a second copy
                  </button>
                )}
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
  shots,
  reading,
  onPick,
  onSkip,
  onRepeat,
  onRetake,
  onClose,
}: {
  shot: Shot;
  /** The whole session, to say which candidates the pile already has. */
  shots: readonly Shot[];
  reading: boolean;
  onPick: (c: PrintingRef) => void;
  /** Not a card: a sheet or a hand. */
  onSkip: () => void;
  /** A second photo of a slip already taken. */
  onRepeat: () => void;
  onRetake: () => void;
  onClose: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [confirmRetake, setConfirmRetake] = useState(false);
  // Another kept shot of the same Printing: a tap on such a candidate adds a second copy, which is
  // right now and then, but a second photo of the same slip is a repeat.
  const inPile = (c: PrintingLike) => alreadyInPile(shots, c, shot.id) !== null;
  const secondCopy = shot.chosen !== null && inPile(shot.chosen);
  const offersCopy = !secondCopy && shot.candidates.some(inPile);
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
        {shot.reason && <span className="muted">{shot.reason[0]!.toUpperCase() + shot.reason.slice(1)}.</span>}
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
                  {inPile(c) && <span className="candidate-tag">already in this pile</span>}
                </button>
              </li>
            );
          })}
          {shot.candidates.length === 0 && <li className="muted">{reading ? 'Recognising…' : 'No candidates. Search by name.'}</li>}
        </ol>
      </div>
      <p className="muted">
        {secondCopy
          ? `Counted as a second copy of ${shot.chosen!.name}, which is already in this pile.`
          : offersCopy
            ? 'Tap the card that is in the photo. A card already in this pile adds a second copy of it; a second photo of the same slip is a repeat.'
            : 'Tap the card that is in the photo.'}
      </p>
      <div className="actions">
        <button type="button" aria-expanded={searching} onClick={() => setSearching((v) => !v)}>
          Search by name
        </button>
        <button type="button" onClick={onRepeat}>
          Repeat, already taken
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

type SharePhase =
  | { kind: 'idle' }
  | { kind: 'sharing'; progress: UploadProgress | null }
  /** The pile is in Scan, but sharing it or its photos stopped; sharedId is null when no shared pile was made. */
  | { kind: 'failed'; error: string; pile: Pile; shots: Shot[]; sharedId: string | null }
  /** Shared as a plain pile: the rules refused the photos. */
  | { kind: 'plain' };

function ExportPanel({
  shots,
  meta,
  onExported,
  onDone,
  onNewSession,
}: {
  shots: Shot[];
  meta: CameraSessionMeta;
  onExported: (label: string, cards: number) => void;
  onDone: () => void;
  onNewSession: () => void;
}) {
  const { store } = useStore();
  const [asking, setAsking] = useState(false);
  const [label, setLabel] = useState('');
  const [labelEdited, setLabelEdited] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  // On by default once the shared store is there; the Owner's own choice wins.
  const [shareChoice, setShareChoice] = useState<boolean | null>(null);
  const wantShare = !!store && (shareChoice ?? true);
  const [by, setBy] = useDisplayName();
  const [needName, setNeedName] = useState(false);
  const [phase, setPhase] = useState<SharePhase>({ kind: 'idle' });
  const counts = shotCounts(shots);
  const cards = shotsToRows(shots).reduce((n, r) => n + r.quantity, 0);

  /** Opens the form with a fresh default name (time and count) unless the Owner typed one. */
  function openForm() {
    if (!labelEdited) setLabel(defaultPileLabel(new Date(), cards));
    setAsking(true);
  }

  async function share(pile: Pile, taken: Shot[], sharedId: string | null) {
    if (!store) return;
    let id = sharedId;
    const onProgress = (progress: UploadProgress) => setPhase({ kind: 'sharing', progress });
    setPhase({ kind: 'sharing', progress: null });
    try {
      let withoutPhotos = false;
      if (id) {
        await resumeCameraPhotos(store, id, pile, taken, onProgress);
      } else {
        const res = await shareCameraPile(store, pile, by.trim(), taken, {
          onShared: (newId) => {
            id = newId;
            recordSharedFrom(pile.id, newId);
            setPhotosPending(pile.id, newId);
          },
          onProgress,
        });
        withoutPhotos = res.withoutPhotos;
      }
      setPhotosPending(pile.id, null);
      if (withoutPhotos) {
        setPhase({ kind: 'plain' });
        return;
      }
      setPhase({ kind: 'idle' });
      onDone();
    } catch (e) {
      console.warn('Sharing the camera pile failed', e);
      setPhase({ kind: 'failed', error: errorText(e, PHOTOS_DENIED), pile, shots: taken, sharedId: id });
    }
  }

  function add() {
    if (wantShare && !by.trim()) {
      setNeedName(true);
      return;
    }
    const name = label.trim() || defaultPileLabel(new Date(), cards);
    const taken = [...shots];
    const { pile, cards: n } = addShotsToScan(taken, name);
    onExported(name, n);
    setAsking(false);
    if (wantShare) void share(pile, taken, null);
    else onDone();
  }

  // With photos shared, a session of slips that all still need review is worth sharing too.
  const canAdd = wantShare ? shots.length > 0 : cards > 0;
  return (
    <div className="panel camera-export">
      {meta.exported && (
        <p className="muted">
          Added to Scan as {meta.exported.label} ({meta.exported.cards} {meta.exported.cards === 1 ? 'card' : 'cards'}).
        </p>
      )}
      {phase.kind === 'sharing' && (
        <p className="status num" role="status">
          {progressText(phase.progress)}
          {phase.progress && <progress max={phase.progress.total || 1} value={phase.progress.done} />}
        </p>
      )}
      {phase.kind === 'plain' && (
        <>
          <p className="status error" role="alert">
            Shared without photos: the new Firestore rules are not pasted yet. Paste them and share again from the Scan tab for the photos.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={onDone}>
              Go to Scan
            </button>
          </div>
        </>
      )}
      {phase.kind === 'failed' && (
        <>
          <p className="status error" role="alert">
            The pile is in Scan, but {phase.sharedId ? 'not all its photos were uploaded' : 'it was not shared'}: {phase.error}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void share(phase.pile, phase.shots, phase.sharedId)}>
              Try again
            </button>
            <button type="button" onClick={onDone}>
              Go to Scan
            </button>
          </div>
        </>
      )}
      {phase.kind === 'idle' &&
        (asking ? (
          <>
            <label className="field">
              <span>Pile name</span>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setLabelEdited(true);
                }}
              />
            </label>
            {store && (
              <label className="check">
                <input type="checkbox" checked={wantShare} onChange={(e) => setShareChoice(e.target.checked)} />
                Share it with photos
              </label>
            )}
            {wantShare && (
              <>
                <NameField
                  value={by}
                  onChange={(v) => {
                    setBy(v);
                    if (v.trim()) setNeedName(false);
                  }}
                  label="Your name, shown on shared piles"
                />
                {needName && (
                  <p className="status error" role="alert">
                    Write your name first; it is shown on the shared pile.
                  </p>
                )}
                <p className="muted">All {shots.length} photos go with the shared pile, so doubtful slips can be checked on a PC.</p>
              </>
            )}
            {counts.toReview > 0 && (
              <p className="status error">
                {counts.toReview} {counts.toReview === 1 ? 'photo is' : 'photos are'} still to review and will be left out of the pile
                {wantShare ? ` until ${counts.toReview === 1 ? 'it is' : 'they are'} reviewed from the shared photos.` : '.'}
              </p>
            )}
            <div className="actions">
              <button type="button" className="primary" onClick={add} disabled={!canAdd}>
                {counts.toReview > 0 ? `Leave them out and add ${cards}` : `Add ${cards}`} {cards === 1 ? 'card' : 'cards'}
                {wantShare ? ' and share' : ''}
              </button>
              <button type="button" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="actions">
            <button type="button" className="primary" onClick={openForm} disabled={store ? shots.length === 0 : cards === 0}>
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
                  Delete {shots.length} {shots.length === 1 ? 'photo' : 'photos'} and start again
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
        ))}
      {confirmNew && !meta.exported && counts.matched > 0 && (
        <p className="status error">This session has not been added to Scan yet.</p>
      )}
    </div>
  );
}
