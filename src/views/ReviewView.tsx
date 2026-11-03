// The desk review (#/review): the camera's doubtful photos of the shared piles, decided on a big
// screen, where printings are told apart more easily than on the phone. The piles and the photos
// are live, so the page stays open and keeps up as piles arrive from the phone. A decision is the
// Scan tab's (Store.decideShot: the shot and the pile's rows in one transaction); which pile opens,
// the order of the photos, the tags, the repeats to set aside in one go and the printing order
// come from src/review/queue.ts. A repeat always names its card: a click on a candidate a pile
// already has records a repeat of that card, and "Second copy" beside it adds it after all. The
// photo often shows another printing than the one the app has as In-box: "Box has this printing"
// (Owner only) records the photographed one as the Scan tab does, without deciding the photo.
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadPrintings, usePrintings } from '../printings/load';
import { replaceHash, reviewHash } from '../router';
import {
  candidateTags,
  canSetInBox,
  inBoxFromPrinting,
  namesInPhotos,
  namesInPiles,
  nextPileToReview,
  nextToReview,
  openPileId,
  orderPrintings,
  otherToReview,
  photoPiles,
  pileOrder,
  positionText,
  queueOrder,
  repeatsInPile,
  tagText,
  toReviewOf,
  type CandidateTag,
} from '../review/queue';
import { knownPrintings } from '../scan/resolve';
import { scryfallImage } from '../store/baseline';
import { errorText, PHOTOS_DENIED, useScans, useShotChunks, useStore } from '../store/context';
import { lookupById } from '../store/lookup';
import { flattenChunks, photosComplete, refOfShared, sharedNeedsReview, sharedShotCounts } from '../store/shotChunks';
import type { SharedPile, SharedShot, SharedShotRef, ShotDecisionInput } from '../store/types';
import type { Card } from '../types';
import { NameSearch } from './camera/NameSearch';
import { score, setNumber } from './camera/parts';
import { LiveStatus } from './common';
import { Pill, SharedPhoto, shownName } from './SharedPhotoReview';

type Item = { chunk: number; shot: SharedShot };
type CardsByOracle = ReadonlyMap<string, Card>;

/** The card whose printings the picker shows, and the Printing it opened from (its art groups first). */
interface PickerTarget {
  oracle_id: string;
  name: string;
  pickedId: string | null;
}

/** How far the bulk clean-up has come: `running` while it decides, `error` where it stopped. */
interface Sweep {
  done: number;
  total: number;
  running: boolean;
  error: string | null;
}

/** How "Box has this printing" went: the confirmation, or the error. */
interface BoxNote {
  error: boolean;
  text: string;
}

/** The label of the pile that already has the card, from its tags; null when no pile has it. */
const alreadyIn = (tags: readonly CandidateTag[]): string | null => tags.find((t) => t.kind === 'alreadyIn')?.label ?? null;
/** True when the tags say the candidate is another printing of an In-box card. */
const otherPrinting = (tags: readonly CandidateTag[]): boolean => tags.some((t) => t.kind === 'inBoxOtherPrinting');

