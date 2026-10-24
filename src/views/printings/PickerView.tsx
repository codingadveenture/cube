// The Printing picker, #/cube/<oracle_id>/printings: every Printing of a card, one tile per art.
// The Owner sets the Wanted Printing; visitors send a printing Suggestion.
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { Card } from '../../types';
import { useCardStates, useStore } from '../../store/context';
import type { WantedReason } from '../../store/types';
import { defaultPrinting, isReleased, todayIso } from '../../printings/defaultRule';
import { smallImage } from '../../printings/images';
import { forgetPrintings, usePrintings } from '../../printings/load';
import {
  DEFAULT_FILTERS,
  badges,
  filterPrintings,
  groupByArt,
  type BorderFilter,
  type FrameFilter,
  type PickerFilters,
} from '../../printings/picker';
import { frameLabel } from '../../printings/style';
import type { IndexPrinting } from '../../printings/types';
import { wantedFromPrinting } from '../../printings/wanted';
import { previousHash, replaceHash } from '../../router';
import { NameField, useDisplayName } from '../common';
import { CycleSheet } from './CycleSheet';
import { printingLine } from './shared';

const FRAMES: [FrameFilter, string][] = [
  ['any', 'Any frame'],
  ['old', 'Old (1993, 1997)'],
  ['modern', 'Modern (2003, 2015)'],
  ['future', 'Future'],
];
const BORDERS: [BorderFilter, string][] = [
  ['any', 'Any border'],
  ['black', 'Black'],
  ['white', 'White'],
  ['borderless', 'Borderless'],
];

