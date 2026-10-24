// #/cycles: every Cycle with its status; #/cycles/<name>: one Cycle and its candidate Print runs.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { Card } from '../../types';
import { useCardStates, useCycleAcks, useStore } from '../../store/context';
import type { CardPatchFor, CycleAcks } from '../../store/types';
import { candidateRuns, cyclesOf, humanizeCycle, type CandidateRun } from '../../printings/cycles';
import { currentCells, runCells } from '../../printings/compare';
import { todayIso } from '../../printings/defaultRule';
import { wantedFromInBox, wantedFromPrinting } from '../../printings/wanted';
import { cycleHash, printingsHash } from '../../router';
import { CompareGrid } from './CompareGrid';
import { SplitLine, StatusChip, printingLine, useCycleAnalysis, useCycleAnalysisWith, type CycleAnalysis } from './shared';

export default function CyclesView({ cards, cycle }: { cards: Card[]; cycle: string | null }) {
  return cycle ? <CyclePage key={cycle} cards={cards} cycle={cycle} /> : <CycleList cards={cards} />;
}

function Strip({ cards }: { cards: Card[] }) {
  return (
    <ul className="strip">
      {cards.map((m) => (
        <li key={m.oracle_id}>
          <img className="thumb" src={m.wanted.image_small} alt={m.name} title={m.name} loading="lazy" decoding="async" width={146} height={204} />
          <span className="num">{m.wanted.set.toUpperCase()}</span>
        </li>
      ))}
    </ul>
  );
}

/** True once the element has come near the viewport (always true without IntersectionObserver). */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/** One Cycle in the list. Its members' printings files load only once it scrolls into view. */
function CycleItem({ cards, name, acks }: { cards: Card[]; name: string; acks: CycleAcks }) {
  const ref = useRef<HTMLLIElement>(null);
  const seen = useSeen(ref);
  const names = useMemo(() => [name], [name]);
  const { analyses, loading, errors } = useCycleAnalysisWith(cards, names, acks, seen);
  const a = analyses[0]!;
  return (
    <li ref={ref} className="cycle-item">
      <a className="cycle-link" href={cycleHash(a.name)}>
        <span className="row-name">
          {a.label} <span className="count num">{a.members.length}</span>
        </span>
        <span className="printing">
          <StatusChip shown={loading ? 'unknown' : a.shown} loading={loading} /> {!loading && <span>{a.status.summary}</span>}
        </span>
      </a>
      {errors.length > 0 && <p className="status error">Could not load the Printings of {errors.length} cards; the status may be unknown.</p>}
      <Strip cards={a.members} />
    </li>
  );
}

function CycleList({ cards }: { cards: Card[] }) {
  const names = useMemo(() => cyclesOf(cards).map((c) => c.name), [cards]);
  // One listener for the accepted splits, shared by every item.
  const acks = useCycleAcks();
  return (
    <div className="cycles">
      <h1>Cycles</h1>
      <p className="muted">
        A Cycle should share one Print run. Uniform: one set and style. Styled: the same frame, border and style from different sets.
        Split: anything else.
      </p>
      <ul className="items">
        {names.map((name) => (
          <CycleItem key={name} cards={cards} name={name} acks={acks.data} />
        ))}
      </ul>
      {names.length === 0 && <p className="status">No card belongs to a Cycle.</p>}
    </div>
  );
}

/** How long the pointer rests on a run's strip before its Compare overlay opens. */
const HOVER_OPEN_MS = 400;

/**
 * Hover to open, on devices whose pointer hovers (media query hover: hover; touch never does):
 * resting on a strip for HOVER_OPEN_MS calls onOpen with its id. Scrolling cancels the wait, so
 * strips passing under a still pointer do not open. After the overlay closes, the strip under the
 * pointer waits until the pointer has left it, so closing does not open it again at once.
 */
function useHoverOpen(open: boolean, onOpen: (id: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const blocked = useRef<string | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const scrolledAt = useRef(0);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const onScroll = () => {
      scrolledAt.current = Date.now();
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (open || !pointer.current) return;
    const under = document.elementFromPoint(pointer.current.x, pointer.current.y);
    blocked.current = under?.closest<HTMLElement>('[data-hover-run]')?.dataset.hoverRun ?? null;
  }, [open]);

  return (id: string) => {
    const arm = (e: ReactPointerEvent) => {
      if (open || timer.current !== undefined || blocked.current === id) return;
      if (e.pointerType === 'touch' || !window.matchMedia?.('(hover: hover)').matches) return;
      if (Date.now() - scrolledAt.current < 150) return;
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        onOpenRef.current(id);
      }, HOVER_OPEN_MS);
    };
    return {
      onPointerEnter: arm,
      onPointerMove: arm,
      onPointerLeave: () => {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        if (blocked.current === id) blocked.current = null;
      },
    };
  };
}

