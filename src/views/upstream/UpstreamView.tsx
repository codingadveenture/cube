// #/upstream ("Update"): refresh the List and Upstream from CubeCobra, decide on the Upstream feed,
// build and apply the Update, and hand the new List back to CubeCobra.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../../types';
import { smallImage } from '../../printings/images';
import { historyTrim } from '../../print/settings';
import { errorText, useLog, useOverrides, useStore, useUpdatesMetaDoc, useUpstreamMetaDoc } from '../../store/context';
import type { Decision, DecisionStatus, UpdateHistoryEntry } from '../../store/types';
import { acceptRemaining, computeFeed, decide, groupFeed, previewBasis, staleDecisions, stickySets, type FeedItem } from '../../upstream/feed';
import { toUpdateHistory, toUpstreamMeta } from '../../upstream/meta';
import { keyOf, nameIndex, parseNameLines, snapshotProblem } from '../../upstream/names';
import { fetchCubelist, LIST_ID, UPSTREAM_ID } from '../../upstream/net';
import { cachedFacts, fetchFacts, isAborted, type FactsHit } from '../../upstream/scryfall';
import { resolveIns, resolveOuts, type ResolvedIn } from '../../upstream/resolveIn';
import { pendingReprints } from '../../upstream/update';
import { planApply, planIsEmpty, type Preview } from '../../upstream/plan';
import { CopyButton, formatTime, LiveStatus } from '../common';
import { ExportPanel } from './ExportPanel';

interface Snapshot {
  fetched_at: string;
  list_names: string[];
  upstream_names: string[];
}

const MANUAL_KEY = 'cube.update.manual';

