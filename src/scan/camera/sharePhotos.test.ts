import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPhotoPlan, savePhotoPlan, setPhotosPending, type PhotoPlan } from '../../store/scanPrefs';
import { progressText } from '../../store/shotChunks';
import type { SharedPileInput, SharedShot, Store } from '../../store/types';
import type { Pile } from '../parse';
import { isPermissionError, PhotosGoneError, resumeCameraPhotos, shareCameraPile } from './sharePhotos';
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

describe('sharing without the new rules', () => {
  it('tells a refused write from other failures', () => {
    expect(isPermissionError({ code: 'permission-denied' })).toBe(true);
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'firestore/permission-denied' }))).toBe(true);
    expect(isPermissionError(new Error('7 PERMISSION_DENIED: no'))).toBe(true);
    expect(isPermissionError(new Error('Missing or insufficient permissions.'))).toBe(true);
    expect(isPermissionError(new Error('The photo upload stopped (no connection?).'))).toBe(false);
    expect(isPermissionError({ code: 'unavailable' })).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });

  const camPile = {
    id: 'local',
    label: 'Camera 2026-10-25',
    rows: [{ name: 'Sol Ring', quantity: 1, scryfall_id: 'x', set: 'lea', collector_number: '270', foil: null, language: null }],
    camera: true,
    shotIds: [],
  } as unknown as Pile;

  /** A store whose first createScanPile is refused with `first` (unless `refuse` is false); later ones succeed. */
  function refusingStore(first: unknown, refuse = true) {
    const created: SharedPileInput[] = [];
    const writes: number[] = [];
    const store = {
      createScanPile: (input: SharedPileInput) => {
        created.push(input);
        const n = created.length;
        return { id: `shared-${n}`, written: n === 1 && refuse ? Promise.reject(first) : Promise.resolve() };
      },
      shotChunkIndexes: async () => [],
      writeShotChunk: async (_p: string, c: { index: number }) => void writes.push(c.index),
    } as unknown as Store;
    return { store, created, writes };
  }

  it('shares a plain pile once when the rules refuse the photo fields', async () => {
    const { store, created, writes } = refusingStore({ code: 'permission-denied' });
    const shared: string[] = [];
    const res = await shareCameraPile(store, camPile, 'Kim', [], { onShared: (id) => shared.push(id), onProgress: () => {} });
    expect(res).toEqual({ id: 'shared-2', withoutPhotos: true });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ camera: true, shot_count: 0, to_review: 0 });
    expect(created[1]).toEqual({ label: 'Camera 2026-10-25', by: 'Kim', rows: created[0]!.rows });
    expect(writes).toEqual([]);
    expect(shared.at(-1)).toBe('shared-2');
    expect(loadPhotoPlan('local')).toBeNull();
  });

  it('keeps the error for other failures', async () => {
    const { store, created } = refusingStore(new Error('offline'));
    await expect(shareCameraPile(store, camPile, 'Kim', [], { onShared: () => {}, onProgress: () => {} })).rejects.toThrow('offline');
    expect(created).toHaveLength(1);
  });

  it('shares with the photo fields when the rules allow it', async () => {
    const { store, created } = refusingStore(undefined, false);
    const res = await shareCameraPile(store, camPile, 'A', [], { onShared: () => {}, onProgress: () => {} });
    expect(res).toEqual({ id: 'shared-1', withoutPhotos: false });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ camera: true });
  });
});

describe('progressText', () => {
  it('counts photos', () => {
    expect(progressText(null)).toBe('Preparing the photos…');
    expect(progressText({ done: 150, total: 540 })).toBe('Uploading photos: 150 of 540');
  });
});
