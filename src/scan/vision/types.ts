// Types shared by the art catalog, the matcher and the scanner API.

/** One row of public/data/art-catalog.json: one face of one Printing. */
export interface CatalogEntry {
  /** Row number in art-catalog.bin. */
  row: number;
  scryfall_id: string;
  oracle_id: string;
  /** Card name (for a back-face row too). */
  name: string;
  set: string;
  collector_number: string;
  /** The illustration of this face (the back face's own for a back-face row). */
  illustration_id: string | null;
  digital: boolean;
  face: 'front' | 'back';
  /** 'hosted': from the CollectorVision catalog; 'self': embedded by build-art-catalog.mjs. */
  source: 'hosted' | 'self';
  /** True for a card on the List, false for an extra card (data/extra-cards.txt). */
  on_list: boolean;
}

/** A catalog row with its cosine similarity to a query embedding. */
export interface Hit extends CatalogEntry {
  score: number;
}
