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

export interface Card {
  name: string;
  front_name: string;
  oracle_id: string;
  in_list: boolean;
  list_source: 'cubecobra' | 'sheet-adds';
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
  in_box: InBoxPrinting;
  wanted: WantedPrinting;
  cycles: string[];
  oracle_cycle_tags: string[];
  flags: Flag[];
}

export interface CardsFile {
  generated_at: string;
  source: { cube_record_generated_at: string; scryfall_fetched_at: string };
  cards: Card[];
}
