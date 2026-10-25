// shotChunks.ts: the camera photos of a shared pile, in chunk documents under
// cubes/main/scans/{pileId}/shots/{chunkId}. Pure: chunking, size estimates, resuming an upload,
// and what a review decision does to the shot and to the parent pile's rows.
import type {
  SharedPileRow,
  SharedShot,
  SharedShotCandidate,
  SharedShotRef,
  SharedShotStatus,
  ShotChunk,
  ShotDecisionInput,
} from './types';

/** At most this many shots per chunk document (firestore.rules checks shots.size() <= 50). */
export const MAX_CHUNK_SHOTS = 50;
/** At most this many base64 characters of thumbnails per chunk, well under the 1 MiB document cap. */
export const MAX_CHUNK_THUMB_CHARS = 700 * 1024;
/** At most this many base64 characters per thumbnail (12 KB as stored). */
export const MAX_THUMB_CHARS = 12 * 1024;
/** A thumbnail fits in 240x336 (portrait) or 336x240 (landscape). */
export const THUMB_SHORT = 240;
export const THUMB_LONG = 336;

const STATUSES: readonly SharedShotStatus[] = ['match', 'review', 'none', 'confirmed', 'skipped'];

/** Characters of the base64 text of `bytes` bytes (with padding). */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(Math.max(0, bytes) / 3);
}

/** Bytes of the data a base64 text decodes to. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, (b64.length / 4) * 3 - pad);
}

/** The size a thumbnail is drawn at: within 240x336 either way round, never enlarged. */
export function thumbSize(width: number, height: number, scale = 1): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const k = Math.min(THUMB_SHORT / Math.min(w, h), THUMB_LONG / Math.max(w, h), 1) * scale;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * The JPEG encodings tried in turn until one fits MAX_THUMB_CHARS: lower quality first, then
 * smaller. The last step is small enough for any slip.
 */
export const THUMB_STEPS: readonly { quality: number; scale: number }[] = [
  { quality: 0.75, scale: 1 },
  { quality: 0.65, scale: 1 },
  { quality: 0.55, scale: 1 },
  { quality: 0.45, scale: 1 },
  { quality: 0.55, scale: 0.85 },
  { quality: 0.45, scale: 0.85 },
  { quality: 0.45, scale: 0.7 },
  { quality: 0.35, scale: 0.55 },
];

/** The document id of chunk `index`: c0000, c0001, ... so ids sort in chunk order. */
export function chunkId(index: number): string {
  return `c${String(index).padStart(4, '0')}`;
}

/**
 * Splits shots into chunks of at most `maxShots` shots and `maxChars` thumbnail characters,
 * whichever comes first, keeping the order. A shot larger than `maxChars` on its own gets a chunk
 * of its own.
 */
