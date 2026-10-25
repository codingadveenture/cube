// sharePhotos.ts: shares a camera pile with its photos. The pile document goes first, then the
// photos as small JPEG thumbnails in chunk documents (cubes/main/scans/{id}/shots/{chunkId}), in
// order. The chunk plan (which shot goes in which chunk, with its status and row) is kept on the
// device, so a retry, even after a reload, asks the server which chunks it has and writes exactly
// the planned shots of the missing ones.
// Browser only (canvas, IndexedDB); the pure parts are in src/store/shotChunks.ts.
import { MAX_PILE_ROWS, toSharedRows } from '../../store/piles';
import {
  chunkShots,
  countToReview,
  MAX_THUMB_CHARS,
  missingChunkIndexes,
  planSharedShots,
  THUMB_STEPS,
  thumbSize,
  type UploadProgress,
} from '../../store/shotChunks';
import { loadPhotoPlan, savePhotoPlan, type PhotoPlan } from '../../store/scanPrefs';
import type { SharedPileInput, SharedPileRow, SharedShot, Store } from '../../store/types';
import type { Pile } from '../parse';
import { loadShots } from './db';
import type { Shot } from './shots';

export type { UploadProgress };

/** Thrown by a resume when photos the plan needs are no longer on this device. */
export class PhotosGoneError extends Error {
  constructor(missing: number) {
    super(
      `${missing} ${missing === 1 ? 'photo' : 'photos'} of this pile ${missing === 1 ? 'is' : 'are'} no longer on this device, so the upload cannot be finished; the shared pile keeps the photos that arrived.`,
    );
    this.name = 'PhotosGoneError';
  }
}

/** A chunk write that has not reached the server after this long counts as stopped. */
const WRITE_TIMEOUT_MS = 60_000;

const STOPPED = 'The photo upload stopped (no connection?). Try again; it goes on from where it stopped.';

function base64Of(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no JPEG'))), 'image/jpeg', quality));
}

/**
 * The shot's photo as base64 JPEG for a chunk: upright (a slip that lay upside down is turned),
 * within 240x336, and at most MAX_THUMB_CHARS characters.
 */
export async function encodeThumb(shot: Pick<Shot, 'thumb' | 'orientation'>): Promise<string> {
  const bmp = await createImageBitmap(shot.thumb);
  try {
    let last = '';
    for (const step of THUMB_STEPS) {
      const size = thumbSize(bmp.width, bmp.height, step.scale);
      const c = document.createElement('canvas');
      c.width = size.width;
      c.height = size.height;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      if (shot.orientation === 'rotated') {
        ctx.translate(size.width, size.height);
        ctx.rotate(Math.PI);
      }
      ctx.drawImage(bmp, 0, 0, size.width, size.height);
      last = base64Of(await (await toJpeg(c, step.quality)).arrayBuffer());
      if (last.length <= MAX_THUMB_CHARS) return last;
    }
    return last;
  } finally {
    bmp.close();
  }
}

/** The shots as shared shots with their thumbnails, oldest first. */
export async function sharedShotsOf(shots: readonly Shot[], rows: readonly SharedPileRow[]): Promise<SharedShot[]> {
  const byId = new Map(shots.map((s) => [s.id, s]));
  const out: SharedShot[] = [];
  for (const p of planSharedShots(shots, rows)) out.push({ ...p, thumb: await encodeThumb(byId.get(p.id)!) });
  return out;
}

/** The shared pile document of a camera pile. */
export function cameraPileInput(pile: Pile, by: string, shots: readonly Pick<SharedShot, 'status'>[]): SharedPileInput {
  return { label: pile.label, by, rows: toSharedRows(pile.rows), shot_count: shots.length, to_review: countToReview(shots), camera: true };
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(STOPPED)), WRITE_TIMEOUT_MS);
  });
  return Promise.race([p, stop]).finally(() => clearTimeout(timer));
}

function needOnline(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Sharing photos needs a connection. Try again when online.');
}

/**
 * Writes the chunks the server does not have yet, in order, reporting photos. `sizes` are the
 * shots per chunk; `build` gives the shots of chunk `index` when it is written.
 */
