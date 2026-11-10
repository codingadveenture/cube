import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { printingsHash, replaceHash, reviewHash } from '../router';
import { parseScanText, type Pile } from '../scan/parse';
import {
  diffScan,
  type CardResult,
  type ExpectedCard,
  type ResolvedPrinting,
  type ToPrintResult,
  type UnexpectedResult,
  scannedPrintings,
  pilesOf,
} from '../scan/diff';
import { knownPrintings, localPrintings, resolvePrintings, type ResolveProgress } from '../scan/resolve';
import { expectedCards, toPrintCards } from '../scan/expected';
import { inBoxForToPrint, notInBoxCandidates, recordedCardState, scannedInBox } from '../scan/owner';
import {
  clearSession,
  emptySession,
  loadSession,
  makePile,
  mergedRows,
  saveSession,
  type ScanSession,
} from '../scan/session';
import { takeSharedFiles } from '../scan/shared';
import { boxAgainstUpstream, scryfallByName, type BoxCard } from '../scan/upstreamDiff';
import { errorText, PHOTOS_DENIED, useCardStates, useLog, useOverrides, useScans, useStore, useUpstreamMetaDoc, type Live } from '../store/context';
import { lookupById, lookupPrinting } from '../store/lookup';
import { MAX_PILE_ROWS, pilesForDiff, sharedPileInput } from '../store/piles';
import { progressText, type UploadProgress } from '../store/shotChunks';
import { loadIncluded, loadPhotosPending, loadSharedFrom, saveIncluded, saveSharedFrom, setPhotosPending } from '../store/scanPrefs';
import type { CardPatchFor, InBoxState, SharedPile } from '../store/types';
import { proposedList, stickySets } from '../upstream/feed';
import { toUpstreamMeta } from '../upstream/meta';
import { keyOf, LIST_MAX, LIST_MIN, nameIndex } from '../upstream/names';
import { fetchCubelist, UPSTREAM_ID } from '../upstream/net';
import { fetchFacts } from '../upstream/scryfall';
import { formatTime, LiveStatus, NameField, useDisplayName } from './common';

// Camera code (IndexedDB shots, thumbnails, the art catalog of Search by name) loads only when a
// camera pile is shared or its photos are reviewed, so the Scan tab stays light.
const SharedPhotoReview = lazy(() => import('./SharedPhotoReview').then((m) => ({ default: m.SharedPhotoReview })));
const loadSharePhotos = () => import('../scan/camera/sharePhotos');

/** A photo upload of a local camera pile, shown under that pile. */
interface PhotoUpload {
  pileId: string;
  progress: UploadProgress | null;
  error: string | null;
  done: boolean;
}

type Tab = 'missing' | 'unexpected' | 'to-print' | 'different-art' | 'duplicates' | 'other-set' | 'unknown';

const NOTHING_SHARED = 'Nothing arrived from the share. Try Choose files instead.';

/** Upstream's names, fetched by this device or saved on the Update page by the Owner. */
interface UpstreamNames {
  names: string[];
  fetched_at: string;
  saved: boolean;
}
const wholeCube = (names: readonly string[]) => names.length >= LIST_MIN && names.length <= LIST_MAX;

/** One line per tab: what the list means and what to do with it. */
const TAB_HINT: Record<Tab, string> = {
  missing: 'On the List but not scanned: look for these in the box.',
  unexpected: 'Scanned but not in the Cube record: take these out. The Owner can record them as in the box first; they then count under To pull in the Cube, and an Update that wants one knows the box has it.',
  'to-print': 'On the List and marked To print, but the scan found it. If the box really has it, say so and it leaves the print batch.',
  'different-art': 'Scanned with other art than the In-box Printing: check the card in the box.',
  duplicates: 'Scanned more than once: take out the extra copies.',
  'other-set': 'Same art as the In-box Printing but another set or number. Probably the scanner guessed the wrong Printing; counted as present.',
  unknown: 'No scanned row of these cards could be matched to a Printing, so the art was not checked.',
};

