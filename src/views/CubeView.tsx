import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../types';
import { COLOR_LABEL, groupCards, summarize, wantedDiffers } from '../cube/order';
import { cubeHash, isDetailHash, previousHash, replaceHash } from '../router';

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
  const summary = useMemo(() => summarize(cards), [cards]);
  const keys = useMemo(() => new Map(cards.map((c) => [c.oracle_id, searchKey(c.name)])), [cards]);

  const sections = useMemo(() => {
    const q = searchKey(deferred);
    const filtered = q ? cards.filter((c) => keys.get(c.oracle_id)?.includes(q)) : cards;
    return groupCards(filtered);
  }, [cards, keys, deferred]);
  const shown = sections.reduce((s, x) => s + x.count, 0);

  return (
    <div className="cube">
      <p className="summary num">
        <span>{summary.total} cards</span>
        <span>{summary.wantedDiffers} Wanted differs from In-box</span>
        <span>{summary.flagged} with an Art flag</span>
        <span>{summary.nonPaper} In-box not on paper</span>
      </p>
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
      {query && (
        <p className="muted num" aria-live="polite">
          {shown} of {cards.length} cards
        </p>
      )}
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
              <ul className="rows">
                {group.cards.map((c) => (
                  <CardRow key={c.oracle_id} card={c} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {shown === 0 && <p className="status">No card matches “{query}”.</p>}
    </div>
  );
}

function CardRow({ card }: { card: Card }) {
  const differs = wantedDiffers(card);
  return (
    <li>
      <a className="row" href={`#/cube/${encodeURIComponent(card.oracle_id)}`}>
        <img
          className="thumb"
          src={card.in_box.image_small}
          alt=""
          loading="lazy"
          decoding="async"
          width={146}
          height={204}
        />
        <span className="row-text">
          <span className="row-name">{card.name}</span>
          <span className="printing num">
            {card.in_box.set.toUpperCase()} {card.in_box.collector_number.toUpperCase()}
            {differs && (
              <span className="marker" title={`Wanted: ${card.wanted.set.toUpperCase()} ${card.wanted.collector_number}`}>
                Wanted differs
              </span>
            )}
          </span>
          {(card.cycles.length > 0 || card.flags.length > 0) && (
            <span className="chips">
              {card.cycles.map((cy) => (
                <span key={cy} className="chip">
                  {cy}
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
    </li>
  );
}