type Compare = { kind: 'run'; id: string } | { kind: 'current' } | null;

function CyclePage({ cards, cycle }: { cards: Card[]; cycle: string }) {
  const { store, auth, save } = useStore();
  const states = useCardStates();
  const names = useMemo(() => [cycle], [cycle]);
  const { analyses, files, loading, errors } = useCycleAnalysis(cards, names);
  const a = analyses[0]!;
  const runs = useMemo(() => (loading ? [] : candidateRuns(a.members, files, { today: todayIso() })), [loading, a.members, files]);
  const [preview, setPreview] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<Compare>(null);
  const closeCompare = useCallback(() => setCompare(null), []);
  const compareRun = compare?.kind === 'run' ? (runs.find((r) => r.id === compare.id) ?? null) : null;
  const hover = useHoverOpen(compare?.kind === 'current' || compareRun !== null, (id) => setCompare({ kind: 'run', id }));
  // Not from a cache-only snapshot: a stale In-box Printing must not become the new Wanted.
  const ownerReady = auth.isOwner && !!store && states.status === 'ready' && !states.fromCache;

  if (a.members.length === 0) {
    return (
      <div>
        <p className="status">No Cycle called {humanizeCycle(cycle)}.</p>
        <p>
          <a href="#/cycles">All Cycles</a>
        </p>
      </div>
    );
  }

  async function write(patches: CardPatchFor[], done: string) {
    if (!store || busy) return;
    setBusy(true);
    try {
      if (await save(() => store.updateCards(patches), done)) setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function writeRun(run: CandidateRun) {
    const patches = run.picks.map((p) => ({
      oracle_id: p.oracle_id,
      patch: { kind: 'wanted' as const, wanted: wantedFromPrinting(p.printing, null, 'cycle') },
    }));
    void write(patches, `Wanted Printing set on ${patches.length} cards in ${a.label}.`);
  }

  function resetToBox() {
    if (!window.confirm(`Set the Wanted Printing of all ${a.members.length} cards in ${a.label} back to their In-box Printing?`)) return;
    const patches = a.members.flatMap((m) => {
      const wanted = wantedFromInBox(m);
      return wanted ? [{ oracle_id: m.oracle_id, patch: { kind: 'wanted' as const, wanted } }] : [];
    });
    void write(patches, `${a.label} reset to the In-box Printings.`);
  }

  /** The Owner's "Choose this Print run", its plan and the write: on the page and in the overlay. */
  function runAction(run: CandidateRun) {
    if (!auth.isOwner) return null;
    return (
      <>
        <button type="button" aria-expanded={preview === run.id} onClick={() => setPreview(preview === run.id ? null : run.id)}>
          {preview === run.id ? 'Hide preview' : 'Choose this Print run'}
        </button>
        {preview === run.id && (
          <div className="run-preview">
            <ul className="plan">
              {run.picks.map((p) => {
                const m = a.members.find((x) => x.oracle_id === p.oracle_id);
                const same = m?.wanted.scryfall_id === p.printing.id;
                return (
                  <li key={p.oracle_id}>
                    {p.name}{' '}
                    <span className="num muted">
                      {m ? printingLine(m.wanted) : ''} → {printingLine(p.printing)}
                      {same ? ' (unchanged)' : ''}
                    </span>
                  </li>
                );
              })}
              {run.missing.map((m) => (
                <li key={m.oracle_id} className="marker-line">
                  no printing in {run.set.toUpperCase()} for {m.name}, kept as is ·{' '}
                  <a href={printingsHash(m.oracle_id)}>choose for {m.name}</a>
                </li>
              ))}
            </ul>
            <button type="button" className="primary" disabled={!ownerReady || busy} onClick={() => writeRun(run)}>
              {busy ? 'Saving…' : `Write ${run.picks.length} Wanted Printings`}
            </button>
          </div>
        )}
      </>
    );
  }

  const shownRuns = showAll ? runs : runs.slice(0, 8);
  return (
    <article className="cycle-page">
      <p>
        <a href="#/cycles">All Cycles</a>
      </p>
      <h1>
        {a.label} <span className="count num">{a.members.length}</span>
      </h1>
      <p className="printing">
        <StatusChip shown={a.shown} loading={loading} /> <span>{a.status.summary}</span>
      </p>
      <SplitLine a={a} />
      <MemberList a={a} />
      <p className="run-actions">
        <button type="button" onClick={() => setCompare({ kind: 'current' })}>
          Compare current
        </button>
        {auth.isOwner && (
          <button type="button" disabled={!ownerReady || busy} onClick={resetToBox}>
            Reset Cycle to In-box
          </button>
        )}
      </p>

      <h2>Pick a Print run</h2>
      {loading && <p className="status">Loading the Printings of the Cycle…</p>}
      {errors.length > 0 && <p className="status error">Could not load the Printings of {errors.length} cards.</p>}
      {!loading && runs.length === 0 && <p className="status">No Print run covers this Cycle, not even with one card missing.</p>}
      <ul className="items">
        {shownRuns.map((run) => (
          <li key={run.id} className="run">
            <div className="run-head">
              <span className="row-name">{run.label}</span>
              <span className="muted">{run.set_name}</span>
              <RunFacts run={run} />
            </div>
            <ul className="art-row" data-hover-run={run.id} {...hover(run.id)}>
              {run.picks.map((p) => (
                <li key={p.oracle_id} className="art-tile">
                  <img className="art-img" src={p.printing.image_normal} alt="" loading="lazy" decoding="async" width={488} height={680} />
                  <span className="art-name">{p.name}</span>
                  <span className="num muted">{printingLine(p.printing)}</span>
                </li>
              ))}
            </ul>
            <div className="run-actions">
              <button type="button" onClick={() => setCompare({ kind: 'run', id: run.id })}>
                Compare all {a.members.length}
              </button>
              {runAction(run)}
            </div>
          </li>
        ))}
      </ul>
      {runs.length > shownRuns.length && (
        <button type="button" onClick={() => setShowAll(true)}>
          Show all {runs.length} Print runs
        </button>
      )}

      {compare?.kind === 'current' && (
        <CompareGrid
          cycleLabel={a.label}
          runLabel="current Wanted Printings"
          detail={<span>{a.status.summary}</span>}
          cells={currentCells(a.members)}
          onClose={closeCompare}
        />
      )}
      {compareRun && (
        <CompareGrid
          cycleLabel={a.label}
          runLabel={compareRun.label}
          detail={
            <>
              <span>{compareRun.set_name}</span>
              <RunFacts run={compareRun} />
            </>
          }
          cells={runCells(compareRun, a.members)}
          actions={runAction(compareRun)}
          onClose={closeCompare}
        />
      )}
    </article>
  );
}

/** Complete or missing, resolution, promos and year of a candidate run. */
function RunFacts({ run }: { run: CandidateRun }) {
  return (
    <span className="printing num">
      <span className={run.complete ? 'chip status-chip status-uniform' : 'chip status-chip status-split'}>
        {run.complete ? 'complete' : `missing: ${run.missing.map((m) => m.name).join(', ')}`}
      </span>
      <span>
        {run.highresCount} of {run.picks.length} high resolution
      </span>
      {run.anyPromo && <span>includes promos</span>}
      <span>{run.released_at.slice(0, 4)}</span>
      {run.unreleased && <span className="chip status-chip status-split">not released yet ({run.released_at})</span>}
    </span>
  );
}

/** The members' Wanted Printings as card-sized tiles, each a link to its Printing picker. */
function MemberList({ a }: { a: CycleAnalysis }) {
  return (
    <ul className="art-row">
      {a.members.map((m) => (
        <li key={m.oracle_id} className="art-tile">
          <a className="art-link" href={printingsHash(m.oracle_id)}>
            <img className="art-img" src={m.wanted.image_normal} alt="" loading="lazy" decoding="async" width={488} height={680} />
            <span className="art-name">{m.name}</span>
            <span className="num muted">Wanted {printingLine(m.wanted)}</span>
            {!m.in_box ? <span className="marker">To print</span> : m.wanted.scryfall_id !== m.in_box.scryfall_id && <span className="marker">Reprint pending</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}
