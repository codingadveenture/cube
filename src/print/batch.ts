// The Print batch: reprints from the merged cards, extra lines, tokens, and the slips they become.
// Pure: no React, no storage, no network.
import type { Card } from '../types';
import { compareCards, wantedDiffers } from '../cube/order';
import { largeFromPng, largeImage, pngImage } from '../printings/images';
import type { SlipGroup } from './layout';
import type { Quality } from './settings';
import type { CardPatchFor } from '../store/types';

/** One card line of the batch: a new card (to print), a reprint (Wanted differs from In-box) or an extra line. */
export interface BatchLine {
  /** 'n:<oracle_id>' for a new card, 'r:<oracle_id>' for a reprint, 'x:<id>' for an extra line. */
  key: string;
  source: 'new' | 'reprint' | 'extra';
  oracle_id: string | null;
  /** The display name (the front face for a double-faced card). */
  name: string;
  /** The full Printing name for lists and In-box, e.g. "Front // Back" for a double-faced card. */
  list_name: string;
  set: string;
  collector_number: string;
  scryfall_id: string;
  illustration_id: string | null;
  image_normal: string;
  /** The back face's normal image for a double-faced card, else null. */
  back_image_normal: string | null;
  back_name: string | null;
  quantity: number;
}

/** A token type added to the batch with a number of copies. */
export interface TokenLine {
  key: string;
  name: string;
  count: number;
  image_png: string;
}

/** One slip on the print sheet. */
export interface Slip {
  group: SlipGroup;
  /** The batch line or token it comes from. */
  key: string;
  name: string;
  /** The image to fetch, already in the chosen quality. */
  url: string;
}

/** The batch line of a card's Wanted Printing. */
function wantedLine(c: Card, source: 'new' | 'reprint'): BatchLine {
  const w = c.wanted;
  return {
    key: `${source === 'new' ? 'n' : 'r'}:${c.oracle_id}`,
    source,
    oracle_id: c.oracle_id,
    name: c.name,
    list_name: w.name ?? c.name,
    set: w.set,
    collector_number: w.collector_number,
    scryfall_id: w.scryfall_id,
    illustration_id: w.illustration_id,
    image_normal: w.image_normal,
    back_image_normal: w.back_image_normal,
    back_name: w.back_name,
    quantity: 1,
  };
}

/** Every card on the List that is not in the box yet (to print), as a new slip of its Wanted Printing, in Cube order. */
export function newCardLines(cards: Card[]): BatchLine[] {
  return cards
    .filter((c) => c.in_list && c.in_box === null)
    .sort(compareCards)
    .map((c) => wantedLine(c, 'new'));
}

/** Every card whose Wanted Printing differs from its In-box Printing, in Cube order. */
export function reprintLines(cards: Card[]): BatchLine[] {
  return cards
    .filter((c) => c.in_list && wantedDiffers(c))
    .sort(compareCards)
    .map((c) => wantedLine(c, 'reprint'));
}

/** The image of a card face in the chosen quality: Scryfall large JPEG or png. */
export function faceImage(normal: string, quality: Quality): string {
  return quality === 'best' ? pngImage(normal) : largeImage(normal);
}

/** A token's image in the chosen quality; tokens.json carries the png. */
export function tokenImage(png: string, quality: Quality): string {
  return quality === 'best' ? png : largeFromPng(png);
}

export function frontImage(line: BatchLine, quality: Quality = 'standard'): string {
  return faceImage(line.image_normal, quality);
}

export function backImage(line: BatchLine, quality: Quality = 'standard'): string | null {
  return line.back_image_normal ? faceImage(line.back_image_normal, quality) : null;
}

/**
 * The slips of a batch: one front per copy of each checked line in batch order, then one back
 * face per copy of each checked double-faced line (the Back pool), then each token type's copies.
 */
export function composeSlips(lines: BatchLine[], tokens: TokenLine[], quality: Quality): Slip[] {
  const fronts: Slip[] = [];
  const backs: Slip[] = [];
  for (const l of lines) {
    const q = Math.max(1, Math.floor(l.quantity));
    const back = backImage(l, quality);
    for (let i = 0; i < q; i++) {
      fronts.push({ group: 'front', key: l.key, name: l.name, url: frontImage(l, quality) });
      if (back) backs.push({ group: 'back', key: l.key, name: l.back_name ?? `${l.name} (back)`, url: back });
    }
  }
  const toks: Slip[] = [];
  for (const t of tokens) {
    const url = tokenImage(t.image_png, quality);
    for (let i = 0; i < Math.max(0, Math.floor(t.count)); i++) toks.push({ group: 'token', key: t.key, name: t.name, url });
  }
  return [...fronts, ...backs, ...toks];
}

// The two copyable lists. Tokens and back faces are never in them.

/** mtgprint.net: "1 Name (SET) number", set upper-case, collector number unchanged. */
export function mtgprintList(lines: BatchLine[]): string {
  return lines.map((l) => `${l.quantity} ${l.list_name} (${l.set.toUpperCase()}) ${l.collector_number}`).join('\n');
}

/** MTG Proxy Generator: "1 SET/number -cd"; -cd fetches exactly that Printing from Scryfall. */
export function proxyGeneratorList(lines: BatchLine[]): string {
  return lines.map((l) => `${l.quantity} ${l.set.toUpperCase()}/${l.collector_number} -cd`).join('\n');
}

/**
 * Mark as printed: for every given reprint or new-card line, In-box := the Printing on that line
 * (the one that went on the sheet, not the card's current Wanted) with source "printed" and
 * confidence "high". A new card is in the box from then on. Extra lines, and lines whose card is
 * gone, are skipped.
 */
export function markPrintedPatches(cards: Card[], lines: BatchLine[]): CardPatchFor[] {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  const out: CardPatchFor[] = [];
  for (const l of lines) {
    if ((l.source !== 'reprint' && l.source !== 'new') || !l.oracle_id) continue;
    const card = byId.get(l.oracle_id);
    if (!card) continue;
    out.push({
      oracle_id: card.oracle_id,
      patch: {
        kind: 'in_box',
        in_box: {
          scryfall_id: l.scryfall_id,
          set: l.set,
          collector_number: l.collector_number,
          illustration_id: l.illustration_id,
          name: l.list_name,
          image_normal: l.image_normal,
          source: 'printed',
          confidence: 'high',
        },
      },
    });
  }
  return out;
}

/**
 * The names for the print history: the lines whose In-box Printing the patches change. Extras
 * are printed too but change no In-box Printing, so they are left out.
 */
export function printedHistoryNames(lines: BatchLine[], patches: CardPatchFor[]): string[] {
  const patched = new Set(patches.map((p) => p.oracle_id));
  return lines
    .filter((l) => (l.source === 'reprint' || l.source === 'new') && l.oracle_id && patched.has(l.oracle_id))
    .map((l) => l.name);
}
