import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_OPTIONS,
  greyStats,
  initialLoop,
  loopPhase,
  meanAbsDiff,
  medianRgb,
  presence,
  step,
  toGrey,
  type Baseline,
  type Grey,
  type LoopState,
} from './capture';
import { clampGuide, guideRect, moveGuide, parseGuide, resizeGuide, turnGuide, DEFAULT_GUIDE, MIN_H } from './guide';
import { initialOrientation, LOCK_AFTER, parseOrientation, passesFor, recordOrientation } from './orientation';
import { nextPassMs, parseCameraSession, parseSettings } from './settings';
import {
  applyRecognition,
  confirmShot,
  defaultPileLabel,
  filterShots,
  isSameSlip,
  keepSecondCopy,
  newShot,
  nextToReview,
  previousShot,
  reviveShot,
  SAME_SLIP,
  sameSlipAsBefore,
  shotCounts,
  shotsToRows,
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

const empty = sheet();
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
    expect(shotCounts([s])).toEqual({ captured: 1, matched: 0, toReview: 1, skipped: 0 });
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
    expect(shotCounts(shots)).toEqual({ captured: 7, matched: 4, toReview: 2, skipped: 1 });
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
    expect(defaultPileLabel(new Date(2026, 9, 5, 23, 59))).toBe('Camera 2026-10-05');
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
    const skipped = skipSameSlip(b);
    expect(skipped.status).toBe('skipped');
    expect(skipped.reason).toBe(SAME_SLIP);
    expect(isSameSlip(skipped)).toBe(true);
    expect(shotCounts([a, skipped])).toEqual({ captured: 1, matched: 1, toReview: 0, skipped: 1 });
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
    const skipped = skipSameSlip(recognised('b', 1, 'match', [bolt], unit()));
    const kept = keepSecondCopy(skipped);
    expect(kept.status).toBe('match');
    expect(kept.chosen?.scryfall_id).toBe('lea-161');
    expect(kept.reason).toBeUndefined();
    expect(shotCounts([a, kept])).toEqual({ captured: 2, matched: 2, toReview: 0, skipped: 0 });
    expect(shotsToRows([a, kept])[0]!.quantity).toBe(2);
    const doubtful = keepSecondCopy(skipSameSlip(recognised('c', 2, 'review', [bolt], unit())));
    expect(doubtful.status).toBe('review');
    expect(doubtful.chosen).toBe(null);
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
    const s = skipSameSlip(recognised('a', 0, 'match', [bolt], unit()));
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
});
