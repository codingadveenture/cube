// The scanner API the camera view will use: load the model and the catalog, then recognise one
// guide-box crop at a time.
//
// Adapted in part from HanClinto/CollectorVision examples/web_scanner/scanner.worker.mjs at
// commit 8b295ab (AGPL-3.0-or-later): the preprocessing (lines 508-522, 884-917) and the
// optional 180-degree second pass that keeps the better match (lines 919-936). Changed by the
// cube project on 2026-10-25: no corner detection (the rig holds every slip in a fixed guide
// box), Pillow-style resampling in code, a closed catalog of our cards' Printings, and top-k
// search with a name margin and a separate Printing decision (match.ts).
import { loadArtCatalog, type ArtCatalog } from './catalog';
import { loadEmbedder, type Embedder } from './embedder';
import { decide, type DecideOptions, type Decision } from './match';
import { preprocess, type RgbaImage } from './preprocess';
import type { Hit } from './types';

export type { Decision, DecideOptions, ExpectedPrinting, Verdict, Candidate } from './match';
export type { CatalogEntry, Hit } from './types';
export type { RgbaImage, Rect } from './preprocess';
export { cropImage, refineCardBox, luminanceSpread } from './preprocess';
export { votes, decide, DEFAULT_DECIDE_OPTIONS } from './match';

export interface PrepareProgress {
  stage: 'model' | 'catalog' | 'ready';
  /** 0 to 1 for the model download when its size is known. */
  fraction?: number;
}

export interface Scanner {
  embedder: Embedder;
  catalog: ArtCatalog;
}

let scanner: Promise<Scanner> | null = null;

/** Loads the Milo model and the art catalog (once per session), reporting progress. */
export function prepareScanner(onProgress?: (p: PrepareProgress) => void): Promise<Scanner> {
  if (!scanner) {
    scanner = (async () => {
      onProgress?.({ stage: 'catalog' });
      const catalogPromise = loadArtCatalog();
      onProgress?.({ stage: 'model', fraction: 0 });
      const embedder = await loadEmbedder((fraction) => onProgress?.({ stage: 'model', fraction }));
      const catalog = await catalogPromise;
      onProgress?.({ stage: 'ready' });
      return { embedder, catalog };
    })();
    scanner.catch(() => {
      scanner = null;
    });
  }
  return scanner;
}

export interface ScanOptions {
  /** Also embed the crop upside down and keep the better result (default true). */
  rotate180?: boolean;
  /** Hits to keep from the search (default 100). */
  k?: number;
  decide?: Partial<DecideOptions>;
}

export interface ScanResult {
  embedding: Float32Array;
  hits: Hit[];
  decision: Decision;
  /** 'upright' or 'rotated' (the 180-degree pass won). */
  orientation: 'upright' | 'rotated';
  elapsedMs: number;
}

/** Recognises one guide-box crop (an ImageData or anything with RGBA data, width and height). */
export async function scanCrop(image: RgbaImage, options: ScanOptions = {}): Promise<ScanResult> {
  const started = performance.now();
  const { embedder, catalog } = await prepareScanner();
  const k = options.k ?? 100;
  const passes: ('upright' | 'rotated')[] = options.rotate180 === false ? ['upright'] : ['upright', 'rotated'];
  let best: Omit<ScanResult, 'decision' | 'elapsedMs'> | null = null;
  for (const orientation of passes) {
    const embedding = await embedder.embed(preprocess(image, { rotate180: orientation === 'rotated' }));
    const hits = catalog.search(embedding, k);
    if (!best || (hits[0]?.score ?? -1) > (best.hits[0]?.score ?? -1)) best = { embedding, hits, orientation };
  }
  const result = best!;
  return { ...result, decision: decide(result.hits, options.decide), elapsedMs: performance.now() - started };
}
