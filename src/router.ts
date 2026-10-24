// A tiny hash router: #/cube (default), #/cube?q=<search>, #/cube/<oracle_id>, #/scan,
// #/cube/<oracle_id>/printings, #/cycles, #/cycles/<name>, #/suggestions, #/log, #/about.
import { useEffect, useState } from 'react';

export type Route =
  | { view: 'cube'; oracleId: string | null; query: URLSearchParams }
  | { view: 'printings'; oracleId: string }
  | { view: 'cycles'; cycle: string | null }
  | { view: 'scan'; query: URLSearchParams }
  | { view: 'suggestions' }
  | { view: 'log' }
  | { view: 'about' };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [path = '', query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'scan') return { view: 'scan', query: new URLSearchParams(query) };
  if (parts[0] === 'about') return { view: 'about' };
  if (parts[0] === 'suggestions') return { view: 'suggestions' };
  if (parts[0] === 'log') return { view: 'log' };
  if (parts[0] === 'cycles') return { view: 'cycles', cycle: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (parts[0] === 'cube' && parts[1] && parts[2] === 'printings') return { view: 'printings', oracleId: decodeURIComponent(parts[1]) };
  return {
    view: 'cube',
    oracleId: parts[0] === 'cube' && parts[1] ? decodeURIComponent(parts[1]) : null,
    query: new URLSearchParams(query),
  };
}

/** True for the Cube list (#/cube, with or without a search), false for a card or another view. */
export function isListHash(hash: string): boolean {
  const r = parseHash(hash);
  return r.view === 'cube' && r.oracleId === null;
}

/** True for a card detail page, #/cube/<oracle_id>. */
export function isDetailHash(hash: string): boolean {
  const r = parseHash(hash);
  return r.view === 'cube' && r.oracleId !== null;
}

/** The picker page of a card. */
export function printingsHash(oracleId: string): string {
  return `#/cube/${encodeURIComponent(oracleId)}/printings`;
}

/** The page of one Cycle. */
export function cycleHash(cycle: string): string {
  return `#/cycles/${encodeURIComponent(cycle)}`;
}

/** The hash of the Cube list with a search. */
export function cubeHash(q: string): string {
  return q ? `#/cube?q=${encodeURIComponent(q)}` : '#/cube';
}

const REPLACE_EVENT = 'cube:replacehash';
const initialHash = typeof window === 'undefined' ? '' : window.location.hash;
/**
 * The hashes visited in this tab, as a model of the history stack. A navigation to the hash just
 * below the top is taken as a Back, so a Back (or history.back()) does not make the page left
 * behind the "previous" one.
 */
const stack: string[] = [initialHash];

/** The hash shown before the current one in this tab, or null on the first page. */
export function previousHash(): string | null {
  return stack.length >= 2 ? stack[stack.length - 2]! : null;
}

/** Record a navigation from the current hash to `next`. Exported for tests. */
export function recordNavigation(next: string, replace = false): void {
  if (next === stack[stack.length - 1]) return;
  if (replace) stack[stack.length - 1] = next;
  else if (stack.length >= 2 && stack[stack.length - 2] === next) stack.pop();
  else stack.push(next);
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      recordNavigation(window.location.hash);
      setHash(window.location.hash);
    };
    const onReplace = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    window.addEventListener(REPLACE_EVENT, onReplace);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener(REPLACE_EVENT, onReplace);
    };
  }, []);
  return parseHash(hash);
}

/** Replace the hash without adding a history entry; the route updates, hashchange does not fire. */
export function replaceHash(hash: string): void {
  window.history.replaceState(null, '', hash);
  recordNavigation(window.location.hash, true);
  window.dispatchEvent(new Event(REPLACE_EVENT));
}
