// Pieces shared by the Printing picker, the Cycle prompt and the Cycles view.
import { useMemo } from 'react';
import type { Card } from '../../types';
import { useCardStates, useCycleAcks, useStore } from '../../store/context';
import {
  STATUS_LABEL,
  cycleMembers,
  cycleStatus,
  displayStatus,
  humanizeCycle,
  memberRun,
  type CycleStatus,
} from '../../printings/cycles';
import { useManyPrintings } from '../../printings/load';
import type { CycleAcks } from '../../store/types';
import type { IndexPrinting } from '../../printings/types';

export interface CycleAnalysis {
  name: string;
  label: string;
  members: Card[];
  status: CycleStatus;
  /** The chip: uniform, styled, split, accepted split or unknown. */
  shown: ReturnType<typeof displayStatus>;
  ack: string | undefined;
}

/**
 * Status of each named Cycle from the live cards, with the members' printings files loaded.
 * With `load` false nothing is fetched yet (and the result counts as loading).
 */
export function useCycleAnalysis(cards: Card[], cycles: readonly string[], load = true) {
  const acks = useCycleAcks();
  return useCycleAnalysisWith(cards, cycles, acks.data, load);
}

/**
 * useCycleAnalysis with the accepted splits passed in, so a list of Cycles reads them through one
 * listener in its parent instead of one per item.
 */
export function useCycleAnalysisWith(cards: Card[], cycles: readonly string[], acks: CycleAcks, load = true) {
  const byCycle = useMemo(() => cycles.map((c) => ({ name: c, members: cycleMembers(cards, c) })), [cards, cycles]);
  const ids = useMemo(() => (load ? byCycle.flatMap((c) => c.members.map((m) => m.oracle_id)) : []), [byCycle, load]);
  const many = useManyPrintings(ids);
  const analyses = useMemo<CycleAnalysis[]>(
    () =>
      byCycle.map(({ name, members }) => {
        const status = cycleStatus(members.map((m) => memberRun(m, many.files.get(m.oracle_id))));
        const ack = acks.ack[name];
        return { name, label: humanizeCycle(name), members, status, shown: displayStatus(status, ack), ack };
      }),
    [byCycle, many.files, acks],
  );
  return { analyses, files: many.files, loading: many.loading || !load, errors: many.errors };
}

export function StatusChip({ shown, loading }: { shown: CycleAnalysis['shown']; loading?: boolean }) {
  const text = shown === 'unknown' && loading ? 'checking' : STATUS_LABEL[shown];
  return <span className={`chip status-chip status-${shown}`}>{text}</span>;
}

/** The warning for a split Cycle, with the Owner's "Accept this split". */
export function SplitLine({ a }: { a: CycleAnalysis }) {
  const { store, auth, save } = useStore();
  const states = useCardStates();
  // The signature must come from the stored Wanted Printings, not from cards.json while they load.
  const ready = states.status === 'ready';
  if (a.shown === 'accepted') {
    return (
      <p className="muted">
        <StatusChip shown="accepted" /> {a.label}: {a.status.summary}
        {auth.isOwner && store && (
          <button type="button" className="link" disabled={!ready} onClick={() => void save(() => store.setMeta('cycles', { ack: { [a.name]: '' } }), 'Split no longer accepted.')}>
            Undo
          </button>
        )}
      </p>
    );
  }
  if (a.status.kind !== 'split') return null;
  return (
    <div className="split-line">
      <p className="marker-line">
        {a.label} is split: {a.status.summary}
      </p>
      {auth.isOwner && store && (
        <button
          type="button"
          disabled={!ready}
          onClick={() => void save(() => store.setMeta('cycles', { ack: { [a.name]: a.status.signature } }), 'Split accepted.')}
        >
          Accept this split
        </button>
      )}
    </div>
  );
}

export function printingLine(p: Pick<IndexPrinting, 'set' | 'collector_number'>): string {
  return `${p.set.toUpperCase()} ${p.collector_number}`;
}
