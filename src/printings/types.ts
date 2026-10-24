// Types for public/data/printings/<oracle_id>.json, built by scripts/build-printings.mjs.

export type Frame = '1993' | '1997' | '2003' | '2015' | 'future';

export interface IndexPrinting {
  id: string;
  set: string;
  set_name: string;
  set_type: string;
  collector_number: string;
  released_at: string;
  frame: Frame | string;
  frame_effects: string[];
  border_color: string;
  full_art: boolean;
  textless: boolean;
  promo: boolean;
  promo_types: string[];
  finishes: string[];
  highres: boolean;
  illustration_id: string | null;
  artist: string;
  image_normal: string;
  back_image_normal: string | null;
  back_illustration_id: string | null;
  security_stamp: string | null;
  reprint: boolean;
  variation: boolean;
  booster: boolean;
  /** True for a digital-only Printing (MTGO or Arena); every Cube card is a Proxy, so it is printable. */
  digital: boolean;
  /** Scryfall's games, for example ["paper", "mtgo"] or ["arena"]; tells MTGO from Arena. */
  games: string[];
}

export interface PrintingsFile {
  name: string;
  oracle_id: string;
  /** Newest first. */
  printings: IndexPrinting[];
}

/** Collectors' Edition sets: square-cornered oddities, hidden unless asked for. */
export const COLLECTORS_SETS: readonly string[] = ['ced', 'cei'];

export type DigitalOnly = 'MTGO' | 'Arena' | 'digital';

/**
 * Where a set of Printings exists when every one is digital-only: "MTGO" when all are on MTGO,
 * else "Arena" when all are on Arena, else "digital". Null when any is a paper Printing (or the
 * list is empty), so a mix of paper and digital counts as paper.
 */
export function digitalOnly(printings: readonly Pick<IndexPrinting, 'digital' | 'games'>[]): DigitalOnly | null {
  if (printings.length === 0 || printings.some((p) => !p.digital)) return null;
  const all = (game: string) => printings.every((p) => (p.games ?? []).includes(game));
  if (all('mtgo')) return 'MTGO';
  if (all('arena')) return 'Arena';
  return 'digital';
}

export function isCollectors(p: Pick<IndexPrinting, 'set'>): boolean {
  return COLLECTORS_SETS.includes(p.set);
}
