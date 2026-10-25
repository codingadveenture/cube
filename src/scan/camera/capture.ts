// capture.ts: when to take the photo of a slip. Pure, so it can be tested on synthetic frames.
//
// Each frame of the guide box is drawn into a small greyscale thumbnail. A slip is present when
// the thumbnail's luminance spread (or its mean) has moved away from the empty-sheet baseline;
// it is still when consecutive thumbnails barely differ. A capture fires when a slip is present,
// has been still for a couple of frames, and either nothing has been captured since the box was
// last empty or the box has clearly been swapped since the last capture: a run of moving frames
// that all looked unlike the last capture (another slip slid straight over the previous one, so
// the box never showed the sheet). That run is what re-arms, not how far the still picture is from
// the last capture, so slow drift (exposure settling, a sleeve sagging) never fires again, and a
// second copy of the same card slid over the first is still taken; the embedding check in
// shots.ts then decides whether it was the same slip. A slip lying still, or nudged a little, is
// counted once.

/** Size of the stability thumbnail for a portrait box (swapped for a landscape box). */
export const THUMB_W = 32;
export const THUMB_H = 45;

export interface Grey {
  /** Luminance 0-255, one byte per pixel, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
}

/** What the empty guide box looks like, from "Set the empty sheet". */
export interface Baseline {
  /** Luminance spread of the empty box's thumbnail. */
  spread: number;
  /** Mean luminance of the empty box's thumbnail. */
  mean: number;
  /** The sheet colour (median RGB of the empty box), for refineCardBox. */
  sheet: [number, number, number];
}

export interface LoopOptions {
  /** A slip is present when the spread exceeds the baseline by this much (0-255)... */
  spreadDelta: number;
  /** ...or the mean luminance differs from the baseline by this much. */
  meanDelta: number;
  /** Two consecutive thumbnails are "the same" when their mean absolute difference is at most this. */
  stableDiff: number;
  /** Consecutive same-looking frame pairs needed before a capture. */
  stableFrames: number;
  /**
   * A moving frame whose thumbnail differs from the last captured one by at least this much (mean
   * absolute difference, 0-255) looks like another slip passing through the box...
   */
  newSlipDiff: number;
  /** ...and this many such frames in a row since the last capture mean the box was swapped. */
  swapFrames: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  spreadDelta: 14,
  meanDelta: 30,
  stableDiff: 4,
  stableFrames: 2,
  newSlipDiff: 18,
  swapFrames: 2,
};

/** RGBA pixels (the shape of ImageData) to luminance. */
export function toGrey(img: { data: ArrayLike<number>; width: number; height: number }): Grey {
  const n = img.width * img.height;
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    data[i] = Math.round(0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]);
  }
  return { data, width: img.width, height: img.height };
}

export interface GreyStats {
  mean: number;
  /** Standard deviation of the luminance. */
  spread: number;
}

export function greyStats(g: Grey): GreyStats {
  const n = g.data.length;
  if (!n) return { mean: 0, spread: 0 };
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = g.data[i];
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return { mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** Mean absolute difference of two thumbnails; Infinity when their sizes differ. */
export function meanAbsDiff(a: Grey, b: Grey): number {
  if (a.width !== b.width || a.height !== b.height || !a.data.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}

/** Median of each RGB channel of an RGBA image (the sheet colour of an empty box). */
export function medianRgb(img: { data: ArrayLike<number>; width: number; height: number }): [number, number, number] {
  const n = img.width * img.height;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) hist[c][img.data[i * 4 + c]]++;
  const out: number[] = [];
  for (let c = 0; c < 3; c++) {
    let seen = 0;
    let v = 0;
    for (; v < 255; v++) {
      seen += hist[c][v];
      if (seen > n / 2) break;
    }
    out.push(v);
  }
  return [out[0], out[1], out[2]];
}

export type Presence = 'present' | 'empty' | 'unsure';

/**
 * Present when the frame is clearly unlike the empty sheet, empty when it is clearly like it,
 * unsure in between (the caller keeps its last answer, so the state does not flicker).
 */
export function presence(stats: GreyStats, baseline: Pick<Baseline, 'spread' | 'mean'>, o: LoopOptions = DEFAULT_LOOP_OPTIONS): Presence {
  const ds = stats.spread - baseline.spread;
  const dm = Math.abs(stats.mean - baseline.mean);
  if (ds >= o.spreadDelta || dm >= o.meanDelta) return 'present';
  if (ds < o.spreadDelta / 2 && dm < o.meanDelta / 2) return 'empty';
  return 'unsure';
}

export interface LoopState {
  prev: Grey | null;
  /** Consecutive frame pairs that looked the same. */
  stable: number;
  /** True when the next still slip may be captured (nothing captured since the box was empty). */
  armed: boolean;
  present: boolean;
  /** The thumbnail of the last capture, to tell a new slip from the same one nudged. */
  lastCaptured: Grey | null;
  /** Consecutive moving frames unlike the last capture (see LoopOptions.newSlipDiff). */
  away: number;
  /** True once the box was swapped since the last capture (a run of swapFrames such frames). */
  swapped: boolean;
}

export function initialLoop(): LoopState {
  return { prev: null, stable: 0, armed: true, present: false, lastCaptured: null, away: 0, swapped: false };
}

export interface StepResult {
  state: LoopState;
  capture: boolean;
  present: boolean;
  stable: boolean;
}

/** One frame of the capture loop. */
export function step(state: LoopState, frame: Grey, baseline: Pick<Baseline, 'spread' | 'mean'>, o: LoopOptions = DEFAULT_LOOP_OPTIONS): StepResult {
  const p = presence(greyStats(frame), baseline, o);
  const present = p === 'present' ? true : p === 'empty' ? false : state.present;
  const diff = state.prev ? meanAbsDiff(state.prev, frame) : Infinity;
  const stableCount = diff <= o.stableDiff ? state.stable + 1 : 0;
  const stable = stableCount >= o.stableFrames;
  let armed = present ? state.armed : true;
  const moving = state.prev !== null && diff > o.stableDiff;
  const unlike = moving && state.lastCaptured !== null && meanAbsDiff(frame, state.lastCaptured) >= o.newSlipDiff;
  let away = unlike ? state.away + 1 : 0;
  let swapped = state.swapped || away >= o.swapFrames;
  const newSlip = present && stable && !armed && swapped;
  const capture = present && stable && (armed || newSlip);
  if (capture) {
    armed = false;
    away = 0;
    swapped = false;
  }
  const lastCaptured = capture ? frame : state.lastCaptured;
  return { state: { prev: frame, stable: stableCount, armed, present, lastCaptured, away, swapped }, capture, present, stable };
}

/**
 * What the loop is waiting for, for the one-line status under the video: 'captured' means the slip
 * in the box is taken and the next one may be slid in, over it or after taking it away.
 */
export type LoopPhase = 'empty' | 'settling' | 'captured';

export function loopPhase(s: LoopState): LoopPhase {
  if (!s.present) return 'empty';
  return s.armed ? 'settling' : 'captured';
}
