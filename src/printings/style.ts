// The look of a Printing: its run key (what a Print run must share) and its art key.
import type { IndexPrinting } from './types';

export type RunStyle = 'retro' | 'borderless' | 'extended' | 'showcase' | 'fullart' | 'regular';

export interface RunKey {
  set: string;
  frame: string;
  border_color: string;
  style: RunStyle;
}

type StyleFields = Pick<IndexPrinting, 'set' | 'frame' | 'border_color' | 'frame_effects' | 'full_art'>;

export function runStyle(p: Omit<StyleFields, 'set'>): RunStyle {
  if (p.frame === '1993' || p.frame === '1997') return 'retro';
  if (p.border_color === 'borderless') return 'borderless';
  if (p.frame_effects.includes('extendedart')) return 'extended';
  if (p.frame_effects.includes('showcase')) return 'showcase';
  if (p.full_art) return 'fullart';
  return 'regular';
}

export function runKey(p: StyleFields): RunKey {
  return { set: p.set, frame: p.frame, border_color: p.border_color, style: runStyle(p) };
}

/** The id of a Print run: set and style. */
export function runId(k: Pick<RunKey, 'set' | 'style'>): string {
  return `${k.set}|${k.style}`;
}

export function frameLabel(frame: string): string {
  if (frame === '1993' || frame === '1997') return `${frame} retro frame`;
  if (frame === 'future') return 'future frame';
  if (frame === '2003' || frame === '2015') return `${frame} modern frame`;
  return frame ? `${frame} frame` : 'unknown frame';
}

const STYLE_LABEL: Record<RunStyle, string> = {
  retro: 'retro frame',
  borderless: 'borderless',
  extended: 'extended art',
  showcase: 'showcase',
  fullart: 'full art',
  regular: 'regular frame',
};

/** The style part of a label, for example "retro frame · black border" or "borderless". */
export function styleLabel(k: Omit<RunKey, 'set'>): string {
  const parts = [STYLE_LABEL[k.style]];
  if (k.border_color && k.border_color !== 'borderless') parts.push(`${k.border_color} border`);
  return parts.join(' · ');
}

/** For example "MH3 · retro frame · black border". */
export function runLabel(k: RunKey): string {
  return `${k.set.toUpperCase()} · ${styleLabel(k)}`;
}

/** The art of a Printing: its illustration id, or the Printing id when Scryfall has none. */
export function artKey(p: Pick<IndexPrinting, 'id' | 'illustration_id'>): string {
  return p.illustration_id ?? `printing:${p.id}`;
}
