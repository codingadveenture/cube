import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_OPTIONS,
  greyStats,
  initialLoop,
  loopPhase,
  meanAbsDiff,
  medianRgb,
  normalisedMeanAbsDiff,
  presence,
  step,
  toGrey,
  type Baseline,
  type Grey,
  type LoopState,
} from './capture';
import { clampGuide, guideRect, moveGuide, parseGuide, resizeGuide, turnGuide, DEFAULT_GUIDE, MIN_H } from './guide';
import { initialOrientation, LOCK_AFTER, parseOrientation, passesFor, recordOrientation } from './orientation';
import { COUNT_EVERY, crossedCheckpoint, defaultSettings, nextPassMs, parseCameraSession, parseSettings } from './settings';
import {
  alreadyInPile,
  applyRecognition,
  betterShot,
  confirmShot,
  defaultPileLabel,
  filterShots,
  isSameSlip,
  keepSecondCopy,
  newShot,
  nextToReview,
  previousShot,
  refOf,
  REPEAT,
  repeatOf,
  REPLACED,
  reviveShot,
  SAME_SLIP,
  sameSlipAsBefore,
  sameSlipOf,
  shotCounts,
  shotsToRows,
  skipAsRepeat,
  skipSameSlip,
  skipShot,
  sortShots,
  type Shot,
} from './shots';
import type { RecogniseResult, ShotCandidate } from '../vision/protocol';

const W = 32;
const H = 45;

/** A flat sheet with a little noise. */
function sheet(level = 230, noise = 2, seed = 1): Grey {
  const data = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (s * 16807) % 2147483647;
    data[i] = level + ((s % (2 * noise + 1)) - noise);
  }
  return { data, width: W, height: H };
}

/** A slip: dark border, a busy picture inside, on the sheet. */
function slip(shift = 0): Grey {
  const g = sheet();
  for (let y = 3; y < H - 3; y++) {
    for (let x = 2; x < W - 2; x++) {
      const border = y < 6 || y >= H - 6 || x < 4 || x >= W - 4;
      g.data[y * W + x] = border ? 20 : 60 + (((x + shift) * 37 + y * 11) % 150);
    }
  }
  return g;
}

/** The same picture, a little brighter: the same slip nudged or lit a little differently. */
function brighter(g: Grey, by: number): Grey {
  return { ...g, data: g.data.map((v) => Math.min(255, v + by)) };
}

/** The top `rows` rows of a slip with the sheet below: a slip only part of the way into the box. */
function partOf(g: Grey, rows: number): Grey {
  const out = sheet();
  out.data.set(g.data.subarray(0, rows * W));
  return out;
}

/** A bright blob over the middle of a slip: a hand resting on it. */
function hand(g: Grey): Grey {
  const data = g.data.slice();
  for (let y = 8; y < 36; y++) for (let x = 6; x < 26; x++) data[y * W + x] = 200;
  return { ...g, data };
}

/** The leftmost `cols` columns darkened by `by`: a shadow creeping over the box. */
function shaded(g: Grey, cols: number, by: number): Grey {
  const data = g.data.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < cols; x++) data[y * W + x] = Math.max(0, data[y * W + x] - by);
  return { ...g, data };
}

const empty = sheet();
/** The empty sheet in half-shadow: neither clearly empty nor clearly a slip. */
const shade = sheet(210);
const baseline: Baseline = { ...greyStats(empty), sheet: [230, 230, 230] };

function run(frames: Grey[], state: LoopState = initialLoop()) {
  const captures: number[] = [];
  frames.forEach((f, i) => {
    const r = step(state, f, baseline);
    state = r.state;
    if (r.capture) captures.push(i);
  });
  return { captures, state };
}

describe('capture: presence and stability', () => {
  it('turns RGBA into luminance and measures it', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
    const g = toGrey({ data: rgba, width: 2, height: 2 });
    expect(Array.from(g.data)).toEqual([255, 0, 76, 150]);
    const st = greyStats({ data: new Uint8Array([10, 30]), width: 2, height: 1 });
    expect(st.mean).toBe(20);
    expect(st.spread).toBe(10);
  });

  it('tells an empty sheet from a slip', () => {
    expect(presence(greyStats(sheet(230, 2, 7)), baseline)).toBe('empty');
    expect(presence(greyStats(slip()), baseline)).toBe('present');
    // A uniformly darker box (a plain dark slip) is present through its mean.
    expect(presence(greyStats(sheet(120)), baseline)).toBe('present');
    // In between: unsure, so the loop keeps its last answer.
    const halfway = { mean: baseline.mean, spread: baseline.spread + DEFAULT_LOOP_OPTIONS.spreadDelta * 0.75 };
    expect(presence(halfway, baseline)).toBe('unsure');
  });

  it('measures the difference between thumbnails', () => {
    expect(meanAbsDiff(slip(), slip())).toBe(0);
    expect(meanAbsDiff(slip(0), slip(5))).toBeGreaterThan(DEFAULT_LOOP_OPTIONS.stableDiff);
    expect(meanAbsDiff(slip(), { data: new Uint8Array(4), width: 2, height: 2 })).toBe(Infinity);
  });

  it('takes the median colour of the sheet', () => {
    const px = [
      [200, 210, 220],
      [201, 211, 221],
      [10, 10, 10],
      [202, 212, 222],
      [199, 209, 219],
    ];
    const data = new Uint8ClampedArray(px.flatMap((p) => [...p, 255]));
    expect(medianRgb({ data, width: 5, height: 1 })).toEqual([200, 210, 220]);
  });
});

