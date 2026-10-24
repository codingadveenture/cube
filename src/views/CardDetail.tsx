import type { Card, PrintingBase } from '../types';
import { wantedDiffers } from '../cube/order';
import { TOKENS_HASH, cycleHash, isListHash, previousHash, printingsHash } from '../router';
import { humanizeCycle } from '../printings/cycles';
import { reasonLabel } from '../printings/wanted';
import { useStore, useUpdatesMetaDoc } from '../store/context';
import { historyTrim } from '../print/settings';
import { LIFECYCLE_LABEL, lifecycleOf, pullPatches } from '../store/lifecycle';
import { buildUpdateWrites } from '../upstream/update';
import { CardActions } from './CardActions';

function scryfallUrl(p: PrintingBase): string {
  return `https://scryfall.com/card/${encodeURIComponent(p.set)}/${encodeURIComponent(p.collector_number)}`;
}

function PrintingPanel({
  title,
  printing,
  extra,
}: {
  title: string;
  printing: PrintingBase;
  extra: [string, string][];
}) {
  const rows: [string, string][] = [
    ['Set', `${printing.set.toUpperCase()} · ${printing.set_name}`],
    ['Collector number', printing.collector_number],
    ['Released', printing.released_at],
    ['Artist', printing.artist],
    ['Frame', printing.frame],
    ['Border', printing.border_color],
    ['Language', printing.lang],
    ['On paper', printing.paper ? 'yes' : 'no'],
    ...extra,
  ];
  return (
    <section className="panel">
      <h2>{title}</h2>
      <div className="faces">
        <img className="card-img" src={printing.image_normal} alt={`${title} front`} width={488} height={680} />
        {printing.back_image_normal && (
          <img
            className="card-img"
            src={printing.back_image_normal}
            alt={`${title} back: ${printing.back_name ?? ''}`}
            loading="lazy"
            width={488}
            height={680}
          />
        )}
      </div>
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      <p>
        <a href={scryfallUrl(printing)} target="_blank" rel="noopener noreferrer">
          Open on Scryfall
        </a>
      </p>
    </section>
  );
}

function TagList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="taglist">
      <h3>{label}</h3>
      <p className="chips">
        {items.map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
      </p>
    </div>
  );
}

/** Back to the list the card was opened from: a real Back, so the search and scroll are kept. */
function BackToCube() {
  const from = previousHash();
  const fromList = from !== null && isListHash(from);
  return (
    <a
      href={fromList ? from : '#/cube'}
      onClick={(e) => {
        if (!fromList) return;
        e.preventDefault();
        window.history.back();
      }}
    >
      Back to the Cube
    </a>
  );
}

