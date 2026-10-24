// Card detail actions: Flag the art, Suggest a change, and for the Owner the In-box Printing.
import { useMemo, useState, type FormEvent } from 'react';
import type { Card } from '../types';
import { useCardStates, useStore } from '../store/context';
import { lookupPrinting } from '../store/lookup';
import { plainError } from '../print/errors';
import { knownPrintings } from '../scan/resolve';
import { SUGGESTION_LABEL, SUGGESTION_TYPES, type SuggestionType } from '../store/types';
import { addFlagPatch } from '../store/writes';
import { Field, NameField, useDisplayName } from './common';

type Open = null | 'flag' | 'suggest' | 'box';

export function CardActions({ card, cards }: { card: Card; cards: Card[] }) {
  const { store, auth, save, connection } = useStore();
  const states = useCardStates();
  const [open, setOpen] = useState<Open>(null);
  const toggle = (o: Open) => setOpen((cur) => (cur === o ? null : o));
  if (!store) {
    if (connection === 'connecting') return <p className="muted">Connecting…</p>;
    return <p className="muted">Suggestions need the shared data, which is not available on this device right now.</p>;
  }
  // Owner card writes wait for the shared card state, so a card shown from cards.json alone
  // never decides what is written.
  const ownerReady = states.status === 'ready';
  const stored = states.data.has(card.oracle_id);
  return (
    <section className="panel actions-panel" aria-label="Changes">
      <div className="actions">
        <button type="button" aria-expanded={open === 'flag'} onClick={() => toggle('flag')} disabled={auth.isOwner && !ownerReady}>
          Flag the art
        </button>
        <button type="button" aria-expanded={open === 'suggest'} onClick={() => toggle('suggest')}>
          Suggest a change
        </button>
        {auth.isOwner && (
          <button type="button" aria-expanded={open === 'box'} onClick={() => toggle('box')} disabled={!ownerReady}>
            Box has a different printing
          </button>
        )}
        {auth.isOwner && card.flags.length > 0 && (
          <button
            type="button"
            className="danger"
            disabled={!ownerReady}
            onClick={() => {
              if (!window.confirm('Clear the Art flags on this card?')) return;
              void save(() => store.updateCard(card.oracle_id, { kind: 'clear_flags' }), 'Art flags cleared.');
            }}
          >
            Clear Art flags
          </button>
        )}
      </div>
      {auth.isOwner && !ownerReady && <p className="muted">Changes to this card wait until the shared card state has loaded.</p>}
      {open === 'flag' && (!auth.isOwner || ownerReady) && <FlagForm card={card} stored={stored} onDone={() => setOpen(null)} />}
      {open === 'suggest' && <SuggestForm card={card} onDone={() => setOpen(null)} />}
      {open === 'box' && ownerReady && <BoxPrintingForm card={card} cards={cards} onDone={() => setOpen(null)} />}
    </section>
  );
}

function FlagForm({ card, stored, onDone }: { card: Card; stored: boolean; onDone: () => void }) {
  const { store, auth, save } = useStore();
  const [by, setBy] = useDisplayName();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!store || !by.trim() || busy) return;
    setBusy(true);
    try {
      const flag = { type: 'art', by: by.trim(), note: note.trim(), createdAt: new Date().toISOString() };
      const ok = auth.isOwner
        ? await save(() => store.updateCard(card.oracle_id, addFlagPatch(card, flag, stored)), 'Art flag added.')
        : await save(
            () =>
              store.createSuggestion({ type: 'art_flag', card_name: card.name, oracle_id: card.oracle_id, printing: null, by, note }),
            'Suggestion sent. The Owner will confirm it.',
          );
      if (ok) onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <p className="muted">
        {auth.isOwner ? 'Adds an Art flag to the card.' : 'Sends a Suggestion; the Art flag appears once the Owner confirms it.'}
      </p>
      <NameField value={by} onChange={setBy} />
      <Field label="Reason">
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1900} />
      </Field>
      <button type="submit" className="primary" disabled={!by.trim() || busy}>
        {busy ? 'Saving…' : auth.isOwner ? 'Add Art flag' : 'Send Suggestion'}
      </button>
    </form>
  );
}

