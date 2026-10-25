// recognise.ts: one guide-box crop in, a decision out. Runs in the recognition worker
// (vision.worker.ts), or on the main thread when no module worker can be started (client.ts).
//
// The same steps as scanCrop in index.ts, plus what the camera view needs: the crop is trimmed
// to the slip against the empty sheet first (refineCardBox), the passes can be limited to one
// orientation once the slips are known to come one way round, and the time of a pass is
// measured. The decision uses the In-box Printings the view sends (setExpected).
import { prepareScanner, type PrepareProgress } from './index';
import { decide, type ExpectedPrinting } from './match';
import { cropImage, preprocess, refineCardBox, MILO_SIZE, type RgbaImage } from './preprocess';
import type { Hit } from './types';
import type { Orientation, PrepareInfo, RecogniseRequest, RecogniseResult, ShotCandidate } from './protocol';

const K = 100;

let expected = new Map<string, ExpectedPrinting>();

export function setExpected(entries: [string, ExpectedPrinting][]): void {
  expected = new Map(entries);
}

/** Loads the model and the catalog, then times one warm-up pass. */
export async function prepare(onProgress?: (p: PrepareProgress) => void): Promise<PrepareInfo> {
  const { embedder, catalog } = await prepareScanner(onProgress);
  const blank = new Float32Array(3 * MILO_SIZE * MILO_SIZE);
  const t0 = performance.now();
  await embedder.embed(blank);
  return { threads: embedder.threads, catalogSize: catalog.size, warmupMs: performance.now() - t0 };
}

export async function recognise(image: RgbaImage, request: RecogniseRequest): Promise<RecogniseResult> {
  const started = performance.now();
  const { embedder, catalog } = await prepareScanner();
  const box = refineCardBox(image, request.sheet ? { sheet: request.sheet } : {});
  const whole = box.x === 0 && box.y === 0 && box.width === image.width && box.height === image.height;
  const crop = whole ? image : cropImage(image, box);

  let best: { hits: Hit[]; orientation: Orientation; embedding: Float32Array } | null = null;
  let passTime = 0;
  let passes = 0;
  const tried = new Set<Orientation>();
  const run = async (orientation: Orientation) => {
    const t0 = performance.now();
    const embedding = await embedder.embed(preprocess(crop, { rotate180: orientation === 'rotated' }));
    passTime += performance.now() - t0;
    passes++;
    tried.add(orientation);
    const hits = catalog.search(embedding, K);
    if (!best || (hits[0]?.score ?? -1) > (best.hits[0]?.score ?? -1)) best = { hits, orientation, embedding };
  };
  const first: Orientation[] = request.passes.length ? request.passes : ['upright', 'rotated'];
  for (const o of first) await run(o);
  const options = { expected: (oracleId: string) => expected.get(oracleId) };
  let decision = decide(best!.hits, options);
  if (request.fallbackBoth && decision.status !== 'match') {
    for (const o of ['upright', 'rotated'] as const) if (!tried.has(o)) await run(o);
    decision = decide(best!.hits, options);
  }
  const winner = best! as { hits: Hit[]; orientation: Orientation; embedding: Float32Array };
  const candidates: ShotCandidate[] = decision.candidates.map((c) => ({
    scryfall_id: c.printing.scryfall_id,
    oracle_id: c.oracle_id,
    name: c.name,
    set: c.printing.set,
    collector_number: c.printing.collector_number,
    score: c.score,
    face: c.printing.face,
  }));
  return {
    decision: { status: decision.status, score: decision.score, margin: decision.margin, verdict: decision.verdict },
    candidates,
    orientation: winner.orientation,
    // A copy with its own buffer, so the worker can transfer it.
    embedding: Float32Array.from(winner.embedding),
    elapsedMs: performance.now() - started,
    passMs: passes ? passTime / passes : 0,
    passes,
    box,
  };
}