async function writeMissingChunks(
  store: Store,
  pileId: string,
  sizes: readonly number[],
  build: (index: number) => Promise<SharedShot[]>,
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  needOnline();
  const existing = await withTimeout(store.shotChunkIndexes(pileId));
  const missing = missingChunkIndexes(sizes.length, existing);
  const total = sizes.reduce((n, k) => n + k, 0);
  let done = total - missing.reduce((n, i) => n + sizes[i]!, 0);
  onProgress({ done, total });
  for (const index of missing) {
    const part = await build(index);
    await withTimeout(store.writeShotChunk(pileId, { index, shots: part, count: part.length }));
    done += part.length;
    onProgress({ done, total });
  }
}

/** Writes the chunks of these shots that the server does not have yet, in order, reporting photos. */
export async function uploadShotChunks(
  store: Store,
  pileId: string,
  shots: readonly SharedShot[],
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  const chunks = chunkShots(shots);
  await writeMissingChunks(store, pileId, chunks.map((c) => c.length), async (i) => chunks[i]!, onProgress);
}

function planOf(chunks: readonly SharedShot[][]): PhotoPlan {
  return chunks.map((c) => c.map(({ thumb: _thumb, ...rest }) => rest));
}

/** The pile's shots still in this device's camera session (IndexedDB); empty when they are gone. */
export async function shotsOfPile(pile: Pile): Promise<Shot[]> {
  if (!pile.camera || !pile.shotIds?.length) return [];
  const ids = new Set(pile.shotIds);
  try {
    return (await loadShots()).filter((s) => ids.has(s.id));
  } catch {
    return [];
  }
}

/**
 * Shares a camera pile: encodes the photos, creates the shared pile, calls onShared with its id
 * (record it at once, so a stopped upload can be resumed), waits for the server, then uploads
 * the chunks. Resolves with the shared pile id.
 */
export async function shareCameraPile(
  store: Store,
  pile: Pile,
  by: string,
  shots: readonly Shot[],
  hooks: { onShared: (id: string) => void; onProgress: (p: UploadProgress) => void },
): Promise<string> {
  needOnline();
  if (pile.rows.length > MAX_PILE_ROWS) throw new Error(`A shared pile holds at most ${MAX_PILE_ROWS} rows; this one has ${pile.rows.length}.`);
  const rows = toSharedRows(pile.rows);
  // Encoded before the pile exists, so a failure here leaves nothing half-shared.
  const shared = await sharedShotsOf(shots, rows);
  const chunks = chunkShots(shared);
  // Kept before the pile exists, so a resume after a reload writes exactly these chunks.
  savePhotoPlan(pile.id, planOf(chunks));
  const { id, written } = store.createScanPile(cameraPileInput(pile, by, shared));
  hooks.onShared(id);
  await withTimeout(written);
  await writeMissingChunks(store, id, chunks.map((c) => c.length), async (i) => chunks[i]!, hooks.onProgress);
  return id;
}

/**
 * Uploads the missing chunks of a camera pile shared earlier, exactly as planned when it was
 * shared: the same shots in the same chunks, with the status and row they were shared with, so
 * retaking, deleting or re-deciding a shot since then changes nothing. Throws PhotosGoneError when
 * a shot a missing chunk needs is gone. Without a kept plan (it did not fit in storage), every
 * shot of the pile must still be here; the plan is then made again from them.
 */
export async function resumeCameraPhotos(
  store: Store,
  sharedId: string,
  pile: Pile,
  shots: readonly Shot[],
  onProgress: (p: UploadProgress) => void,
): Promise<void> {
  needOnline();
  const byId = new Map(shots.map((s) => [s.id, s]));
  const plan = loadPhotoPlan(pile.id);
  if (plan) {
    const existing = new Set(await withTimeout(store.shotChunkIndexes(sharedId)));
    const gone = plan.flatMap((c, i) => (existing.has(i) ? [] : c.filter((s) => !byId.has(s.id)))).length;
    if (gone > 0) throw new PhotosGoneError(gone);
    const build = async (i: number) => {
      const out: SharedShot[] = [];
      for (const p of plan[i]!) out.push({ ...p, thumb: await encodeThumb(byId.get(p.id)!) });
      return out;
    };
    await writeMissingChunks(store, sharedId, plan.map((c) => c.length), build, onProgress);
    return;
  }
  const ids = pile.shotIds ?? shots.map((s) => s.id);
  const gone = ids.filter((id) => !byId.has(id)).length;
  if (gone > 0) throw new PhotosGoneError(gone);
  const own = new Set(ids);
  const shared = await sharedShotsOf(
    shots.filter((s) => own.has(s.id)),
    toSharedRows(pile.rows),
  );
  await uploadShotChunks(store, sharedId, shared, onProgress);
}

export { progressText } from '../../store/shotChunks';
