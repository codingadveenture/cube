// protocol.ts: what the camera view and the recognition worker say to each other. Types only, so
// the camera view can import them without pulling the scanner into its chunk.
import type { ExpectedPrinting, Verdict } from './match';
import type { PrepareProgress } from './index';
import type { Rect } from './preprocess';

export type Orientation = 'upright' | 'rotated';

/** One of the top candidates of a slip, flattened for storage. */
export interface ShotCandidate {
  scryfall_id: string;
  oracle_id: string;
  name: string;
  set: string;
  collector_number: string;
  score: number;
  /** 'back' when the best row of this card was its back face (the image is the back face's). */
  face: 'front' | 'back';
}

/** The parts of a Decision worth keeping with a shot. */
export interface ShotDecision {
  status: 'match' | 'review' | 'none';
  score: number;
  margin: number;
  verdict: Verdict | null;
}

export interface RecogniseRequest {
  /** The empty sheet's colour, for refineCardBox; null when it has not been set. */
  sheet: [number, number, number] | null;
  /** The passes to run first, in order. */
  passes: Orientation[];
  /** When the first passes do not give a match, also run the passes not yet tried. */
  fallbackBoth: boolean;
}

export interface RecogniseResult {
  decision: ShotDecision;
  /** The top three cards, best first. */
  candidates: ShotCandidate[];
  /** The orientation whose pass won. */
  orientation: Orientation;
  /**
   * The winning pass's Milo embedding: 128 values, L2-normalised, so the dot product of two is
   * their cosine similarity. Transferred from the worker.
   */
  embedding: Float32Array;
  /** Wall time of the whole recognition, from the crop to the decision. */
  elapsedMs: number;
  /** Mean time of one pass (preprocessing plus one embed call). */
  passMs: number;
  /** Passes run. */
  passes: number;
  /** The slip inside the crop after trimming the sheet. */
  box: Rect;
}

export interface PrepareInfo {
  threads: number;
  catalogSize: number;
  /** Time of one warm-up pass on a blank image, a first estimate of the pass time. */
  warmupMs: number;
}

export type ExpectedEntries = [oracleId: string, printing: ExpectedPrinting][];

export type ToWorker =
  | { type: 'prepare' }
  | { type: 'expected'; entries: ExpectedEntries }
  | { type: 'scan'; id: number; image: { data: Uint8ClampedArray; width: number; height: number }; request: RecogniseRequest };

export type FromWorker =
  | { type: 'progress'; progress: PrepareProgress }
  | { type: 'ready'; info: PrepareInfo }
  | { type: 'prepare-error'; message: string }
  | { type: 'result'; id: number; result: RecogniseResult }
  | { type: 'scan-error'; id: number; message: string };
