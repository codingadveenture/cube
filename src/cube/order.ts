import type { Card, ColorCategory, TypeCategory } from '../types';

// CubeCobra's Color Category order (Sort.ts): White, Blue, Black, Red, Green, Colorless,
// Multicolored, (Hybrid,) Lands. See research/community-workflows.md section 1.1.
export const COLOR_ORDER: ColorCategory[] = ['W', 'U', 'B', 'R', 'G', 'C', 'M', 'L'];
export const TYPE_ORDER: TypeCategory[] = [
  'Creature',
  'Planeswalker',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Battle',
  'Land',
  'Other',
];

export const COLOR_LABEL: Record<ColorCategory, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
  M: 'Multicolor',
  C: 'Colorless',
  L: 'Land',
};

/** CubeCobra groups mana value 8 and above into one '8+' bucket, sorted by name within it. */
export function manaValueBucket(cmc: number): number {
  return Math.min(cmc, 8);
}

function rank<T>(order: T[], v: T): number {
  const i = order.indexOf(v);
  return i === -1 ? order.length : i;
}

/** CubeCobra's default sort: color category, type category, mana value, name. */
export function compareCards(a: Card, b: Card): number {
  return (
    rank(COLOR_ORDER, a.color_category) - rank(COLOR_ORDER, b.color_category) ||
    rank(TYPE_ORDER, a.type_category) - rank(TYPE_ORDER, b.type_category) ||
    manaValueBucket(a.cmc) - manaValueBucket(b.cmc) ||
    a.name.localeCompare(b.name, 'en')
  );
}

export interface Section {
  color: ColorCategory;
  groups: { type: TypeCategory; cards: Card[] }[];
  count: number;
}

export function groupCards(cards: Card[]): Section[] {
  const sorted = [...cards].sort(compareCards);
  const sections: Section[] = [];
  for (const card of sorted) {
    let section = sections[sections.length - 1];
    if (!section || section.color !== card.color_category) {
      section = { color: card.color_category, groups: [], count: 0 };
      sections.push(section);
    }
    let group = section.groups[section.groups.length - 1];
    if (!group || group.type !== card.type_category) {
      group = { type: card.type_category, cards: [] };
      section.groups.push(group);
    }
    group.cards.push(card);
    section.count++;
  }
  return sections;
}

/** A reprint: the card is in the box and its Wanted Printing differs from its In-box Printing. */
export function wantedDiffers(c: Card): boolean {
  return c.in_box !== null && c.wanted.scryfall_id !== c.in_box.scryfall_id;
}

export function summarize(cards: Card[]) {
  return {
    total: cards.length,
    wantedDiffers: cards.filter(wantedDiffers).length,
    flagged: cards.filter((c) => c.flags.length > 0).length,
    nonPaper: cards.filter((c) => c.in_box && !c.in_box.paper).length,
  };
}
