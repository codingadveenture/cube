import { describe, expect, it } from 'vitest';
import { cubeHash, isDetailHash, isListHash, parseHash, previousHash, recordNavigation } from './router';

describe('router', () => {
  it('keeps the Cube search in the hash', () => {
    const r = parseHash(cubeHash('lightning bolt'));
    expect(r.view).toBe('cube');
    expect(r.view === 'cube' && r.query.get('q')).toBe('lightning bolt');
    expect(r.view === 'cube' && r.oracleId).toBe(null);
    expect(cubeHash('')).toBe('#/cube');
  });

  it('tells the list from a card page', () => {
    expect(isListHash('#/cube?q=bolt')).toBe(true);
    expect(isListHash('')).toBe(true);
    expect(isListHash('#/cube/abc')).toBe(false);
    expect(isListHash('#/scan')).toBe(false);
    expect(isDetailHash('#/cube/abc')).toBe(true);
  });

  it('knows the Suggestions and Log views', () => {
    expect(parseHash('#/suggestions').view).toBe('suggestions');
    expect(parseHash('#/log').view).toBe('log');
    expect(parseHash('#/about').view).toBe('about');
  });

  it('knows the Update view and keeps #/log working', () => {
    expect(parseHash('#/upstream').view).toBe('upstream');
    expect(parseHash('#/log').view).toBe('log');
  });

  it('remembers the previous hash, and a replace does not count as a step', () => {
    recordNavigation('#/cube');
    recordNavigation('#/cube?q=b', true);
    recordNavigation('#/cube/abc');
    expect(previousHash()).toBe('#/cube?q=b');
  });

  it('treats a Back from the picker as a step back, so the card still knows its list', () => {
    recordNavigation('#/cube?q=mox');
    recordNavigation('#/cube/ghi');
    recordNavigation('#/cube/ghi/printings');
    expect(previousHash()).toBe('#/cube/ghi');
    recordNavigation('#/cube/ghi'); // history.back()
    expect(previousHash()).toBe('#/cube?q=mox');
    expect(isListHash(previousHash()!)).toBe(true);
  });

  it('leaves the page before the picker as previous when the picker is left by a replace', () => {
    recordNavigation('#/cycles/moxen');
    recordNavigation('#/cube/def/printings');
    recordNavigation('#/cube/def', true);
    expect(previousHash()).toBe('#/cycles/moxen');
  });
});