function readManual(): string {
  try {
    return localStorage.getItem(MANUAL_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeManual(v: string) {
  try {
    localStorage.setItem(MANUAL_KEY, v);
  } catch {
    // Blocked storage: the draft is a convenience only.
  }
}

export default function UpstreamView({ cards, cardsReady }: { cards: Card[]; cardsReady: boolean }) {
  const { auth, store, save } = useStore();
  const isOwner = auth.isOwner && !!store;
  const metaLive = useUpstreamMetaDoc();
  const updatesLive = useUpdatesMetaDoc();
  const log = useLog();
  const overrides = useOverrides();
  const meta = useMemo(() => toUpstreamMeta(metaLive.data), [metaLive.data]);
  const history = useMemo(() => toUpdateHistory(updatesLive.data), [updatesLive.data]);
  // The feed must not drive decisions until the Winner's Picks and Bans (Log and overrides) are
  // known from the server: before that, every Winner's Pick would show as an Upstream cut.
  const stickyReady = log.status === 'ready' && !log.fromCache && overrides.status === 'ready' && !overrides.fromCache;
  const canDecide = isOwner && stickyReady;
  // The history trim, as in print history: only from a server snapshot.
  const trimList = updatesLive.status === 'ready' && !updatesLive.fromCache ? historyTrim(updatesLive.data?.history) : null;

  // The last fetch: this session's, else the one the Owner stored (unless it fails the sanity check).
  const [local, setLocal] = useState<Snapshot | null>(null);
  const stored: Snapshot | null = meta.fetched_at
    ? { fetched_at: meta.fetched_at, list_names: meta.list_names, upstream_names: meta.upstream_names }
    : null;
  const storedProblem = stored ? snapshotProblem(stored.list_names.length, stored.upstream_names.length, LIST_ID, UPSTREAM_ID) : null;
  const snap: Snapshot | null = local ?? (storedProblem ? null : stored);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const [list_names, upstream_names] = await Promise.all([fetchCubelist(LIST_ID), fetchCubelist(UPSTREAM_ID)]);
      const problem = snapshotProblem(list_names.length, upstream_names.length, LIST_ID, UPSTREAM_ID);
      if (problem) {
        // Keep the previous snapshot: an empty or truncated answer would turn the List into cuts.
        setRefreshError(problem);
        return;
      }
      const next = { fetched_at: new Date().toISOString(), list_names, upstream_names };
      setLocal(next);
      if (isOwner) {
        // Drop the decisions whose item left the feed, only when the decisions and the sticky sets
        // are known from the server.
        const decisionsCurrent = metaLive.status === 'ready' && !metaLive.fromCache;
        const drop =
          stickyReady && decisionsCurrent
            ? staleDecisions(meta.decisions, computeFeed({ list: list_names, upstream: upstream_names, sticky, keyOf: key }), key)
            : [];
        await save(() => store!.saveUpstreamSnapshot(next, drop), 'Fetched the List and Upstream; the snapshot is saved for everyone.');
      }
    } catch (e) {
      setRefreshError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  }

  // Facts from Scryfall: also teach the name index the names Scryfall gives (renames).
  const [facts, setFacts] = useState<Map<string, FactsHit | null>>(new Map());
  const index = useMemo(() => {
    const extra: [string, string][] = [];
    for (const [name, hit] of facts) if (hit) extra.push([name, hit.oracle_id], [hit.facts.name, hit.oracle_id]);
    return nameIndex(cards, extra);
  }, [cards, facts]);
  const key = useMemo(() => (name: string) => keyOf(index, name), [index]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.oracle_id, c])), [cards]);

  const sticky = useMemo(() => stickySets(overrides.data, log.data), [overrides.data, log.data]);
  const feed = useMemo(
    () => (snap ? computeFeed({ list: snap.list_names, upstream: snap.upstream_names, sticky, keyOf: key, decisions: meta.decisions }) : null),
    [snap, sticky, key, meta.decisions],
  );

  // Load facts for feed items the Cube does not know, in batches of 75.
  const [factsProgress, setFactsProgress] = useState<{ done: number; total: number } | null>(null);
  const [factsError, setFactsError] = useState<string | null>(null);
  const unknownNames = useMemo(() => {
    if (!feed) return [];
    // Sticky names that match nothing yet are looked up too, so their oracle_ids reach the index.
    return [...[...feed.adds, ...feed.cuts].filter((i) => !byId.has(i.key)).map((i) => i.name), ...feed.unresolvedSticky];
  }, [feed, byId]);
  const unknownKey = unknownNames.join('\n');
  useEffect(() => {
    const names = unknownKey ? unknownKey.split('\n') : [];
    const todo = names.filter((n) => cachedFacts(n) === undefined);
    // Cached facts are applied at once; only the rest go to Scryfall.
    const cached = new Map<string, FactsHit | null>();
    for (const n of names) {
      const c = cachedFacts(n);
      if (c !== undefined) cached.set(n, c);
    }
    if (cached.size) setFacts((old) => new Map([...old, ...cached]));
    if (todo.length === 0) return;
    const ctl = new AbortController();
    setFactsError(null);
    fetchFacts(todo, setFactsProgress, ctl.signal).then(
      (got) => setFacts((old) => new Map([...old, ...got])),
      (e: unknown) => {
        if (!isAborted(e)) setFactsError(`Card facts from Scryfall: ${errorText(e)}`);
      },
    );
    return () => ctl.abort();
  }, [unknownKey]);

  const factsFor = (item: FeedItem): ItemFacts | null => {
    const c = byId.get(item.key);
    if (c) return { type_line: c.type_line, cmc: c.cmc, colors: c.colors, image: (c.in_box ?? c.wanted).image_normal };
    const hit = facts.get(item.name);
    if (!hit) return null;
    return { type_line: hit.facts.type_line, cmc: hit.facts.cmc, colors: hit.facts.colors, image: hit.facts.image_normal };
  };

  async function setDecisions(d: Record<string, Decision>, done: string) {
    if (!canDecide || Object.keys(d).length === 0) return;
    await save(() => store!.setMeta('upstream', { decisions: d }), done);
  }
  const decideOne = (item: FeedItem, status: DecisionStatus) =>
    void setDecisions(decide([item], status, new Date().toISOString()), `${item.name}: ${STATUS_TEXT[status].toLowerCase()}.`);

  // Manual In names.
  const [manualText, setManualText] = useState(readManual);
  const manual = useMemo(() => parseNameLines(manualText), [manualText]);
  // Sticky names that Scryfall did not find either (only once their lookup has answered).
  const unmatchedSticky = feed ? feed.unresolvedSticky.filter((n) => facts.has(n) && !facts.get(n)) : [];

  return (
    <div className="upstream">
      <h1>Update</h1>
      <p className="muted">
        The List follows Upstream, the MTGO Vintage Cube, plus the Winner&rsquo;s Picks and minus the Bans. Refresh, decide on each change,
        build the Update, print and pull, then push the List back to CubeCobra.
      </p>
      <LiveStatus live={metaLive} what="Update data" />

      <section className="panel" aria-labelledby="refresh-head">
        <h2 id="refresh-head">1. Refresh</h2>
        <div className="actions">
          <button type="button" className="primary" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Reading CubeCobra…' : 'Refresh from CubeCobra'}
          </button>
        </div>
        {refreshError && <p className="status error">{refreshError}</p>}
        {!local && storedProblem && <p className="status error">The saved snapshot is not used. {storedProblem}</p>}
        {snap ? (
          <p className="num">
            List ({LIST_ID}): {snap.list_names.length} cards · Upstream ({UPSTREAM_ID}): {snap.upstream_names.length} cards · fetched{' '}
            {formatTime(snap.fetched_at)}
            {local ? '' : ' (saved snapshot)'}
          </p>
        ) : (
          <p className="muted">Not fetched yet.</p>
        )}
        <p className="muted num">
          Sticky: {sticky.adds.length} Winner&rsquo;s Picks and adds stay in, {sticky.bans.length} Bans stay out.
          {!isOwner && ' Only the Owner can decide; the feed below is read-only.'}
        </p>
        {isOwner && !stickyReady && (
          <p className="status" role="status">
            Waiting for the Log: deciding and building open once the Winner&rsquo;s Picks and Bans have loaded from the server.
          </p>
        )}
        {unmatchedSticky.length > 0 && (
          <p className="status error">
            {unmatchedSticky.length === 1 ? 'This sticky name matches' : 'These sticky names match'} no card on Scryfall, the List or Upstream, so{' '}
            {unmatchedSticky.length === 1 ? 'it does' : 'they do'} not apply: {unmatchedSticky.join(', ')}. Check the spelling in the Log.
          </p>
        )}
      </section>

      {feed && (
        <section className="panel" aria-labelledby="feed-head">
          <h2 id="feed-head">2. Decide</h2>
          <p className="muted num">The proposed List has {feed.proposed} cards.</p>
          {factsProgress && factsProgress.done < factsProgress.total && (
            <p className="status num" role="status">
              Card facts from Scryfall: {factsProgress.done} of {factsProgress.total}
            </p>
          )}
          {factsError && <p className="status error">{factsError}</p>}
          <FeedSide
            title="Upstream adds"
            items={feed.adds}
            factsFor={factsFor}
            isOwner={canDecide}
            onDecide={decideOne}
            onAcceptAll={(items) => void setDecisions(acceptRemaining(items, new Date().toISOString()), 'Accepted all remaining adds.')}
            acceptAllLabel="Accept all remaining adds"
          />
          <FeedSide
            title="Upstream cuts"
            items={feed.cuts}
            factsFor={factsFor}
            isOwner={canDecide}
            onDecide={decideOne}
            onAcceptAll={(items) => void setDecisions(acceptRemaining(items, new Date().toISOString()), 'Accepted all remaining cuts.')}
            acceptAllLabel="Accept all remaining cuts"
          />
        </section>
      )}

      <section className="panel" aria-labelledby="manual-head">
        <h2 id="manual-head">Add cards by name</h2>
        <p className="muted">For a Winner&rsquo;s Pick or any card that is not in the feed. One name per line; they come In with the next Update.</p>
        <label className="field">
          <span>Card names</span>
          <textarea
            rows={3}
            value={manualText}
            onChange={(e) => {
              setManualText(e.target.value);
              writeManual(e.target.value);
            }}
            spellCheck={false}
          />
        </label>
        {manual.length > 0 && <p className="muted num">{manual.length} {manual.length === 1 ? 'name' : 'names'}</p>}
      </section>

      <BuildUpdate
        feed={feed}
        manual={manual}
        stickyAdds={sticky.adds}
        cards={cards}
        cardsReady={cardsReady}
        stickyReady={stickyReady}
        index={index}
        isOwner={isOwner}
        historyTrim={trimList}
        onApplied={(keep) => {
          // Typed names that failed to resolve stay for correction; the rest went in.
          const text = keep.join('\n');
          setManualText(text);
          writeManual(text);
        }}
      />

      <ExportPanel cards={cards} cardsReady={cardsReady} lastUpdate={history[0] ?? null} index={index} />

      {history.length > 0 && <History history={history} />}
    </div>
  );
}

