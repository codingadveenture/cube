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

  it('remembers the previous hash, and a replace does not count as a step', () => {
    recordNavigation('#/cube');
    recordNavigation('#/cube?q=b', true);
    recordNavigation('#/cube/abc');
    expect(previousHash()).toBe('#/cube?q=b');
  });
});
