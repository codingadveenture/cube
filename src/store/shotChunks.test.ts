import { describe, expect, it } from 'vitest';
import { uploadShotChunks } from '../scan/camera/sharePhotos';
import { shotsToRows, type Shot } from '../scan/camera/shots';
import type { Pile } from '../scan/parse';
import { mergedRows } from '../scan/session';
import { fromShared, pilesForDiff, scanPileDoc, toSharedRows } from './piles';
import {
  applyShotDecision,
  base64Bytes,
  base64Length,
  chunkId,
  chunkShots,
  countToReview,
  filterSharedShots,
  flattenChunks,
  MAX_CHUNK_SHOTS,
  MAX_CHUNK_THUMB_CHARS,
  MAX_THUMB_CHARS,
  missingChunkIndexes,
  parseShotChunk,
  photosComplete,
  planSharedShots,
  sharedShotCounts,
  shotChunkDoc,
  THUMB_STEPS,
  thumbSize,
} from './shotChunks';
import type { SharedPile, SharedPileRow, SharedShot, SharedShotRef, ShotChunk, Store } from './types';

const ref = (name: string, set = 'lea', n = '1'): SharedShotRef => ({
  scryfall_id: `sf-${name}-${set}-${n}`,
  oracle_id: `o-${name}`,
  name,
  set,
  collector_number: n,
});

const shared = (id: string, over: Partial<SharedShot> = {}): SharedShot => ({
  row: -1,
  id,
  at: `2026-10-25T10:00:${id.padStart(2, '0')}Z`,
  thumb: 'x'.repeat(100),
  status: 'review',
  score: 0.5,
  chosen: null,
  candidates: [],
  ...over,
});

const pileRow = (r: SharedShotRef, quantity = 1): SharedPileRow => ({
  name: r.name,
  quantity,
  scryfall_id: r.scryfall_id,
  set: r.set,
  collector_number: r.collector_number,
});

describe('base64 size estimate', () => {
  it('counts four characters per three bytes, padded', () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    expect(base64Length(9000)).toBe(12000);
  });

  it('matches real base64 text and decodes back to the byte count', () => {
    for (const n of [0, 1, 2, 3, 10, 1000, 9216]) {
      const b64 = btoa('a'.repeat(n));
      expect(b64.length).toBe(base64Length(n));
      expect(base64Bytes(b64)).toBe(n);
    }
  });

  it('allows a 9 KB JPEG and refuses a 9.3 KB one at the 12 KB cap', () => {
    expect(base64Length(9 * 1024)).toBeLessThanOrEqual(MAX_THUMB_CHARS);
    expect(base64Length(9300)).toBeGreaterThan(MAX_THUMB_CHARS);
  });

  it('keeps a full chunk of capped thumbnails well under the 1 MiB document cap', () => {
    expect(MAX_CHUNK_SHOTS * MAX_THUMB_CHARS).toBeLessThanOrEqual(MAX_CHUNK_THUMB_CHARS);
    // Thumbnails plus generous room for the other fields of 50 shots.
    expect(MAX_CHUNK_THUMB_CHARS + MAX_CHUNK_SHOTS * 2000).toBeLessThan(1024 * 1024);
  });
});

describe('thumbSize', () => {
  it('fits a portrait crop into 240x336 and a landscape one into 336x240', () => {
    expect(thumbSize(640, 896)).toEqual({ width: 240, height: 336 });
    expect(thumbSize(896, 640)).toEqual({ width: 336, height: 240 });
  });

  it('never enlarges and scales down for the later steps', () => {
    expect(thumbSize(200, 280)).toEqual({ width: 200, height: 280 });
    expect(thumbSize(240, 336, 0.5)).toEqual({ width: 120, height: 168 });
  });

  it('tries lower quality before smaller sizes and ends small', () => {
    const scales = THUMB_STEPS.map((s) => s.scale);
    expect([...scales].sort((a, b) => b - a)).toEqual(scales);
    expect(THUMB_STEPS[0]!.scale).toBe(1);
    expect(THUMB_STEPS.at(-1)!.scale).toBeLessThan(0.6);
  });
});