describe('capture: one photo per visit', () => {
  it('captures a slip once it has been still for two frame pairs', () => {
    const { captures } = run([empty, empty, slip(3), slip(), slip(), slip(), slip(), slip()]);
    // slip(3) -> slip() at index 3 is still a move; the pairs 3-4 and 4-5 are still, so index 5.
    expect(captures).toEqual([5]);
  });

  it('does not capture a slip that keeps moving', () => {
    const { captures } = run([empty, slip(0), slip(1), slip(2), slip(3), slip(5), slip(6)]);
    expect(captures).toEqual([]);
  });

  it('counts a slip lying still once, and the next after the box has emptied', () => {
    const frames = [empty, slip(), slip(), slip(), slip(), slip(), slip(), empty, empty, slip(2), slip(2), slip(2)];
    expect(run(frames).captures).toEqual([3, 11]);
  });

  it('captures a slip slid straight over the previous one, without the box emptying', () => {
    expect(meanAbsDiff(slip(0), slip(7))).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.newSlipDiff);
    const frames = [empty, slip(), slip(), slip(), slip(), slip(3), slip(5), slip(7), slip(7), slip(7), slip(7)];
    expect(run(frames).captures).toEqual([3, 9]);
  });

  it('does not capture the same slip again when it is nudged', () => {
    const nudged = brighter(slip(), 10);
    const d = meanAbsDiff(slip(), nudged);
    expect(d).toBeGreaterThan(DEFAULT_LOOP_OPTIONS.stableDiff);
    expect(d).toBeLessThan(DEFAULT_LOOP_OPTIONS.newSlipDiff);
    const frames = [empty, slip(), slip(), slip(), slip(3), nudged, nudged, nudged, nudged];
    const { captures, state } = run(frames);
    expect(captures).toEqual([3]);
    expect(loopPhase(state)).toBe('captured');
  });

  it('captures a second copy of the same card slid straight over the first', () => {
    // Another card passes through the box (moving frames unlike the capture), then the copy settles.
    const frames = [empty, slip(), slip(), slip(), slip(), slip(3), slip(5), slip(7), slip(), slip(), slip(), slip()];
    expect(run(frames).captures).toEqual([3, 10]);
  });

  it('does not capture again when the picture drifts slowly without a swap', () => {
    // Exposure settling: 3 levels a frame counts as still, and drifts far from the capture.
    const frames = [empty, slip(), slip(), slip()];
    for (let i = 1; i <= 20; i++) frames.push(brighter(slip(), 3 * i));
    expect(meanAbsDiff(slip(), frames[frames.length - 1]!)).toBeGreaterThan(DEFAULT_LOOP_OPTIONS.newSlipDiff);
    expect(run(frames).captures).toEqual([3]);
  });

  it('captures the same slip again when it is lifted and put back', () => {
    const frames = [empty, slip(), slip(), slip(), empty, empty, slip(), slip(), slip()];
    expect(run(frames).captures).toEqual([3, 8]);
  });

  it('still captures a slow swap with the sheet showing in between', () => {
    const frames = [slip(), slip(), slip(), empty, empty, empty, slip(7), slip(7), slip(7)];
    expect(run(frames).captures).toEqual([2, 8]);
  });

  it('captures a slip already lying there when the loop starts', () => {
    expect(run([slip(), slip(), slip()]).captures).toEqual([2]);
  });

  it('says what it is waiting for', () => {
    expect(loopPhase(initialLoop())).toBe('empty');
    const settling = run([empty, slip()]).state;
    expect(loopPhase(settling)).toBe('settling');
    const taken = run([slip(), slip(), slip()]).state;
    expect(loopPhase(taken)).toBe('captured');
  });

  it('measures the difference between pictures with the exposure taken out', () => {
    const a = slip();
    expect(normalisedMeanAbsDiff(a, a)).toBe(0);
    // Uniformly brighter is the same picture: nothing is left once each mean is removed.
    expect(meanAbsDiff(a, brighter(a, 10))).toBeCloseTo(10, 6);
    expect(normalisedMeanAbsDiff(a, brighter(a, 10))).toBeCloseTo(0, 6);
    // A change in the picture survives, with or without a change of exposure on top.
    const covered = hand(a);
    expect(normalisedMeanAbsDiff(a, covered)).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.settledDiff);
    expect(normalisedMeanAbsDiff(a, brighter(covered, 10))).toBeCloseTo(normalisedMeanAbsDiff(a, covered), 6);
    expect(normalisedMeanAbsDiff(a, { data: new Uint8Array(4), width: 2, height: 2 })).toBe(Infinity);
  });

  it('captures a slip pushed fully in after a photo of it half-way (the lost slip)', () => {
    const other = slip(7);
    const half = partOf(other, 24);
    // Slip B slides in over A and pauses half-way: the swap run takes that photo.
    const first = run([empty, slip(), slip(), slip(), partOf(other, 12), partOf(other, 18), half, half, half]);
    expect(first.captures).toEqual([3, 8]);
    expect(first.state.lastCaptured).toBe(half);
    // One quick push, then B lies still fully in. A single moving frame is no swap run, but the
    // picture that settles is unlike the half-way photo.
    expect(normalisedMeanAbsDiff(other, half)).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.settledDiff);
    expect(run([other, other, other], first.state).captures).toEqual([2]);
  });

  it('captures the clean slip after the hand that was in its photo has left', () => {
    const covered = hand(slip());
    expect(normalisedMeanAbsDiff(covered, slip())).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.settledDiff);
    // The hand lifts in one frame: the swap rule needs two, the settled picture is enough.
    expect(run([empty, covered, covered, covered, slip(), slip(), slip()]).captures).toEqual([3, 6]);
  });

  it('does not capture a slip that settles after a nudge which left the picture the same', () => {
    const taken = slip();
    // Lit a little differently, with a sliver of shadow on the margin: moving frames, same picture.
    const nudged = [brighter(taken, 10), shaded(brighter(taken, 20), 2, 30)];
    for (const n of nudged) {
      expect(meanAbsDiff(taken, n)).toBeGreaterThan(DEFAULT_LOOP_OPTIONS.stableDiff);
      expect(normalisedMeanAbsDiff(taken, n)).toBeLessThan(DEFAULT_LOOP_OPTIONS.settledDiff);
    }
    const { captures, state } = run([empty, taken, taken, taken, nudged[0]!, nudged[1]!, nudged[1]!, nudged[1]!, nudged[1]!]);
    expect(captures).toEqual([3]);
    expect(loopPhase(state)).toBe('captured');
  });

  it('does not capture again when a shadow creeps over a still slip', () => {
    // One column every four frames: every frame counts as still, and after sixty the picture is
    // far from the capture, but no frame ever settles after motion, so the check never runs.
    const frames = [empty, slip(), slip(), slip()];
    for (let i = 1; i <= 60; i++) frames.push(shaded(slip(), Math.floor(i / 4), 40));
    for (let i = 4; i < frames.length; i++) expect(meanAbsDiff(frames[i - 1]!, frames[i]!)).toBeLessThanOrEqual(DEFAULT_LOOP_OPTIONS.stableDiff);
    expect(normalisedMeanAbsDiff(slip(), frames[frames.length - 1]!)).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.settledDiff);
    expect(run(frames).captures).toEqual([3]);
  });

  it('never photographs a frame that is only half-way present, even settled while armed or swapped', () => {
    expect(presence(greyStats(shade), baseline)).toBe('unsure');
    // Armed: a slip slid through and the box settled on the sheet in half-shadow.
    const armed = run([empty, slip(0), slip(1), slip(2), shade, shade, shade, shade]);
    expect(armed.captures).toEqual([]);
    expect(armed.state.armed).toBe(true);
    expect(armed.state.stable).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.stableFrames);
    // The status line says so, instead of asking the Owner to hold still forever.
    expect(loopPhase(armed.state)).toBe('unclear');
    // Swapped: a capture, a swap run, then the box settled in half-shadow.
    const swapped = run([empty, slip(), slip(), slip(), slip(3), slip(5), slip(7), shade, shade, shade, shade]);
    expect(swapped.captures).toEqual([3]);
    expect(swapped.state.swapped).toBe(true);
    expect(loopPhase(swapped.state)).toBe('unclear');
  });

  it('compares the settled picture on the first still frame that clearly shows a slip, not only the first still one', () => {
    // After the photo of A, one moving frame (no swap run), then the box settles on something that
    // reads unsure for two frames and clearly present from the next, without moving in between.
    const unsure = sheet(201);
    const clear = sheet(199);
    expect(presence(greyStats(unsure), baseline)).toBe('unsure');
    expect(presence(greyStats(clear), baseline)).toBe('present');
    expect(meanAbsDiff(unsure, clear)).toBeLessThanOrEqual(DEFAULT_LOOP_OPTIONS.stableDiff);
    const { captures, state } = run([empty, slip(), slip(), slip(), unsure, unsure, unsure, clear, clear]);
    expect(state.swapped).toBe(false);
    expect(captures).toEqual([3, 7]);
    // Once compared, the still run is done with: more still frames never compare again.
    expect(run([clear, clear, clear], state).captures).toEqual([]);
  });

  it('takes a change of gain out of the difference as well as a shift of brightness', () => {
    const a = slip();
    const gained = { ...a, data: a.data.map((v) => Math.min(255, Math.round(v * 1.08))) };
    expect(meanAbsDiff(a, gained)).toBeGreaterThan(DEFAULT_LOOP_OPTIONS.stableDiff);
    expect(normalisedMeanAbsDiff(a, gained)).toBeLessThan(1);
    // A stronger gain clips the sheet at white; what is left stays well under settledDiff.
    const clipped = { ...a, data: a.data.map((v) => Math.min(255, Math.round(v * 1.15))) };
    expect(normalisedMeanAbsDiff(a, clipped)).toBeLessThan(DEFAULT_LOOP_OPTIONS.settledDiff);
    // A different picture at the same exposure is not taken out.
    expect(normalisedMeanAbsDiff(a, slip(7))).toBeGreaterThanOrEqual(DEFAULT_LOOP_OPTIONS.settledDiff);
  });
});

