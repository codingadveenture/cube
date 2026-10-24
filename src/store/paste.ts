// Text to paste into CubeCobra for the pending List changes. The List is edited there by hand.
import { normalizeName } from '../lib/normalize';
import type { Overrides } from './types';

function clean(list: string[], exclude: string[] = []): string[] {
  const skip = new Set(exclude.map(normalizeName));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim();
    const key = normalizeName(name);
    if (!name || seen.has(key) || skip.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, 'en'));
}

/** Names to add: one per line, for CubeCobra's bulk add. A name that is also banned is left out. */
export function addsText(o: Overrides): string {
  return clean(o.adds, o.bans).join('\n');
}

/** Names to remove: one per line. */
export function bansText(o: Overrides): string {
  return clean(o.bans).join('\n');
}

/** Both lists in one text. */
export function cubecobraPasteText(o: Overrides): string {
  const adds = addsText(o);
  const bans = bansText(o);
  const parts: string[] = [];
  if (adds) parts.push(`Add:\n${adds}`);
  if (bans) parts.push(`Remove:\n${bans}`);
  return parts.join('\n\n');
}