const STATUS_TEXT: Record<DecisionStatus, string> = { accepted: 'Accepted', rejected: 'Rejected', later: 'Later' };

interface ItemFacts {
  type_line: string;
  cmc: number;
  colors: string[];
  image: string | null;
}

function FeedSide({
  title,
  items,
  factsFor,
  isOwner,
  onDecide,
  onAcceptAll,
  acceptAllLabel,
}: {
  title: string;
  items: FeedItem[];
  factsFor: (i: FeedItem) => ItemFacts | null;
  isOwner: boolean;
  onDecide: (i: FeedItem, s: DecisionStatus) => void;
  onAcceptAll: (items: FeedItem[]) => void;
  acceptAllLabel: string;
}) {
  const g = groupFeed(items);
  const list = (xs: FeedItem[]) => (
    <ul className="items">
      {xs.map((i) => (
        <FeedRow key={`${i.side}|${i.key}`} item={i} facts={factsFor(i)} isOwner={isOwner} onDecide={onDecide} />
      ))}
    </ul>
  );
  return (
    <div className="feed-side">
      <h3>
        {title} <span className="count num">{items.length}</span>
      </h3>
      {items.length === 0 && <p className="muted">None.</p>}
      {g.open.length > 0 && (
        <>
          <p className="muted num">{g.open.length} to decide</p>
          {isOwner && g.open.length > 1 && (
            <div className="actions">
              <button type="button" onClick={() => onAcceptAll(items)}>
                {acceptAllLabel}
              </button>
            </div>
          )}
          {list(g.open)}
        </>
      )}
      {g.accepted.length > 0 && (
        <details open>
          <summary>
            Accepted, not applied yet <span className="num">({g.accepted.length})</span>
          </summary>
          {list(g.accepted)}
        </details>
      )}
      {g.applied.length > 0 && (
        <details>
          <summary>
            Applied here, not on CubeCobra yet <span className="num">({g.applied.length})</span>
          </summary>
          <p className="muted">
            These went into an Update. They leave the feed once the List on CubeCobra has them (step 4) and the next Refresh is stored. If one
            stays after that, decide on it again.
          </p>
          {list(g.applied)}
        </details>
      )}
      {g.later.length > 0 && (
        <details>
          <summary>
            Later <span className="num">({g.later.length})</span>
          </summary>
          {list(g.later)}
        </details>
      )}
      {g.rejected.length > 0 && (
        <details>
          <summary>
            Rejected <span className="num">({g.rejected.length})</span>
          </summary>
          {list(g.rejected)}
        </details>
      )}
    </div>
  );
}