describe('orientation lock', () => {
  it('runs both passes until five matched slips come the same way', () => {
    let s = initialOrientation();
    for (let i = 0; i < LOCK_AFTER - 1; i++) {
      s = recordOrientation(s, 'rotated');
      expect(s.locked).toBe(null);
      expect(passesFor(s)).toEqual(['upright', 'rotated']);
    }
    s = recordOrientation(s, 'rotated');
    expect(s.locked).toBe('rotated');
    expect(passesFor(s)).toEqual(['rotated']);
  });

  it('does not lock when the slips come both ways, and locks on a later run of five', () => {
    let s = initialOrientation();
    for (const o of ['upright', 'upright', 'rotated', 'upright', 'upright'] as const) s = recordOrientation(s, o);
    expect(s.locked).toBe(null);
    s = recordOrientation(s, 'upright');
    expect(s.locked).toBe(null); // last five: upright, rotated, upright, upright, upright
    s = recordOrientation(s, 'upright');
    expect(s.locked).toBe(null); // rotated, then four upright
    s = recordOrientation(s, 'upright');
    expect(s.locked).toBe('upright');
  });

  it('drops the lock when the other way wins', () => {
    let s = { recent: [], locked: 'upright' as const };
    expect(recordOrientation(s, 'upright')).toBe(s);
    const next = recordOrientation(s, 'rotated');
    expect(next).toEqual({ recent: ['rotated'], locked: null });
    s = { recent: [], locked: 'upright' };
    expect(passesFor(s)).toEqual(['upright']);
  });

  it('reads a stored state defensively', () => {
    expect(parseOrientation(null)).toEqual(initialOrientation());
    expect(parseOrientation({ recent: ['upright', 'x', 'rotated'], locked: 'sideways' })).toEqual({ recent: ['upright', 'rotated'], locked: null });
  });
});

