// #/suggestions: send a Suggestion, see them all, and (Owner) accept or reject them.
import { useMemo, useState, type FormEvent } from 'react';
import type { Card } from '../types';
import { normalizeName } from '../lib/normalize';
import { applySuggestion, ApplyError } from '../store/apply';
import { cardStateOf } from '../store/baseline';
import { errorText, useCardStates, useOverrides, useStore, useSuggestions, type Live } from '../store/context';
import { lookupById, lookupPrinting } from '../store/lookup';
import { addsText, bansText } from '../store/paste';
import { sortSuggestions } from '../store/suggestions';
import { EMPTY_OVERRIDES, SUGGESTION_LABEL, SUGGESTION_TYPES, type Overrides, type Suggestion, type SuggestionType } from '../store/types';
import { knownPrintings } from '../scan/resolve';
import { CopyButton, Field, formatTime, LiveStatus, NameField, useDisplayName } from './common';

const STATUS_LABEL = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected' } as const;

export function SuggestionsView({ cards }: { cards: Card[] }) {
  const live = useSuggestions();
  const overrides = useOverrides();
  const cardStates = useCardStates();
  const sorted = useMemo(() => sortSuggestions(live.data), [live.data]);
  const openCount = sorted.filter((s) => s.status === 'open').length;
  return (
    <div className="suggestions">
      <h1>Suggestions</h1>
      <p className="muted">
        Anyone with the link can suggest a change. A Suggestion does nothing until the Owner confirms it.
      </p>
      <NewSuggestion cards={cards} />
      <PendingListChanges live={overrides} />
      <h2>
        All Suggestions <span className="count num">{openCount} open</span>
      </h2>
      <LiveStatus live={live} what="Suggestions" />
      {live.status === 'ready' && sorted.length === 0 && <p className="status">No Suggestions yet.</p>}
      <ul className="items">
        {sorted.map((s) => (
          <SuggestionItem
            key={s.id}
            s={s}
            cards={cards}
            overrides={overrides.data}
            cardsReady={cardStates.status === 'ready'}
            storedIds={cardStates.data}
          />
        ))}
      </ul>
    </div>
  );
}

function NewSuggestion({ cards }: { cards: Card[] }) {
  const { store, save, connection } = useStore();
  const [by, setBy] = useDisplayName();
  const [type, setType] = useState<SuggestionType>('add');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [set, setSet] = useState('');
  const [num, setNum] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const byName = useMemo(() => new Map(cards.map((c) => [normalizeName(c.name), c])), [cards]);
  const card = byName.get(normalizeName(name)) ?? null;
  const needsCard = type === 'art_flag' || type === 'printing';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!store || !by.trim() || !name.trim() || busy) return;
    setError(null);
    if (needsCard && !card) {
      setError('That card is not in the Cube. Pick a name from the list.');
      return;
    }
    setBusy(true);
    try {
      let printing = null;
      if (type === 'printing') {
        setLooking(true);
        try {
          const p = await lookupPrinting(set, num);
          if (!p || !p.scryfall_id) {
            setError(`No Printing ${set.toUpperCase()} ${num} on Scryfall.`);
            return;
          }
          printing = { set: p.set, collector_number: p.collector_number, scryfall_id: p.scryfall_id };
        } catch (err) {
          setError(errorText(err));
          return;
        } finally {
          setLooking(false);
        }
      }
      const ok = await save(
        () =>
          store.createSuggestion({
            type,
            card_name: card?.name ?? name.trim(),
            oracle_id: card?.oracle_id ?? null,
            printing,
            by,
            note,
          }),
        'Suggestion sent. The Owner will confirm it.',
      );
      if (ok) {
        setName('');
        setNote('');
        setSet('');
        setNum('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel">
      <summary>New Suggestion</summary>
      {!store ? (
        <p className="muted">
          {connection === 'connecting'
            ? 'Connecting…'
            : 'Sending Suggestions needs the shared data, which is not available on this device.'}
        </p>
      ) : (
      <form className="form" onSubmit={(e) => void submit(e)}>
        <NameField value={by} onChange={setBy} />
        <Field label="Kind of change">
          <select value={type} onChange={(e) => setType(e.target.value as SuggestionType)}>
            {SUGGESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {SUGGESTION_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Card">
          <input type="text" list="cube-card-names" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" maxLength={150} />
        </Field>
        <datalist id="cube-card-names">
          {cards.map((c) => (
            <option key={c.oracle_id} value={c.name} />
          ))}
        </datalist>
        {type === 'printing' && (
          <div className="inline-fields">
            <Field label="Set code">
              <input type="text" value={set} onChange={(e) => setSet(e.target.value)} required size={6} />
            </Field>
            <Field label="Collector number">
              <input type="text" value={num} onChange={(e) => setNum(e.target.value)} required size={6} />
            </Field>
          </div>
        )}
        <Field label="Note">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1900} />
        </Field>
        {error && <p className="status error">{error}</p>}
        <button type="submit" className="primary" disabled={busy || !by.trim() || !name.trim()}>
          {looking ? 'Looking up the Printing…' : busy ? 'Sending…' : 'Send Suggestion'}
        </button>
      </form>
      )}
    </details>
  );
}

function PendingListChanges({ live }: { live: Live<Overrides> }) {
  const { store, auth, save } = useStore();
  const o = live.data;
  if (live.status !== 'ready' || (o.adds.length === 0 && o.bans.length === 0)) return null;
  const adds = addsText(o);
  const bans = bansText(o);
  return (
    <section className="panel">
      <h2>Pending List changes</h2>
      <p className="muted">Accepted Suggestions that change the List. Make these on CubeCobra by hand.</p>
      {adds && (
        <>
          <h3>Add</h3>
          <pre className="paste-text">{adds}</pre>
        </>
      )}
      {bans && (
        <>
          <h3>Remove</h3>
          <pre className="paste-text">{bans}</pre>
        </>
      )}
      <div className="actions">
        <CopyButton text={adds} label="Copy adds" />
        <CopyButton text={bans} label="Copy removals" />
        {auth.isOwner && store && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (!window.confirm('Clear the pending List changes? Do this after updating CubeCobra.')) return;
              void save(() => store.setOverrides(EMPTY_OVERRIDES), 'Pending List changes cleared.');
            }}
          >
            Done on CubeCobra, clear
          </button>
        )}
      </div>
    </section>
  );
}

