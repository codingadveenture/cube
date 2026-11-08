// The box against Upstream: what the scanned piles hold, compared straight with the proposed List
// (Upstream with the Winner's Picks kept and the Bans left out). To pull = in the box, not proposed;
// To print = proposed, not in the box. This is the whole gap for a box that skipped an Update: it
// reads the scan, not the record, and changes nothing. Pure: no React, no storage, no network.
import { pilesOf, type Diff } from './diff';

/** A card of the box or of the proposed List, by comparison key (oracle_id when known, else "n:" + name). */
export interface BoxCard {
  key: string;
  name: string;
  /** The oracle_id when the record knows the card; null for a name the record has never seen. */
  oracle_id: string | null;
  /** Copies the scan found (0 for a card to print). */
  count: number;
  /** The piles the copies were scanned in. */
  piles: string[];
  /** A small image of the scanned Printing, when one resolved. */
  image_small: string | null;
}

export interface BoxDiff {
  /** Every card the scan found, once per key. */
  box: BoxCard[];
  /** Proposed cards the box lacks, by name. */
  print: BoxCard[];
  /** Box cards the proposed List lacks, by name. */
  pull: BoxCard[];
  /** How many cards the proposed List has. */
  proposed: number;
}

const byName = (a: BoxCard, b: BoxCard) => a.name.localeCompare(b.name, 'en');

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Every card the scan found: the expected cards present (once or more), the To print cards found
 * anyway, and the unexpected names, each under its comparison key. `keyOf` turns an unexpected name
 * into its key (an oracle_id when some record name matches it, else "n:" + the normalised name).
 */
export function boxCards(diff: Diff, keyOf: (name: string) => string): BoxCard[] {
  const out = new Map<string, BoxCard>();
  const put = (c: BoxCard) => {
    const prev = out.get(c.key);
    if (!prev) {
      out.set(c.key, c);
      return;
    }
    prev.count += c.count;
    prev.piles = unique([...prev.piles, ...c.piles]);
    prev.image_small ??= c.image_small;
  };
  for (const r of [...diff.present, ...diff.duplicates]) {
    put({
      key: r.card.oracle_id,
      name: r.card.name,
      oracle_id: r.card.oracle_id,
      count: r.count,
      piles: pilesOf(r.rows),
      image_small: r.scanned?.image_small ?? r.card.in_box.image_small,
    });
  }
  for (const f of diff.foundToPrint) {
    put({
      key: f.card.oracle_id,
      name: f.card.name,
      oracle_id: f.card.oracle_id,
      count: f.count,
      piles: pilesOf(f.rows),
      image_small: f.rows.find((x) => x.printing)?.printing?.image_small ?? null,
    });
  }
  for (const u of diff.unexpected) {
    const key = keyOf(u.name);
    put({
      key,
      name: u.name,
      oracle_id: key.startsWith('n:') ? null : key,
      count: u.count,
      piles: pilesOf(u.rows),
      image_small: u.rows.find((x) => x.printing)?.printing?.image_small ?? null,
    });
  }
  return [...out.values()];
}

/** The box against the proposed List (key -> name, from proposedList). */
export function boxAgainstUpstream(diff: Diff, proposed: ReadonlyMap<string, string>, keyOf: (name: string) => string): BoxDiff {
  const box = boxCards(diff, keyOf);
  const inBox = new Set(box.map((c) => c.key));
  const pull = box.filter((c) => !proposed.has(c.key)).sort(byName);
  const print = [...proposed]
    .filter(([k]) => !inBox.has(k))
    .map(([key, name]): BoxCard => ({ key, name, oracle_id: key.startsWith('n:') ? null : key, count: 0, piles: [], image_small: null }))
    .sort(byName);
  return { box, print, pull, proposed: proposed.size };
}

/** Scryfall's paper printings of a card the record does not know, by exact front name. */
export function scryfallByName(name: string): string {
  const front = name.split(' // ')[0] ?? name;
  const q = encodeURIComponent(`!"${front}" game:paper`).replace(/%20/g, '+');
  return `https://scryfall.com/search?q=${q}&unique=prints&order=released`;
}