const blob = new Blob(['x'], { type: 'image/jpeg' });

function cand(name: string, set: string, cn: string, score: number, id = `${set}-${cn}`): ShotCandidate {
  return { scryfall_id: id, oracle_id: `o-${name}`, name, set, collector_number: cn, score, face: 'front' };
}

function shot(id: string, at: string): Shot {
  return newShot({ id, at, thumb: blob, width: 640, height: 896, source: 'camera' });
}

function result(status: 'match' | 'review' | 'none', candidates: ShotCandidate[], embedding: Float32Array = new Float32Array(128)): RecogniseResult {
  return {
    embedding,
    decision: { status, score: candidates[0]?.score ?? 0, margin: 0.1, verdict: null },
    candidates,
    orientation: 'rotated',
    elapsedMs: 400,
    passMs: 200,
    passes: 2,
    box: { x: 0, y: 0, width: 640, height: 896 },
  };
}

describe('shots', () => {
  const bolt = cand('Lightning Bolt', 'lea', '161', 0.9);
  const ring = cand('Sol Ring', 'lea', '270', 0.88);
  const ringC21 = cand('Sol Ring', 'c21', '263', 0.8);

  it('keeps a new shot as review until it is recognised', () => {
    const s = shot('a', '2026-10-25T10:00:00Z');
    expect(s.status).toBe('review');
    expect(s.decision).toBe(null);
    expect(shotCounts([s])).toEqual({ captured: 1, matched: 0, toReview: 1, skipped: 0, repeats: 0 });
  });

  it('chooses the best Printing of a match and nothing for review', () => {
    const m = applyRecognition(shot('a', 't1'), result('match', [bolt, ring]));
    expect(m.status).toBe('match');
    expect(m.chosen).toEqual({ scryfall_id: 'lea-161', oracle_id: 'o-Lightning Bolt', name: 'Lightning Bolt', set: 'lea', collector_number: '161' });
    expect(m.orientation).toBe('rotated');
    const r = applyRecognition(shot('b', 't2'), result('review', [bolt, ring]));
    expect(r.status).toBe('review');
    expect(r.chosen).toBe(null);
    expect(r.candidates).toHaveLength(2);
  });

  it('keeps the Owner’s choice when recognition answers late', () => {
    const confirmed = confirmShot(shot('a', 't1'), ring);
    const late = applyRecognition(confirmed, result('match', [bolt]));
    expect(late.status).toBe('confirmed');
    expect(late.chosen?.name).toBe('Sol Ring');
    expect(applyRecognition(skipShot(shot('b', 't2')), result('match', [bolt])).status).toBe('skipped');
  });

  it('turns matched and confirmed shots into rows, merging identical Printings', () => {
    const shots = [
      applyRecognition(shot('1', '2026-10-25T10:00:01Z'), result('match', [bolt])),
      applyRecognition(shot('2', '2026-10-25T10:00:02Z'), result('match', [ring])),
      confirmShot(shot('3', '2026-10-25T10:00:03Z'), bolt),
      confirmShot(shot('4', '2026-10-25T10:00:04Z'), ringC21),
      applyRecognition(shot('5', '2026-10-25T10:00:05Z'), result('review', [bolt])),
      applyRecognition(shot('6', '2026-10-25T10:00:06Z'), result('none', [])),
      skipShot(shot('7', '2026-10-25T10:00:07Z')),
    ];
    const rows = shotsToRows(sortShots(shots));
    expect(rows).toEqual([
      { name: 'Lightning Bolt', quantity: 2, scryfall_id: 'lea-161', set: 'lea', collector_number: '161', foil: null, language: null },
      { name: 'Sol Ring', quantity: 1, scryfall_id: 'lea-270', set: 'lea', collector_number: '270', foil: null, language: null },
      { name: 'Sol Ring', quantity: 1, scryfall_id: 'c21-263', set: 'c21', collector_number: '263', foil: null, language: null },
    ]);
    expect(shotCounts(shots)).toEqual({ captured: 7, matched: 4, toReview: 2, skipped: 1, repeats: 0 });
    expect(filterShots(shots, 'review').map((s) => s.id)).toEqual(['5', '6']);
    expect(filterShots(shots, 'matched').map((s) => s.id)).toEqual(['1', '2', '3', '4']);
    expect(filterShots(shots, 'skipped').map((s) => s.id)).toEqual(['7']);
    expect(filterShots(shots, 'all')).toHaveLength(7);
  });

  it('sorts newest first and finds the next shot to review', () => {
    const a = shot('a', '2026-10-25T10:00:01Z');
    const b = applyRecognition(shot('b', '2026-10-25T10:00:02Z'), result('match', [bolt]));
    const c = shot('c', '2026-10-25T10:00:03Z');
    const list = sortShots([a, b, c]);
    expect(list.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(nextToReview(list, 'c')?.id).toBe('a');
    expect(nextToReview(list, 'a')?.id).toBe('c');
    expect(nextToReview([b], 'b')).toBe(null);
  });

  it('names the pile after the local date', () => {
    expect(defaultPileLabel(new Date(2026, 9, 5, 23, 59))).toBe('Camera 2026-10-05 23:59');
    expect(defaultPileLabel(new Date(2026, 9, 5, 8, 7), 70)).toBe('Camera 2026-10-05 08:07, 70 slips');
    expect(defaultPileLabel(new Date(2026, 9, 5, 8, 7), 1)).toBe('Camera 2026-10-05 08:07, 1 slip');
  });

  it('checks records read back from the store', () => {
    const s = applyRecognition(shot('a', 't'), result('match', [bolt]));
    expect(reviveShot(structuredClone({ ...s, thumb: undefined }))).toBe(null);
    expect(reviveShot({ ...s, status: 'lost' })).toBe(null);
    expect(reviveShot(null)).toBe(null);
    const back = reviveShot({ ...s, orientation: 'sideways', source: undefined });
    expect(back?.orientation).toBe(null);
    expect(back?.source).toBe('camera');
    expect(back?.chosen?.name).toBe('Lightning Bolt');
  });

  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 11, 0, 0) + s * 1000).toISOString();
  const matched = (id: string, t: number, c: ShotCandidate[], e?: Float32Array) => applyRecognition(shot(id, at(t)), result('match', c, e));

  it('sets a later match of a Printing already in the pile aside as a repeat', () => {
    const first = matched('a', 0, [bolt]);
    const again = matched('b', 30, [bolt]);
    expect(repeatOf([again, first], again)?.id).toBe('a');
    expect(repeatOf([first], matched('c', 31, [ring]))).toBe(null);
    const aside = skipAsRepeat(again);
    expect(aside.status).toBe('skipped');
    expect(aside.chosen).toBe(null);
    expect(aside.reason).toBe(REPEAT);
    // The recognition stays, so Review can keep it as a second copy.
    expect(aside.decision).toEqual(again.decision);
    expect(aside.candidates).toEqual(again.candidates);
    expect(aside.embedding).toBe(again.embedding);
    expect(isSameSlip(aside)).toBe(true);
    expect(shotCounts([first, aside])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1, repeats: 1 });
    expect(shotsToRows([first, aside])).toEqual([expect.objectContaining({ name: 'Lightning Bolt', quantity: 1 })]);
    expect(reviveShot(structuredClone(aside))?.reason).toBe(REPEAT);
  });

  it('finds the repeat by name, set and number when an id is missing', () => {
    const unknownId = { ...bolt, scryfall_id: '' };
    const first = matched('a', 0, [unknownId]);
    expect(repeatOf([first], matched('b', 10, [bolt]))?.id).toBe('a');
    expect(repeatOf([first], matched('b', 10, [{ ...unknownId, collector_number: '162' }]))).toBe(null);
    // With ids on both, the id decides: another Printing of the same card is not a repeat.
    const confirmed = confirmShot(shot('c', at(20)), ring);
    expect(repeatOf([confirmed], matched('d', 25, [ring]))?.id).toBe('c');
    expect(repeatOf([confirmed], matched('d', 25, [ringC21]))).toBe(null);
  });

  it('never takes a doubtful shot, a photo, or a match before the kept shot for a repeat', () => {
    const first = matched('a', 0, [bolt]);
    const doubt = applyRecognition(shot('b', at(10)), result('review', [bolt]));
    expect(repeatOf([doubt, first], doubt)).toBe(null);
    const photo = applyRecognition({ ...shot('p', at(11)), source: 'photo' as const }, result('match', [bolt]));
    expect(repeatOf([photo, first], photo)).toBe(null);
    // A skipped shot is not in the pile, and a shot is no repeat of itself or of a later one.
    const later = matched('c', 20, [bolt]);
    expect(repeatOf([later, skipShot(first)], later)).toBe(null);
    expect(repeatOf([later, skipAsRepeat(first)], later)).toBe(null);
    expect(repeatOf([later, first], first)).toBe(null);
    expect(repeatOf([first], first)).toBe(null);
    // The Owner's confirmation is their word, even of a card already in the pile.
    const confirmed = confirmShot(later, bolt);
    expect(repeatOf([confirmed, first], confirmed)).toBe(null);
  });

  it('keeps a repeat as a second copy, back to what its recognition gave', () => {
    const first = matched('a', 0, [bolt]);
    const copy = keepSecondCopy(skipAsRepeat(matched('b', 10, [bolt])));
    expect(copy.status).toBe('match');
    expect(copy.chosen?.scryfall_id).toBe('lea-161');
    expect(copy.reason).toBeUndefined();
    expect(shotCounts([first, copy])).toEqual({ captured: 2, matched: 2, toReview: 0, skipped: 0, repeats: 0 });
    expect(shotsToRows([first, copy])[0]!.quantity).toBe(2);
    // A doubtful photo the Owner called a repeat in Review comes back doubtful.
    const doubtful = keepSecondCopy(skipAsRepeat(applyRecognition(shot('c', at(20)), result('review', [bolt]))));
    expect(doubtful.status).toBe('review');
    expect(doubtful.chosen).toBe(null);
  });

  it('tells which candidates are already in the pile', () => {
    const first = matched('a', 0, [bolt]);
    const byName = confirmShot(shot('b', at(1)), { ...ring, scryfall_id: '' });
    const shots = [skipShot(matched('c', 2, [ringC21])), byName, first];
    expect(alreadyInPile(shots, bolt)?.id).toBe('a');
    expect(alreadyInPile(shots, ring)?.id).toBe('b');
    expect(alreadyInPile(shots, ringC21)).toBe(null);
    // A shot is not in the pile on its own account.
    expect(alreadyInPile(shots, bolt, 'a')).toBe(null);
  });

  it('keeps a repeat set aside when the slip is nudged', () => {
    const first = matched('a', 0, [{ ...bolt, score: 0.7 }], unit());
    const repeat = skipAsRepeat(matched('b', 20, [{ ...bolt, score: 0.6 }], unit()));
    const nudged = matched('c', 21, [{ ...bolt, score: 0.8 }], unit());
    expect(sameSlipOf([nudged, repeat, first], nudged)?.id).toBe('b');
    const out = skipSameSlip(repeat, nudged);
    expect(out.kept).toBe('next');
    expect(out.previous.reason).toBe(REPLACED);
    // Judged on the pile as settled, the better photo is still a repeat of the first slip.
    expect(repeatOf([out.next, out.previous, first], out.next)?.id).toBe('a');
    expect(shotCounts([skipAsRepeat(out.next), out.previous, first])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 2, repeats: 1 });
    // A worse photo of the nudged slip loses to the repeat as the same slip.
    const worse = matched('d', 22, [{ ...bolt, score: 0.5 }], unit());
    expect(skipSameSlip(repeat, worse).next.reason).toBe(SAME_SLIP);
  });
});

