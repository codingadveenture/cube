// Step 4 of an Update: hand the List back to CubeCobra as a CSV (Replace with CSV) or a paste text.
import { useMemo, useState } from 'react';
import type { Card } from '../../types';
import { todayIso } from '../../printings/defaultRule';
import type { UpdateHistoryEntry } from '../../store/types';
import { csvFileName, cubecobraCsv, cubecobraPaste, listBasics, listCards, pasteLine, type CubeJsonCard } from '../../upstream/cubecobra';
import { keyOf, type NameIndex } from '../../upstream/names';
import { fetchListJson } from '../../upstream/net';
import { CopyButton } from '../common';

export function ExportPanel({
  cards,
  cardsReady,
  lastUpdate,
  index,
}: {
  cards: Card[];
  /** False until the shared card state has come from the server: before that `cards` is cards.json only. */
  cardsReady: boolean;
  lastUpdate: UpdateHistoryEntry | null;
  index: NameIndex;
}) {
  // A paste only adds cards, so it defaults to the In cards of the last Update when there is one.
  const [chosen, setChosen] = useState<'list' | 'last' | null>(null);
  const scope = chosen ?? (lastUpdate ? 'last' : 'list');
  const onList = useMemo(() => listCards(cards), [cards]);
  const lastIn = useMemo(() => {
    if (!lastUpdate) return [];
    const byId = new Map(cards.map((c) => [c.oracle_id, c]));
    return lastUpdate.in.map((n) => byId.get(keyOf(index, n))).filter((c): c is Card => !!c && c.in_list);
  }, [cards, lastUpdate, index]);
  const paste = scope === 'list' ? cubecobraPaste(cards) : lastIn.map(pasteLine).join('\n');

  // "Replace with CSV" empties every board the file leaves out, so the basics board is read from
  // the List on CubeCobra at download time and written back as rows of its own.
  const [reading, setReading] = useState(false);
  const [basicsMissing, setBasicsMissing] = useState(false);

  async function download() {
    if (!cardsReady || reading) return;
    setReading(true);
    let basics: CubeJsonCard[] = [];
    let missing = false;
    try {
      basics = listBasics(await fetchListJson(AbortSignal.timeout(30_000)));
    } catch (e) {
      console.error('CubeCobra basics:', e);
      missing = true;
    } finally {
      setReading(false);
    }
    setBasicsMissing(missing);
    const blob = new Blob([cubecobraCsv(cards, basics)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(todayIso());
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="panel" aria-labelledby="export-head">
      <h2 id="export-head">4. Push to CubeCobra</h2>
      <p className="muted">
        CubeCobra has no way for this site to write, so the List goes back by hand. CubeCobra stores a Printing per card, so the CSV also pushes
        every Wanted Printing.
      </p>
      {!cardsReady && <p className="status">Waits until the shared card state has loaded from the server; until then the List here is incomplete.</p>}
      <h3>CSV, the whole List ({onList.length} cards)</h3>
      <ol className="howto">
        <li>Download the CSV. It also carries the cube&rsquo;s basics, read from CubeCobra as you download, so the replace keeps them.</li>
        <li>On CubeCobra open the Cube, choose Edit, then &ldquo;Replace with CSV&rdquo;, pick the file and confirm.</li>
      </ol>
      <p className="muted">After the replace, select all cards on CubeCobra and bulk-edit their status to Proxied, since the CSV&rsquo;s status only reaches the cards whose Printing changes.</p>
      {basicsMissing && (
        <p className="status error" role="alert">
          The basics could not be read from CubeCobra, so this CSV has none and the replace will remove the cube&rsquo;s basics. Add them back by hand on
          CubeCobra after the replace.
        </p>
      )}
      <div className="actions">
        <button type="button" className="primary" disabled={!cardsReady || onList.length === 0 || reading} onClick={() => void download()}>
          {reading ? 'Reading the basics from CubeCobra…' : `Download ${csvFileName(todayIso())}`}
        </button>
      </div>
      <h3>Paste text</h3>
      <ol className="howto">
        <li>Copy the In cards of the last Update: one &ldquo;1 Name [SET] number&rdquo; line per card.</li>
        <li>On CubeCobra choose Edit, then Bulk upload, and paste it. A paste only adds cards: remove the Out cards of the Update there by hand.</li>
      </ol>
      <div className="actions" role="group" aria-label="Which cards">
        <button type="button" aria-pressed={scope === 'last'} disabled={!lastUpdate} onClick={() => setChosen('last')}>
          In cards of the last Update{lastUpdate ? ` (${lastIn.length})` : ''}
        </button>
        <button type="button" aria-pressed={scope === 'list'} onClick={() => setChosen('list')}>
          Whole List (only for an empty cube)
        </button>
        <CopyButton text={paste} label="Copy paste text" disabled={!cardsReady} />
      </div>
      {scope === 'list' && (
        <p className="muted">Pasting the whole List into a cube that has cards adds every card a second time. Use the CSV instead.</p>
      )}
      <textarea className="paste-text" readOnly rows={6} value={cardsReady ? paste : ''} aria-label="Paste text for CubeCobra" />
    </section>
  );
}