function SuggestForm({ card, onDone }: { card: Card; onDone: () => void }) {
  const { store, save } = useStore();
  const [by, setBy] = useDisplayName();
  const [type, setType] = useState<SuggestionType>('other');
  const [note, setNote] = useState('');
  const [set, setSet] = useState('');
  const [num, setNum] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!store || !by.trim() || busy) return;
    setError(null);
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
          console.error('Printing lookup:', err);
          setError(plainError(err, 'scryfall'));
          return;
        } finally {
          setLooking(false);
        }
      }
      const ok = await save(
        () => store.createSuggestion({ type, card_name: card.name, oracle_id: card.oracle_id, printing, by, note }),
        'Suggestion sent. The Owner will confirm it.',
      );
      if (ok) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <NameField value={by} onChange={setBy} />
      <Field label="Kind of change">
        <select value={type} onChange={(e) => setType(e.target.value as SuggestionType)}>
          {SUGGESTION_TYPES.filter((t) => t !== 'add').map((t) => (
            <option key={t} value={t}>
              {SUGGESTION_LABEL[t]}
            </option>
          ))}
        </select>
      </Field>
      {type === 'printing' && (
        <div className="inline-fields">
          <Field label="Set code">
            <input type="text" value={set} onChange={(e) => setSet(e.target.value)} required autoCapitalize="characters" autoCorrect="off" spellCheck={false} size={6} />
          </Field>
          <Field label="Collector number">
            <input type="text" value={num} onChange={(e) => setNum(e.target.value)} required autoCorrect="off" spellCheck={false} size={6} />
          </Field>
        </div>
      )}
      <Field label="Note">
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1900} />
      </Field>
      {error && <p className="status error">{error}</p>}
      <button type="submit" className="primary" disabled={!by.trim() || busy}>
        {looking ? 'Looking up the Printing…' : busy ? 'Sending…' : 'Send Suggestion'}
      </button>
    </form>
  );
}

function BoxPrintingForm({ card, cards, onDone }: { card: Card; cards: Card[]; onDone: () => void }) {
  const { store, save } = useStore();
  const known = useMemo(() => knownPrintings(cards), [cards]);
  const [set, setSet] = useState('');
  const [num, setNum] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!store || busy) return;
    setError(null);
    setBusy(true);
    try {
      const p = await lookupPrinting(set, num, known);
      if (!p || !p.scryfall_id) {
        setError(`No Printing ${set.toUpperCase()} ${num} on Scryfall.`);
        return;
      }
      const ok = await save(
        () =>
          store.updateCard(card.oracle_id, {
            kind: 'in_box',
            in_box: {
              scryfall_id: p.scryfall_id!,
              set: p.set,
              collector_number: p.collector_number,
              illustration_id: p.illustration_id,
              name: p.name,
              source: 'owner',
              confidence: 'high',
            },
          }),
        `In-box Printing set to ${p.set.toUpperCase()} ${p.collector_number}.`,
      );
      if (ok) onDone();
    } catch (err) {
      console.error('Printing lookup:', err);
      setError(plainError(err, 'scryfall'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <p className="muted">Records the Printing that is physically in the box. The Wanted Printing stays as it is, so a difference becomes a reprint.</p>
      <div className="inline-fields">
        <Field label="Set code">
          <input type="text" value={set} onChange={(e) => setSet(e.target.value)} required autoCapitalize="characters" autoCorrect="off" spellCheck={false} size={6} />
        </Field>
        <Field label="Collector number">
          <input type="text" value={num} onChange={(e) => setNum(e.target.value)} required autoCorrect="off" spellCheck={false} size={6} />
        </Field>
      </div>
      {error && <p className="status error">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !set.trim() || !num.trim()}>
        {busy ? 'Looking up the Printing…' : 'Save In-box Printing'}
      </button>
    </form>
  );
}