/** A unit vector along axis `i`, turned towards axis `j` so that its dot with the axis-i vector is `cos`. */
function unit(cos = 1, i = 0, j = 1): Float32Array {
  const v = new Float32Array(128);
  v[i] = cos;
  v[j] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

describe('same slip twice', () => {
  const bolt = cand('Lightning Bolt', 'lea', '161', 0.9);
  const ring = cand('Sol Ring', 'lea', '270', 0.88);
  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + s * 1000).toISOString();
  const recognised = (id: string, t: number, status: 'match' | 'review' | 'none', c: ShotCandidate[], e: Float32Array) =>
    applyRecognition(shot(id, at(t)), result(status, c, e));

  it('skips the same slip captured again within 4 seconds', () => {
    const a = recognised('a', 0, 'match', [bolt], unit());
    const b = recognised('b', 1.5, 'match', [bolt], unit(0.97));
    expect(sameSlipAsBefore(a, b)).toBe(true);
    const out = skipSameSlip(a, b);
    expect(out.kept).toBe('previous');
    const skipped = out.next;
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe(SAME_SLIP);
    expect(isSameSlip(skipped)).toBe(true);
    expect(shotCounts([a, skipped])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1, repeats: 0 });
  });

  it('treats two unmatched recognitions as naming the same thing', () => {
    const a = recognised('a', 0, 'review', [bolt], unit());
    const b = recognised('b', 1, 'none', [], unit(0.95));
    expect(sameSlipAsBefore(a, b)).toBe(true);
  });

  it('counts a slip captured again after 4 seconds', () => {
    const a = recognised('a', 0, 'match', [bolt], unit());
    expect(sameSlipAsBefore(a, recognised('b', 4, 'match', [bolt], unit()))).toBe(false);
    expect(sameSlipAsBefore(a, recognised('b', 3.9, 'match', [bolt], unit()))).toBe(true);
  });

  it('counts a different Printing', () => {
    const a = recognised('a', 0, 'match', [bolt], unit());
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [ring], unit(0.95)))).toBe(false);
    expect(sameSlipAsBefore(a, recognised('b', 1, 'review', [bolt], unit(0.95)))).toBe(false);
  });

  it('skips a near-identical slip even when one recognition says match and the other review', () => {
    const a = recognised('a', 0, 'review', [bolt], unit());
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [bolt], unit(0.99)))).toBe(true);
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [ring], unit(0.97)))).toBe(true);
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [bolt], unit(0.96)))).toBe(false);
  });

  it('counts a slip whose embedding is less alike', () => {
    const a = recognised('a', 0, 'match', [bolt], unit());
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [bolt], unit(0.9)))).toBe(false);
    expect(sameSlipAsBefore(a, recognised('b', 1, 'match', [bolt], unit(0.93)))).toBe(true);
    // Without an embedding (recognition failed or was behind) nothing is skipped.
    expect(sameSlipAsBefore(shot('a', at(0)), recognised('b', 1, 'match', [bolt], unit()))).toBe(false);
    expect(sameSlipAsBefore(null, recognised('b', 1, 'match', [bolt], unit()))).toBe(false);
  });

  it('counts a restored shot as a second copy', () => {
    const a = recognised('a', 0, 'match', [bolt], unit());
    const skipped = skipSameSlip(a, recognised('b', 1, 'match', [bolt], unit())).next;
    const kept = keepSecondCopy(skipped);
    expect(kept.status).toBe('match');
    expect(kept.chosen?.scryfall_id).toBe('lea-161');
    expect(kept.reason).toBeUndefined();
    expect(shotCounts([a, kept])).toEqual({ captured: 2, matched: 2, toReview: 0, skipped: 0, repeats: 0 });
    expect(shotsToRows([a, kept])[0]!.quantity).toBe(2);
    const doubtful = keepSecondCopy(skipSameSlip(a, recognised('c', 2, 'review', [bolt], unit())).next);
    expect(doubtful.status).toBe('review');
    expect(doubtful.chosen).toBe(null);
  });

  it('keeps the clean second photo over a first one with a thumb in it', () => {
    // The thumb-covered photo named the wrong card with a confident score; the clean one is better.
    const thumb = recognised('a', 0, 'match', [{ ...ring, score: 0.56 }], unit());
    const clean = recognised('b', 1.5, 'match', [{ ...bolt, score: 0.66 }], unit(0.98));
    expect(sameSlipOf([clean, thumb], clean)?.id).toBe('a');
    const out = skipSameSlip(thumb, clean);
    expect(out.kept).toBe('next');
    expect(out.previous.status).toBe('skipped');
    expect(out.previous.chosen).toBe(null);
    expect(out.previous.reason).toBe(REPLACED);
    expect(isSameSlip(out.previous)).toBe(true);
    expect(out.next.status).toBe('match');
    expect(out.next.chosen?.scryfall_id).toBe('lea-161');
    expect(out.next.reason).toBeUndefined();
    expect(shotCounts([out.next, out.previous])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1, repeats: 0 });
    expect(shotsToRows([out.next, out.previous])).toEqual([expect.objectContaining({ name: 'Lightning Bolt', quantity: 1 })]);
  });

  it('prefers a match over a review, then the higher top-1 score', () => {
    const review = recognised('a', 0, 'review', [{ ...bolt, score: 0.7 }], unit());
    const match = recognised('b', 1, 'match', [{ ...bolt, score: 0.5 }], unit());
    expect(betterShot(review, match).id).toBe('b');
    expect(betterShot(match, review).id).toBe('b');
    const low = recognised('c', 0, 'match', [{ ...bolt, score: 0.6 }], unit());
    const high = recognised('d', 1, 'match', [{ ...bolt, score: 0.61 }], unit());
    expect(betterShot(low, high).id).toBe('d');
    // A tie keeps the first.
    expect(betterShot(low, { ...high, candidates: [{ ...bolt, score: 0.6 }] }).id).toBe('c');
    expect(betterShot(shot('e', at(0)), recognised('f', 1, 'none', [], unit())).id).toBe('f');
  });

  it('keeps the clean first photo over a nudged second one', () => {
    const clean = recognised('a', 0, 'match', [{ ...bolt, score: 0.7 }], unit());
    const nudged = recognised('b', 1, 'match', [{ ...bolt, score: 0.6 }], unit(0.95));
    expect(sameSlipOf([nudged, clean], nudged)?.id).toBe('a');
    const out = skipSameSlip(clean, nudged);
    expect(out.kept).toBe('previous');
    expect(out.previous).toBe(clean);
    expect(out.next.status).toBe('skipped');
    expect(out.next.reason).toBe(SAME_SLIP);
    expect(out.recordOrientation).toBe(false);
    expect(shotCounts([out.next, out.previous])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1, repeats: 0 });
  });

  it('carries the confirmed Printing of the first photo over to a better second one', () => {
    const first = confirmShot(recognised('a', 0, 'review', [{ ...bolt, score: 0.42 }], unit()), refOf(bolt));
    const other = cand('Lightning Bolt', '2ed', '162', 0.7);
    const second = recognised('b', 1, 'match', [other], unit(0.98));
    const out = skipSameSlip(first, second);
    expect(out.kept).toBe('next');
    expect(out.next.status).toBe('confirmed');
    expect(out.next.chosen?.scryfall_id).toBe('lea-161');
    expect(out.previous.reason).toBe(REPLACED);
    expect(out.previous.chosen).toBe(null);
    expect(shotCounts([out.next, out.previous])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1, repeats: 0 });
    expect(shotsToRows([out.next, out.previous]).map((r) => [r.scryfall_id, r.quantity])).toEqual([['lea-161', 1]]);
  });

  it('lets the orientation lock see a slip once', () => {
    const review = recognised('a', 0, 'review', [{ ...bolt, score: 0.4 }], unit());
    const match = recognised('b', 1, 'match', [{ ...bolt, score: 0.7 }], unit());
    expect(skipSameSlip(review, match).recordOrientation).toBe(true);
    const weaker = recognised('c', 0, 'match', [{ ...bolt, score: 0.6 }], unit());
    expect(skipSameSlip(weaker, match).kept).toBe('next');
    expect(skipSameSlip(weaker, match).recordOrientation).toBe(false);
  });

  it('keeps a photo the Owner skipped as the one that counts', () => {
    const skipped = skipShot(recognised('a', 0, 'review', [{ ...bolt, score: 0.4 }], unit()));
    const out = skipSameSlip(skipped, recognised('b', 1, 'match', [{ ...bolt, score: 0.7 }], unit()));
    expect(out.kept).toBe('previous');
    expect(out.next.reason).toBe(SAME_SLIP);
  });

  it('restores either photo of the slip as a second copy', () => {
    const thumb = recognised('a', 0, 'review', [{ ...bolt, score: 0.44 }], unit());
    const clean = recognised('b', 1, 'match', [{ ...bolt, score: 0.66 }], unit());
    const replaced = skipSameSlip(thumb, clean);
    const first = keepSecondCopy(replaced.previous);
    expect(first.status).toBe('review');
    expect(first.reason).toBeUndefined();
    expect(shotCounts([replaced.next, first])).toEqual({ captured: 2, matched: 1, toReview: 1, skipped: 0, repeats: 0 });

    const lost = skipSameSlip(clean, recognised('c', 2, 'match', [{ ...bolt, score: 0.6 }], unit()));
    const second = keepSecondCopy(lost.next);
    expect(second.status).toBe('match');
    expect(shotCounts([second, lost.previous])).toEqual({ captured: 2, matched: 2, toReview: 0, skipped: 0, repeats: 0 });
  });

  it('compares a third photo with the one that counts, past a skipped one', () => {
    const a = recognised('a', 0, 'match', [{ ...bolt, score: 0.7 }], unit());
    const b = skipSameSlip(a, recognised('b', 1, 'match', [{ ...bolt, score: 0.6 }], unit())).next;
    const c = recognised('c', 2, 'match', [{ ...bolt, score: 0.8 }], unit());
    expect(sameSlipOf([c, b, a], c)?.id).toBe('a');
    const out = skipSameSlip(a, c);
    expect(out.kept).toBe('next');
    expect(shotCounts([out.next, b, out.previous])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 2, repeats: 0 });
    // A different slip is not compared at all.
    const d = recognised('d', 3, 'match', [ring], unit(0.5));
    expect(sameSlipOf([d, c, b, a], d)).toBe(null);
  });

  it('finds the camera shot captured just before', () => {
    const a = shot('a', at(0));
    const b = shot('b', at(1));
    const photo = { ...shot('p', at(2)), source: 'photo' as const };
    const c = shot('c', at(3));
    expect(previousShot([c, photo, b, a], c)?.id).toBe('b');
    expect(previousShot([c, photo, b, a], a)).toBe(null);
  });

  it('keeps the embedding and the reason in the store', () => {
    const s = skipSameSlip(recognised('p', 0, 'match', [bolt], unit()), recognised('a', 1, 'match', [bolt], unit())).next;
    const back = reviveShot(structuredClone(s));
    expect(back?.reason).toBe(SAME_SLIP);
    expect(back?.embedding).toBeInstanceOf(Float32Array);
    expect(reviveShot({ ...s, embedding: [1, 2] })?.embedding).toBe(null);
  });
});