describe('chunkShots', () => {
  it('cuts at 50 shots', () => {
    const shots = Array.from({ length: 120 }, (_, i) => shared(String(i)));
    const chunks = chunkShots(shots);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks.flat().map((s) => s.id)).toEqual(shots.map((s) => s.id));
  });

  it('cuts at the thumbnail size cap when it comes first', () => {
    const big = Array.from({ length: 10 }, (_, i) => shared(String(i), { thumb: 'x'.repeat(300 * 1024) }));
    expect(chunkShots(big).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    const exact = Array.from({ length: 4 }, (_, i) => shared(String(i), { thumb: 'x'.repeat(350 * 1024) }));
    expect(chunkShots(exact).map((c) => c.length)).toEqual([2, 2]);
  });

  it('gives an oversized shot a chunk of its own and handles nothing', () => {
    const shots = [shared('1'), shared('2', { thumb: 'x'.repeat(800 * 1024) }), shared('3')];
    expect(chunkShots(shots).map((c) => c.map((s) => s.id))).toEqual([['1'], ['2'], ['3']]);
    expect(chunkShots([])).toEqual([]);
  });

  it('names chunks so they sort in order', () => {
    expect(chunkId(0)).toBe('c0000');
    expect(chunkId(12)).toBe('c0012');
    const ids = [10, 2, 0, 1].map(chunkId).sort();
    expect(ids).toEqual(['c0000', 'c0001', 'c0002', 'c0010']);
    expect(parseShotChunk('c0012', { shots: [] }).index).toBe(12);
  });
});

describe('resuming an upload', () => {
  it('lists the missing chunk indexes in order', () => {
    expect(missingChunkIndexes(5, [])).toEqual([0, 1, 2, 3, 4]);
    expect(missingChunkIndexes(5, [0, 1, 3])).toEqual([2, 4]);
    expect(missingChunkIndexes(3, [0, 1, 2, 7])).toEqual([]);
    expect(missingChunkIndexes(0, [])).toEqual([]);
  });

  it('knows when every photo has arrived', () => {
    expect(photosComplete(120, [{ count: 50 }, { count: 50 }])).toBe(false);
    expect(photosComplete(120, [{ count: 50 }, { count: 50 }, { count: 20 }])).toBe(true);
  });

  /** A store that keeps chunks in memory and fails the write of chunk `failAt` once. */
  function fakeStore(failAt: number | null) {
    const written = new Map<number, number>();
    const order: number[] = [];
    let fail = failAt;
    const store = {
      shotChunkIndexes: async () => [...written.keys()],
      writeShotChunk: async (_pile: string, chunk: { index: number; shots: SharedShot[] }) => {
        if (chunk.index === fail) {
          fail = null;
          throw new Error('offline');
        }
        written.set(chunk.index, chunk.shots.length);
        order.push(chunk.index);
      },
    } as unknown as Store;
    return { store, written, order };
  }

  it('writes the chunks in order with progress, and a retry writes only the missing ones', async () => {
    const shots = Array.from({ length: 160 }, (_, i) => shared(String(i)));
    const { store, written, order } = fakeStore(2);
    const progress: string[] = [];
    await expect(uploadShotChunks(store, 'p', shots, (p) => progress.push(`${p.done}/${p.total}`))).rejects.toThrow('offline');
    expect(order).toEqual([0, 1]);
    expect(progress).toEqual(['0/160', '50/160', '100/160']);
    progress.length = 0;
    await uploadShotChunks(store, 'p', shots, (p) => progress.push(`${p.done}/${p.total}`));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(progress).toEqual(['100/160', '150/160', '160/160']);
    expect([...written.values()].reduce((a, b) => a + b, 0)).toBe(160);
  });
});

