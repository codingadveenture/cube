import { describe, expect, it } from 'vitest';
import type { Card } from '../types';
import { groupCards } from './order';

function c(name: string, color: Card['color_category'], type: Card['type_category'], cmc: number): Card {
  return { name, color_category: color, type_category: type, cmc } as Card;
}

describe('groupCards', () => {
  it('sorts by color, type, mana value, then name', () => {
    const sections = groupCards([
      c('Island', 'L', 'Land', 0),
      c('Counterspell', 'U', 'Instant', 2),
      c('Snapcaster Mage', 'U', 'Creature', 2),
      c('Brainstorm', 'U', 'Instant', 1),
      c('Swords to Plowshares', 'W', 'Instant', 1),
      c('Ancestral Recall', 'U', 'Instant', 1),
      c('Sol Ring', 'C', 'Artifact', 1),
      c('Fire // Ice', 'M', 'Instant', 4),
    ]);
    expect(sections.map((s) => [s.color, s.count])).toEqual([
      ['W', 1],
      ['U', 4],
      ['C', 1],
      ['M', 1],
      ['L', 1],
    ]);
    const blue = sections[1]!;
    expect(blue.groups.map((g) => g.type)).toEqual(['Creature', 'Instant']);
    expect(blue.groups[1]!.cards.map((x) => x.name)).toEqual(['Ancestral Recall', 'Brainstorm', 'Counterspell']);
  });

  it('groups mana value 8 and above into one bucket sorted by name', () => {
    const [section] = groupCards([
      c('Zygote', 'C', 'Creature', 8),
      c('Emrakul, the Aeons Torn', 'C', 'Creature', 15),
      c('Blightsteel Colossus', 'C', 'Creature', 12),
      c('Wurmcoil Engine', 'C', 'Creature', 6),
    ]);
    expect(section!.groups[0]!.cards.map((x) => x.name)).toEqual([
      'Wurmcoil Engine',
      'Blightsteel Colossus',
      'Emrakul, the Aeons Torn',
      'Zygote',
    ]);
  });
});
