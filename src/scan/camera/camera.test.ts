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
  newShot,
  nextToReview,
  reviveShot,
  shotCounts,
  shotsToRows,
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

  it('counts a slip lying still once, and the next only after the box has emptied', () => {
    const frames = [empty, slip(), slip(), slip(), slip(), slip(), slip(), slip(7), slip(7), slip(7), slip(7), empty, empty, slip(2), slip(2), slip(2)];
    const { captures } = run(frames);
    // The second slip pushed in without the box emptying is not counted; the third is.
    expect(captures).toEqual([3, 15]);
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

function result(status: 'match' | 'review' | 'none', candidates: ShotCandidate[]): RecogniseResult {
  return {
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
