// Types for public/data/cards.json, the contract between scripts/build-cards.mjs and the app.

export type ColorCategory = 'W' | 'U' | 'B' | 'R' | 'G' | 'M' | 'C' | 'L';
export type TypeCategory =
  | 'Creature'
  | 'Planeswalker'
  | 'Instant'
  | 'Sorcery'
  | 'Artifact'
  | 'Enchantment'
  | 'Battle'
  | 'Land'
  | 'Other';

export interface PrintingBase {
  scryfall_id: string;
  /** Name on this Printing, for example 'Spectacular Spider-Man' for a Through the Omenpaths card. */
  name: string | null;
  set: string;
  set_name: string;
  collector_number: string;
  released_at: string;
  lang: string;
  paper: boolean;
  frame: string;
  border_color: string;
  illustration_id: string | null;
  artist: string;
  image_small: string;
  image_normal: string;
  image_png: string;
  back_name: string | null;
  back_image_normal: string | null;
  back_illustration_id: string | null;
}

export interface InBoxPrinting extends PrintingBase {
  source: string;
  confidence: string;
}

export interface WantedPrinting extends PrintingBase {
  reason: string;
}

export interface Flag {
  type: string;
  by: string;
  /** The reason, for flags raised in the app. */
  note?: string;
  createdAt?: string | null;
}

/** Where a card's place on the List comes from. */
export type ListSource = 'cubecobra' | 'sheet-adds' | 'winner_pick' | 'upstream';

/**
 * Where a card stands, from In-box and in_list: in the box and on the List ('in_box'), on the
 * List but not printed yet ('to_print'), in the box but off the List ('to_pull'), or neither
 * ('retired', hidden from the Cube).
 */
export type Lifecycle = 'in_box' | 'to_print' | 'to_pull' | 'retired';

/** The In-box Printing a card had before it was pulled. */
export interface RetiredPrinting {
  scryfall_id: string;
  set: string;
  collector_number: string;
  name: string | null;
}

export interface Card {
  name: string;
  front_name: string;
  oracle_id: string;
  in_list: boolean;
  list_source: ListSource;
  cubecobra_card_id: string | null;
  layout: string;
  type_line: string;
  mana_cost: string;
  cmc: number;
  colors: string[];
  color_identity: string[];
  color_category: ColorCategory;
  type_category: TypeCategory;
  rarity: string;
  keywords: string[];
  produces_tokens: { name: string; scryfall_id: string }[];
  /** The Printing physically in the box; null for a card not printed yet or pulled. Never null in cards.json. */
  in_box: InBoxPrinting | null;
  wanted: WantedPrinting;
  cycles: string[];
  oracle_cycle_tags: string[];
  flags: Flag[];
  // Lifecycle fields from the card doc; absent in cards.json.
  retired_printing?: RetiredPrinting | null;
  added_at?: string | null;
  retired_at?: string | null;
  /** True for a card that is not in cards.json and is drawn from the facts on its doc. */
  from_facts?: boolean;
}

export interface CardsFile {
  generated_at: string;
  source: { cube_record_generated_at: string; scryfall_fetched_at: string };
  cards: Card[];
}