export function chunkShots<T extends { thumb: string }>(
  shots: readonly T[],
  maxShots = MAX_CHUNK_SHOTS,
  maxChars = MAX_CHUNK_THUMB_CHARS,
): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const s of shots) {
    const n = s.thumb.length;
    if (cur.length > 0 && (cur.length >= maxShots || chars + n > maxChars)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s);
    chars += n;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** How far a photo upload has come, in photos. */
export interface UploadProgress {
  /** Photos on the server. */
  done: number;
  /** Photos in all. */
  total: number;
}

export function progressText(p: UploadProgress | null): string {
  if (!p) return 'Preparing the photos…';
  return `Uploading photos: ${p.done} of ${p.total}`;
}

/** The chunk indexes of 0..total-1 the server does not have yet, in order: what a retry writes. */
export function missingChunkIndexes(total: number, existing: readonly number[]): number[] {
  const have = new Set(existing);
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (!have.has(i)) out.push(i);
  return out;
}

/** True when every chunk of the pile has arrived. */
export function photosComplete(shotCount: number, chunks: readonly Pick<ShotChunk, 'count'>[]): boolean {
  return chunks.reduce((n, c) => n + c.count, 0) >= shotCount;
}

export function refOfShared(c: SharedShotRef): SharedShotRef {
  return { scryfall_id: c.scryfall_id, oracle_id: c.oracle_id, name: c.name, set: c.set, collector_number: c.collector_number };
}

/** The key a Printing merges on in shotsToRows: the Scryfall id, else name, set and number. */
function rowKey(r: { scryfall_id: string | null; name: string; set: string | null; collector_number: string | null }): string {
  return r.scryfall_id || `${r.name}|${r.set ?? ''}|${r.collector_number ?? ''}`;
}

/** The index of the row holding this Printing, or -1. */
export function rowIndexOf(rows: readonly SharedPileRow[], ref: SharedShotRef): number {
  const key = rowKey(ref);
  return rows.findIndex((r) => rowKey(r) === key);
}

/** What the camera keeps of a shot, as far as sharing it needs (src/scan/camera/shots.ts Shot). */
export interface CameraShotLike {
  id: string;
  at: string;
  status: SharedShotStatus;
  decision: { score: number } | null;
  candidates: readonly SharedShotCandidate[];
  chosen: SharedShotRef | null;
}

const isMatchedStatus = (s: { status: SharedShotStatus; chosen: SharedShotRef | null }) =>
  (s.status === 'match' || s.status === 'confirmed') && s.chosen !== null;

/**
 * The shots of a camera pile as shared shots without their thumbnails, oldest first. A matched
 * shot points at the row of its Printing in `rows` (the pile's rows, made by shotsToRows), and a
 * row gets at most `quantity` shots pointing at it. A matched shot whose Printing has no row, or
 * whose row already has as many shots as its quantity (it was decided after the pile was made),
 * goes back to review with row -1, so the review adds its row. Every other shot has row -1.
 */
export function planSharedShots(shots: readonly CameraShotLike[], rows: readonly SharedPileRow[]): Omit<SharedShot, 'thumb'>[] {
  const ordered = [...shots].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const claimed = new Map<number, number>();
  return ordered.map((s) => {
    const chosen = s.chosen ? refOfShared(s.chosen) : null;
    let row = isMatchedStatus(s) && chosen ? rowIndexOf(rows, chosen) : -1;
    if (row >= 0) {
      const n = claimed.get(row) ?? 0;
      if (n >= rows[row]!.quantity) row = -1;
      else claimed.set(row, n + 1);
    }
    const status: SharedShotStatus = isMatchedStatus(s) && row < 0 ? 'review' : s.status;
    return {
      row,
      id: s.id,
      at: s.at,
      status,
      score: s.decision && Number.isFinite(s.decision.score) ? s.decision.score : null,
      chosen,
      candidates: s.candidates.slice(0, 3).map((c) => ({ ...refOfShared(c), score: c.score })),
    };
  });
}

export function sharedNeedsReview(s: Pick<SharedShot, 'status'>): boolean {
  return s.status === 'review' || s.status === 'none';
}

export function sharedIsMatched(s: Pick<SharedShot, 'status' | 'chosen'>): boolean {
  return isMatchedStatus(s);
}

/** No card: not recognised, or marked Not a card. */
export function sharedIsUnknown(s: Pick<SharedShot, 'status'>): boolean {
  return s.status === 'none' || s.status === 'skipped';
}

export function countToReview(shots: readonly Pick<SharedShot, 'status'>[]): number {
  return shots.filter(sharedNeedsReview).length;
}

export type SharedShotFilter = 'all' | 'review' | 'matched' | 'unknown';

export function filterSharedShots<T extends { shot: SharedShot }>(list: readonly T[], f: SharedShotFilter): T[] {
  if (f === 'review') return list.filter((x) => sharedNeedsReview(x.shot));
  if (f === 'matched') return list.filter((x) => sharedIsMatched(x.shot));
  if (f === 'unknown') return list.filter((x) => sharedIsUnknown(x.shot));
  return [...list];
}

export function sharedShotCounts(shots: readonly SharedShot[]): Record<SharedShotFilter, number> {
  return {
    all: shots.length,
    review: shots.filter(sharedNeedsReview).length,
    matched: shots.filter(sharedIsMatched).length,
    unknown: shots.filter(sharedIsUnknown).length,
  };
}

/** Every shot of the pile with the chunk it lives in, in chunk order. */
export function flattenChunks(chunks: readonly ShotChunk[]): { chunk: number; shot: SharedShot }[] {
  return [...chunks].sort((a, b) => a.index - b.index).flatMap((c) => c.shots.map((shot) => ({ chunk: c.index, shot })));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseRef(v: unknown): SharedShotRef | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.name !== 'string') return null;
  return { scryfall_id: str(r.scryfall_id), oracle_id: str(r.oracle_id), name: r.name, set: str(r.set), collector_number: str(r.collector_number) };
}