export default function ReviewView({ cards, pileId, cardsReady }: { cards: Card[] | null; pileId: string | null; cardsReady: boolean }) {
  const scans = useScans();
  const { auth } = useStore();
  const ordered = useMemo(() => pileOrder(scans.data), [scans.data]);
  const piles = useMemo(() => photoPiles(ordered), [ordered]);
  const openId = useMemo(() => openPileId(piles, pileId), [piles, pileId]);
  const open = openId ? (piles.find((p) => p.id === openId) ?? null) : null;
  // The open pile goes into the URL: a pile arriving from the phone must not take over mid-photo,
  // and a reload comes back to the same pile.
  useEffect(() => {
    if (scans.status === 'ready' && openId && openId !== pileId) replaceHash(reviewHash(openId));
  }, [scans.status, openId, pileId]);
  const byOracle = useMemo<CardsByOracle | null>(() => (cards ? new Map(cards.map((c) => [c.oracle_id, c])) : null), [cards]);
  // The names every other shared pile holds, CSV piles too: a candidate another stack already has.
  const names = useMemo(() => namesInPiles(ordered, openId), [ordered, openId]);
  const total = piles.reduce((n, p) => n + toReviewOf(p), 0);
  const canDecide = open !== null && (auth.isOwner || (!!auth.uid && open.createdByUid === auth.uid));

  return (
    <div className="review">
      <h1>Review</h1>
      <p className="muted">
        The camera's doubtful photos, decided at the desk. The piles are live: new ones appear here as they are shared from the phone.
      </p>
      <LiveStatus live={scans} what="piles" />
      {scans.status === 'ready' && piles.length === 0 && <p className="status">No camera piles yet. Piles shared from the phone appear here.</p>}
      {scans.status === 'ready' && piles.length > 0 && total === 0 && (
        <p className="status">Nothing to review. New piles appear here as they are shared from the phone.</p>
      )}
      {piles.length > 0 && (
        <nav className="desk-piles" aria-label="Piles">
          {piles.map((p) => (
            <a key={p.id} href={reviewHash(p.id)} aria-current={p.id === openId ? 'page' : undefined}>
              <span className="pile-label">{p.label}</span>
              <span className={toReviewOf(p) > 0 ? 'count open num' : 'count num'}>{toReviewOf(p)} to review</span>
            </a>
          ))}
        </nav>
      )}
      {open && <PileDesk key={open.id} pile={open} piles={piles} allPiles={ordered} canDecide={canDecide} cards={byOracle} cardsReady={cardsReady} names={names} />}
    </div>
  );
}