describe('guide box', () => {
  const vw = 1080;
  const vh = 1920;

  it('keeps the 63:88 proportion in video pixels, and 88:63 when turned', () => {
    const g = { ...DEFAULT_GUIDE, h: 0.4 };
    const r = guideRect(g, vw, vh);
    expect(r.width / r.height).toBeCloseTo(63 / 88, 6);
    expect(r.x + r.width / 2).toBeCloseTo(vw / 2, 6);
    const t = guideRect(turnGuide(g, vw, vh), vw, vh);
    expect(t.width / t.height).toBeCloseTo(88 / 63, 6);
    expect(t.height).toBeCloseTo(r.width, 6);
  });

  it('stays inside the frame when moved or grown', () => {
    const far = moveGuide(DEFAULT_GUIDE, 5000, -5000, vw, vh);
    const r = guideRect(far, vw, vh);
    expect(r.x + r.width).toBeCloseTo(vw, 6);
    expect(r.y).toBeCloseTo(0, 6);
    const huge = clampGuide({ cx: 0.5, cy: 0.5, h: 1, landscape: false }, vw, vh);
    const hr = guideRect(huge, vw, vh);
    expect(hr.width).toBeLessThanOrEqual(vw + 1e-6);
    expect(hr.height).toBeLessThanOrEqual(vh + 1e-6);
  });

  it('resizes from a corner with the opposite corner fixed', () => {
    const before = guideRect(DEFAULT_GUIDE, vw, vh);
    const g = resizeGuide(DEFAULT_GUIDE, 'se', -100, -200, vw, vh);
    const after = guideRect(g, vw, vh);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.height).toBeCloseTo(before.height - 100 / (63 / 88), 3);
    expect(after.width / after.height).toBeCloseTo(63 / 88, 6);
    const nw = guideRect(resizeGuide(DEFAULT_GUIDE, 'nw', 50, 0, vw, vh), vw, vh);
    expect(nw.x + nw.width).toBeCloseTo(before.x + before.width, 6);
    expect(nw.y + nw.height).toBeCloseTo(before.y + before.height, 6);
    const tiny = guideRect(resizeGuide(DEFAULT_GUIDE, 'se', -5000, -5000, vw, vh), vw, vh);
    expect(tiny.height).toBeCloseTo(vh * MIN_H, 6);
  });

  it('reads a stored guide defensively', () => {
    expect(parseGuide(undefined)).toEqual(DEFAULT_GUIDE);
    expect(parseGuide({ cx: 0.3, cy: 'x', h: 2, landscape: true })).toEqual({ cx: 0.3, cy: 0.5, h: 0.6, landscape: true });
  });
});

