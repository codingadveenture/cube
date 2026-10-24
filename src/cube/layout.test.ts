import { describe, expect, it } from 'vitest';
import { CUBE_LAYOUT_KEY, readCubeLayout, writeCubeLayout } from './layout';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const failing = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError');
  },
};

describe('Cube layout preference', () => {
  it('defaults to Spoiler with nothing stored, no storage, or an unknown value', () => {
    expect(readCubeLayout(memory())).toBe('spoiler');
    expect(readCubeLayout(null)).toBe('spoiler');
    expect(readCubeLayout(memory({ [CUBE_LAYOUT_KEY]: 'grid' }))).toBe('spoiler');
  });

  it('reads back what was written', () => {
    const s = memory();
    expect(writeCubeLayout('list', s)).toBe(true);
    expect(s.data.get(CUBE_LAYOUT_KEY)).toBe('list');
    expect(readCubeLayout(s)).toBe('list');
    writeCubeLayout('spoiler', s);
    expect(readCubeLayout(s)).toBe('spoiler');
  });

  it('survives storage that throws', () => {
    expect(readCubeLayout(failing)).toBe('spoiler');
    expect(writeCubeLayout('list', failing)).toBe(false);
    expect(writeCubeLayout('list', null)).toBe(false);
  });
});
