// The Cycle prompt: before the Owner sets Wanted on a card in a Cycle, choose "This card only" or
// a whole Cycle. A whole Cycle gets the same Print run (set and style), written in one batch.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../../types';
import { useStore } from '../../store/context';
import type { CardPatchFor, WantedReason } from '../../store/types';
import { cycleMembers, humanizeCycle, planCycleApply } from '../../printings/cycles';
import { useManyPrintings } from '../../printings/load';
import { runStyle, styleLabel, runKey } from '../../printings/style';
import type { IndexPrinting } from '../../printings/types';
import { wantedFromPrinting } from '../../printings/wanted';
import { printingsHash } from '../../router';
import { SplitLine, printingLine, useCycleAnalysis } from './shared';

type Step = { kind: 'choose' } | { kind: 'cycle'; cycle: string } | { kind: 'done' };

export function CycleSheet({
  card,
  cards,
  printing,
  reason,
  onClose,
}: {
  card: Card;
  cards: Card[];
  printing: IndexPrinting;
  reason: WantedReason;
  onClose: () => void;
}) {
  const { store, save } = useStore();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        // Keep Tab inside the dialog.
        const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        // Focus on the heading (tabIndex -1) or outside the sheet is not a trap stop, so wrap from there too.
        const active = document.activeElement;
        const onStop = active instanceof HTMLElement && focusable.includes(active);
        if (e.shiftKey && (active === first || !onStop)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !onStop)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus returns to whatever opened the sheet when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  // The heading takes focus on each step, so focus never falls to the body behind a disabled button.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('#sheet-title')?.focus();
  }, [step.kind]);

  const label = printingLine(printing);

  async function write(patches: CardPatchFor[], done: string) {
    if (!store || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const ok = await save(() => (patches.length === 1 ? store.updateCard(patches[0]!.oracle_id, patches[0]!.patch) : store.updateCards(patches)), done);
      // The toast sits under the sheet, so a failed write is also told here.
      if (ok) setStep({ kind: 'done' });
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref}>
        <h2 id="sheet-title" tabIndex={-1}>Set Wanted to {label}</h2>
        {failed && step.kind !== 'done' && (
          <p className="status error" role="alert">
            Could not save the Wanted Printing. Nothing was changed; check the connection and try again.
          </p>
        )}
        {step.kind === 'choose' && (
          <>
            <p className="muted">
              {card.name} belongs to {card.cycles.length === 1 ? 'a Cycle' : `${card.cycles.length} Cycles`}. Set the same Print
              run ({printing.set.toUpperCase()} · {styleLabel(runKey(printing))}) on the whole Cycle?
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="primary"
                disabled={busy || !store}
                onClick={() =>
                  void write(
                    [{ oracle_id: card.oracle_id, patch: { kind: 'wanted', wanted: wantedFromPrinting(printing, null, reason) } }],
                    `Wanted Printing set to ${label}.`,
                  )
                }
              >
                This card only
              </button>
              {card.cycles.map((cy) => (
                <button key={cy} type="button" disabled={busy || !store} onClick={() => setStep({ kind: 'cycle', cycle: cy })}>
                  All {cycleMembers(cards, cy).length} cards in {humanizeCycle(cy)}
                </button>
              ))}
              <button type="button" className="link" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
        {step.kind === 'cycle' && (
          <CyclePreview
            card={card}
            cards={cards}
            cycle={step.cycle}
            printing={printing}
            reason={reason}
            busy={busy}
            onBack={() => setStep({ kind: 'choose' })}
            onConfirm={(patches, n) => void write(patches, `Wanted Printing set on ${n} cards in ${humanizeCycle(step.cycle)}.`)}
          />
        )}
        {step.kind === 'done' && <DoneStep card={card} cards={cards} onClose={onClose} />}
      </div>
    </div>
  );
}

function CyclePreview({
  card,
  cards,
  cycle,
  printing,
  reason,
  busy,
  onBack,
  onConfirm,
}: {
  card: Card;
  cards: Card[];
  cycle: string;
  printing: IndexPrinting;
  reason: WantedReason;
  busy: boolean;
  onBack: () => void;
  onConfirm: (patches: CardPatchFor[], n: number) => void;
}) {
  const members = useMemo(() => cycleMembers(cards, cycle), [cards, cycle]);
  const ids = useMemo(() => members.map((m) => m.oracle_id), [members]);
  const many = useManyPrintings(ids);
  const plan = useMemo(
    () =>
      many.loading
        ? null
        : planCycleApply(members, many.files, { set: printing.set, style: runStyle(printing) }, { oracle_id: card.oracle_id, printing }),
    [many.loading, many.files, members, printing, card.oracle_id],
  );
  const set = printing.set.toUpperCase();
  return (
    <>
      <p className="muted">
        {humanizeCycle(cycle)}: {members.length} cards on {set} · {styleLabel(runKey(printing))}.
      </p>
      {many.loading && <p className="status">Loading the Printings of the Cycle…</p>}
      {many.errors.length > 0 && <p className="status error">Could not load some printings files; those cards are kept as is.</p>}
      {plan && (
        <ul className="plan">
          {plan.matched.map((m) => (
            <li key={m.oracle_id}>
              {m.name} <span className="num muted">→ {printingLine(m.printing)}</span>
            </li>
          ))}
          {plan.unmatched.map((m) => (
            <li key={m.oracle_id} className="marker-line">
              no printing in {set} for {m.name}, kept as is ·{' '}
              <a href={printingsHash(m.oracle_id)}>choose for {m.name}</a>
            </li>
          ))}
        </ul>
      )}
      <div className="sheet-actions">
        <button
          type="button"
          className="primary"
          disabled={!plan || busy || plan.matched.length === 0}
          onClick={() => {
            if (!plan) return;
            const patches = plan.matched.map((m) => ({
              oracle_id: m.oracle_id,
              patch: {
                kind: 'wanted' as const,
                wanted: wantedFromPrinting(m.printing, null, m.oracle_id === card.oracle_id ? reason : 'cycle'),
              },
            }));
            onConfirm(patches, patches.length);
          }}
        >
          {busy ? 'Saving…' : plan ? `Write ${plan.matched.length} Wanted Printings` : 'Write'}
        </button>
        <button type="button" onClick={onBack} disabled={busy}>
          Back
        </button>
      </div>
    </>
  );
}

function DoneStep({ card, cards, onClose }: { card: Card; cards: Card[]; onClose: () => void }) {
  const { analyses, loading } = useCycleAnalysis(cards, card.cycles);
  return (
    <>
      <p>Saved.</p>
      {loading && <p className="muted">Checking the Cycles…</p>}
      {!loading &&
        analyses.map((a) =>
          a.status.kind === 'split' ? (
            <SplitLine key={a.name} a={a} />
          ) : (
            <p key={a.name} className="muted">
              {a.label}: {a.status.kind === 'uniform' ? 'uniform' : a.status.kind === 'styled' ? 'styled' : 'unknown'} · {a.status.summary}
            </p>
          ),
        )}
      <div className="sheet-actions">
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}
