import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { replaceHash } from '../router';
import { parseScanText, type Pile } from '../scan/parse';
import {
  diffScan,
  type CardResult,
  type ExpectedCard,
  type ResolvedPrinting,
  type ToPrintResult,
  type UnexpectedResult,
  scannedPrintings,
} from '../scan/diff';
import { knownPrintings, localPrintings, resolvePrintings, type ResolveProgress } from '../scan/resolve';
import { expectedCards, toPrintCards } from '../scan/expected';
import { inBoxForToPrint, notInBoxCandidates } from '../scan/owner';
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
import { useCardStates, useScans, useStore, type Live } from '../store/context';
import { lookupById, lookupPrinting } from '../store/lookup';
import { MAX_PILE_ROWS, pilesForDiff, sharedPileInput } from '../store/piles';
import { loadIncluded, loadSharedFrom, saveIncluded, saveSharedFrom } from '../store/scanPrefs';
import type { InBoxState, SharedPile } from '../store/types';
import { formatTime, LiveStatus, NameField, useDisplayName } from './common';

type Tab = 'missing' | 'unexpected' | 'to-print' | 'different-art' | 'duplicates' | 'other-set' | 'unknown';

const NOTHING_SHARED = 'Nothing arrived from the share. Try Choose files instead.';

/** One line per tab: what the list means and what to do with it. */
const TAB_HINT: Record<Tab, string> = {
  missing: 'On the List but not scanned: look for these in the box.',
  unexpected: 'Scanned but not on the List: take these out.',
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
    void save(() => {
      const { id, written } = store.createScanPile(sharedPileInput(pile, by));
      setSharedFrom((m) => ({ ...m, [pile.id]: id }));
      return written;
    }, `Shared ${pile.label}.`);
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
  // Scryfall is still being asked: the art tabs are not final yet.
  const checking = progress !== null && progress.done < progress.total;
  const artEmpty = (text: string) => (checking ? 'Checking art…' : text);

  const canWrite = auth.isOwner && !!store;
  // Only List cards can go to the print batch; a missing card that is To pull is not offered.
  const onList = (c: Pick<ExpectedCard, 'oracle_id'>) => byOracle.get(c.oracle_id)?.in_list === true;
  const unresolvedMissing = notInBoxCandidates(diff.missing, (id) => onList({ oracle_id: id }), session.resolved);
  // Owner writes wait for the shared card state, the way CardActions does.
  const statesReady = cardStates.status === 'ready';

  const imageOf = (c: ExpectedCard) => byOracle.get(c.oracle_id)?.in_box?.image_small ?? c.in_box.image_small;

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
              return (
                <li key={p.id}>
                  <span className="pile-label">{p.label}</span>
                  <span className="num muted">{p.rows.length} rows</span>
                  {isShared ? (
                    <span className="muted">Shared</span>
                  ) : (
                    store && (
                      <button type="button" className="link" onClick={() => sharePile(p)}>
                        Share this pile
                      </button>
                    )
                  )}
                  <button type="button" className="link" onClick={() => removePile(p.id)}>
                    Remove
                  </button>
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

      <SharedPiles
        live={scans}
        included={included}
        onToggle={(id) => setIncluded((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
        canDelete={(p) => auth.isOwner || (!!auth.uid && p.createdByUid === auth.uid)}
        onDelete={(p) => {
          if (!store || !window.confirm(`Delete the shared pile ${p.label}?`)) return;
          void save(() => store.deleteScanPile(p.id), `Deleted ${p.label}.`);
          setIncluded((cur) => cur.filter((x) => x !== p.id));
        }}
      />

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
            {canWrite && !statesReady && (tab === 'missing' || tab === 'to-print') && (
              <p className="muted">Changes wait until the shared card state has loaded.</p>
            )}
            {rowError && (tab === 'missing' || tab === 'to-print') && (
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
              <ItemList empty="Nothing unexpected.">
                {diff.unexpected.map((u) => (
                  <UnexpectedItem key={u.name} u={u} session={session} toggle={toggle} />
                ))}
              </ItemList>
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
        </>
      )}
    </div>
  );
}

function duplicateNote(r: CardResult): string {
  const seen = scannedPrintings(r.rows);
  return `Scanned ${r.count} times, expected once${seen.length > 0 ? ` · ${seen.join(', ')}` : ''}`;
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
  return (
    <Item k={`${tab}:${r.card.oracle_id}`} session={session} toggle={toggle}>
      <span className="row-text art-name">
        <a className="row-name" href={`#/cube/${encodeURIComponent(r.card.oracle_id)}`}>
          {r.card.name}
        </a>
        {tab === 'other-set' && <span className="muted">Probable scanner guess</span>}
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
}: {
  u: UnexpectedResult;
  session: ScanSession;
  toggle: (k: string) => void;
}) {
  const p = u.rows.find((r) => r.printing)?.printing ?? null;
  const first = u.rows[0];
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
          {where && ` · ${where}`} · not on the List
        </span>
      </span>
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
  return (
    <Item k={`to-print:${f.card.oracle_id}`} session={session} toggle={toggle}>
      <Thumb src={p?.image_small ?? image} />
      <span className="row-text">
        <a className="row-name" href={`#/cube/${encodeURIComponent(f.card.oracle_id)}`}>
          {f.card.name}
        </a>
        <span className="muted num">
          {f.count > 1 ? `${f.count} scanned` : '1 scanned'}
          {seen.length > 0 && ` · ${seen.join(', ')}`} · marked To print
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
}: {
  live: Live<SharedPile[]>;
  included: string[];
  onToggle: (id: string) => void;
  canDelete: (p: SharedPile) => boolean;
  onDelete: (p: SharedPile) => void;
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
