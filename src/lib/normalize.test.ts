import { describe, expect, it } from 'vitest';
import { normalizeName } from './normalize';

describe('normalizeName', () => {
  it('strips diacritics', () => {
    expect(normalizeName('Lim-Dûl the Necromancer')).toBe('lim-dul the necromancer');
    expect(normalizeName('Séance')).toBe('seance');
    expect(normalizeName('Jötun Grunt')).toBe('jotun grunt');
  });

  it('keeps only the front of split and double-faced names', () => {
    expect(normalizeName('Fire // Ice')).toBe('fire');
    expect(normalizeName('Delver of Secrets // Insectile Aberration')).toBe('delver of secrets');
  });

  it('collapses whitespace, trims and lower-cases', () => {
    expect(normalizeName('  Black   Lotus\t')).toBe('black lotus');
    expect(normalizeName('BLACK LOTUS')).toBe('black lotus');
  });

  it('treats decomposed and composed forms the same', () => {
    expect(normalizeName('Séance')).toBe(normalizeName('Séance'));
  });
});
