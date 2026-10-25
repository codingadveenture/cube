// cv-catalog.mjs: download the CollectorVision hosted catalog v2 ("scryfall/mtg", Milo 1) into
// scripts/.cache/cv-catalog/ and pick out the rows for a set of Scryfall ids.
//
// Format, from research/collectorvision-integration.md section 2 (which reads
// examples/web_scanner/lib/collectorvision-catalog-v2.mjs at commit 8b295ab of
// https://github.com/HanClinto/CollectorVision):
// - feed: https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/catalog-feed-v2.json,
//   families.milo1.catalogs["scryfall/mtg"] has a base version and daily updates (deltas);
// - each asset is gzip with a size and sha256 in the feed;
// - embeddings: raw little-endian float16, row-major, 128 values per row, no header;
// - records: JSON Lines, line r belongs to embedding row r; id is the Scryfall card id,
//   face_index is omitted for face 0 and 1 for the back face;
// - delta lines: {op: "upsert", record, embedding_index?, metadata?} or
//   {op: "delete", id, face_index?}; an upsert without embedding_index keeps the old embedding.
// Every asset is downloaded once; a cached file whose sha256 matches the feed is reused. The
// catalog data is MIT-licensed (https://github.com/HanClinto/CollectorVisionCatalog).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export const FEED_URL = 'https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/catalog-feed-v2.json';
const DIMS = 128;
const ROW_BYTES = DIMS * 2;
const HEADERS = { 'User-Agent': 'cube-app-build/0.1 (github.com/codingadveenture/cube)' };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBytes(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns the gunzipped bytes of one asset, from the cache when its checksum matches.
async function loadAsset(cacheDir, name, asset) {
  const file = join(cacheDir, name);
  let gz = existsSync(file) ? await readFile(file) : null;
  if (!gz || gz.length !== asset.size || sha256(gz) !== asset.sha256) {
    console.log(`downloading ${asset.url} (${asset.size} bytes)`);
    gz = await fetchBytes(asset.url);
    if (gz.length !== asset.size || sha256(gz) !== asset.sha256) {
      throw new Error(`checksum mismatch for ${asset.url}`);
    }
    await writeFile(file, gz);
  }
  return gunzipSync(gz);
}

const key = (id, face) => (face ? `${id}:face:${face}` : id);

/**
 * Loads the current catalog and returns the rows whose Scryfall id is in `wantedIds`, as a Map
 * from "id" or "id:face:1" to { id, face, name, oracle_id, embedding (Uint8Array of 256 bytes) }.
 * The feed is refetched unless `offline` is set and a cached feed exists.
 */
export async function loadHostedRows(cacheRoot, wantedIds, { offline = false } = {}) {
  const cacheDir = join(cacheRoot, 'cv-catalog');
  await mkdir(cacheDir, { recursive: true });
  const feedFile = join(cacheDir, 'feed.json');
  let feed;
  if (offline && existsSync(feedFile)) {
    feed = JSON.parse(await readFile(feedFile, 'utf8'));
  } else {
    const bytes = await fetchBytes(FEED_URL);
    feed = JSON.parse(bytes.toString('utf8'));
    await writeFile(feedFile, bytes);
  }
  const cat = feed.families.milo1.catalogs['scryfall/mtg'];
  const emb = feed.families.milo1.embedding;
  if (emb && (emb.dimensions !== DIMS || emb.dtype !== 'float16')) {
    throw new Error(`unexpected embedding format ${JSON.stringify(emb)}`);
  }
  const rows = new Map();
  const base = cat.base;
  const baseDir = join(cacheDir, `v${base.version}-base`);
  await mkdir(baseDir, { recursive: true });
  const baseEmb = await loadAsset(baseDir, 'embeddings.f16.gz', base.assets.embeddings);
  const baseRec = (await loadAsset(baseDir, 'records.jsonl.gz', base.assets.records)).toString('utf8');
  if (baseEmb.length !== base.rows * ROW_BYTES) throw new Error('base embeddings have the wrong length');
  let r = 0;
  for (const line of baseRec.split('\n')) {
    if (!line) continue;
    const rec = JSON.parse(line);
    if (wantedIds.has(rec.id)) {
      const face = rec.face_index || 0;
      rows.set(key(rec.id, face), {
        id: rec.id,
        face,
        name: rec.name,
        oracle_id: rec.identifiers?.scryfall_oracle ?? null,
        embedding: Uint8Array.prototype.slice.call(baseEmb, r * ROW_BYTES, (r + 1) * ROW_BYTES),
        version: base.version,
      });
    }
    r++;
  }
  if (r !== base.rows) throw new Error(`base records have ${r} lines, feed says ${base.rows}`);

  const versions = Object.keys(cat.updates || {})
    .map(Number)
    .filter((v) => v > base.version && v <= cat.current_version)
    .sort((a, b) => a - b);
  let ops = 0;
  for (const v of versions) {
    const upd = cat.updates[String(v)];
    if (upd.from_version !== v - 1) throw new Error(`delta ${v} is not from ${v - 1}`);
    const dir = join(cacheDir, `v${v}-delta`);
    await mkdir(dir, { recursive: true });
    const deltaEmb = upd.assets.embeddings ? await loadAsset(dir, 'embeddings.f16.gz', upd.assets.embeddings) : null;
    const deltaRec = (await loadAsset(dir, 'records.jsonl.gz', upd.assets.records)).toString('utf8');
    for (const line of deltaRec.split('\n')) {
      if (!line) continue;
      const op = JSON.parse(line);
      ops++;
      if (op.op === 'delete') {
        const target = op.record || op;
        rows.delete(key(target.id, target.face_index || 0));
        continue;
      }
      if (op.op !== 'upsert') throw new Error(`unknown delta op ${op.op}`);
      const rec = op.record;
      if (!wantedIds.has(rec.id)) continue;
      const k = key(rec.id, rec.face_index || 0);
      const prior = rows.get(k);
      let embedding = prior?.embedding;
      if (Number.isInteger(op.embedding_index)) {
        const i = op.embedding_index;
        embedding = Uint8Array.prototype.slice.call(deltaEmb, i * ROW_BYTES, (i + 1) * ROW_BYTES);
      }
      if (!embedding) throw new Error(`delta ${v} adds ${k} without an embedding`);
      rows.set(k, {
        id: rec.id,
        face: rec.face_index || 0,
        name: rec.name,
        oracle_id: rec.identifiers?.scryfall_oracle ?? null,
        embedding,
        version: v,
      });
    }
  }
  return {
    rows,
    info: {
      feed: FEED_URL,
      checked_at: feed.checked_at ?? null,
      base_version: base.version,
      current_version: cat.current_version,
      catalog_rows: cat.rows,
      delta_ops: ops,
      model: emb?.model ?? null,
    },
  };
}
