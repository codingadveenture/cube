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
  digital: boolean;
}

export interface PrintingsFile {
  name: string;
  oracle_id: string;
  /** Newest first. */
  printings: IndexPrinting[];
}

/** Collectors' Edition sets: square-cornered oddities, hidden unless asked for. */
export const COLLECTORS_SETS: readonly string[] = ['ced', 'cei'];

export function isCollectors(p: Pick<IndexPrinting, 'set'>): boolean {
  return COLLECTORS_SETS.includes(p.set);
}