describe('camera settings', () => {
  it('falls back to defaults on missing or broken storage', () => {
    const d = parseSettings(null);
    expect(d.baseline).toBe(null);
    expect(d.flipped).toBe(false);
    expect(parseSettings('{not json')).toEqual(d);
  });

  it('keeps a valid setup and drops a broken baseline', () => {
    const s = parseSettings(
      JSON.stringify({ flipped: true, beep: true, baseline: { spread: 3, mean: 220, sheet: [230, 231, 229] }, orientation: { recent: [], locked: 'rotated' }, passMs: 250 }),
    );
    expect(s.flipped).toBe(true);
    expect(s.baseline?.sheet).toEqual([230, 231, 229]);
    expect(s.orientation.locked).toBe('rotated');
    expect(s.passMs).toBe(250);
    expect(parseSettings(JSON.stringify({ baseline: { spread: 3, mean: 220, sheet: [1, 2] } })).baseline).toBe(null);
  });

  it('follows the pass time with a running mean', () => {
    expect(nextPassMs(null, 300)).toBe(300);
    expect(nextPassMs(300, 200)).toBeCloseTo(270, 6);
  });

  it('reads the camera session record', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(parseCameraSession(null, now)).toEqual({ startedAt: now.toISOString(), exported: null });
    const m = parseCameraSession(JSON.stringify({ startedAt: 'a', exported: { at: 'b', label: 'Camera', cards: 3 } }), now);
    expect(m.exported).toEqual({ at: 'b', label: 'Camera', cards: 3 });
  });

  it('keeps the speak choice and falls back to off', () => {
    expect(parseSettings(null).speak).toBe('off');
    for (const speak of ['off', 'count', 'names'] as const) {
      expect(parseSettings(JSON.stringify({ ...defaultSettings(), speak })).speak).toBe(speak);
    }
    expect(parseSettings(JSON.stringify({ speak: 'loud' })).speak).toBe('off');
    expect(parseSettings(JSON.stringify({ speak: 1 })).speak).toBe('off');
    expect(parseSettings(JSON.stringify({ flipped: true })).speak).toBe('off');
  });

  it('marks a count checkpoint when the count crosses a multiple, once on the way up', () => {
    expect(COUNT_EVERY).toBe(25);
    expect(crossedCheckpoint(24, 25)).toBe(true);
    expect(crossedCheckpoint(49, 50)).toBe(true);
    expect(crossedCheckpoint(23, 24)).toBe(false);
    expect(crossedCheckpoint(25, 26)).toBe(false);
    // A photo added in between landed on the multiple: the next slip still marks it.
    expect(crossedCheckpoint(24, 26)).toBe(true);
    // A count that fell marks nothing; nor does a count that stayed, or no checkpoints at all.
    expect(crossedCheckpoint(26, 25)).toBe(false);
    expect(crossedCheckpoint(25, 25)).toBe(false);
    expect(crossedCheckpoint(0, 0)).toBe(false);
    expect(crossedCheckpoint(9, 10, 10)).toBe(true);
    expect(crossedCheckpoint(9, 10, 0)).toBe(false);
    // Counted up one slip at a time, a run of 60 slips passes a checkpoint exactly twice.
    const hits = Array.from({ length: 60 }, (_, i) => i + 1).filter((n) => crossedCheckpoint(n - 1, n));
    expect(hits).toEqual([25, 50]);
  });
});
