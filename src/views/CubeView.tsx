import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Card } from '../types';
import { COLOR_LABEL, compareCards, groupCards, summarize, wantedDiffers } from '../cube/order';
import { cubeHash, isDetailHash, previousHash, replaceHash } from '../router';
import { humanizeCycle } from '../printings/cycles';
import { LIFECYCLE_LABEL, lifecycleOf, partitionCards, physicallyPresent, pullPatches, shownPrinting } from '../store/lifecycle';
import { readCubeLayout, writeCubeLayout, type CubeLayout } from '../cube/layout';
import { useStore } from '../store/context';

// Scroll position of the list when a card was opened from it, restored on the way back.
let savedScroll: { hash: string; y: number } | null = null;

function searchKey(s: string): string {
  // Like normalizeName but keeps both halves of split names searchable.
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function CubeView({ cards, initialQuery }: { cards: Card[]; initialQuery: string }) {
  // The search lives in the hash (#/cube?q=bolt), so it is still there after opening a card.
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  function changeQuery(q: string) {
    setQuery(q);
    replaceHash(cubeHash(q));
  }

  // Read before the first render, so the remembered layout shows without a flash of the other one.
  const [layout, setLayout] = useState<CubeLayout>(() => readCubeLayout());
  function chooseLayout(next: CubeLayout) {
    setLayout(next);
    writeCubeLayout(next);
  }

  const lastY = useRef(0);
  useLayoutEffect(() => {
    if (savedScroll && savedScroll.hash === window.location.hash) window.scrollTo(0, savedScroll.y);
    savedScroll = null;
    lastY.current = window.scrollY;
    const onScroll = () => {
      lastY.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      // Leaving for a card page: remember where the list was.
      const from = previousHash();
      if (isDetailHash(window.location.hash) && from !== null) savedScroll = { hash: from, y: lastY.current };
    };
  }, []);
  const deferred = useDeferredValue(query);
  // The count is what is physically in the box: on the List, or waiting to be pulled.
  const present = useMemo(() => physicallyPresent(cards), [cards]);
  const summary = useMemo(() => summarize(present), [present]);
  const parts = useMemo(() => partitionCards(cards), [cards]);
  const keys = useMemo(() => new Map(cards.map((c) => [c.oracle_id, searchKey(c.name)])), [cards]);

  const view = useMemo(() => {
    const q = searchKey(deferred);
    const match = (list: Card[]) => (q ? list.filter((c) => keys.get(c.oracle_id)?.includes(q)) : [...list]).sort(compareCards);
    return { sections: groupCards(match(parts.inBox)), toPrint: match(parts.toPrint), toPull: match(parts.toPull), retired: match(parts.retired) };
  }, [parts, keys, deferred]);
  const sections = view.sections;
  const shown = sections.reduce((s, x) => s + x.count, 0) + view.toPrint.length + view.toPull.length;
  const listed = parts.inBox.length + parts.toPrint.length + parts.toPull.length;

  return (
    <div className="cube">
      <p className="summary num">
        <span>{summary.total} cards in the box</span>
        {parts.toPrint.length > 0 && <span>{parts.toPrint.length} to print</span>}
        {parts.toPull.length > 0 && <span>{parts.toPull.length} to pull</span>}
        <span>{summary.wantedDiffers} Wanted differs from In-box</span>
        <span>{summary.flagged} with an Art flag</span>
        <span>{summary.nonPaper} In-box digital-only art</span>
      </p>
      <div className="cube-tools">
        <label className="search">
          <span className="visually-hidden">Search by name</span>
          <input
            type="search"
            placeholder="Search by name"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="segmented" role="group" aria-label="Layout">
          <button type="button" aria-pressed={layout === 'spoiler'} onClick={() => chooseLayout('spoiler')}>
            Spoiler
          </button>
          <button type="button" aria-pressed={layout === 'list'} onClick={() => chooseLayout('list')}>
            List
          </button>
        </div>
      </div>
      {query && (
        <p className="muted num" aria-live="polite">
          {shown} of {listed} cards
        </p>
      )}
      {view.toPrint.length > 0 && <ToPrint cards={view.toPrint} layout={layout} />}
      {view.toPull.length > 0 && <ToPull cards={view.toPull} layout={layout} />}
      {sections.map((section) => (
        <section key={section.color} className="section" aria-labelledby={`sec-${section.color}`}>
          <h2 id={`sec-${section.color}`} className="section-head">
            {COLOR_LABEL[section.color]} <span className="count num">{section.count}</span>
          </h2>
          {section.groups.map((group) => (
            <div key={group.type} className="group">
              <h3 className="group-head">
                {group.type} <span className="count num">{group.cards.length}</span>
              </h3>
              <CardList cards={group.cards} layout={layout} />
            </div>
          ))}
        </section>
      ))}
      {shown === 0 && query && <p className="status">No card matches “{query}”.</p>}
      {view.retired.length > 0 && (
        <details className="retired">
          <summary>
            <span className="num">{view.retired.length}</span> retired {view.retired.length === 1 ? 'card' : 'cards'}: off the List and out of
            the box
          </summary>
          <CardList cards={view.retired} layout={layout} />
        </details>
      )}
    </div>
  );
}

function ToPrint({ cards, layout }: { cards: Card[]; layout: CubeLayout }) {
  return (
    <section className="section lifecycle" aria-labelledby="sec-to-print">
      <h2 id="sec-to-print" className="section-head">
        To print <span className="count num">{cards.length}</span>
      </h2>
      <p className="muted">
        On the List but not in the box yet. They are in the <a href="#/print">Print batch</a>; Mark as printed puts them in the box.
      </p>
      <CardList cards={cards} layout={layout} />
    </section>
  );
}

function ToPull({ cards, layout }: { cards: Card[]; layout: CubeLayout }) {
  const { auth, store, save } = useStore();
  const [busy, setBusy] = useState(false);
  async function pull(list: Card[]) {
    if (!store || busy) return;
    const patches = pullPatches(list, new Date().toISOString());
    if (patches.length === 0) return;
    setBusy(true);
    try {
      await save(() => store.updateCards(patches), `Marked ${patches.length} ${patches.length === 1 ? 'card' : 'cards'} as pulled.`);
    } finally {
      setBusy(false);
    }
  }
  const owner = auth.isOwner && !!store;
  return (
    <section className="section lifecycle" aria-labelledby="sec-to-pull">
      <h2 id="sec-to-pull" className="section-head">
        To pull <span className="count num">{cards.length}</span>
      </h2>
      <p className="muted">Off the List but still in the box. Take them out, then mark them pulled.</p>
      {owner && cards.length > 1 && (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Mark all ${cards.length} cards as pulled from the box?`)) void pull(cards);
            }}
          >
            Mark all pulled
          </button>
        </div>
      )}
      <CardList
        cards={cards}
        layout={layout}
        action={(c) =>
          owner ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Nothing in the app puts a card back in the box, so a stray tap is confirmed.
                if (window.confirm(`Mark ${c.name} as pulled from the box?`)) void pull([c]);
              }}
            >
              Mark pulled
            </button>
          ) : null
        }
      />
    </section>
  );
}

/** The cards in the chosen layout: a grid of card images (Spoiler) or compact rows (List). */
function CardList({ cards, layout, action }: { cards: Card[]; layout: CubeLayout; action?: (card: Card) => ReactNode }) {
  if (layout === 'list') {
    return (
      <ul className="rows">
        {cards.map((c) => (
          <CardRow key={c.oracle_id} card={c} action={action?.(c)} />
        ))}
      </ul>
    );
  }
  return (
    <ul className="spoiler">
      {cards.map((c) => (
        <CardCell key={c.oracle_id} card={c} action={action?.(c)} />
      ))}
    </ul>
  );
}

/** "SET 123"; "Wanted SET 123" for a card not printed yet; "Was SET 123" for a retired one. */
function printingText(card: Card): string {
  const life = lifecycleOf(card);
  const was = life === 'retired' && card.retired_printing ? card.retired_printing : null;
  const p = was ?? shownPrinting(card);
  return `${life === 'to_print' ? 'Wanted ' : was ? 'Was ' : ''}${p.set.toUpperCase()} ${p.collector_number.toUpperCase()}`;
}

function CardCell({ card, action }: { card: Card; action?: ReactNode }) {
  const differs = wantedDiffers(card);
  const life = lifecycleOf(card);
  const badges = life !== 'in_box' || differs || card.flags.length > 0;
  return (
    <li className="spoiler-cell">
      <a className="spoiler-link" href={`#/cube/${encodeURIComponent(card.oracle_id)}`}>
        <img className="spoiler-img" src={shownPrinting(card).image_normal} alt="" loading="lazy" decoding="async" width={488} height={680} />
        <span className="spoiler-name" title={card.name}>
          {card.name}
        </span>
        <span className="spoiler-set num">{printingText(card)}</span>
        {badges && (
          <span className="chips spoiler-badges">
            {life !== 'in_box' && <span className="chip">{LIFECYCLE_LABEL[life]}</span>}
            {differs && (
              <span className="chip chip-flag num">
                Wanted {card.wanted.set.toUpperCase()} {card.wanted.collector_number.toUpperCase()}
              </span>
            )}
            {card.flags.map((f, i) => {
              const label = f.type === 'art' ? 'Art flag' : f.type;
              return (
                <span key={i} className="chip chip-flag" title={`${label} · ${f.by}`}>
                  {label}
                </span>
              );
            })}
          </span>
        )}
      </a>
      {action}
    </li>
  );
}

function CardRow({ card, action }: { card: Card; action?: ReactNode }) {
  const differs = wantedDiffers(card);
  const printing = shownPrinting(card);
  const life = lifecycleOf(card);
  return (
    <li className={action ? 'row-with-action' : undefined}>
      <a className="row" href={`#/cube/${encodeURIComponent(card.oracle_id)}`}>
        <img className="thumb" src={printing.image_small} alt="" loading="lazy" decoding="async" width={146} height={204} />
        <span className="row-text">
          <span className="row-name">{card.name}</span>
          <span className="printing num">
            {life === 'to_print' && 'Wanted '}
            {life === 'retired' && card.retired_printing ? 'Was ' : ''}
            {(life === 'retired' && card.retired_printing ? card.retired_printing : printing).set.toUpperCase()}{' '}
            {(life === 'retired' && card.retired_printing ? card.retired_printing : printing).collector_number.toUpperCase()}
            {differs && (
              <span className="marker">
                Wanted {card.wanted.set.toUpperCase()} {card.wanted.collector_number.toUpperCase()}
              </span>
            )}
          </span>
          {(card.cycles.length > 0 || card.flags.length > 0) && (
            <span className="chips">
              {card.cycles.map((cy) => (
                <span key={cy} className="chip">
                  {humanizeCycle(cy)}
                </span>
              ))}
              {card.flags.map((f, i) => (
                <span key={i} className="chip chip-flag">
                  {f.type === 'art' ? 'Art flag' : f.type} · {f.by}
                </span>
              ))}
            </span>
          )}
        </span>
      </a>
      {action}
    </li>
  );
}