const CARD_TYPES: SuggestionType[] = ['art_flag', 'printing'];

function SuggestionItem({
  s,
  cards,
  overrides,
  cardsReady,
  storedIds,
}: {
  s: Suggestion;
  cards: Card[];
  overrides: Overrides;
  /** The shared card state has loaded; accepting a card change waits for it. */
  cardsReady: boolean;
  storedIds: ReadonlyMap<string, unknown>;
}) {
  const { store, auth, save } = useStore();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = s.oracle_id ? cards.find((c) => c.oracle_id === s.oracle_id) ?? null : null;

  const waitsForCards = CARD_TYPES.includes(s.type) && !cardsReady;

  async function accept() {
    if (!store || busy || waitsForCards) return;
    setError(null);
    setBusy(true);
    try {
      const now = new Date().toISOString();
      let printingDetails = null;
      if (s.type === 'printing' && s.printing) {
        const known = knownPrintings(cards);
        const p = s.printing.scryfall_id
          ? await lookupById(s.printing.scryfall_id, known)
          : await lookupPrinting(s.printing.set, s.printing.collector_number, known);
        if (p) printingDetails = { scryfall_id: p.scryfall_id ?? null, illustration_id: p.illustration_id, name: p.name };
      }
      const plan = applySuggestion(s, {
        card: card ? cardStateOf(card, now) : null,
        cardStored: !!s.oracle_id && storedIds.has(s.oracle_id),
        overrides,
        now,
        resolutionNote: note.trim() || null,
        printingDetails,
      });
      await save(() => store.resolveSuggestion(s.id, 'accepted', note.trim() || null, plan), 'Suggestion accepted.');
    } catch (e) {
      setError(e instanceof ApplyError ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!store || busy) return;
    setBusy(true);
    try {
      await save(() => store.resolveSuggestion(s.id, 'rejected', note.trim() || null, null), 'Suggestion rejected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`item suggestion status-${s.status}`}>
      <span className="row-text">
        <span className="row-name">
          {SUGGESTION_LABEL[s.type] ?? s.type}:{' '}
          {card ? <a href={`#/cube/${encodeURIComponent(card.oracle_id)}`}>{s.card_name}</a> : s.card_name || 'no card'}
        </span>
        {s.printing && (
          <span className="muted num">
            Printing {s.printing.set.toUpperCase()} {s.printing.collector_number}
          </span>
        )}
        {s.note && <span>{s.note}</span>}
        <span className="muted num">
          {STATUS_LABEL[s.status]} · by {s.by || 'someone'} · {formatTime(s.createdAt)}
        </span>
        {s.status !== 'open' && (
          <span className="muted">
            {s.status === 'accepted' ? 'Accepted' : 'Rejected'} {formatTime(s.resolvedAt)}
            {s.resolution_note ? `: ${s.resolution_note}` : ''}
          </span>
        )}
        {error && <span className="error">{error}</span>}
      </span>
      {auth.isOwner && s.status === 'open' && (
        <div className="resolve">
          <label className="field">
            <span>Resolution note (optional)</span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <div className="actions">
            <button type="button" className="primary" disabled={busy || waitsForCards} onClick={() => void accept()}>
              {busy ? 'Saving…' : 'Accept'}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void reject()}>
              Reject
            </button>
          </div>
          {waitsForCards && <p className="muted">Accept waits until the shared card state has loaded.</p>}
        </div>
      )}
    </li>
  );
}