export function CardDetail({ cards, oracleId }: { cards: Card[]; oracleId: string }) {
  const { auth } = useStore();
  const card = cards.find((c) => c.oracle_id === oracleId);
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
  const differs = wantedDiffers(card);
  const life = lifecycleOf(card);
  let line: string;
  if (life === 'to_print') line = `Not printed yet: Wanted ${card.wanted.set.toUpperCase()} ${card.wanted.collector_number} is in the Print batch.`;
  else if (life === 'to_pull') line = 'Off the List: take it out of the box, then mark it pulled.';
  else if (life === 'retired')
    line = card.retired_printing
      ? `Retired: off the List and out of the box. It was ${card.retired_printing.set.toUpperCase()} ${card.retired_printing.collector_number}.`
      : 'Retired: off the List and never printed.';
  else if (differs && card.in_box)
    line = `Reprint pending: Wanted ${card.wanted.set.toUpperCase()} ${card.wanted.collector_number} differs from In-box ${card.in_box.set.toUpperCase()} ${card.in_box.collector_number}.`;
  else line = 'Wanted is the In-box Printing.';
  return (
    <article className="detail">
      <p>
        <BackToCube />
      </p>
      <h1>{card.name}</h1>
      {life !== 'in_box' && (
        <p className="chips">
          <span className="chip chip-mark">{LIFECYCLE_LABEL[life]}</span>
        </p>
      )}
      <p className="muted">
        {card.type_line} {card.mana_cost && <span className="num">· {card.mana_cost}</span>}
      </p>
      <p className={differs || life !== 'in_box' ? 'marker-line' : 'muted'}>{line}</p>
      <LifecycleActions card={card} cards={cards} />
      {card.produces_tokens.length > 0 && (
        <p className="makes">
          Makes:{' '}
          <a href={TOKENS_HASH}>{[...new Set(card.produces_tokens.map((t) => t.name))].join(', ')}</a>
        </p>
      )}
      <p>
        <a className="button" href={printingsHash(card.oracle_id)}>
          {auth.isOwner ? 'Choose Wanted Printing' : 'Suggest a Printing'}
        </a>
      </p>
      {card.flags.length > 0 && (
        <ul className="flags">
          {card.flags.map((f, i) => (
            <li key={i}>
              {f.type === 'art' ? 'Art flag' : f.type} raised by {f.by}
              {f.note ? `: ${f.note}` : ''}
            </li>
          ))}
        </ul>
      )}
      <CardActions card={card} cards={cards} />
      <div className="side-by-side">
        {card.in_box ? (
          <PrintingPanel
            title="In-box"
            printing={card.in_box}
            extra={[
              ['Source', card.in_box.source],
              ['Confidence', card.in_box.confidence],
            ]}
          />
        ) : (
          <section className="panel">
            <h2>In-box</h2>
            <p className="muted">{life === 'retired' ? 'Not in the box.' : 'Not in the box yet.'}</p>
          </section>
        )}
        <PrintingPanel title="Wanted" printing={card.wanted} extra={[['Reason', reasonLabel(card.wanted.reason)]]} />
      </div>
      {card.cycles.length > 0 && (
        <div className="taglist">
          <h3>Cycles</h3>
          <p className="chips">
            {card.cycles.map((cy) => (
              <a key={cy} className="chip chip-link" href={cycleHash(cy)}>
                {humanizeCycle(cy)}
              </a>
            ))}
          </p>
        </div>
      )}
      <TagList label="Oracle cycle tags" items={card.oracle_cycle_tags} />
      {card.produces_tokens.length > 0 && (
        <div className="taglist">
          <h3>Produces tokens</h3>
          <ul>
            {card.produces_tokens.map((t) => (
              <li key={t.scryfall_id}>
                <a href={`https://api.scryfall.com/cards/${encodeURIComponent(t.scryfall_id)}?format=image&version=normal`} target="_blank" rel="noopener noreferrer">
                  {t.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/** Owner: Mark Out (the same Out path as an Update) and Mark pulled. */
function LifecycleActions({ card, cards }: { card: Card; cards: Card[] }) {
  const { auth, store, save } = useStore();
  const updatesLive = useUpdatesMetaDoc();
  if (!auth.isOwner || !store) return null;
  const life = lifecycleOf(card);
  // meta/updates.history stays bounded, as print history: trimmed only from a server snapshot.
  const trim = updatesLive.status === 'ready' && !updatesLive.fromCache ? historyTrim(updatesLive.data?.history) : [];
  if (life === 'in_box' || life === 'to_print') {
    return (
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            const what = life === 'in_box' ? 'It stays in the box until you mark it pulled.' : 'It leaves the Print batch.';
            if (!window.confirm(`Take ${card.name} off the List? ${what}`)) return;
            const writes = buildUpdateWrites({ ins: [], outs: [card.oracle_id], cards, decisions: {}, source: 'manual', now: new Date().toISOString() });
            void save(() => store.applyUpdate({ ...writes, trim }), `${card.name} is Out.`);
          }}
        >
          Mark Out
        </button>
      </div>
    );
  }
  if (life === 'to_pull') {
    return (
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            // Nothing in the app puts a card back in the box, so a stray tap is confirmed.
            if (!window.confirm(`Mark ${card.name} as pulled from the box?`)) return;
            void save(() => store.updateCards(pullPatches([card], new Date().toISOString())), `${card.name} marked pulled.`);
          }}
        >
          Mark pulled
        </button>
      </div>
    );
  }
  return null;
}
