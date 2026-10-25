import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPhotoPlan, savePhotoPlan, setPhotosPending, type PhotoPlan } from '../../store/scanPrefs';
import { progressText } from '../../store/shotChunks';
import type { SharedShot, Store } from '../../store/types';
import type { Pile } from '../parse';
import { PhotosGoneError, resumeCameraPhotos } from './sharePhotos';
import type { Shot } from './shots';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const planned = (id: string): Omit<SharedShot, 'thumb'> => ({
  row: -1,
  id,
  at: '2026-10-25T10:00:00Z',
  status: 'review',
  score: 0.5,
  chosen: null,
  candidates: [],
});

const shot = (id: string) => ({ id }) as unknown as Shot;
const pile = { id: 'local', label: 'Box 1', rows: [], camera: true, shotIds: ['a', 'b', 'c'] } as unknown as Pile;

function storeWith(existing: number[]) {
  const writes: number[] = [];
  const store = {
    shotChunkIndexes: async () => existing,
    writeShotChunk: async (_p: string, c: { index: number }) => void writes.push(c.index),
  } as unknown as Store;
  return { store, writes };
}

describe('photo plan', () => {
  const plan: PhotoPlan = [[planned('a'), planned('b')], [planned('c')]];

  it('round-trips and is forgotten with the pending upload', () => {
    savePhotoPlan('local', plan);
    expect(loadPhotoPlan('local')).toEqual(plan);
    setPhotosPending('local', 'shared');
    expect(loadPhotoPlan('local')).toEqual(plan);
    setPhotosPending('local', null);
    expect(loadPhotoPlan('local')).toBeNull();
  });

  it('refuses a resume when a photo of a missing chunk is gone, instead of shifting the chunks', async () => {
    savePhotoPlan('local', plan);
    const { store, writes } = storeWith([0]);
    await expect(resumeCameraPhotos(store, 'shared', pile, [shot('a'), shot('b')], () => {})).rejects.toBeInstanceOf(PhotosGoneError);
    expect(writes).toEqual([]);
  });

  it('does not mind a gone photo whose chunk already arrived', async () => {
    savePhotoPlan('local', plan);
    const { store, writes } = storeWith([0, 1]);
    const progress: string[] = [];
    await resumeCameraPhotos(store, 'shared', pile, [shot('c')], (p) => progress.push(`${p.done}/${p.total}`));
    expect(writes).toEqual([]);
    expect(progress).toEqual(['3/3']);
  });

  it('without a kept plan, needs every photo of the pile', async () => {
    const { store } = storeWith([]);
    await expect(resumeCameraPhotos(store, 'shared', pile, [shot('a'), shot('c')], () => {})).rejects.toThrow('1 photo of this pile is no longer');
  });
});

describe('progressText', () => {
  it('counts photos', () => {
    expect(progressText(null)).toBe('Preparing the photos…');
    expect(progressText({ done: 150, total: 540 })).toBe('Uploading photos: 150 of 540');
  });
});
