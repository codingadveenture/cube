// A light guard against drift between firestore.rules and the TypeScript shapes of shared piles
// and their photo chunks: the field lists the rules allow must be the ones the app writes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_PILE_ROWS, scanPileDoc } from './piles';
import { MAX_CHUNK_SHOTS, shotChunkDoc } from './shotChunks';
import {
  SCAN_CREATE_KEYS,
  SCAN_UPDATE_KEYS,
  SHARED_SHOT_KEYS,
  SHOT_CHUNK_KEYS,
  type SharedPile,
  type SharedPileInput,
  type SharedShot,
  type ShotChunk,
} from './types';

// A checkout with CRLF line ends reads the same.
const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The body of `function name() { ... }` in the rules. */
function fn(name: string): string {
  const m = new RegExp(`function ${name}\\(\\) \\{([\\s\\S]*?)\\n    \\}`).exec(rules);
  if (!m) throw new Error(`function ${name} not found in firestore.rules`);
  return m[1]!;
}

/** The string list inside the first `<call>([...])` of a rules snippet. */
function list(src: string, call: string): string[] {
  const m = new RegExp(`${call.replace(/[.()]/g, '\\$&')}\\(\\[([^\\]]*)\\]\\)`).exec(src);
  if (!m) throw new Error(`${call} not found`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

// Compile-time halves of the guard: each key list names exactly the fields of its type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const chunkKeysMatch: Same<keyof ShotChunk, (typeof SHOT_CHUNK_KEYS)[number]> = true;
const shotKeysMatch: Same<keyof SharedShot, (typeof SHARED_SHOT_KEYS)[number]> = true;
const createKeysMatch: Same<keyof SharedPileInput | 'row_count' | 'createdAt' | 'createdByUid', (typeof SCAN_CREATE_KEYS)[number]> = true;
const updateKeysInPile: Same<Extract<keyof SharedPile, (typeof SCAN_UPDATE_KEYS)[number]>, (typeof SCAN_UPDATE_KEYS)[number]> = true;

describe('firestore.rules and the shared pile shapes', () => {
  it('the TypeScript key lists match their types', () => {
    expect([chunkKeysMatch, shotKeysMatch, createKeysMatch, updateKeysInPile]).toEqual([true, true, true, true]);
  });

  it('validShotChunk allows exactly the chunk fields and caps a chunk at 50 shots', () => {
    const body = fn('validShotChunk');
    expect(sorted(list(body, 'keys().hasOnly'))).toEqual(sorted(SHOT_CHUNK_KEYS));
    expect(sorted(list(body, 'keys().hasAll'))).toEqual(sorted(SHOT_CHUNK_KEYS));
    expect(body).toContain(`d.shots.size() <= ${MAX_CHUNK_SHOTS}`);
    expect(body).toContain('d.count == d.shots.size()');
    const doc = shotChunkDoc({ index: 0, shots: [] }, 'u', 't');
    expect(sorted(Object.keys(doc))).toEqual(sorted(SHOT_CHUNK_KEYS));
  });

  it('validScan allows the camera fields, all optional', () => {
    const body = fn('validScan');
    const only = list(body, 'keys().hasOnly');
    const all = list(body, 'keys().hasAll');
    expect(sorted(only)).toEqual(sorted(SCAN_CREATE_KEYS));
    for (const k of ['shot_count', 'to_review', 'camera']) {
      expect(all).not.toContain(k);
      expect(body).toContain(`!('${k}' in d)`);
    }
    expect(body).toContain(`d.rows.size() <= ${MAX_PILE_ROWS}`);
    const full = scanPileDoc({ label: 'L', by: 'A', rows: [], shot_count: 1, to_review: 0, camera: true }, 'u', 't');
    for (const k of Object.keys(full)) expect(only).toContain(k);
    for (const k of all) expect(Object.keys(scanPileDoc({ label: 'L', by: 'A', rows: [] }, 'u', 't'))).toContain(k);
  });

  it('validScanUpdate lets a review change only the rows and the counts', () => {
    const body = fn('validScanUpdate');
    expect(sorted(list(body, 'affectedKeys().hasOnly'))).toEqual(sorted(SCAN_UPDATE_KEYS));
    expect(body).toContain(`d.rows.size() <= ${MAX_PILE_ROWS}`);
  });

  it('has the shots match block under scans with public read and creator or Owner writes', () => {
    const scans = /match \/scans\/\{id\} \{([\s\S]*?)\n      \}/.exec(rules)?.[1] ?? '';
    expect(scans).toContain('allow update: if signedIn() && (resource.data.createdByUid == request.auth.uid || isOwner()) && validScanUpdate();');
    const shots = /match \/shots\/\{chunkId\} \{([\s\S]*?)\n        \}/.exec(scans)?.[1] ?? '';
    expect(shots).toContain('allow read: if true;');
    expect(shots).toMatch(/allow create: if signedIn\(\) && validShotChunk\(\)/);
    expect(shots).toMatch(/allow update: if signedIn\(\) && \(resource\.data\.createdByUid == request\.auth\.uid \|\| isOwner\(\)\) && validShotChunk\(\)/);
    expect(shots).toMatch(/allow delete: if signedIn\(\) && \(resource\.data\.createdByUid == request\.auth\.uid \|\| isOwner\(\)\);/);
  });
});