describe('planSharedShots', () => {
  const lotus = ref('Black Lotus');
  const ring = ref('Sol Ring', 'c21', '263');
  const cand = (r: SharedShotRef, score: number) => ({ ...r, score, face: 'front' as const });
  const shot = (id: string, at: string, status: Shot['status'], chosen: SharedShotRef | null, score = 0.9): Shot => ({
    id,
    at,
    thumb: new Blob(),
    width: 240,
    height: 336,
    decision: { status: status === 'confirmed' || status === 'skipped' ? 'review' : status, score, margin: 0.1, verdict: null },
    candidates: [cand(lotus, score), cand(ring, 0.4), cand(ref('Mox Pearl'), 0.3), cand(ref('Time Walk'), 0.2)],
    status,
    chosen,
    orientation: 'upright',
    source: 'camera',
  });
  const shots = [
    shot('c', '2026-10-25T10:00:03Z', 'review', null, 0.6),
    shot('a', '2026-10-25T10:00:01Z', 'match', lotus),
    shot('b', '2026-10-25T10:00:02Z', 'confirmed', ring),
    shot('d', '2026-10-25T10:00:04Z', 'none', null, 0.2),
    shot('e', '2026-10-25T10:00:05Z', 'skipped', null),
    shot('f', '2026-10-25T10:00:06Z', 'match', lotus),
  ];
  const rows = toSharedRows(shotsToRows(shots));

  it('points matched shots at their rows, oldest first, and gives the rest row -1', () => {
    const plan = planSharedShots(shots, rows);
    expect(plan.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(plan.map((s) => s.row)).toEqual([0, 1, -1, -1, -1, 0]);
    expect(rows[0]).toMatchObject({ name: 'Black Lotus', quantity: 2 });
    expect(plan.map((s) => s.status)).toEqual(['match', 'confirmed', 'review', 'none', 'skipped', 'match']);
    expect(countToReview(plan)).toBe(2);
  });

  it('keeps the top three candidates with their scores and the recognition score', () => {
    const p = planSharedShots(shots, rows)[0]!;
    expect(p.candidates).toHaveLength(3);
    expect(p.candidates[0]).toEqual({ ...lotus, score: 0.9 });
    expect(Object.keys(p.candidates[0]!)).not.toContain('face');
    expect(p.score).toBe(0.9);
    expect(p.chosen).toEqual(lotus);
  });

  it('points no more shots at a row than its quantity; the extra ones go back to review', () => {
    // Row 0 was made from one Lotus; a second Lotus was confirmed in the camera afterwards.
    const one = [{ ...rows[0]!, quantity: 1 }, ...rows.slice(1)];
    const plan = planSharedShots(shots, one);
    const f = plan.find((s) => s.id === 'f')!;
    expect(plan.find((s) => s.id === 'a')!.row).toBe(0);
    expect(f.row).toBe(-1);
    expect(f.status).toBe('review');
    expect(f.chosen).toEqual(lotus);
  });

  it('sends a matched shot whose Printing has no row back to review', () => {
    const plan = planSharedShots(shots, rows.slice(0, 1));
    const b = plan.find((s) => s.id === 'b')!;
    expect(b.row).toBe(-1);
    expect(b.status).toBe('review');
  });
});

describe('applyShotDecision', () => {
  const lotus = ref('Black Lotus');
  const ring = ref('Sol Ring', 'c21', '263');
  const mox = ref('Mox Pearl');

  it('appends a row for a shot without one and points the shot at it', () => {
    const rows = [pileRow(lotus)];
    const r = applyShotDecision(rows, shared('1'), { kind: 'pick', ref: ring });
    expect(r.rows).toEqual([pileRow(lotus), pileRow(ring)]);
    expect(r.shot).toMatchObject({ row: 1, status: 'confirmed', chosen: ring });
    expect(rows).toHaveLength(1);
  });

  it("replaces the Printing of the shot's own row", () => {
    const rows = [pileRow(lotus), pileRow(ring)];
    const r = applyShotDecision(rows, shared('1', { row: 1, status: 'match', chosen: ring }), { kind: 'pick', ref: mox });
    expect(r.rows).toEqual([pileRow(lotus), pileRow(mox)]);
    expect(r.shot).toMatchObject({ row: 1, status: 'confirmed', chosen: mox });
  });

  it('takes one off a row that counts several slips and appends a row of its own', () => {
    const rows = [pileRow(lotus, 2)];
    const r = applyShotDecision(rows, shared('1', { row: 0, status: 'match', chosen: lotus }), { kind: 'pick', ref: mox });
    expect(r.rows).toEqual([pileRow(lotus, 1), pileRow(mox)]);
    expect(r.shot.row).toBe(1);
  });

  it('confirms the same Printing without touching the rows', () => {
    const rows = [pileRow(lotus, 2)];
    const r = applyShotDecision(rows, shared('1', { row: 0, status: 'match', chosen: lotus }), { kind: 'pick', ref: lotus });
    expect(r.rows).toEqual(rows);
    expect(r.shot).toMatchObject({ row: 0, status: 'confirmed' });
  });

  it('reuses a row Not a card took down to 0', () => {
    const rows = [pileRow(lotus, 0), pileRow(ring)];
    const r = applyShotDecision(rows, shared('1', { row: 0, status: 'skipped' }), { kind: 'pick', ref: mox });
    expect(r.rows).toEqual([pileRow(mox), pileRow(ring)]);
    expect(r.shot.row).toBe(0);
  });

  it('Not a card takes the shot off its row, keeping the other rows where they are', () => {
    const rows = [pileRow(lotus), pileRow(ring)];
    const r = applyShotDecision(rows, shared('1', { row: 0, status: 'match', chosen: lotus }), { kind: 'not_a_card' });
    expect(r.rows).toEqual([pileRow(lotus, 0), pileRow(ring)]);
    expect(r.shot).toMatchObject({ row: -1, status: 'skipped', chosen: null });
    const none = applyShotDecision(rows, shared('2'), { kind: 'not_a_card' });
    expect(none.rows).toEqual(rows);
  });

  it('treats a row index past the end as no row', () => {
    const r = applyShotDecision([pileRow(lotus)], shared('1', { row: 5 }), { kind: 'pick', ref: ring });
    expect(r.rows).toHaveLength(2);
    expect(r.shot.row).toBe(1);
  });

  it('leaves a 0-quantity row out of the diff', () => {
    const pile: SharedPile = {
      id: 'p',
      label: 'Camera',
      by: 'A',
      rows: [pileRow(lotus, 0), pileRow(ring)],
      row_count: 2,
      createdAt: '2026-10-25T10:00:00Z',
      createdByUid: 'u',
    };
    expect(fromShared(pile).rows.map((r) => r.name)).toEqual(['Sol Ring']);
  });
});

describe('shared shots in the review', () => {
  const lotus = ref('Black Lotus');
  const shots = [
    shared('1', { status: 'match', chosen: lotus, row: 0 }),
    shared('2', { status: 'review' }),
    shared('3', { status: 'none' }),
    shared('4', { status: 'skipped' }),
    shared('5', { status: 'confirmed', chosen: lotus, row: 0 }),
  ];

  it('counts and filters All, To review, Matched and Unknown', () => {
    expect(sharedShotCounts(shots)).toEqual({ all: 5, review: 2, matched: 2, unknown: 2 });
    const items = shots.map((shot) => ({ chunk: 0, shot }));
    expect(filterSharedShots(items, 'review').map((x) => x.shot.id)).toEqual(['2', '3']);
    expect(filterSharedShots(items, 'matched').map((x) => x.shot.id)).toEqual(['1', '5']);
    expect(filterSharedShots(items, 'unknown').map((x) => x.shot.id)).toEqual(['3', '4']);
  });

  it('flattens chunks in chunk order', () => {
    const chunks: ShotChunk[] = [
      { index: 1, shots: [shots[2]!], count: 1, createdAt: '', createdByUid: 'u' },
      { index: 0, shots: [shots[0]!, shots[1]!], count: 2, createdAt: '', createdByUid: 'u' },
    ];
    expect(flattenChunks(chunks).map((x) => [x.chunk, x.shot.id])).toEqual([
      [0, '1'],
      [0, '2'],
      [1, '3'],
    ]);
  });

  it('reads a chunk defensively', () => {
    const c = parseShotChunk('c0001', {
      index: 1,
      shots: [{ id: 'a', thumb: 'abc', status: 'weird', candidates: [{ name: 'Sol Ring', score: 'x' }] }, { nope: true }],
      createdByUid: 'u',
    });
    expect(c.count).toBe(1);
    expect(c.shots[0]).toMatchObject({ id: 'a', row: -1, status: 'review', score: null, chosen: null });
    expect(c.shots[0]!.candidates[0]).toMatchObject({ name: 'Sol Ring', score: 0 });
  });

  it('writes a chunk document with exactly the chunk fields', () => {
    const d = shotChunkDoc({ index: 3, shots }, 'u1', '2026-10-25T10:00:00Z');
    expect(d).toEqual({ index: 3, shots, count: 5, createdAt: '2026-10-25T10:00:00Z', createdByUid: 'u1' });
  });
});

describe('a shared pile with photos', () => {
  it('writes the camera fields only when set', () => {
    const base = { label: 'L', by: ' A ', rows: [] };
    expect(Object.keys(scanPileDoc(base, 'u', 't')).sort()).toEqual(['by', 'createdAt', 'createdByUid', 'label', 'row_count', 'rows']);
    const cam = scanPileDoc({ ...base, shot_count: 3, to_review: 1, camera: true }, 'u', 't');
    expect(cam).toMatchObject({ by: 'A', shot_count: 3, to_review: 1, camera: true });
  });

  it("uses a reviewed shared copy's rows for the local pile it came from", () => {
    const row = (name: string) => ({ name, quantity: 1, scryfall_id: null, set: null, collector_number: null, foil: null, language: null });
    const local: Pile[] = [{ id: 'l1', label: 'Camera', rows: [row('Sol Ring')], camera: true }];
    const copy: SharedPile = {
      id: 'a',
      label: 'Camera',
      by: 'A',
      rows: [
        { name: 'Sol Ring', quantity: 1, scryfall_id: null, set: null, collector_number: null },
        { name: 'Black Lotus', quantity: 1, scryfall_id: null, set: null, collector_number: null },
      ],
      row_count: 2,
      createdAt: 't',
      createdByUid: 'u',
    };
    expect(mergedRows(pilesForDiff(local, [copy], new Set(), { l1: 'a' })).map((r) => r.name)).toEqual(['Sol Ring']);
    const reviewed = { ...copy, updatedAt: '2026-10-25T11:00:00Z' };
    const piles = pilesForDiff(local, [reviewed], new Set(['a']), { l1: 'a' });
    expect(piles).toHaveLength(1);
    expect(mergedRows(piles).map((r) => r.name)).toEqual(['Sol Ring', 'Black Lotus']);
  });
});
