import type { Card, PrintingBase } from '../types';
import { wantedDiffers } from '../cube/order';
import { isListHash, previousHash } from '../router';

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
  return (
    <article className="detail">
      <p>
        <BackToCube />
      </p>
      <h1>{card.name}</h1>
      <p className="muted">
        {card.type_line} {card.mana_cost && <span className="num">· {card.mana_cost}</span>}
      </p>
      <p className={differs ? 'marker-line' : 'muted'}>
        {differs ? 'Wanted Printing differs from In-box: reprint in the next Print batch.' : 'Wanted is the In-box Printing.'}
      </p>
      {card.flags.length > 0 && (
        <ul className="flags">
          {card.flags.map((f, i) => (
            <li key={i}>
              {f.type === 'art' ? 'Art flag' : f.type} raised by {f.by}
            </li>
          ))}
        </ul>
      )}
      <div className="side-by-side">
        <PrintingPanel
          title="In-box"
          printing={card.in_box}
          extra={[
            ['Source', card.in_box.source],
            ['Confidence', card.in_box.confidence],
          ]}
        />
        <PrintingPanel title="Wanted" printing={card.wanted} extra={[['Reason', card.wanted.reason]]} />
      </div>
      <TagList label="Cycles" items={card.cycles} />
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