function PileDesk({
  pile,
  piles,
  allPiles,
  canDecide,
  cardsReady,
  cards,
  names,
}: {
  pile: SharedPile;
  /** The piles with photos, in pileOrder: where to go on to. */
  piles: SharedPile[];
  /** Every shared pile, CSV ones too, in pileOrder: which were created before this one. */
  allPiles: SharedPile[];
  canDecide: boolean;
  /** True once the shared card state has come from the server, so an In-box write acts on the current record. */
  cardsReady: boolean;
  cards: CardsByOracle | null;
  names: ReadonlyMap<string, string>;
}) {
  const { store, auth } = useStore();
  // One subscription, for this pile: the desk is keyed by the pile, so a switch mounts a fresh
  // desk that starts loading, instead of one that pins a photo of the previous pile's chunks.
  const live = useShotChunks(pile.id);
  // The In-box and Wanted Printings of every card, for the illustration of a photographed printing.
  const known = useMemo(() => knownPrintings(cards ? [...cards.values()] : []), [cards]);
  const items = useMemo(() => flattenChunks(live.data), [live.data]);
  const queue = useMemo(() => queueOrder(items), [items]);
  const counts = useMemo(() => sharedShotCounts(items.map((x) => x.shot)), [items]);
  const repeats = useMemo(() => repeatsInPile(pile, allPiles, items), [pile, allPiles, items]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  // The printing "Box has this printing" is saving (its scryfall_id), and how the last one went.
  const [boxBusy, setBoxBusy] = useState<string | null>(null);
  const [boxNote, setBoxNote] = useState<BoxNote | null>(null);
  const index = openId ? queue.findIndex((x) => x.shot.id === openId) : -1;
  const at = index >= 0 ? index : 0;
  const current = queue[at] ?? null;
  // The queue as of the latest render, for a decision whose promise settles later.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const shotCount = pile.shot_count ?? items.length;
  const others = otherToReview(piles, pile.id);
  const otherPile = nextPileToReview(piles, pile.id);
  const decidable = canDecide && !!store;
  const s = current?.shot ?? null;
  // The names this pile's other kept photos hold join the other piles' (this pile's word wins):
  // a candidate tagged as already in a pile is recorded as a repeat when clicked.
  const currentId = s?.id ?? null;
  const namesHere = useMemo(() => new Map([...names, ...namesInPhotos(items, currentId)]), [names, items, currentId]);
  const tagsOf = (c: Pick<SharedShotRef, 'scryfall_id' | 'oracle_id' | 'name'>) => candidateTags(c, cards, namesHere);

  // Pin the first photo once it is there, so a live change does not move the desk to another one.
  useEffect(() => {
    if (openId === null && queue.length > 0) setOpenId(queue[0]!.shot.id);
  }, [openId, queue]);

  function show(id: string) {
    setOpenId(id);
    setSearching(false);
    setPicker(null);
    setBoxNote(null);
  }

  function step(d: 1 | -1) {
    const next = queue[at + d];
    if (next) show(next.shot.id);
  }

  function advance(afterId: string) {
    const next = nextToReview(queueRef.current, afterId);
    if (next) show(next.shot.id);
    else if (otherPile) window.location.hash = reviewHash(otherPile.id);
  }

  /** Decide the photo; then on to the next one to review, unless the Owner should stay (a name search opens the picker). */
  async function decide(item: Item, decision: ShotDecisionInput, stay = false) {
    if (!store || busy) return;
    setBusy(true);
    setError(null);
    try {
      await store.decideShot(pile.id, item.chunk, item.shot.id, decision);
      if (!stay) advance(item.shot.id);
    } catch (e) {
      console.warn('Deciding the photo failed', e);
      setError({ id: item.shot.id, text: errorText(e, PHOTOS_DENIED) });
    } finally {
      setBusy(false);
    }
  }

  /** Sets aside every repeat of the pile (repeatsInPile), one decision after another; stops at the first error. */
  async function sweepRepeats() {
    if (!store || busy || repeats.length === 0) return;
    const list = repeats;
    setBusy(true);
    setError(null);
    setSweep({ done: 0, total: list.length, running: true, error: null });
    let done = 0;
    try {
      for (const r of list) {
        await store.decideShot(pile.id, r.chunk, r.shot.id, { kind: 'repeat', ref: refOfShared(r.ref) });
        done++;
        setSweep({ done, total: list.length, running: true, error: null });
      }
      setSweep({ done, total: list.length, running: false, error: null });
    } catch (e) {
      console.warn('Setting the repeats aside failed', e);
      setSweep({ done, total: list.length, running: false, error: errorText(e, PHOTOS_DENIED) });
    } finally {
      setBusy(false);
    }
  }

  /** Owner: the printing may be recorded as the card's In-box one (canSetInBox: a List card, another printing than the recorded). */
  const canBox = (oracleId: string, scryfallId: string) => auth.isOwner && !!store && cardsReady && canSetInBox(cards?.get(oracleId), scryfallId);

  /**
   * The illustration of a photographed printing: the known Printings and Scryfall (lookupById)
   * first, then the card's printings file; null when neither has it, so the record is written anyway.
   */
  async function illustrationOf(ref: SharedShotRef): Promise<string | null> {
    try {
      const hit = await lookupById(ref.scryfall_id, known);
      if (hit?.illustration_id) return hit.illustration_id;
    } catch (e) {
      console.warn('Looking the printing up failed; trying the printings file', e);
    }
    try {
      const file = await loadPrintings(ref.oracle_id);
      return file.printings.find((p) => p.id === ref.scryfall_id)?.illustration_id ?? null;
    } catch (e) {
      console.warn('Loading the printings file failed', e);
      return null;
    }
  }

  /**
   * Owner: the photographed printing is what is in the box. Writes the card's In-box Printing as
   * the Scan tab's "Box has this printing" does; the photo is not decided by it. `illustration`
   * is the printings file's when the picker knows it, else undefined and looked up.
   */
  async function setInBox(ref: SharedShotRef, illustration?: string | null) {
    if (!store || boxBusy !== null) return;
    const card = cards?.get(ref.oracle_id);
    if (!card || !canBox(ref.oracle_id, ref.scryfall_id)) return;
    setBoxBusy(ref.scryfall_id);
    setBoxNote(null);
    try {
      const art = illustration === undefined ? await illustrationOf(ref) : illustration;
      await store.updateCard(card.oracle_id, { kind: 'in_box', in_box: inBoxFromPrinting(ref, art) });
      setBoxNote({ error: false, text: `In-box printing of ${card.name} set to ${ref.set.toUpperCase()} ${ref.collector_number}.` });
    } catch (e) {
      console.warn('Box has this printing failed', e);
      setBoxNote({ error: true, text: errorText(e) });
    } finally {
      setBoxBusy(null);
    }
  }

  // A pick while a decision is saving is dropped, so nothing else (the picker) may act on it either.
  const canPick = () => current !== null && decidable && !busy;
  /**
   * The Owner's rule: a card a pile already has is a repeat of that card (the repeat names it, so
   * it is certainly a repeat and not another card); any other card is the card in the photo.
   */
  const choose = (ref: SharedShotRef, stay = false) => {
    if (!canPick()) return;
    setSearching(false);
    if (!stay) setPicker(null);
    const r = refOfShared(ref);
    const decision: ShotDecisionInput = alreadyIn(tagsOf(r)) !== null ? { kind: 'repeat', ref: r } : { kind: 'pick', ref: r };
    void decide(current!, decision, stay);
  };
  /** The card in the photo, whatever pile has it: a second copy. */
  const pick = (ref: SharedShotRef) => {
    if (!canPick()) return;
    setSearching(false);
    setPicker(null);
    void decide(current!, { kind: 'pick', ref: refOfShared(ref) });
  };
  const chooseCandidate = (i: number) => {
    const c = current?.shot.candidates[i];
    if (c) choose(c);
  };
  const notACard = () => {
    if (!canPick() || current!.shot.status === 'skipped') return;
    setSearching(false);
    setPicker(null);
    void decide(current!, { kind: 'not_a_card' });
  };
  const toggleSearch = () => {
    if (!decidable) return;
    setSearching((v) => !v);
  };
  // The name search picks from the art catalog, which knows few printings of a card: the pick
  // decides the photo, and the picker of that card follows for the right printing.
  const pickFromSearch = (ref: SharedShotRef) => {
    if (!canPick()) return;
    setPicker({ oracle_id: ref.oracle_id, name: ref.name, pickedId: ref.scryfall_id });
    choose(ref, true);
  };

  // One listener for the whole desk; the latest actions through a ref, so it is added once.
  const actions = useRef({ step, chooseCandidate, notACard, toggleSearch });
  actions.current = { step, chooseCandidate, notACard, toggleSearch };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
      // Enter on a focused button or link is that control's; a second action would double it.
      if (e.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const a = actions.current;
      switch (key) {
        case 'ArrowRight':
        case 'j':
          a.step(1);
          break;
        case 'ArrowLeft':
        case 'k':
          a.step(-1);
          break;
        case '1':
        case '2':
        case '3':
          a.chooseCandidate(Number(key) - 1);
          break;
        case 'Enter':
          a.chooseCandidate(0);
          break;
        case 'n':
          a.notACard();
          break;
        case 's':
          a.toggleSearch();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toReviewNext = current && !sharedNeedsReview(current.shot) ? nextToReview(queue, current.shot.id) : null;
  const chosenOutside = s?.chosen && !s.candidates.some((c) => c.scryfall_id === s.chosen!.scryfall_id) ? s.chosen : null;
  const inBoxIdOf = (oracleId: string) => cards?.get(oracleId)?.in_box?.scryfall_id ?? null;
  const pickerAgain = picker ? alreadyIn(tagsOf({ scryfall_id: picker.pickedId ?? '', oracle_id: picker.oracle_id, name: picker.name })) : null;

  /** A candidate's art, name, set and tags; the chosen one's Printing is shown the same way. */
  const candidateBody = (c: SharedShotRef & { score?: number }, key: number | null) => (
    <>
      <img
        className="desk-candidate-art"
        src={scryfallImage(c.scryfall_id, 'normal', 'front')}
        alt=""
        loading="lazy"
        decoding="async"
        width={488}
        height={680}
      />
      <span className="candidate-name">
        {decidable && key !== null && <kbd aria-hidden="true">{key}</kbd>} {c.name}
      </span>
      <span className="muted num">
        {setNumber(c)}
        {c.score !== undefined && ` · score ${score(c.score)}`}
      </span>
      {tagsOf(c).map((t) => (
        <span key={t.kind} className={t.kind === 'inBox' ? 'candidate-tag in-box' : 'candidate-tag'}>
          {tagText(t)}
        </span>
      ))}
    </>
  );

  return (
    <section className="panel desk-pile" aria-labelledby="desk-head">
      <h2 id="desk-head">{pile.label}</h2>
      <p className="muted num">
        {shotCount} {shotCount === 1 ? 'photo' : 'photos'}, {counts.review} to review
        {counts.repeats > 0 && `, ${counts.repeats} ${counts.repeats === 1 ? 'repeat' : 'repeats'}`} · {pile.by || 'someone'}
      </p>
      {!canDecide && <p className="notice">Only the Owner and the person who shared the pile can decide its photos; here they are only shown.</p>}
      <LiveStatus live={live} what="photos" />
      {live.status === 'ready' && !photosComplete(shotCount, live.data) && (
        <p className="notice">
          {items.length} of {shotCount} photos have arrived. The rest are still uploading, or the upload stopped on the phone that shared the
          pile.
        </p>
      )}
      {live.status === 'ready' && items.length === 0 && <p className="status">No photos have arrived yet.</p>}
      {decidable && repeats.length > 0 && (
        <div className="actions desk-sweep">
          <button type="button" onClick={() => void sweepRepeats()} disabled={busy}>
            Set aside the {repeats.length} {repeats.length === 1 ? 'repeat' : 'repeats'} in this pile
          </button>
          <span className="muted">
            Matched photos of a card a pile created before this one holds, or of a card photographed earlier in this pile; doubtful photos
            are left alone.
          </span>
        </div>
      )}
      {sweep && (
        <p className={sweep.error ? 'status error' : 'status num'} role={sweep.error ? 'alert' : 'status'}>
          {sweep.error
            ? `${sweep.done} of ${sweep.total} ${sweep.total === 1 ? 'repeat' : 'repeats'} set aside, then: ${sweep.error}`
            : sweep.running
              ? `Setting aside repeat ${Math.min(sweep.done + 1, sweep.total)} of ${sweep.total}…`
              : `${sweep.done} ${sweep.done === 1 ? 'repeat' : 'repeats'} set aside.`}
        </p>
      )}
      {current && s && (
        <>
          <div className="desk-nav">
            <button type="button" onClick={() => step(-1)} disabled={at <= 0} aria-keyshortcuts="ArrowLeft k">
              <kbd aria-hidden="true">←</kbd> Previous
            </button>
            <button type="button" onClick={() => step(1)} disabled={at >= queue.length - 1} aria-keyshortcuts="ArrowRight j">
              Next <kbd aria-hidden="true">→</kbd>
            </button>
            <span className="num" aria-live="polite">
              {positionText(queue, s.id, pile.label, others)}
            </span>
            {toReviewNext && (
              <button type="button" className="link" onClick={() => show(toReviewNext.shot.id)}>
                Next to review
              </button>
            )}
            {counts.review === 0 && otherPile && (
              <a className="button" href={reviewHash(otherPile.id)}>
                Review {otherPile.label} ({toReviewOf(otherPile)} to review)
              </a>
            )}
          </div>
          <article className="desk" aria-busy={busy}>
            <DeskPhoto key={s.id} shot={s} />
            <div className="desk-body">
              <div className="shot-detail-head">
                <Pill shot={s} />
                <span>{shownName(s)}</span>
                {s.score !== null && <span className="muted num">score {score(s.score)}</span>}
              </div>
              <ol className="candidates desk-candidates">
                {s.candidates.map((c, i) => {
                  const chosen = s.chosen?.scryfall_id === c.scryfall_id;
                  const tags = tagsOf(c);
                  const again = alreadyIn(tags) !== null;
                  const toBox = otherPrinting(tags) && canBox(c.oracle_id, c.scryfall_id);
                  const open = picker?.oracle_id === c.oracle_id && picker.pickedId === c.scryfall_id;
                  return (
                    <li key={`${c.scryfall_id}-${c.oracle_id}`} className={chosen ? 'chosen' : undefined}>
                      {decidable ? (
                        <button
                          type="button"
                          className="candidate"
                          onClick={() => choose(c)}
                          aria-pressed={chosen}
                          disabled={busy}
                          title={again ? `A repeat of ${c.name}` : undefined}
                        >
                          {candidateBody(c, i + 1)}
                        </button>
                      ) : (
                        <span className="candidate">{candidateBody(c, null)}</span>
                      )}
                      {decidable && again && (
                        <button type="button" className="link" onClick={() => pick(c)} disabled={busy}>
                          Second copy
                        </button>
                      )}
                      {decidable && (
                        <button
                          type="button"
                          className="link"
                          aria-expanded={open}
                          onClick={() => setPicker(open ? null : { oracle_id: c.oracle_id, name: c.name, pickedId: c.scryfall_id })}
                        >
                          Other printing…
                        </button>
                      )}
                      {toBox && (
                        <button type="button" className="link" onClick={() => void setInBox(c)} disabled={boxBusy !== null}>
                          {boxBusy === c.scryfall_id ? 'Setting…' : 'Box has this printing'}
                        </button>
                      )}
                    </li>
                  );
                })}
                {chosenOutside && (
                  <li className="chosen">
                    <span className="candidate">{candidateBody(chosenOutside, null)}</span>
                  </li>
                )}
                {s.candidates.length === 0 && !chosenOutside && <li className="muted">No candidates. Search by name.</li>}
              </ol>
              {decidable && (
                <div className="actions">
                  <button type="button" aria-expanded={searching} onClick={toggleSearch} disabled={busy} aria-keyshortcuts="s">
                    <kbd aria-hidden="true">S</kbd> Search by name
                  </button>
                  <button type="button" onClick={notACard} disabled={busy || s.status === 'skipped'} aria-keyshortcuts="n">
                    <kbd aria-hidden="true">N</kbd> Not a card
                  </button>
                </div>
              )}
              {searching && decidable && <NameSearch onPick={pickFromSearch} />}
              {picker && decidable && (
                <PrintingPicker
                  key={picker.oracle_id}
                  target={picker}
                  inBoxId={inBoxIdOf(picker.oracle_id)}
                  chosenId={s.chosen?.scryfall_id ?? null}
                  again={pickerAgain}
                  busy={busy}
                  onPick={(ref) => choose(ref)}
                  onCopy={(ref) => pick(ref)}
                  canBox={(id) => canBox(picker.oracle_id, id)}
                  boxBusy={boxBusy}
                  onBox={(ref, illustration) => void setInBox(ref, illustration)}
                  onClose={() => setPicker(null)}
                />
              )}
              {busy && !sweep?.running && <p className="status">Saving…</p>}
              {error?.id === s.id && (
                <p className="status error" role="alert">
                  {error.text}
                </p>
              )}
              {boxNote && (
                <p className={boxNote.error ? 'status error' : 'status'} role={boxNote.error ? 'alert' : 'status'}>
                  {boxNote.text}
                </p>
              )}
              {decidable && (
                <>
                  <p className="muted desk-keys">
                    Keys: 1, 2, 3 take a candidate, Enter the first; N marks not a card; S searches by name; ← and → (or K and J) move
                    between photos.
                  </p>
                  <p className="muted desk-keys">
                    A candidate marked as already in a pile is recorded as a repeat of that card, which names it; “Second copy” beside it
                    adds it to this pile after all. “Not a card” is for the empty sheet or a hand only.
                  </p>
                  {auth.isOwner && (
                    <p className="muted desk-keys">
                      “Box has this printing” under another printing of an In-box card records that printing as the one in the box, as the
                      Scan tab does; it does not decide the photo.
                    </p>
                  )}
                </>
              )}
            </div>
          </article>
        </>
      )}
    </section>
  );
}

/** The photo at twice the thumbnail's size, with a Turn for a slip that lay the other way round. */
function DeskPhoto({ shot }: { shot: SharedShot }) {
  const [turned, setTurned] = useState(false);
  return (
    <div className="desk-photo-box">
      <SharedPhoto shot={shot} className={turned ? 'desk-photo turned' : 'desk-photo'} />
      <button type="button" className="link" onClick={() => setTurned((v) => !v)} aria-pressed={turned}>
        Turn
      </button>
    </div>
  );
}

/**
 * A card's printings as a wrapping row of images; a click decides the photo as that printing: a
 * repeat of the card when a pile already has it (`again` says which), else the card in the photo.
 * For the Owner, "Box has this printing" under a printing records it as the card's In-box one.
 */
function PrintingPicker({
  target,
  inBoxId,
  chosenId,
  again,
  busy,
  onPick,
  onCopy,
  canBox,
  boxBusy,
  onBox,
  onClose,
}: {
  target: PickerTarget;
  inBoxId: string | null;
  chosenId: string | null;
  /** The pile that already has the card, or null. */
  again: string | null;
  busy: boolean;
  onPick: (ref: SharedShotRef) => void;
  /** A second copy: the card in the photo, though a pile has it already. */
  onCopy: (ref: SharedShotRef) => void;
  /** Whether the printing may be recorded as the In-box one (false for anyone but the Owner). */
  canBox: (id: string) => boolean;
  /** The printing whose In-box record is saving, or null. */
  boxBusy: string | null;
  /** Record the printing as the In-box one; the illustration is the printings file's. */
  onBox: (ref: SharedShotRef, illustration_id: string | null) => void;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const state = usePrintings(target.oracle_id, attempt);
  if (state.status === 'loading') return <p className="status">Loading the printings of {target.name}…</p>;
  if (state.status === 'error') {
    return (
      <p className="status error">
        Could not load the printings of {target.name} ({state.message}).{' '}
        <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </p>
    );
  }
  const file = state.file;
  // A file that came from a Scryfall search has no name; the candidate's serves.
  const name = file.name || target.name;
  const ordered = orderPrintings(file.printings, inBoxId, target.pickedId);
  const art = target.pickedId ? (file.printings.find((p) => p.id === target.pickedId)?.illustration_id ?? null) : null;
  const refOfPrinting = (p: { id: string; set: string; collector_number: string }): SharedShotRef => ({
    scryfall_id: p.id,
    oracle_id: target.oracle_id,
    name,
    set: p.set,
    collector_number: p.collector_number,
  });
  return (
    <div className="desk-picker">
      <p>
        Printings of <strong>{name}</strong> <span className="muted num">({ordered.length})</span>{' '}
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </p>
      {again !== null && (
        <p className="muted">
          {name} is already in {again}: a printing picked here is recorded as a repeat of it; “Second copy” adds it to this pile instead.
        </p>
      )}
      {ordered.length === 0 && <p className="status">No printings known.</p>}
      <ul className="desk-printings">
        {ordered.map((p) => {
          const chosen = p.id === chosenId;
          return (
            <li key={p.id} className={chosen ? 'chosen' : undefined}>
              <button type="button" className="candidate" aria-pressed={chosen} disabled={busy} onClick={() => onPick(refOfPrinting(p))}>
                <img className="desk-printing-art" src={p.image_normal} alt="" loading="lazy" decoding="async" width={488} height={680} />
                <span className="muted num">
                  {setNumber(p)} · {p.released_at.slice(0, 4)}
                </span>
                {p.id === inBoxId && <span className="candidate-tag in-box">in the box</span>}
                {p.id !== inBoxId && art !== null && p.illustration_id === art && <span className="candidate-tag">same art</span>}
              </button>
              {again !== null && (
                <button type="button" className="link" disabled={busy} onClick={() => onCopy(refOfPrinting(p))}>
                  Second copy
                </button>
              )}
              {canBox(p.id) && (
                <button type="button" className="link" disabled={boxBusy !== null} onClick={() => onBox(refOfPrinting(p), p.illustration_id)}>
                  {boxBusy === p.id ? 'Setting…' : 'Box has this printing'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
