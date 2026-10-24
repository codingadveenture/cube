// #/log: Winner's Picks and Bans, newest first. The Owner adds, edits and imports entries.
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { errorText, useLog, useStore } from '../store/context';
import { newLogEntries, parseLogFile, sortLog } from '../store/logImport';
import type { LogEntry, LogEntryInput, LogType } from '../store/types';
import { Field, LiveStatus } from './common';

const TYPE_LABEL: Record<LogType, string> = { winner_pick: "Winner's Pick", ban: 'Ban' };

const EMPTY_ENTRY: LogEntryInput = { type: 'winner_pick', card_name: null, by: '', date: null, cut: null, note: '' };

export function LogView() {
  const live = useLog();
  const { auth } = useStore();
  const [adding, setAdding] = useState(false);
  const entries = useMemo(() => sortLog(live.data), [live.data]);
  return (
    <div className="log">
      <h1>Log</h1>
      <p className="muted">Winner&rsquo;s Picks stay in the List for good; Bans keep a card out for good.</p>
      {auth.isOwner && (
        <div className="actions">
          <button type="button" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            Add entry
          </button>
          <ImportLog existing={live.data} />
        </div>
      )}
      {adding && <EntryForm initial={EMPTY_ENTRY} onDone={() => setAdding(false)} />}
      <LiveStatus live={live} what="log entries" />
      {live.status === 'ready' && entries.length === 0 && <p className="status">No Winner&rsquo;s Picks or Bans yet.</p>}
      <ul className="items">
        {entries.map((e) => (
          <LogItem key={e.id} entry={e} />
        ))}
      </ul>
    </div>
  );
}

function LogItem({ entry }: { entry: LogEntry }) {
  const { auth } = useStore();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="item">
        <EntryForm initial={entry} id={entry.id} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="item">
      <span className="row-text">
        <span className="row-name">
          {TYPE_LABEL[entry.type]}: {entry.card_name ?? <span className="marker">pick pending</span>}
        </span>
        <span className="muted num">
          {entry.date ?? 'no date'}
          {entry.by && ` · ${entry.by}`}
          {entry.cut && ` · cut ${entry.cut}`}
        </span>
        {entry.note && <span>{entry.note}</span>}
      </span>
      {auth.isOwner && (
        <button type="button" className="link" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
    </li>
  );
}

function EntryForm({ initial, id, onDone }: { initial: LogEntryInput; id?: string; onDone: () => void }) {
  const { store, save } = useStore();
  const [e, setE] = useState<LogEntryInput>(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LogEntryInput>(k: K, v: LogEntryInput[K]) => setE((old) => ({ ...old, [k]: v }));
  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!store || busy) return;
    const entry: LogEntryInput = {
      type: e.type,
      card_name: e.card_name?.trim() || null,
      by: e.by.trim(),
      date: e.date || null,
      cut: e.cut?.trim() || null,
      note: e.note.trim(),
    };
    setBusy(true);
    try {
      const ok = id
        ? await save(() => store.updateLogEntry(id, entry), 'Log entry saved.')
        : await save(() => store.addLogEntry(entry), 'Log entry added.');
      if (ok) onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={(ev) => void submit(ev)}>
      <Field label="Kind">
        <select value={e.type} onChange={(ev) => set('type', ev.target.value as LogType)}>
          <option value="winner_pick">Winner&rsquo;s Pick</option>
          <option value="ban">Ban</option>
        </select>
      </Field>
      <Field label="Card (empty while the pick is pending)">
        <input type="text" value={e.card_name ?? ''} onChange={(ev) => set('card_name', ev.target.value)} maxLength={150} />
      </Field>
      <Field label="By">
        <input type="text" value={e.by} onChange={(ev) => set('by', ev.target.value)} maxLength={80} />
      </Field>
      <Field label="Date">
        <input type="date" value={e.date ?? ''} onChange={(ev) => set('date', ev.target.value || null)} />
      </Field>
      <Field label="Cut (the card that made room)">
        <input type="text" value={e.cut ?? ''} onChange={(ev) => set('cut', ev.target.value)} maxLength={150} />
      </Field>
      <Field label="Note">
        <textarea rows={2} value={e.note} onChange={(ev) => set('note', ev.target.value)} maxLength={1900} />
      </Field>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ImportLog({ existing }: { existing: LogEntry[] }) {
  const { store, save } = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file || !store) return;
    setError(null);
    try {
      const incoming = parseLogFile(JSON.parse(await file.text()));
      const fresh = newLogEntries(incoming, existing);
      const skipped = incoming.length - fresh.length;
      if (fresh.length === 0) {
        setError(`Nothing new: all ${incoming.length} entries are already in the log.`);
      } else {
        await save(
          () => store.addLogEntries(fresh),
          `Imported ${fresh.length} entries${skipped ? ` (${skipped} were already in the log)` : ''}.`,
        );
      }
    } catch (e) {
      setError(`Could not import the file: ${errorText(e)}`);
    } finally {
      if (input.current) input.current.value = '';
    }
  }
  return (
    <>
      <label className="button">
        Import log from file
        <input ref={input} className="visually-hidden" type="file" accept=".json,application/json" onChange={(e) => void pick(e.target.files)} />
      </label>
      {error && <p className="status error">{error}</p>}
    </>
  );
}
