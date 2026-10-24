// Turn a Card from cards.json into the ExpectedCard the Scan diff matches against.
import type { Card, PrintingBase } from '../types';
import type { ExpectedCard } from './diff';

function keysOf(p: PrintingBase): string[] {
  return [p.scryfall_id.toLowerCase(), `${p.set.toLowerCase()}/${p.collector_number.toLowerCase()}`];
}

export function toExpectedCard(card: Card): ExpectedCard {
  // A paper Printing can carry another name than the card (Through the Omenpaths cards are
  // printed as Spider-Man cards), and scanners report that printed name.
  const aliases = [card.in_box.name, card.wanted.name].filter(
    (n): n is string => !!n && n !== card.name,
  );
  return {
    name: card.name,
    front_name: card.front_name,
    oracle_id: card.oracle_id,
    in_box: {
      illustration_id: card.in_box.illustration_id,
      set: card.in_box.set,
      collector_number: card.in_box.collector_number,
      image_small: card.in_box.image_small,
    },
    aliases: [...new Set(aliases)],
    printing_keys: [...new Set([...keysOf(card.in_box), ...keysOf(card.wanted)])],
  };
}

export function expectedCards(cards: Card[]): ExpectedCard[] {
  return cards.filter((c) => c.in_list).map(toExpectedCard);
}
