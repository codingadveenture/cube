// The Printing picker's filters, art grouping and badges. Pure.
import { artKey } from './style';
import { isCollectors, type IndexPrinting } from './types';

export type FrameFilter = 'any' | 'old' | 'modern' | 'future';
export type BorderFilter = 'any' | 'black' | 'white' | 'borderless';

export interface PickerFilters {
  hidePromos: boolean;
  hideCollectors: boolean;
  frame: FrameFilter;
  border: BorderFilter;
  highresOnly: boolean;
  /** Digital-only (MTGO, Arena) Printings are hidden unless this is on. */
  showDigital: boolean;
}

export const DEFAULT_FILTERS: PickerFilters = {
  hidePromos: true,
  hideCollectors: true,
  frame: 'any',
  border: 'any',
  highresOnly: false,
  showDigital: false,
};

function frameMatches(frame: string, f: FrameFilter): boolean {
  if (f === 'any') return true;
  if (f === 'old') return frame === '1993' || frame === '1997';
  if (f === 'modern') return frame === '2003' || frame === '2015';
  return frame === 'future';
}

/**
 * The Printings the filters let through. The Printings in `keep` (the current Wanted and In-box)
 * always stay, so a filter never hides them, digital-only ones included.
 */
export function filterPrintings(
  printings: readonly IndexPrinting[],
  f: PickerFilters,
  keep: ReadonlySet<string> = new Set(),
): IndexPrinting[] {
  return printings.filter(
    (p) =>
      keep.has(p.id) ||
      ((!f.hidePromos || !p.promo) &&
        (!f.hideCollectors || !isCollectors(p)) &&
        frameMatches(p.frame, f.frame) &&
        (f.border === 'any' || p.border_color === f.border) &&
        (!f.highresOnly || p.highres) &&
        (f.showDigital || !p.digital)),
  );
}

export interface ArtGroup {
  key: string;
  /** Pinned Printings first, then newest first. */
  printings: IndexPrinting[];
  /** The Printing whose image the tile shows: the newest. */
  cover: IndexPrinting;
  pinned: boolean;
}

function newestFirst(a: IndexPrinting, b: IndexPrinting): number {
  return b.released_at.localeCompare(a.released_at);
}

/** One group per art, newest art first, with the arts holding a pinned Printing on top. */
export function groupByArt(printings: readonly IndexPrinting[], pinned: ReadonlySet<string> = new Set()): ArtGroup[] {
  const map = new Map<string, IndexPrinting[]>();
  for (const p of printings) map.set(artKey(p), [...(map.get(artKey(p)) ?? []), p]);
  const groups: ArtGroup[] = [...map.entries()].map(([key, list]) => {
    const byDate = [...list].sort(newestFirst);
    const ordered = [...byDate].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
    return { key, printings: ordered, cover: byDate[0]!, pinned: list.some((p) => pinned.has(p.id)) };
  });
  return groups.sort((a, b) => Number(b.pinned) - Number(a.pinned) || newestFirst(a.cover, b.cover));
}

/** Short badges for a Printing variant. */
export function badges(p: IndexPrinting): string[] {
  const out: string[] = [];
  // "MTGO" and/or "Arena" for a digital-only Printing (from its games); a paper one gets none.
  if (p.digital) {
    const games = p.games ?? [];
    if (games.includes('mtgo')) out.push('MTGO');
    if (games.includes('arena')) out.push('Arena');
    if (!games.includes('mtgo') && !games.includes('arena')) out.push('digital-only');
  }
  if (p.set === '30a') out.push('30A');
  if (p.frame === '1993' || p.frame === '1997') out.push('retro');
  if (p.border_color === 'borderless') out.push('borderless');
  if (p.frame_effects.includes('extendedart')) out.push('extended');
  if (p.frame_effects.includes('showcase')) out.push('showcase');
  if (p.promo) out.push('promo');
  if (!p.highres) out.push('low-res');
  if (p.set === 'sld') out.push('Secret Lair');
  if (isCollectors(p)) out.push("collectors' edition");
  return out;
}