export default function PickerView({ cards, oracleId }: { cards: Card[]; oracleId: string }) {
  const card = cards.find((c) => c.oracle_id === oracleId);
  const [attempt, setAttempt] = useState(0);
  const state = usePrintings(oracleId, attempt);
  const errorMessage = state.status === 'error' ? state.message : null;
  useEffect(() => {
    if (errorMessage) console.warn(`Printings of ${oracleId}: ${errorMessage}`);
  }, [errorMessage, oracleId]);
  if (!card) {
    return (
      <div>
        <p className="status">No card with that id.</p>
        <p>
          <a href="#/cube">Back to the Cube</a>
        </p>
      </div>
    );
  }
  return (
    <article className="picker">
      <p>
        <BackToCard card={card} />
      </p>
      <h1>Printings of {card.name}</h1>
      <p className="muted num">
        Wanted: {printingLine(card.wanted)} · In-box: {card.in_box ? printingLine(card.in_box) : 'none (not printed yet)'}
      </p>
      {state.status === 'loading' && <p className="status">Loading the Printings…</p>}
      {state.status === 'error' && (
        <div className="status error" role="alert">
          <p>Could not load the Printings of this card. Check the connection and try again.</p>
          <button
            type="button"
            onClick={() => {
              forgetPrintings(oracleId);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' && <Picker card={card} cards={cards} printings={state.file.printings} />}
    </article>
  );
}

/**
 * Back to the card detail without a new history entry: a real Back when the detail is the page
 * before, else the picker entry is replaced. The detail's "Back to the Cube" then still returns
 * to the list the card was opened from.
 */
function BackToCard({ card }: { card: Card }) {
  const detail = `#/cube/${encodeURIComponent(card.oracle_id)}`;
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (previousHash() === detail) window.history.back();
    else replaceHash(detail);
  }
  return (
    <a href={detail} onClick={onClick}>
      Back to {card.name}
    </a>
  );
}

function Picker({ card, cards, printings }: { card: Card; cards: Card[]; printings: IndexPrinting[] }) {
  const { store, auth, save, connection } = useStore();
  const states = useCardStates();
  const [filters, setFilters] = useState<PickerFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ printing: IndexPrinting; reason: WantedReason } | null>(null);
  const [by, setBy] = useDisplayName();
  const [busy, setBusy] = useState(false);

  const isOwner = auth.isOwner;
  const ownerReady = isOwner && !!store && states.status === 'ready';
  const boxId = card.in_box?.scryfall_id ?? null;
  const pinned = useMemo(() => new Set([card.wanted.scryfall_id, ...(boxId ? [boxId] : [])]), [card.wanted.scryfall_id, boxId]);
  const shown = useMemo(() => filterPrintings(printings, filters, pinned), [printings, filters, pinned]);
  const groups = useMemo(() => groupByArt(shown, pinned), [shown, pinned]);
  const today = todayIso();
  const rule = useMemo(() => defaultPrinting(printings, today), [printings, today]);
  const set = <K extends keyof PickerFilters>(k: K, v: PickerFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  async function setWanted(p: IndexPrinting, reason: WantedReason) {
    if (!store || busy) return;
    if (card.cycles.length > 0) {
      setSheet({ printing: p, reason });
      return;
    }
    setBusy(true);
    try {
      await save(
        () => store.updateCard(card.oracle_id, { kind: 'wanted', wanted: wantedFromPrinting(p, card.name, reason) }),
        `Wanted Printing set to ${printingLine(p)}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function suggest(p: IndexPrinting) {
    if (!store || busy || !by.trim()) return;
    setBusy(true);
    try {
      await save(
        () =>
          store.createSuggestion({
            type: 'printing',
            card_name: card.name,
            oracle_id: card.oracle_id,
            printing: { set: p.set, collector_number: p.collector_number, scryfall_id: p.id },
            by,
            note: '',
          }),
        `Suggestion sent: ${printingLine(p)}. The Owner will confirm it.`,
      );
    } finally {
      setBusy(false);
    }
  }

  function action(p: IndexPrinting) {
    if (isOwner) {
      const current = p.id === card.wanted.scryfall_id;
      return (
        <button type="button" disabled={!ownerReady || busy || current} onClick={() => void setWanted(p, 'picked')}>
          {current ? 'Wanted now' : 'Set as Wanted'}
        </button>
      );
    }
    return (
      <button type="button" disabled={!store || busy || !by.trim()} onClick={() => void suggest(p)}>
        Suggest this Printing
      </button>
    );
  }

  if (printings.length === 0) {
    return <p className="status">This card has no paper Printing on Scryfall.</p>;
  }

  return (
    <>
      {!store && (
        <p className="notice">
          {connection === 'connecting' ? 'Connecting…' : 'Shared data is not available on this device; Printings can be browsed but not chosen.'}
        </p>
      )}
      {isOwner && store && !ownerReady && <p className="muted">Changes wait until the shared card state has loaded.</p>}
      {!isOwner && store && (
        <div className="form">
          <NameField value={by} onChange={setBy} />
          {!by.trim() && <p className="muted">Enter your name to suggest a Printing.</p>}
        </div>
      )}

      <section className="panel" aria-label="Default rule">
        {rule ? (
          <p>
            Default rule picks{' '}
            <strong className="num">
              {printingLine(rule)} · {rule.set_name} · {rule.released_at.slice(0, 4)}
            </strong>
            .
          </p>
        ) : (
          <p>No Printing qualifies for the default rule.</p>
        )}
        {isOwner && (
          <button type="button" disabled={!rule || !ownerReady || busy} onClick={() => rule && void setWanted(rule, 'default-rule')}>
            Use default rule
          </button>
        )}
      </section>

      <div className="filters" role="group" aria-label="Filters">
        <div className="chips">
          <Toggle label="Hide promos" on={filters.hidePromos} set={(v) => set('hidePromos', v)} />
          <Toggle label="Hide collectors' editions" on={filters.hideCollectors} set={(v) => set('hideCollectors', v)} />
          <Toggle label="High resolution only" on={filters.highresOnly} set={(v) => set('highresOnly', v)} />
        </div>
        <div className="chips" role="radiogroup" aria-label="Frame">
          {FRAMES.map(([v, l]) => (
            <Radio key={v} label={l} on={filters.frame === v} pick={() => set('frame', v)} />
          ))}
        </div>
        <div className="chips" role="radiogroup" aria-label="Border">
          {BORDERS.map(([v, l]) => (
            <Radio key={v} label={l} on={filters.border === v} pick={() => set('border', v)} />
          ))}
        </div>
      </div>
      <p className="muted num" aria-live="polite">
        {shown.length} of {printings.length} Printings, {groups.length} {groups.length === 1 ? 'art' : 'arts'}
      </p>

      <ul className="tiles">
        {groups.map((g) => {
          const expanded = open === g.key;
          const marks = marksFor(g.printings, card);
          return (
            <li key={g.key} className={expanded ? 'tile open' : 'tile'}>
              <button type="button" className="tile-button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : g.key)}>
                <img className="tile-img" src={smallImage(g.cover.image_normal)} alt="" loading="lazy" decoding="async" width={146} height={204} />
                <span className="tile-text">
                  <span className="num">
                    {g.printings.length} {g.printings.length === 1 ? 'Printing' : 'Printings'}
                  </span>
                  <span className="muted">{g.cover.artist}</span>
                  {marks.length > 0 && (
                    <span className="chips">
                      {marks.map((m) => (
                        <span key={m} className="chip chip-mark">
                          {m}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              {expanded && (
                <ul className="variants">
                  {g.printings.map((p) => (
                    <li key={p.id} className="variant">
                      <img className="thumb" src={smallImage(p.image_normal)} alt="" loading="lazy" decoding="async" width={146} height={204} />
                      <div className="row-text">
                        <span className="row-name">
                          {p.set.toUpperCase()} · {p.set_name}
                        </span>
                        <span className="printing num">
                          #{p.collector_number} · {p.released_at.slice(0, 4)} · {frameLabel(p.frame)}
                        </span>
                        <span className="chips">
                          {p.id === card.wanted.scryfall_id && <span className="chip chip-mark">Wanted</span>}
                          {p.id === card.in_box?.scryfall_id && <span className="chip chip-mark">In-box</span>}
                          {!isReleased(p, today) && <span className="chip chip-mark">not released yet</span>}
                          {badges(p).map((b) => (
                            <span key={b} className="chip">
                              {b}
                            </span>
                          ))}
                        </span>
                        <span>{action(p)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {groups.length === 0 && <p className="status">No Printing matches these filters.</p>}
      {sheet && <CycleSheet card={card} cards={cards} printing={sheet.printing} reason={sheet.reason} onClose={() => setSheet(null)} />}
    </>
  );
}

function marksFor(printings: IndexPrinting[], card: Card): string[] {
  const out: string[] = [];
  if (printings.some((p) => p.id === card.wanted.scryfall_id)) out.push('Wanted');
  if (card.in_box && printings.some((p) => p.id === card.in_box!.scryfall_id)) out.push('In-box');
  return out;
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" className="filter-chip" aria-pressed={on} onClick={() => set(!on)}>
      {label}
    </button>
  );
}

function Radio({ label, on, pick }: { label: string; on: boolean; pick: () => void }) {
  return (
    <button type="button" role="radio" className="filter-chip" aria-checked={on} onClick={pick}>
      {label}
    </button>
  );
}
