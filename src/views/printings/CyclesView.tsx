// #/cycles: every Cycle with its status; #/cycles/<name>: one Cycle and its candidate Print runs.
import { useMemo, useState } from 'react';
import type { Card } from '../../types';
import { useCardStates, useStore } from '../../store/context';
import type { CardPatchFor } from '../../store/types';
import { candidateRuns, cyclesOf, humanizeCycle, type CandidateRun } from '../../printings/cycles';
import { todayIso } from '../../printings/defaultRule';
import { smallImage } from '../../printings/images';
import { wantedFromInBox, wantedFromPrinting } from '../../printings/wanted';
import { cycleHash, printingsHash } from '../../router';
import { SplitLine, StatusChip, printingLine, useCycleAnalysis, type CycleAnalysis } from './shared';

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

function CycleList({ cards }: { cards: Card[] }) {
  const names = useMemo(() => cyclesOf(cards).map((c) => c.name), [cards]);
  const { analyses, loading, errors } = useCycleAnalysis(cards, names);
  return (
    <div className="cycles">
      <h1>Cycles</h1>
      <p className="muted">
        A Cycle should share one Print run. Uniform: one set and style. Styled: the same frame, border and style from different sets.
        Split: anything else.
      </p>
      {errors.length > 0 && <p className="status error">Could not load the Printings of {errors.length} cards; their status may be unknown.</p>}
      <ul className="items">
        {analyses.map((a) => (
          <li key={a.name} className="cycle-item">
            <a className="cycle-link" href={cycleHash(a.name)}>
              <span className="row-name">
                {a.label} <span className="count num">{a.members.length}</span>
              </span>
              <span className="printing">
                <StatusChip shown={a.shown} loading={loading} /> <span>{a.status.summary}</span>
              </span>
            </a>
            <Strip cards={a.members} />
          </li>
        ))}
      </ul>
      {analyses.length === 0 && <p className="status">No card belongs to a Cycle.</p>}
    </div>
  );
}

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
  const ownerReady = auth.isOwner && !!store && states.status === 'ready';

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
      patch: { kind: 'wanted' as const, wanted: wantedFromPrinting(p.printing, p.name, 'cycle') },
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
      {auth.isOwner && (
        <p>
          <button type="button" disabled={!ownerReady || busy} onClick={resetToBox}>
            Reset Cycle to In-box
          </button>
        </p>
      )}

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
            </div>
            <ul className="strip">
              {run.picks.map((p) => (
                <li key={p.oracle_id}>
                  <img className="thumb" src={smallImage(p.printing.image_normal)} alt={p.name} title={p.name} loading="lazy" decoding="async" width={146} height={204} />
                  <span className="num">{p.printing.collector_number}</span>
                </li>
              ))}
            </ul>
            {auth.isOwner && (
              <button type="button" aria-expanded={preview === run.id} onClick={() => setPreview(preview === run.id ? null : run.id)}>
                {preview === run.id ? 'Hide preview' : 'Choose this Print run'}
              </button>
            )}
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
          </li>
        ))}
      </ul>
      {runs.length > shownRuns.length && (
        <button type="button" onClick={() => setShowAll(true)}>
          Show all {runs.length} Print runs
        </button>
      )}
    </article>
  );
}

function MemberList({ a }: { a: CycleAnalysis }) {
  return (
    <ul className="rows">
      {a.members.map((m) => (
        <li key={m.oracle_id}>
          <a className="row" href={printingsHash(m.oracle_id)}>
            <img className="thumb" src={m.wanted.image_small} alt="" loading="lazy" decoding="async" width={146} height={204} />
            <span className="row-text">
              <span className="row-name">{m.name}</span>
              <span className="printing num">
                Wanted {printingLine(m.wanted)}
                {!m.in_box ? <span className="marker">To print</span> : m.wanted.scryfall_id !== m.in_box.scryfall_id && <span className="marker">Reprint pending</span>}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