export function ScanView({ cards, query }: { cards: Card[]; query: URLSearchParams }) {
  const [session, setSession] = useState<ScanSession>(loadSession);
  const [printings, setPrintings] = useState<Map<string, ResolvedPrinting>>(new Map());
  const [progress, setProgress] = useState<ResolveProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Errors of the Owner row actions show in the tab panel, next to the rows; the page error is off-screen there.
  const [rowError, setRowError] = useState<string | null>(null);
  // "Record as in the box" in progress: its progress text, or null.
  const [recording, setRecording] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{ pile: Pile; index: number } | null>(null);
  const [paste, setPaste] = useState('');
  const [tab, setTab] = useState<Tab>('missing');
  const fileInput = useRef<HTMLInputElement>(null);
  const nameBox = useRef<HTMLDivElement>(null);
  const [needName, setNeedName] = useState(false);

  const expected: ExpectedCard[] = useMemo(() => expectedCards(cards), [cards]);
  const toPrint = useMemo(() => toPrintCards(cards), [cards]);
  const known = useMemo(() => knownPrintings(cards), [cards]);
  const byOracle = useMemo(() => new Map(cards.map((c) => [c.oracle_id, c])), [cards]);
  const { store, auth, save } = useStore();
  const cardStates = useCardStates();
  const scans = useScans();
  const [by, setBy] = useDisplayName();
  const [included, setIncluded] = useState<string[]>(loadIncluded);
  const [sharedFrom, setSharedFrom] = useState<Record<string, string>>(loadSharedFrom);
  useEffect(() => saveIncluded(included), [included]);
  useEffect(() => saveSharedFrom(sharedFrom), [sharedFrom]);
  // Local camera piles whose photos have not all been uploaded (local pile id -> shared pile id).
  const [photosPending, setPhotosPendingState] = useState<Record<string, string>>(loadPhotosPending);
  const [upload, setUpload] = useState<PhotoUpload | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  // This device's piles plus the ticked shared piles; a pile shared from here counts once.
  const diffPiles = useMemo(
    () => pilesForDiff(session.piles, scans.data, new Set(included), sharedFrom),
    [session.piles, scans.data, included, sharedFrom],
  );
  const rows = useMemo(() => mergedRows(diffPiles), [diffPiles]);
  const diff = useMemo(() => diffScan(expected, rows, printings, toPrint), [expected, rows, printings, toPrint]);

  useEffect(() => saveSession(session), [session]);

  // Files shared from another app arrive as #/scan?shared=1; sw.js sends shared=0 when it
  // could store nothing.
  const sharedFlag = query.get('shared');
  useEffect(() => {
    if (sharedFlag === null) return;
    if (sharedFlag !== '1') {
      setNotice(NOTHING_SHARED);
      replaceHash('#/scan');
      return;
    }
    // No unmount guard: the files are deleted from the cache as they are read, so the result
    // must be kept even if this effect is cleaned up meanwhile (React StrictMode runs it twice).
    takeSharedFiles()
      .then((files) => {
        if (files === null) return; // Another call is importing them.
        if (files.length > 0) {
          const piles = files.map((f) => makePile(f.label, parseScanText(f.text)));
          setSession((s) => ({ ...s, piles: [...s.piles, ...piles] }));
          setNotice(`Imported ${files.length} shared ${files.length === 1 ? 'file' : 'files'}.`);
        } else {
          setNotice(NOTHING_SHARED);
        }
        replaceHash('#/scan');
      })
      .catch((e: unknown) => {
        console.warn('Could not read the shared file', e);
        setError('Could not read the shared file. Try Choose files instead.');
      });
  }, [sharedFlag]);

  // Resolve scanned Printings whenever the piles change. What cards.json and the cache already
  // know is shown at once; Scryfall fills in the rest. A newer run cancels the older one.
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setPrintings(localPrintings(rows, known).printings);
    void resolvePrintings(rows, known, {
      signal: controller.signal,
      onProgress: (p) => {
        if (!controller.signal.aborted) setProgress(p);
      },
    }).then((result) => {
      if (result.aborted) return;
      setPrintings(result.printings);
      setProgress(null);
      if (result.error) {
        console.warn('Scryfall lookup stopped:', result.error);
        setError('Could not reach Scryfall (no connection?). Names are still compared; art will be checked next time.');
      }
    });
    return () => controller.abort();
  }, [rows, known]);

  async function addFiles(list: FileList | null) {
    if (!list) return;
    const piles: Pile[] = [];
    for (const file of Array.from(list)) {
      piles.push(makePile(file.name, parseScanText(await file.text())));
    }
    setSession((s) => ({ ...s, piles: [...s.piles, ...piles] }));
    if (fileInput.current) fileInput.current.value = '';
  }

  function addPaste() {
    const parsed = parseScanText(paste);
    if (parsed.length === 0) return;
    setSession((s) => ({ ...s, piles: [...s.piles, makePile(`Pasted list ${s.piles.length + 1}`, parsed)] }));
    setPaste('');
  }

  function sharePile(pile: Pile) {
    if (!store) return;
    if (!by.trim()) {
      // The error used to render far below the button, off-screen on a phone: ask at the field.
      setNeedName(true);
      nameBox.current?.querySelector('input')?.focus();
      return;
    }
    setNeedName(false);
    if (pile.rows.length > MAX_PILE_ROWS) {
      setError(`A shared pile holds at most ${MAX_PILE_ROWS} rows; this one has ${pile.rows.length}. Split it into smaller files.`);
      return;
    }
    setError(null);
    if (pile.camera) {
      void shareCamera(pile);
      return;
    }
    void save(() => {
      const { id, written } = store.createScanPile(sharedPileInput(pile, by));
      setSharedFrom((m) => ({ ...m, [pile.id]: id }));
      return written;
    }, `Shared ${pile.label}.`);
  }

  function markPending(localId: string, sharedId: string | null) {
    setPhotosPending(localId, sharedId);
    setPhotosPendingState(loadPhotosPending());
  }

  /**
   * A pile from the camera: shared with its photos when they are still on this device, else as
   * rows only (marked camera). `resumeId` continues a stopped photo upload of that shared pile.
   */
  async function shareCamera(pile: Pile, resumeId: string | null = null) {
    if (!store || (upload && upload.pileId === pile.id && !upload.done && !upload.error)) return;
    setUpload({ pileId: pile.id, progress: null, error: null, done: false });
    const onProgress = (progress: UploadProgress) => setUpload({ pileId: pile.id, progress, error: null, done: false });
    try {
      const { PhotosGoneError, resumeCameraPhotos, shareCameraPile, shotsOfPile } = await loadSharePhotos();
      const shots = await shotsOfPile(pile);
      if (resumeId && shots.length > 0) {
        try {
          await resumeCameraPhotos(store, resumeId, pile, shots, onProgress);
        } catch (e) {
          if (!(e instanceof PhotosGoneError)) throw e;
          setUpload(null);
          markPending(pile.id, null);
          setError(`${pile.label}: ${e.message}`);
          return;
        }
        markPending(pile.id, null);
        setUpload({ pileId: pile.id, progress: null, error: null, done: true });
        setNotice(`Uploaded the rest of the photos of ${pile.label}.`);
        return;
      }
      if (shots.length === 0) {
        setUpload(null);
        if (resumeId) {
          markPending(pile.id, null);
          setError(`The photos of ${pile.label} are no longer on this device; the shared pile keeps the photos that arrived.`);
          return;
        }
        void save(() => {
          const { id, written } = store.createScanPile({ ...sharedPileInput(pile, by), camera: true });
          setSharedFrom((m) => ({ ...m, [pile.id]: id }));
          return written;
        }, `Shared ${pile.label} without photos; they are no longer on this device.`);
        return;
      }
      const res = await shareCameraPile(store, pile, by, shots, {
        onShared: (id) => {
          setSharedFrom((m) => ({ ...m, [pile.id]: id }));
          markPending(pile.id, id);
        },
        onProgress,
      });
      markPending(pile.id, null);
      setUpload({ pileId: pile.id, progress: null, error: null, done: true });
      setNotice(
        res.withoutPhotos
          ? `Shared ${pile.label} without photos: the new Firestore rules are not pasted yet. Paste them, delete the shared pile and share again for the photos.`
          : `Shared ${pile.label} with ${shots.length} ${shots.length === 1 ? 'photo' : 'photos'}.`,
      );
    } catch (e) {
      console.warn('Sharing the camera pile failed', e);
      setUpload({ pileId: pile.id, progress: null, error: errorText(e, PHOTOS_DENIED), done: false });
    }
  }

  /** Owner: the scanned Printing is what is in the box. Writes the In-box Printing; Wanted stays. */
  async function boxHasThis(r: CardResult) {
    if (!store) return;
    const card = byOracle.get(r.card.oracle_id);
    const s = r.scanned;
    if (!card || !s) return;
    if (cardStates.status !== 'ready') {
      setError('The shared card state has not loaded yet. Try again in a moment.');
      return;
    }
    try {
      const id =
        s.scryfall_id ??
        r.rows.find((x) => x.printing === s && x.scryfall_id)?.scryfall_id ??
        (await lookupPrinting(s.set, s.collector_number, known))?.scryfall_id;
      if (!id) {
        setError(`Could not find ${s.set.toUpperCase()} ${s.collector_number} on Scryfall.`);
        return;
      }
      await save(
        () =>
          store.updateCard(card.oracle_id, {
            kind: 'in_box',
            in_box: {
              scryfall_id: id,
              set: s.set,
              collector_number: s.collector_number,
              illustration_id: s.illustration_id,
              name: s.name,
              source: 'scan',
              confidence: 'high',
            },
          }),
        `In-box Printing of ${card.name} set to ${s.set.toUpperCase()} ${s.collector_number}.`,
      );
    } catch (e) {
      console.warn('Box has this printing failed', e);
      setError(`Could not look up ${s.set.toUpperCase()} ${s.collector_number} (no connection?). Try again.`);
    }
  }

  /** Owner: List cards that are not in the box (never printed, or lost). They go to the print batch. */
  async function notInBox(list: ExpectedCard[], doneText: string) {
    if (!store || list.length === 0) return;
    if (cardStates.status !== 'ready') {
      setRowError('The shared card state has not loaded yet. Try again in a moment.');
      return;
    }
    setRowError(null);
    await save(
      () =>
        list.length === 1
          ? store.updateCard(list[0]!.oracle_id, { kind: 'not_in_box' })
          : store.updateCards(list.map((c) => ({ oracle_id: c.oracle_id, patch: { kind: 'not_in_box' } }))),
      doneText,
    );
  }

  /**
   * Owner: Unexpected cards are in the box, so the record gets a doc for each: in the box as the
   * scanned Printing, off the List (To pull in the Cube). Facts come from Scryfall by name. A name
   * the record knows after all (an alias) is skipped and named; "Box has this printing" is for those.
   */
  async function recordInBox(list: UnexpectedResult[]) {
    if (!store || list.length === 0 || recording !== null) return;
    // A new doc must never land on one the server has: only from a server snapshot.
    if (cardStates.status !== 'ready' || cardStates.fromCache) {
      setRowError('The shared card state has not loaded from the server yet. Try again in a moment.');
      return;
    }
    setRowError(null);
    const lookup = { bySetNumber: (set: string, number: string) => lookupPrinting(set, number, known), byId: (id: string) => lookupById(id, known) };
    const problems: string[] = [];
    const patches: CardPatchFor[] = [];
    const seen = new Set<string>();
    try {
      setRecording(`Looking up ${list.length} ${list.length === 1 ? 'card' : 'cards'} on Scryfall…`);
      const facts = await fetchFacts(list.map((u) => u.name));
      let n = 0;
      for (const u of list) {
        setRecording(`Recording ${++n} of ${list.length}…`);
        const hit = facts.get(u.name);
        if (!hit) {
          problems.push(`${u.name} (not found on Scryfall)`);
          continue;
        }
        const existing = byOracle.get(hit.oracle_id);
        if (existing) {
          problems.push(`${u.name} (already in the record as ${existing.name})`);
          continue;
        }
        if (seen.has(hit.oracle_id)) continue;
        seen.add(hit.oracle_id);
        let inBox = await scannedInBox(u.rows, lookup);
        if (!inBox) {
          // No scanned Printing resolved: Scryfall's Printing of the name, at confidence medium.
          const p = await lookupById(hit.scryfall_id, known);
          if (!p) {
            problems.push(`${u.name} (no Printing found)`);
            continue;
          }
          inBox = { scryfall_id: hit.scryfall_id, set: p.set, collector_number: p.collector_number, illustration_id: p.illustration_id, name: p.name, source: 'scan', confidence: 'medium' };
        }
        patches.push({ oracle_id: hit.oracle_id, patch: { kind: 'new_card', state: recordedCardState(hit, inBox) } });
      }
    } catch (e) {
      console.warn('Recording unexpected cards failed', e);
      setRowError(`Could not look the cards up (no connection?). Nothing was written. ${errorText(e)}`);
      setRecording(null);
      return;
    }
    setRecording(null);
    if (problems.length > 0) setRowError(`Not recorded: ${problems.join(', ')}.`);
    if (patches.length === 0) return;
    await save(
      () => store.updateCards(patches),
      `${patches.length} ${patches.length === 1 ? 'card' : 'cards'} recorded as in the box, off the List; ${patches.length === 1 ? 'it is' : 'they are'} under To pull in the Cube.`,
    );
  }

  function recordUnexpected(list: UnexpectedResult[]) {
    const n = list.length;
    const cardsWord = n === 1 ? 'card' : 'cards';
    if (!window.confirm(`Record ${n} unexpected ${cardsWord} as in the box? ${n === 1 ? 'It gets' : 'They get'} a card record, off the List, and ${n === 1 ? 'shows' : 'show'} under To pull in the Cube.`)) return;
    void recordInBox(list);
  }

  function markMissingNotInBox(list: ExpectedCard[]) {
    const n = list.length;
    const cardsWord = n === 1 ? 'card' : 'cards';
    if (!window.confirm(`Mark ${n} missing ${cardsWord} as not in the box? They go to the print batch and will be printed.`)) return;
    void notInBox(list, `${n} ${cardsWord} marked not in the box; they go to the print batch.`);
  }

  /**
   * Owner: the box has a card that is marked To print. Writes the In-box Printing from the scanned
   * Printing when one can be found, else from the Wanted Printing.
   */
  async function boxHasToPrint(f: ToPrintResult) {
    if (!store) return;
    const card = byOracle.get(f.card.oracle_id);
    if (!card) return;
    if (cardStates.status !== 'ready') {
      setRowError('The shared card state has not loaded yet. Try again in a moment.');
      return;
    }
    setRowError(null);
    let in_box: InBoxState;
    try {
      in_box = await inBoxForToPrint(f.rows, card.wanted, {
        bySetNumber: (set, number) => lookupPrinting(set, number, known),
        byId: (id) => lookupById(id, known),
      });
    } catch (e) {
      console.warn('Box has this failed', e);
      setRowError(`Could not look up the scanned printing of ${card.name} (no connection?). Try again.`);
      return;
    }
    const b = in_box;
    await save(
      () => store.updateCard(card.oracle_id, { kind: 'in_box', in_box: b }),
      `${card.name} is in the box as ${b.set.toUpperCase()} ${b.collector_number}; it leaves the print batch.`,
    );
  }

  function removePile(id: string) {
    const index = session.piles.findIndex((p) => p.id === id);
    const pile = session.piles[index];
    if (!pile) return;
    setRemoved({ pile, index });
    setSession((s) => ({ ...s, piles: s.piles.filter((p) => p.id !== id) }));
  }

  function undoRemove() {
    if (!removed) return;
    const { pile, index } = removed;
    setSession((s) => {
      const piles = [...s.piles];
      piles.splice(Math.min(index, piles.length), 0, pile);
      return { ...s, piles };
    });
    setRemoved(null);
  }

  function toggle(key: string) {
    setSession((s) => {
      const resolved = { ...s.resolved };
      if (resolved[key]) delete resolved[key];
      else resolved[key] = true;
      return { ...s, resolved };
    });
  }

  function exportJson() {
    const body = JSON.stringify(
      { exported_at: new Date().toISOString(), started_at: session.started_at, piles: session.piles, diff, resolved: session.resolved },
      null,
      1,
    );
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `cube-scan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyMissing() {
    const text = diff.missing.map((c) => c.name).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${diff.missing.length} names.`);
    } catch {
      setNotice('Copying was blocked by the browser.');
    }
  }

  function clearAll() {
    if (!window.confirm('Clear the imported piles and the Resolved marks?')) return;
    clearSession();
    setSession(emptySession());
    setNotice(null);
    setRemoved(null);
  }

  const t = diff.totals;
  const withArt = [...diff.present, ...diff.duplicates];
  const differentArt = withArt.filter((r) => r.verdict === 'different-art');
  const otherSet = withArt.filter((r) => r.verdict === 'same-art-other-set');
  const unknown = withArt.filter((r) => r.verdict === 'unknown');
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'missing', label: 'Missing', count: t.missing },
    { id: 'unexpected', label: 'Unexpected', count: t.unexpected },
    { id: 'to-print', label: 'Found, to print', count: t.foundToPrint },
    { id: 'different-art', label: 'Different art', count: t.differentArt },
    { id: 'duplicates', label: 'Duplicates', count: t.duplicates },
    { id: 'other-set', label: 'Other set', count: t.sameArtOtherSet },
    { id: 'unknown', label: 'Unknown art', count: t.unknown },
  ];
  // Tabs pattern: arrow keys, Home and End move the selection and the focus.
  function onTabKey(e: KeyboardEvent) {
    const i = tabs.findIndex((x) => x.id === tab);
    const next =
      e.key === 'ArrowRight' ? (i + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    setTab(id);
    document.getElementById(`scan-tab-${id}`)?.focus();
  }
  const hasPiles = diffPiles.length > 0;
  const hasLocalPiles = session.piles.length > 0;
  const sharedIds = new Set(scans.data.map((s) => s.id));
  // The shared pile whose photos are open; the panel closes by itself when the pile is deleted.
  const reviewing = reviewId ? scans.data.find((s) => s.id === reviewId) ?? null : null;
  const canEditShared = (p: SharedPile) => auth.isOwner || (!!auth.uid && p.createdByUid === auth.uid);
  // Scryfall is still being asked: the art tabs are not final yet.
  const checking = progress !== null && progress.done < progress.total;
  const artEmpty = (text: string) => (checking ? 'Checking art…' : text);

  const canWrite = auth.isOwner && !!store;
  // Only List cards can go to the print batch; a missing card that is To pull is not offered.
  const onList = (c: Pick<ExpectedCard, 'oracle_id'>) => byOracle.get(c.oracle_id)?.in_list === true;
  const unresolvedMissing = notInBoxCandidates(diff.missing, (id) => onList({ oracle_id: id }), session.resolved);
  const unresolvedUnexpected = diff.unexpected.filter((u) => !session.resolved[`unexpected:${normalizeName(u.name)}`]);
  // Owner writes wait for the shared card state, the way CardActions does.
  const statesReady = cardStates.status === 'ready';

  const imageOf = (c: ExpectedCard) => byOracle.get(c.oracle_id)?.in_box?.image_small ?? c.in_box.image_small;

  // The box against Upstream: the scanned piles compared straight with the proposed List (Upstream
  // with the Winner's Picks kept and the Bans left out). The Winner's Picks come from the shared Log,
  // so the diff waits for it; before that every Winner's Pick would show as a pull.
  const upstreamMeta = useUpstreamMetaDoc();
  const log = useLog();
  const overrides = useOverrides();
  const stickyReady = log.status === 'ready' && !log.fromCache && overrides.status === 'ready' && !overrides.fromCache;
  // The shared Log could not be read (offline, or Firestore's daily quota is spent): compare
  // without the Winner's Picks and Bans rather than not at all, and say so.
  const stickyFailed =
    log.status === 'error' || log.status === 'unavailable' || overrides.status === 'error' || overrides.status === 'unavailable';
  const sticky = useMemo(() => (stickyReady ? stickySets(overrides.data, log.data) : { adds: [], bans: [] }), [stickyReady, overrides.data, log.data]);
  const names = useMemo(() => nameIndex(cards), [cards]);
  const [fetchedUpstream, setFetchedUpstream] = useState<UpstreamNames | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  // The Owner's saved snapshot (Update page) serves until this device fetches its own.
  const savedUpstream = useMemo((): UpstreamNames | null => {
    const m = toUpstreamMeta(upstreamMeta.data);
    return m.fetched_at && wholeCube(m.upstream_names) ? { names: m.upstream_names, fetched_at: m.fetched_at, saved: true } : null;
  }, [upstreamMeta.data]);
  const upstream = fetchedUpstream ?? savedUpstream;
  const boxDiff = useMemo(() => {
    if (!upstream || !(stickyReady || stickyFailed)) return null;
    const key = (n: string) => keyOf(names, n);
    const { proposed } = proposedList({ upstream: upstream.names, sticky, keyOf: key, also: rows.map((r) => r.name) });
    return boxAgainstUpstream(diff, proposed, key);
  }, [upstream, stickyReady, stickyFailed, names, sticky, rows, diff]);
  // The lists split by the record: on the List (in_list) or not.
  const onListCard = (c: BoxCard) => (c.oracle_id ? byOracle.get(c.oracle_id)?.in_list === true : false);
  const printListed = boxDiff?.print.filter(onListCard) ?? [];
  const printNew = boxDiff?.print.filter((c) => !onListCard(c)) ?? [];
  const pullCuts = boxDiff?.pull.filter(onListCard) ?? [];
  const pullOff = boxDiff?.pull.filter((c) => !onListCard(c)) ?? [];
  // Wanted and in the box, but not on the List: an Update calls them adds, yet they need no printing.
  const keptOffList = boxDiff?.kept.filter((c) => !onListCard(c)) ?? [];

  async function compareUpstream() {
    setComparing(true);
    setCompareError(null);
    try {
      const list = await fetchCubelist(UPSTREAM_ID);
      if (!wholeCube(list)) {
        throw new Error(`CubeCobra returned ${list.length} names for ${UPSTREAM_ID}, which does not look like a whole cube (expected ${LIST_MIN} to ${LIST_MAX}); not used.`);
      }
      setFetchedUpstream({ names: list, fetched_at: new Date().toISOString(), saved: false });
    } catch (e) {
      setCompareError(errorText(e));
    } finally {
      setComparing(false);
    }
  }

  async function copyNames(list: readonly BoxCard[], what: string) {
    try {
      await navigator.clipboard.writeText(list.map((c) => c.name).join('\n'));
      setNotice(`Copied ${list.length} names ${what}.`);
    } catch {
      setNotice('Copying was blocked by the browser.');
    }
  }

  return (
    <div className="scan">
      <h1>Scan</h1>
      <section className="panel import" aria-labelledby="import-head">
        <h2 id="import-head">Import</h2>
        <p className="muted">ManaBox CSV exports or a plain list, one card per line. Each file is one pile: a box or stack scanned together.</p>
        {!hasLocalPiles && (
          <ol className="howto">
            <li>In ManaBox, make a binder for the Cube (or one per box or pile) and scan the cards into it with Quick Mode, in any order.</li>
            <li>Open the binder and export it as CSV.</li>
            <li>
              Share the CSV file to Cube. Sharing works only after installing this site: Chrome menu, Add to Home screen.
              Or pick the file here with Choose files.
            </li>
            <li>Add one file per pile; the counts are added up. Then work through the tabs.</li>
          </ol>
        )}
        <p>
          <a className="button" href="#/camera">
            Scan with the camera
          </a>
        </p>
        <label className="button">
          Choose files
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            multiple
            accept=".csv,.txt,text/csv,text/plain"
            onChange={(e) => void addFiles(e.target.files)}
          />
        </label>
        <label className="paste">
          <span>Or paste a list</span>
          <textarea
            className="scan-paste"
            rows={4}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={'Lightning Bolt\n2x Counterspell\nSol Ring (C21) 263'}
          />
        </label>
        <button type="button" onClick={addPaste} disabled={!paste.trim()}>
          Add pasted list
        </button>
        {hasLocalPiles && (
          <ul className="piles">
            {session.piles.map((p) => {
              const sharedId = sharedFrom[p.id];
              const isShared = !!sharedId && (sharedIds.has(sharedId) || scans.status !== 'ready');
              const up = upload?.pileId === p.id ? upload : null;
              const uploading = !!up && !up.done && !up.error;
              const pending = isShared && photosPending[p.id] === sharedId;
              return (
                <li key={p.id}>
                  <span className="pile-label">{p.label}</span>
                  <span className="num muted">
                    {p.rows.length} rows{p.camera ? ` · camera${p.shotIds?.length ? `, ${p.shotIds.length} photos` : ''}` : ''}
                  </span>
                  {uploading ? (
                    <span className="muted">Sharing…</span>
                  ) : isShared ? (
                    <span className="muted">Shared</span>
                  ) : (
                    store && (
                      <button type="button" className="link" onClick={() => sharePile(p)}>
                        Share this pile
                      </button>
                    )
                  )}
                  {pending && !uploading && store && (
                    <button type="button" className="link" onClick={() => void shareCamera(p, sharedId)}>
                      Finish uploading the photos
                    </button>
                  )}
                  <button type="button" className="link" onClick={() => removePile(p.id)}>
                    Remove
                  </button>
                  {uploading && (
                    <p className="status num pile-upload" role="status">
                      {progressText(up.progress)}
                      {up.progress && <progress max={up.progress.total || 1} value={up.progress.done} />}
                    </p>
                  )}
                  {up?.error && (
                    <p className="status error pile-upload" role="alert">
                      {isShared ? 'Not all the photos were uploaded' : 'Not shared'}: {up.error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {hasLocalPiles && store && (
          <div ref={nameBox}>
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
                Write your name here first; it is shown on the shared pile. Then press Share this pile again.
              </p>
            )}
          </div>
        )}
      </section>

      {reviewing ? (
        <Suspense fallback={<p className="status muted">Loading the photos…</p>}>
          <SharedPhotoReview key={reviewing.id} pile={reviewing} canDecide={canEditShared(reviewing)} onClose={() => setReviewId(null)} />
        </Suspense>
      ) : (
        <SharedPiles
          live={scans}
          included={included}
          onToggle={(id) => setIncluded((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
          canDelete={canEditShared}
          onDelete={(p) => {
            if (!store || !window.confirm(`Delete the shared pile ${p.label}${p.shot_count ? ' and its photos' : ''}?`)) return;
            void save(() => store.deleteScanPile(p.id), `Deleted ${p.label}.`);
            setIncluded((cur) => cur.filter((x) => x !== p.id));
          }}
          onReview={(p) => setReviewId(p.id)}
        />
      )}

      {notice && <p className="notice" role="status">{notice}</p>}
      {removed && (
        <p className="notice" role="status">
          Removed {removed.pile.label}.{' '}
          <button type="button" className="link" onClick={undoRemove}>
            Undo
          </button>
        </p>
      )}
      {error && <p className="status error" role="alert">{error}</p>}
      {progress && (
        <p className="status num" role="status">
          Checking art on Scryfall: {progress.done} of {progress.total} printings
          <progress max={progress.total || 1} value={progress.done} />
        </p>
      )}

      {hasPiles && (
        <>
          <dl className="totals num">
            <Total label="On the List" value={t.expected} />
            <Total label="Scanned rows" value={t.scannedRows} />
            <Total label="Scanned names" value={t.scannedUniqueNames} />
            <Total label="Missing" value={t.missing} warn />
            <Total label="Unexpected" value={t.unexpected} warn />
            <Total label="Found, to print" value={t.foundToPrint} warn />
            <Total label="Duplicates" value={t.duplicates} warn />
            <Total label="Different art" value={t.differentArt} warn />
            <Total label="Unknown art" value={t.unknown} />
          </dl>

          <div className="actions">
            <button type="button" onClick={exportJson}>Export session JSON</button>
            <button type="button" onClick={() => void copyMissing()} disabled={diff.missing.length === 0}>
              Copy missing as list
            </button>
            <button type="button" className="danger" onClick={clearAll}>Clear session</button>
          </div>

          <div className="tabs" role="tablist" aria-label="Diff" onKeyDown={onTabKey}>
            {tabs.map((x) => (
              <button
                key={x.id}
                id={`scan-tab-${x.id}`}
                type="button"
                role="tab"
                aria-selected={tab === x.id}
                aria-controls="scan-panel"
                tabIndex={tab === x.id ? 0 : -1}
                className="tab"
                onClick={() => setTab(x.id)}
              >
                {x.label} <span className="count num">{x.count}</span>
              </button>
            ))}
          </div>

          <div role="tabpanel" id="scan-panel" aria-labelledby={`scan-tab-${tab}`} tabIndex={0}>
            <p className="muted">{TAB_HINT[tab]}</p>
            {canWrite && !statesReady && (tab === 'missing' || tab === 'to-print' || tab === 'unexpected') && (
              <p className="muted">Changes wait until the shared card state has loaded.</p>
            )}
            {rowError && (tab === 'missing' || tab === 'to-print' || tab === 'unexpected') && (
              <p className="status error" role="alert">{rowError}</p>
            )}
            {tab === 'missing' && (
              <>
                {canWrite && unresolvedMissing.length > 0 && (
                  <div className="actions">
                    <button type="button" onClick={() => markMissingNotInBox(unresolvedMissing)} disabled={!statesReady}>
                      Mark {unresolvedMissing.length} unresolved missing {unresolvedMissing.length === 1 ? 'card' : 'cards'} as not in the box
                    </button>
                  </div>
                )}
                <ItemList empty="Nothing missing.">
                  {diff.missing.map((c) => (
                    <Item key={c.oracle_id} k={`missing:${c.oracle_id}`} session={session} toggle={toggle}>
                      <Thumb src={imageOf(c)} />
                      <ItemText card={c} note={`In-box ${c.in_box.set.toUpperCase()} ${c.in_box.collector_number}`} />
                      {canWrite && onList(c) && (
                        <button
                          type="button"
                          className="link"
                          disabled={!statesReady}
                          onClick={() => void notInBox([c], `${c.name} marked not in the box; it goes to the print batch.`)}
                        >
                          Not in the box
                        </button>
                      )}
                    </Item>
                  ))}
                </ItemList>
              </>
            )}
            {tab === 'unexpected' && (
              <>
                {canWrite && unresolvedUnexpected.length > 0 && (
                  <div className="actions">
                    <button type="button" onClick={() => recordUnexpected(unresolvedUnexpected)} disabled={!statesReady || recording !== null}>
                      Record {unresolvedUnexpected.length} unresolved unexpected {unresolvedUnexpected.length === 1 ? 'card' : 'cards'} as in the box
                    </button>
                  </div>
                )}
                {recording && (
                  <p className="status num" role="status">
                    {recording}
                  </p>
                )}
                <ItemList empty="Nothing unexpected.">
                  {diff.unexpected.map((u) => (
                    <UnexpectedItem
                      key={u.name}
                      u={u}
                      session={session}
                      toggle={toggle}
                      onInBox={canWrite ? () => void recordInBox([u]) : undefined}
                      disabled={!statesReady || recording !== null}
                    />
                  ))}
                </ItemList>
              </>
            )}
            {tab === 'to-print' && (
              <ItemList empty="No card marked To print was scanned.">
                {diff.foundToPrint.map((f) => (
                  <ToPrintItem
                    key={f.card.oracle_id}
                    f={f}
                    image={byOracle.get(f.card.oracle_id)?.wanted.image_small}
                    session={session}
                    toggle={toggle}
                    onBoxHasThis={canWrite ? () => void boxHasToPrint(f) : undefined}
                    disabled={!statesReady}
                  />
                ))}
              </ItemList>
            )}
            {tab === 'different-art' && (
              <ItemList empty={artEmpty('No card with different art.')}>
                {differentArt.map((r) => (
                  <ArtItem
                    key={r.card.oracle_id}
                    r={r}
                    tab="different-art"
                    session={session}
                    toggle={toggle}
                    imageOf={imageOf}
                    onBoxHasThis={auth.isOwner && store && r.scanned ? () => void boxHasThis(r) : undefined}
                  />
                ))}
              </ItemList>
            )}
            {tab === 'duplicates' && (
              <ItemList empty="No duplicates.">
                {diff.duplicates.map((r) => (
                  <Item key={r.card.oracle_id} k={`duplicates:${r.card.oracle_id}`} session={session} toggle={toggle}>
                    <Thumb src={imageOf(r.card)} />
                    <ItemText card={r.card} note={duplicateNote(r)} />
                  </Item>
                ))}
              </ItemList>
            )}
            {tab === 'other-set' && (
              <>
                <ItemList empty={artEmpty('None.')}>
                  {otherSet.map((r) => (
                    <ArtItem key={r.card.oracle_id} r={r} tab="other-set" session={session} toggle={toggle} imageOf={imageOf} />
                  ))}
                </ItemList>
              </>
            )}
            {tab === 'unknown' && (
              <>
                <ItemList empty={artEmpty('None.')}>
                  {unknown.map((r) => (
                    <Item key={r.card.oracle_id} k={`unknown:${r.card.oracle_id}`} session={session} toggle={toggle}>
                      <Thumb src={imageOf(r.card)} />
                      <ItemText card={r.card} note={`Scanned ${r.count}`} />
                    </Item>
                  ))}
                </ItemList>
              </>
            )}
          </div>

          <section className="panel box-diff" aria-labelledby="box-diff-head">
            <h2 id="box-diff-head">The box against Upstream</h2>
            <p className="muted">
              The scanned piles compared straight with Upstream, the Arena Powered Cube ({UPSTREAM_ID}), with the Winner&rsquo;s Picks kept and
              the Bans left out as on the List. To pull: in the box but not wanted. To print: wanted but not in the box. Nothing in the record
              changes; this is the whole gap when the box skipped an Update.
            </p>
            <div className="actions">
              <button type="button" className="primary" disabled={comparing} onClick={() => void compareUpstream()}>
                {comparing ? 'Reading CubeCobra…' : fetchedUpstream ? 'Refresh Upstream' : 'Compare with Upstream'}
              </button>
              {boxDiff && (
                <>
                  <button type="button" onClick={() => void copyNames(boxDiff.pull, 'to pull')} disabled={boxDiff.pull.length === 0}>
                    Copy pull list
                  </button>
                  <button type="button" onClick={() => void copyNames(boxDiff.print, 'to print')} disabled={boxDiff.print.length === 0}>
                    Copy print list
                  </button>
                </>
              )}
            </div>
            {compareError && <p className="status error" role="alert">{compareError}</p>}
            {upstream ? (
              <p className="muted num">
                Upstream ({UPSTREAM_ID}): {upstream.names.length} cards · fetched {formatTime(upstream.fetched_at)}
                {upstream.saved ? ' (the snapshot saved on the Update page)' : ''}
              </p>
            ) : (
              <p className="muted">Not fetched yet.</p>
            )}
            {upstream && !stickyReady && !stickyFailed && <p className="muted">Waiting for the shared Log (Winner&rsquo;s Picks and Bans)…</p>}
            {upstream && stickyFailed && (
              <p className="status error">
                The shared Log could not be read, so the Winner&rsquo;s Picks and Bans are not applied here: a Winner&rsquo;s Pick shows under To
                pull, and a Ban under To print.
              </p>
            )}
            {boxDiff && (
              <>
                <dl className="totals num">
                  <Total label="In the box" value={boxDiff.box.length} />
                  <Total label="Upstream wants" value={boxDiff.proposed} />
                  <Total label="To pull" value={boxDiff.pull.length} warn />
                  <Total label="To print" value={boxDiff.print.length} warn />
                </dl>
                <p className="muted num">
                  To print: {printNew.length} not on the List, {printListed.length} on the List but never printed. To pull: {pullCuts.length} List
                  cards Upstream cuts, {pullOff.length} not on the List.
                  {keptOffList.length > 0 &&
                    ` In the box and wanted, though not on the List: ${keptOffList.length}; an Update lists them as adds, but they need no printing.`}
                </p>
                {keptOffList.length > 0 && (
                  <details className="muted">
                    <summary>The {keptOffList.length} wanted cards already in the box but not on the List</summary>
                    <p>{keptOffList.map((c) => c.name).join(', ')}</p>
                  </details>
                )}
                <h3 className="num">To pull: {boxDiff.pull.length}</h3>
                <p className="muted">
                  Take these out of the box; each says which pile it was scanned in. A name opens the card on the site, or on Scryfall when the
                  record does not know it.
                </p>
                <ItemList empty="Nothing to pull: Upstream wants everything in the box.">
                  {boxDiff.pull.map((c) => (
                    <BoxDiffItem key={c.key} c={c} side="pull" card={c.oracle_id ? byOracle.get(c.oracle_id) : undefined} session={session} toggle={toggle} />
                  ))}
                </ItemList>
                <h3 className="num">To print: {boxDiff.print.length}</h3>
                <p className="muted">
                  Open Printings on a card to choose the art; a card the record does not know yet opens on Scryfall. Once the Update is applied,
                  the <a href="#/print">Print tab</a> lists these with the PDF.
                </p>
                <ItemList empty="Nothing to print: the box has everything Upstream wants.">
                  {boxDiff.print.map((c) => (
                    <BoxDiffItem key={c.key} c={c} side="print" card={c.oracle_id ? byOracle.get(c.oracle_id) : undefined} session={session} toggle={toggle} />
                  ))}
                </ItemList>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** One line of the box against Upstream: a card to pull from the box or to print for it. */
function BoxDiffItem({
  c,
  side,
  card,
  session,
  toggle,
}: {
  c: BoxCard;
  side: 'pull' | 'print';
  card: Card | undefined;
  session: ScanSession;
  toggle: (k: string) => void;
}) {
  const image = side === 'pull' ? c.image_small ?? card?.in_box?.image_small ?? null : card?.wanted.image_small ?? null;
  const href = card ? `#/cube/${encodeURIComponent(card.oracle_id)}` : scryfallByName(c.name);
  const status =
    side === 'pull'
      ? card
        ? card.in_list
          ? 'Upstream cuts it'
          : 'Off the List already'
        : 'Not in the record'
      : card
        ? card.in_list
          ? 'On the List, not in the box'
          : 'In the record, off the List'
        : 'New: not in the record yet';
  const scanned = side === 'pull' ? `${c.count > 1 ? `${c.count} scanned` : '1 scanned'}${c.piles.length > 0 ? ` · in ${c.piles.join(', ')}` : ''} · ` : '';
  return (
    <Item k={`${side}:${c.key}`} session={session} toggle={toggle}>
      <Thumb src={image} />
      <span className="row-text">
        <a className="row-name" href={href} {...(card ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
          {c.name}
        </a>
        <span className="muted num">
          {scanned}
          {status}
          {card ? '' : ' · Scryfall'}
        </span>
      </span>
      {side === 'print' && card && (
        <a className="line-pick" href={printingsHash(card.oracle_id)}>
          Printings
        </a>
      )}
    </Item>
  );
}

function duplicateNote(r: CardResult): string {
  const seen = scannedPrintings(r.rows);
  const piles = pilesOf(r.rows);
  return `Scanned ${r.count} times, expected once${seen.length > 0 ? ` · ${seen.join(', ')}` : ''}${piles.length > 0 ? ` · in ${piles.join(', ')}` : ''}`;
}

function Total({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={warn && value > 0 ? 'total warn' : 'total'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ItemList({ children, empty }: { children: ReactNode[]; empty: string }) {
  if (children.length === 0) return <p className="status">{empty}</p>;
  return <ul className="items">{children}</ul>;
}

function Item({
  k,
  session,
  toggle,
  children,
}: {
  k: string;
  session: ScanSession;
  toggle: (k: string) => void;
  children: ReactNode;
}) {
  const done = !!session.resolved[k];
  return (
    <li className={done ? 'item done' : 'item'}>
      {children}
      <label className="resolved">
        <input type="checkbox" checked={done} onChange={() => toggle(k)} />
        Resolved
      </label>
    </li>
  );
}

function Thumb({ src, label }: { src: string | null | undefined; label?: string }) {
  return (
    <figure className="thumb-fig">
      {src ? <img className="thumb" src={src} alt="" loading="lazy" decoding="async" width={146} height={204} /> : <span className="thumb thumb-empty" />}
      {label && <figcaption className="num">{label}</figcaption>}
    </figure>
  );
}

function ItemText({ card, note }: { card: ExpectedCard; note: string }) {
  return (
    <span className="row-text">
      <a className="row-name" href={`#/cube/${encodeURIComponent(card.oracle_id)}`}>
        {card.name}
      </a>
      <span className="muted num">{note}</span>
    </span>
  );
}

function ArtItem({
  r,
  tab,
  session,
  toggle,
  imageOf,
  onBoxHasThis,
}: {
  r: CardResult;
  tab: Tab;
  session: ScanSession;
  toggle: (k: string) => void;
  imageOf: (c: ExpectedCard) => string;
  onBoxHasThis?: () => void;
}) {
  const s = r.scanned;
  const scannedLabel = s ? `Scanned ${s.set.toUpperCase()} ${s.collector_number}` : 'Scanned';
  const piles = pilesOf(r.rows);
  return (
    <Item k={`${tab}:${r.card.oracle_id}`} session={session} toggle={toggle}>
      <span className="row-text art-name">
        <a className="row-name" href={`#/cube/${encodeURIComponent(r.card.oracle_id)}`}>
          {r.card.name}
        </a>
        {tab === 'other-set' && <span className="muted">Probable scanner guess</span>}
        {piles.length > 0 && <span className="muted">in {piles.join(', ')}</span>}
      </span>
      <Thumb src={imageOf(r.card)} label={`In-box ${r.card.in_box.set.toUpperCase()} ${r.card.in_box.collector_number}`} />
      <Thumb src={s?.image_small} label={scannedLabel} />
      {onBoxHasThis && (
        <button type="button" onClick={onBoxHasThis}>
          Box has this printing
        </button>
      )}
    </Item>
  );
}

function UnexpectedItem({
  u,
  session,
  toggle,
  onInBox,
  disabled = false,
}: {
  u: UnexpectedResult;
  session: ScanSession;
  toggle: (k: string) => void;
  onInBox?: () => void;
  disabled?: boolean;
}) {
  const p = u.rows.find((r) => r.printing)?.printing ?? null;
  const first = u.rows[0];
  const piles = pilesOf(u.rows);
  const where = p
    ? `${p.set.toUpperCase()} ${p.collector_number}`
    : first?.set
      ? `${first.set.toUpperCase()} ${first.collector_number ?? ''}`
      : '';
  return (
    <Item k={`unexpected:${normalizeName(u.name)}`} session={session} toggle={toggle}>
      <Thumb src={p?.image_small} />
      <span className="row-text">
        <span className="row-name">{u.name}</span>
        <span className="muted num">
          {u.count > 1 ? `${u.count} scanned` : '1 scanned'}
          {where && ` · ${where}`}
          {piles.length > 0 && ` · in ${piles.join(', ')}`} · not in the record
        </span>
      </span>
      {onInBox && (
        <button type="button" className="link" onClick={onInBox} disabled={disabled}>
          In the box
        </button>
      )}
    </Item>
  );
}

function ToPrintItem({
  f,
  image,
  session,
  toggle,
  onBoxHasThis,
  disabled = false,
}: {
  f: ToPrintResult;
  image: string | undefined;
  session: ScanSession;
  toggle: (k: string) => void;
  onBoxHasThis?: () => void;
  disabled?: boolean;
}) {
  const p = f.rows.find((r) => r.printing)?.printing ?? null;
  const seen = scannedPrintings(f.rows);
  const piles = pilesOf(f.rows);
  return (
    <Item k={`to-print:${f.card.oracle_id}`} session={session} toggle={toggle}>
      <Thumb src={p?.image_small ?? image} />
      <span className="row-text">
        <a className="row-name" href={`#/cube/${encodeURIComponent(f.card.oracle_id)}`}>
          {f.card.name}
        </a>
        <span className="muted num">
          {f.count > 1 ? `${f.count} scanned` : '1 scanned'}
          {seen.length > 0 && ` · ${seen.join(', ')}`}
          {piles.length > 0 && ` · in ${piles.join(', ')}`} · marked To print
        </span>
      </span>
      {onBoxHasThis && (
        <button type="button" className="link" onClick={onBoxHasThis} disabled={disabled}>
          Box has this
        </button>
      )}
    </Item>
  );
}

function SharedPiles({
  live,
  included,
  onToggle,
  canDelete,
  onDelete,
  onReview,
}: {
  live: Live<SharedPile[]>;
  included: string[];
  onToggle: (id: string) => void;
  canDelete: (p: SharedPile) => boolean;
  onDelete: (p: SharedPile) => void;
  onReview: (p: SharedPile) => void;
}) {
  const piles = live.data;
  return (
    <section className="panel" aria-labelledby="shared-head">
      <h2 id="shared-head">Shared piles</h2>
      <p className="muted">Piles anyone in the group has shared. Tick the ones to include in the diff.</p>
      <LiveStatus live={live} what="piles" />
      {live.status === 'ready' && piles.length === 0 && (
        <p className="status">No shared piles yet. Use Share this pile on an imported pile.</p>
      )}
      {piles.length > 0 && (
        <ul className="piles">
          {piles.map((p) => (
            <li key={p.id}>
              <label className="check">
                <input type="checkbox" checked={included.includes(p.id)} onChange={() => onToggle(p.id)} />
                <span className="pile-label">{p.label}</span>
              </label>
              <span className="num muted">
                {p.row_count} rows · {p.by || 'someone'} · {formatTime(p.createdAt)}
              </span>
              {!!p.shot_count && (
                <>
                  <span className="num muted">
                    {p.shot_count} {p.shot_count === 1 ? 'photo' : 'photos'}
                    {p.to_review !== undefined && `, ${p.to_review} to review`}
                  </span>
                  <button type="button" className="link" onClick={() => onReview(p)}>
                    Review photos
                  </button>
                  <a href={reviewHash(p.id)}>Review at the desk</a>
                </>
              )}
              {canDelete(p) && (
                <button type="button" className="link" onClick={() => onDelete(p)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
