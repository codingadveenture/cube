// catalog.ts: the closed art catalog (public/data/art-catalog.bin and art-catalog.json, built by
// scripts/build-art-catalog.mjs) and a top-k cosine search over it.
//
// The embeddings are L2-normalised, so the dot product is the cosine similarity. A linear scan
// over about 7,000 rows of 128 values takes well under a millisecond, so there is no index.
import { decodeFloat16 } from './float16';
import type { CatalogEntry, Hit } from './types';

export const DIMS = 128;

/** The shape of art-catalog.json (see scripts/build-art-catalog.mjs). */
export interface CatalogJson {
  format: number;
  dims: number;
  dtype: string;
  card_columns: string[];
  cards: [oracleId: string, name: string, onList: number][];
  columns: string[];
  rows: [
    scryfallId: string,
    card: number,
    set: string,
    collectorNumber: string,
    illustrationId: string | null,
    digital: number,
    face: number,
    source: number,
  ][];
}

/** Expands the compact JSON rows into entries. */
export function parseCatalogJson(json: CatalogJson): CatalogEntry[] {
  if (json.format !== 1 || json.dims !== DIMS || json.dtype !== 'float16') {
    throw new Error('unsupported art catalog format');
  }
  return json.rows.map(([scryfallId, card, set, cn, illustration, digital, face, source], row) => {
    const [oracleId, name, onList] = json.cards[card];
    return {
      row,
      scryfall_id: scryfallId,
      oracle_id: oracleId,
      name,
      set,
      collector_number: cn,
      illustration_id: illustration,
      digital: digital === 1,
      face: face === 1 ? 'back' : 'front',
      source: source === 1 ? 'self' : 'hosted',
      on_list: onList === 1,
    };
  });
}

export class ArtCatalog {
  readonly entries: CatalogEntry[];
  /** Row-major float32, entries.length x 128. */
  readonly vectors: Float32Array;

  constructor(entries: CatalogEntry[], vectors: Float32Array) {
    if (vectors.length !== entries.length * DIMS) {
      throw new Error(`art catalog has ${entries.length} rows but ${vectors.length / DIMS} vectors`);
    }
    this.entries = entries;
    this.vectors = vectors;
  }

  /** Builds a catalog from the two files' contents. */
  static fromData(json: CatalogJson, bin: ArrayBuffer | ArrayBufferView): ArtCatalog {
    return new ArtCatalog(parseCatalogJson(json), decodeFloat16(bin));
  }

  get size(): number {
    return this.entries.length;
  }

  /** The k rows most similar to `embedding` (L2-normalised, length 128), best first. */
  search(embedding: ArrayLike<number>, k = 100): Hit[] {
    if (embedding.length !== DIMS) throw new Error(`embedding has ${embedding.length} values, not ${DIMS}`);
    const n = this.entries.length;
    const scores = new Float32Array(n);
    const v = this.vectors;
    for (let r = 0, o = 0; r < n; r++, o += DIMS) {
      let s = 0;
      for (let i = 0; i < DIMS; i++) s += v[o + i] * embedding[i];
      scores[r] = s;
    }
    return topK(scores, Math.min(k, n)).map((r) => ({ ...this.entries[r], score: scores[r] }));
  }
}

/** Indices of the k largest scores, largest first (ties keep row order). */
export function topK(scores: ArrayLike<number>, k: number): number[] {
  const idx = Array.from({ length: scores.length }, (_, i) => i);
  idx.sort((a, b) => scores[b] - scores[a] || a - b);
  return idx.slice(0, Math.max(0, k));
}

export function catalogUrls(base = import.meta.env.BASE_URL): { json: string; bin: string } {
  return { json: `${base}data/art-catalog.json`, bin: `${base}data/art-catalog.bin` };
}

let loading: Promise<ArtCatalog> | null = null;

/** Fetches and decodes the catalog once per session. */
export function loadArtCatalog(): Promise<ArtCatalog> {
  if (!loading) {
    const urls = catalogUrls();
    loading = Promise.all([fetch(urls.json), fetch(urls.bin)]).then(async ([j, b]) => {
      if (!j.ok) throw new Error(`art catalog HTTP ${j.status}`);
      if (!b.ok) throw new Error(`art catalog binary HTTP ${b.status}`);
      return ArtCatalog.fromData((await j.json()) as CatalogJson, await b.arrayBuffer());
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}