/** A shot as read from Firestore, checked; null when it is not one. */
export function parseSharedShot(v: unknown): SharedShot | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.thumb !== 'string') return null;
  const candidates = Array.isArray(r.candidates)
    ? r.candidates.flatMap((c) => {
        const ref = parseRef(c);
        const score = (c as { score?: unknown }).score;
        return ref ? [{ ...ref, score: typeof score === 'number' ? score : 0 }] : [];
      })
    : [];
  return {
    row: typeof r.row === 'number' && Number.isInteger(r.row) ? r.row : -1,
    id: r.id,
    at: str(r.at),
    thumb: r.thumb,
    status: STATUSES.includes(r.status as SharedShotStatus) ? (r.status as SharedShotStatus) : 'review',
    score: typeof r.score === 'number' ? r.score : null,
    chosen: parseRef(r.chosen),
    candidates,
  };
}

/** A chunk document as read from Firestore, checked. */
export function parseShotChunk(id: string, d: Record<string, unknown>): ShotChunk {
  const shots = Array.isArray(d.shots) ? d.shots.map(parseSharedShot).filter((s): s is SharedShot => s !== null) : [];
  const fromId = Number.parseInt(id.replace(/^c/, ''), 10);
  return {
    index: typeof d.index === 'number' ? d.index : Number.isFinite(fromId) ? fromId : 0,
    shots,
    count: typeof d.count === 'number' ? d.count : shots.length,
    createdAt: str(d.createdAt),
    createdByUid: str(d.createdByUid),
  };
}

function samePrinting(row: SharedPileRow, ref: SharedShotRef): boolean {
  return rowKey(row) === rowKey(ref);
}

/**
 * What a decision does to one shot and to the parent pile's rows. Picking a Printing confirms the
 * shot: a shot without a row appends a row and points at it; a shot with a row replaces that
 * row's Printing, or, when the row counts more than this one slip, takes one off it and appends a
 * row of its own. Not a card skips the shot and takes it off its row (a row may reach quantity 0;
 * rows are never removed, so the other shots' row indexes stay right).
 */
export function applyShotDecision(
  rows: readonly SharedPileRow[],
  shot: SharedShot,
  decision: ShotDecisionInput,
): { rows: SharedPileRow[]; shot: SharedShot } {
  const next = rows.map((r) => ({ ...r }));
  const has = shot.row >= 0 && shot.row < next.length;
  if (decision.kind === 'not_a_card') {
    if (has) {
      const r = next[shot.row]!;
      r.quantity = Math.max(0, r.quantity - 1);
    }
    return { rows: next, shot: { ...shot, row: -1, status: 'skipped', chosen: null } };
  }
  const ref = refOfShared(decision.ref);
  const fresh: SharedPileRow = {
    name: ref.name,
    quantity: 1,
    scryfall_id: ref.scryfall_id || null,
    set: ref.set || null,
    collector_number: ref.collector_number || null,
  };
  let row: number;
  if (has && next[shot.row]!.quantity >= 1 && samePrinting(next[shot.row]!, ref)) {
    row = shot.row;
  } else if (has && next[shot.row]!.quantity <= 1) {
    row = shot.row;
    next[row] = fresh;
  } else {
    if (has) next[shot.row]!.quantity -= 1;
    row = next.length;
    next.push(fresh);
  }
  return { rows: next, shot: { ...shot, row, status: 'confirmed', chosen: ref } };
}

/** The document written for a chunk: exactly SHOT_CHUNK_KEYS. */
export function shotChunkDoc(chunk: Pick<ShotChunk, 'index' | 'shots'>, uid: string, t: string): ShotChunk {
  return { index: chunk.index, shots: chunk.shots, count: chunk.shots.length, createdAt: t, createdByUid: uid };
}