function colorsText(colors: string[]): string {
  return colors.length ? colors.join('') : 'C';
}

function FeedRow({
  item,
  facts,
  isOwner,
  onDecide,
}: {
  item: FeedItem;
  facts: ItemFacts | null;
  isOwner: boolean;
  onDecide: (i: FeedItem, s: DecisionStatus) => void;
}) {
  const d = item.decision;
  const href = item.key.startsWith('n:') ? null : `#/cube/${encodeURIComponent(item.key)}`;
  return (
    <li className="item feed-item">
      {facts?.image ? (
        <img className="thumb" src={smallImage(facts.image)} alt="" loading="lazy" decoding="async" width={146} height={204} />
      ) : (
        <span className="thumb thumb-empty" aria-hidden="true" />
      )}
      <span className="row-text">
        <span className="row-name">{href ? <a href={href}>{item.name}</a> : item.name}</span>
        {facts ? (
          <span className="muted num">
            {facts.type_line} · {colorsText(facts.colors)} · MV {facts.cmc}
          </span>
        ) : (
          <span className="muted">Facts loading…</span>
        )}
        {(item.sticky || d) && (
          <span className="chips">
            {item.sticky && <span className="chip chip-mark">Winner&rsquo;s Pick</span>}
            {d && (
              <span className="chip">
                {d.applied_at ? `Applied ${formatTime(d.applied_at)}` : `${STATUS_TEXT[d.status]} ${formatTime(d.at)}`}
              </span>
            )}
          </span>
        )}
      </span>
      {isOwner && (
        <div className="actions decide">
          {(['accepted', 'rejected', 'later'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={d?.status === s} className={s === 'accepted' ? 'primary' : undefined} onClick={() => onDecide(item, s)}>
              {s === 'accepted' ? 'Accept' : s === 'rejected' ? 'Reject' : 'Later'}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

type BuildState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number; what: string }
  | { status: 'error'; message: string }
  | ({ status: 'ready'; basis: string } & Preview);

function BuildUpdate({
  feed,
  manual,
  stickyAdds,
  cards,
  cardsReady,
  stickyReady,
  index,
  isOwner,
  historyTrim,
  onApplied,
}: {
  feed: ReturnType<typeof computeFeed> | null;
  manual: string[];
  stickyAdds: string[];
  cards: Card[];
  cardsReady: boolean;
  stickyReady: boolean;
  index: ReturnType<typeof nameIndex>;
  isOwner: boolean;
  /** Stored history entries to drop, from a server snapshot; null while unknown (nothing is trimmed). */
  historyTrim: unknown[] | null;
  /** After Apply: the typed names that failed and stay in the text box. */
  onApplied: (keepManual: string[]) => void;
}) {
  const { store, save } = useStore();
  const [state, setState] = useState<BuildState>({ status: 'idle' });
  const [applied, setApplied] = useState<{ toPrint: number; toPull: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const acceptedAdds = feed ? groupFeed(feed.adds).accepted : [];
  const acceptedCuts = feed ? groupFeed(feed.cuts).accepted : [];
  const stickyKeys = useMemo(() => new Set(stickyAdds.map((n) => keyOf(index, n))), [stickyAdds, index]);
  const feedKeys = new Set(acceptedAdds.map((i) => i.key));
  const manualIns = manual.filter((n) => !feedKeys.has(keyOf(index, n)));
  const total = acceptedAdds.length + manualIns.length + acceptedCuts.length;
  // What a preview is built from; when it changes after the build, the preview is stale.
  const basis = previewBasis(acceptedAdds, acceptedCuts, manualIns);
  const ready = cardsReady && stickyReady;

  async function build() {
    if (applyingRef.current) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setApplied(null);
    const builtFrom = basis;
    setState({ status: 'running', done: 0, total: 0, what: 'Starting' });
    try {
      const inItems = [
        ...acceptedAdds.map((i) => ({ name: i.name, sticky: i.sticky })),
        ...manualIns.map((n) => ({ name: n, sticky: stickyKeys.has(keyOf(index, n)) })),
      ];
      const ins = await resolveIns(inItems, {
        cards,
        index,
        signal: ctl.signal,
        onProgress: (p) => setState({ status: 'running', ...p }),
      });
      const outs = resolveOuts(
        acceptedCuts.map((i) => i.name),
        cards,
        index,
      );
      setState({
        status: 'ready',
        basis: builtFrom,
        ins,
        outs,
        items: [...acceptedAdds, ...acceptedCuts],
        manual: acceptedAdds.length + acceptedCuts.length === 0,
        manualNames: manualIns,
      });
    } catch (e) {
      setState(isAborted(e) ? { status: 'idle' } : { status: 'error', message: errorText(e) });
    }
  }

  async function apply(s: Extract<BuildState, { status: 'ready' }>) {
    if (!store || applyingRef.current || s.basis !== basis || !ready) return;
    const plan = planApply(s, cards, new Date().toISOString());
    if (planIsEmpty(plan)) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const writes = { ...plan.writes, trim: historyTrim ?? [] };
      const kept = plan.keepManual.length
        ? ` ${plan.keepManual.length} ${plan.keepManual.length === 1 ? 'name that' : 'names that'} did not resolve stay under Add cards by name for correction.`
        : '';
      const ok = await save(() => store.applyUpdate(writes), `Update applied: ${writes.history.in.length} In, ${writes.history.out.length} Out.${kept}`);
      if (!ok) return;
      setApplied({ toPrint: plan.toPrint, toPull: plan.toPull });
      setState({ status: 'idle' });
      onApplied(plan.keepManual);
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }

  const reprints = useMemo(() => pendingReprints(cards), [cards]);
  const plan = state.status === 'ready' ? planApply(state, cards, '') : null;
  const stale = state.status === 'ready' && state.basis !== basis;

  return (
    <section className="panel" aria-labelledby="build-head">
      <h2 id="build-head">3. Build the Update</h2>
      <p className="muted num">
        {acceptedAdds.length + manualIns.length} In ({acceptedAdds.length} accepted adds, {manualIns.length} by name) · {acceptedCuts.length} Out
      </p>
      <div className="actions">
        <button type="button" className="primary" disabled={total === 0 || state.status === 'running' || !ready || applying} onClick={() => void build()}>
          Build the Update
        </button>
        {state.status === 'running' && (
          <button type="button" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      {!cardsReady && <p className="muted">Waits until the shared card state has loaded from the server.</p>}
      {cardsReady && !stickyReady && <p className="muted">Waiting for the Log: the Winner&rsquo;s Picks and Bans have not loaded from the server yet.</p>}
      {state.status === 'running' && (
        <p className="status num" role="status">
          {state.what}
          {state.total > 0 ? `: ${state.done} of ${state.total}` : '…'}
        </p>
      )}
      {state.status === 'error' && <p className="status error">{state.message}</p>}
      {applied && (
        <div className="notice">
          <p>
            <a href="#/print">Print batch has {applied.toPrint} new {applied.toPrint === 1 ? 'card' : 'cards'}</a> ·{' '}
            <a href="#/cube">
              {applied.toPull} {applied.toPull === 1 ? 'card' : 'cards'} to pull
            </a>
          </p>
          <p className="muted">Then push the List to CubeCobra (step 4).</p>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="preview">
          <h3>
            In <span className="count num">{state.ins.length}</span>
          </h3>
          {state.ins.length === 0 && <p className="muted">None.</p>}
          <ul className="items">
            {state.ins.map((i) => (
              <li key={i.name} className="item">
                {i.image ? (
                  <img className="thumb" src={smallImage(i.image)} alt="" loading="lazy" decoding="async" width={146} height={204} />
                ) : (
                  <span className="thumb thumb-empty" aria-hidden="true" />
                )}
                <span className="row-text">
                  <span className="row-name">{i.facts?.name ?? i.name}</span>
                  {i.error ? (
                    <span className="error">{i.error}</span>
                  ) : (
                    <span className="muted num">
                      {IN_ACTION_TEXT[i.action]} · {i.printing}
                      {i.wanted ? ` · ${i.wanted.reason === 'upstream-pick' ? 'Upstream’s Printing' : 'default rule'}` : ''}
                    </span>
                  )}
                  {i.sticky && (
                    <span className="chips">
                      <span className="chip chip-mark">Winner&rsquo;s Pick</span>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <h3>
            Out <span className="count num">{state.outs.length}</span>
          </h3>
          {state.outs.length === 0 && <p className="muted">None.</p>}
          <ul className="items">
            {state.outs.map((o) => (
              <li key={o.name} className="item">
                {o.card ? (
                  <img
                    className="thumb"
                    src={(o.card.in_box ?? o.card.wanted).image_small}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={146}
                    height={204}
                  />
                ) : (
                  <span className="thumb thumb-empty" aria-hidden="true" />
                )}
                <span className="row-text">
                  <span className="row-name">{o.name}</span>
                  {o.error ? (
                    <span className="error">{o.error}</span>
                  ) : (
                    <span className="muted num">
                      {o.card!.in_box
                        ? `In-box ${o.card!.in_box.set.toUpperCase()} ${o.card!.in_box.collector_number} · to pull`
                        : 'Not printed yet · leaves the Print batch'}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted num">{reprints} reprints already pending in the Print batch.</p>
          {plan && (
            <p className="num" role="status">
              Apply writes {plan.writes.history.in.length} In and {plan.writes.history.out.length} Out.
              {plan.errors > 0 &&
                ` ${plan.errors} ${plan.errors === 1 ? 'row with an error is' : 'rows with errors are'} skipped and ${plan.errors === 1 ? 'stays' : 'stay'} accepted.`}
              {plan.unchanged > 0 && ` ${plan.unchanged} ${plan.unchanged === 1 ? 'row changes' : 'rows change'} nothing (already on or off the List).`}
            </p>
          )}
          {stale && (
            <p className="status error" role="alert">
              Decisions or names changed since this preview; build again.
            </p>
          )}
          {isOwner ? (
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={applying || stale || !ready || !plan || planIsEmpty(plan)}
                onClick={() => void apply(state)}
              >
                {applying ? 'Applying…' : 'Apply Update'}
              </button>
            </div>
          ) : (
            <p className="muted">Only the Owner can apply an Update.</p>
          )}
        </div>
      )}
    </section>
  );
}

const IN_ACTION_TEXT: Record<ResolvedIn['action'], string> = {
  new: 'New card, to print',
  back: 'Back from retired, to print',
  keep: 'Still in the box, stays',
  none: 'Already on the List',
};

function History({ history }: { history: UpdateHistoryEntry[] }) {
  return (
    <section className="panel" aria-labelledby="history-head">
      <h2 id="history-head">Applied Updates</h2>
      <ul className="items">
        {history.slice(0, 10).map((h) => (
          <li key={h.at} className="item">
            <span className="row-text">
              <span className="row-name num">
                {h.date} · {h.in.length} In, {h.out.length} Out {h.source === 'manual' ? '(by hand)' : ''}
              </span>
              {h.in.length > 0 && <span className="muted">In: {h.in.join(', ')}</span>}
              {h.out.length > 0 && <span className="muted">Out: {h.out.join(', ')}</span>}
            </span>
            <CopyButton text={[...h.in.map((n) => `+ ${n}`), ...h.out.map((n) => `- ${n}`)].join('\n')} label="Copy" />
          </li>
        ))}
      </ul>
    </section>
  );
}
