import { describe, expect, it } from 'vitest';
import { decodeFloat16, encodeFloat16, floatToHalf, halfToFloat } from './float16';
import {
  cropImage,
  l2Normalize,
  MILO_MEAN,
  MILO_SIZE,
  MILO_STD,
  luminanceSpread,
  preprocess,
  refineCardBox,
  resizeBilinear,
  rotate180,
  toPortrait,
  type RgbaImage,
} from './preprocess';
import { ArtCatalog, parseCatalogJson, topK, type CatalogJson } from './catalog';
import { decide, groupByCard, printingVerdict, votes, type DecideOptions } from './match';
import type { Hit } from './types';

function solid(width: number, height: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...rgb, 255], i * 4);
  return { data, width, height };
}

/** An image whose pixel (x, y) has red = x and green = y. */
function ramp(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x, y, 0, 255], (y * width + x) * 4);
  return { data, width, height };
}

const px = (img: RgbaImage, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));

describe('float16', () => {
  it('decodes known bit patterns', () => {
    expect(halfToFloat(0x0000)).toBe(0);
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3555)).toBeCloseTo(0.33325, 5);
    expect(halfToFloat(0x7bff)).toBe(65504);
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0xfc00)).toBe(-Infinity);
    expect(halfToFloat(0x7e00)).toBeNaN();
  });

  it('decodes little-endian bytes into a Float32Array', () => {
    // 1.0 = 0x3c00, -0.5 = 0xb800, 0.0999755859375 = 0x2e66
    const bytes = new Uint8Array([0x00, 0x3c, 0x00, 0xb8, 0x66, 0x2e]);
    const out = decodeFloat16(bytes.buffer);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1, -0.5, Math.fround(0.0999755859375)]);
    expect(Array.from(decodeFloat16(bytes, 2, 2))).toEqual([-0.5]);
    expect(() => decodeFloat16(new Uint8Array(3))).toThrow();
  });

  it('round-trips every finite float16 value', () => {
    for (let h = 0; h < 0x7c00; h++) {
      expect(floatToHalf(halfToFloat(h))).toBe(h);
      expect(floatToHalf(halfToFloat(h | 0x8000))).toBe(h | 0x8000);
    }
  });

  it('rounds to the nearest float16 and encodes little-endian', () => {
    expect(floatToHalf(0.1)).toBe(0x2e66);
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00); // halfway, ties to even
    expect(floatToHalf(1e6)).toBe(0x7c00);
    expect(Array.from(encodeFloat16([1, -0.5]))).toEqual([0x00, 0x3c, 0x00, 0xb8]);
  });
});

describe('preprocess', () => {
  it('maps a uniform grey crop to the normalised grey value in every plane', () => {
    const out = preprocess(solid(63, 88, [128, 128, 128]));
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(1 * 3 * MILO_SIZE * MILO_SIZE);
    const plane = MILO_SIZE * MILO_SIZE;
    for (let c = 0; c < 3; c++) {
      const expected = (128 / 255 - MILO_MEAN[c]) / MILO_STD[c];
      expect(out[c * plane]).toBeCloseTo(expected, 5);
      expect(out[c * plane + plane - 1]).toBeCloseTo(expected, 5);
      expect(out[c * plane + 12345]).toBeCloseTo(expected, 5);
    }
  });

  it('writes planar R, G, B (NCHW)', () => {
    const out = preprocess(solid(100, 140, [255, 0, 0]));
    const plane = MILO_SIZE * MILO_SIZE;
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(out[plane]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(out[2 * plane]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });

  it('rotates a landscape crop counter-clockwise to portrait', () => {
    const img = ramp(4, 2); // pixel (x, y) = [x, y, 0]
    const p = toPortrait(img);
    expect([p.width, p.height]).toEqual([2, 4]);
    // The old top-right pixel (3, 0) becomes the new top-left.
    expect(px(p, 0, 0)).toEqual([3, 0, 0]);
    expect(px(p, 1, 0)).toEqual([3, 1, 0]);
    expect(px(p, 0, 3)).toEqual([0, 0, 0]);
    expect(toPortrait(ramp(2, 4))).toEqual(ramp(2, 4));
  });

  it('rotates 180 degrees', () => {
    const r = rotate180(ramp(3, 2));
    expect(px(r, 0, 0)).toEqual([2, 1, 0]);
    expect(px(r, 2, 1)).toEqual([0, 0, 0]);
  });

  it('squashes to a square without cropping', () => {
    // Left half black, right half white: the edge stays in the middle after the squash.
    const img = solid(60, 90, [0, 0, 0]);
    for (let y = 0; y < 90; y++) for (let x = 30; x < 60; x++) img.data.set([255, 255, 255], (y * 60 + x) * 4);
    const out = resizeBilinear(img, 448, 448);
    expect([out.width, out.height]).toEqual([448, 448]);
    expect(px(out, 0, 0)).toEqual([0, 0, 0]);
    expect(px(out, 447, 447)).toEqual([255, 255, 255]);
    expect(px(out, 200, 100)[0]).toBe(0);
    expect(px(out, 250, 100)[0]).toBe(255);
  });

  it('averages when downscaling, like Pillow', () => {
    // 2:1 downscale of a two-pixel pattern averages the pair.
    const img: RgbaImage = { data: new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]), width: 2, height: 1 };
    expect(px(resizeBilinear(img, 1, 1), 0, 0)).toEqual([100, 100, 100]);
    // Identity size leaves pixels unchanged.
    const r = ramp(5, 7);
    expect(Array.from(resizeBilinear(r, 5, 7).data)).toEqual(Array.from(r.data));
  });

  it('crops a rectangle, clipped to the image', () => {
    const c = cropImage(ramp(10, 10), { x: 8, y: 2, width: 5, height: 3 });
    expect([c.width, c.height]).toEqual([2, 3]);
    expect(px(c, 0, 0)).toEqual([8, 2, 0]);
  });

  it('finds a dark slip on a white sheet', () => {
    const img = solid(100, 120, [250, 250, 250]);
    for (let y = 10; y < 110; y++) for (let x = 20; x < 85; x++) img.data.set([30, 40, 50], (y * 100 + x) * 4);
    expect(refineCardBox(img)).toEqual({ x: 20, y: 10, width: 65, height: 100 });
  });

  it('returns the whole crop when the slip fills it (the ring is the card border, not sheet)', () => {
    // Black border all round, light art inside: the ring median is the border colour.
    const img = solid(100, 140, [15, 15, 18]);
    for (let y = 12; y < 128; y++) for (let x = 10; x < 90; x++) img.data.set([200, 180, 150], (y * 100 + x) * 4);
    expect(refineCardBox(img)).toEqual({ x: 0, y: 0, width: 100, height: 140 });
    // A busy ring (art reaching the edge) is not sheet either, even where it is light.
    const busy = solid(60, 80, [230, 230, 230]);
    for (let i = 0; i < 60 * 80; i += 2) busy.data.set([40, 90, 160], i * 4);
    expect(refineCardBox(busy)).toEqual({ x: 0, y: 0, width: 60, height: 80 });
  });

  it('checks the ring against the empty guide box colour when given', () => {
    const img = solid(100, 120, [250, 250, 250]);
    for (let y = 10; y < 110; y++) for (let x = 20; x < 85; x++) img.data.set([30, 40, 50], (y * 100 + x) * 4);
    expect(refineCardBox(img, { sheet: [245, 245, 240] })).toEqual({ x: 20, y: 10, width: 65, height: 100 });
    expect(refineCardBox(img, { sheet: [170, 160, 150] })).toEqual({ x: 0, y: 0, width: 100, height: 120 });
  });

  it('returns the whole crop when nothing stands out from the sheet', () => {
    expect(refineCardBox(solid(50, 70, [240, 240, 240]))).toEqual({ x: 0, y: 0, width: 50, height: 70 });
  });

  it('measures luminance spread', () => {
    expect(luminanceSpread(solid(10, 10, [200, 200, 200]))).toBeCloseTo(0, 6);
    const half = solid(10, 10, [0, 0, 0]);
    for (let i = 0; i < 50; i++) half.data.set([255, 255, 255], i * 4);
    expect(luminanceSpread(half)).toBeCloseTo(127.5, 3);
  });

  it('L2-normalises', () => {
    expect(Array.from(l2Normalize([3, 4]))).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect(Array.from(l2Normalize([0, 0]))).toEqual([0, 0]);
  });
});

// ---- catalog and matcher, with synthetic data ----

let rowCounter = 0;
function hit(oracle: string, id: string, score: number, illustration: string | null = `art-${id}`, face: 'front' | 'back' = 'front'): Hit {
  return {
    row: rowCounter++,
    scryfall_id: id,
    oracle_id: oracle,
    name: `Card ${oracle}`,
    set: 'set',
    collector_number: '1',
    illustration_id: illustration,
    digital: false,
    face,
    source: 'hosted',
    on_list: true,
    score,
  };
}

const opts: Partial<DecideOptions> = { accept: 0.6, margin: 0.1, printingMargin: 0.05, floor: 0.3 };

describe('catalog', () => {
  const json: CatalogJson = {
    format: 1,
    dims: 128,
    dtype: 'float16',
    card_columns: ['oracle_id', 'name', 'on_list'],
    cards: [
      ['o1', 'Alpha', 1],
      ['o2', 'Beta', 0],
    ],
    columns: [],
    rows: [
      ['p1', 0, 'lea', '1', 'i1', 0, 0, 0],
      ['p2', 1, 'vma', '2', null, 1, 1, 1],
      ['p3', 0, 'leb', '3', 'i1', 0, 0, 0],
    ],
  };
  const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));

  it('expands compact rows', () => {
    const [a, b] = parseCatalogJson(json);
    expect(a).toMatchObject({ row: 0, scryfall_id: 'p1', oracle_id: 'o1', name: 'Alpha', face: 'front', digital: false, source: 'hosted', on_list: true });
    expect(b).toMatchObject({ row: 1, oracle_id: 'o2', illustration_id: null, face: 'back', digital: true, source: 'self', on_list: false });
  });

  it('searches by cosine and ranks best first', () => {
    const v = [unit(0), unit(1), unit(0).map((x, j) => (j === 1 ? 0.6 : x * 0.8))];
    const bin = encodeFloat16(v.flat());
    const cat = ArtCatalog.fromData(json, bin);
    expect(cat.size).toBe(3);
    const hits = cat.search(unit(0), 2);
    expect(hits.map((h) => h.scryfall_id)).toEqual(['p1', 'p3']);
    expect(hits[0].score).toBeCloseTo(1, 3);
    expect(hits[1].score).toBeCloseTo(0.8, 3);
    expect(() => cat.search([1, 2], 1)).toThrow();
  });

  it('topK keeps row order on ties', () => {
    expect(topK([0.1, 0.5, 0.5, 0.9], 3)).toEqual([3, 1, 2]);
  });
});

describe('decide', () => {
  it('accepts a confident name with a clear margin', () => {
    const d = decide([hit('a', 'a1', 0.82), hit('a', 'a2', 0.8), hit('b', 'b1', 0.6)], opts);
    expect(d.status).toBe('match');
    expect(d.card?.oracle_id).toBe('a');
    expect(d.printing?.scryfall_id).toBe('a1');
    expect(d.margin).toBeCloseTo(0.22, 6);
    expect(d.verdict).toBe('no expected printing');
  });

  it('sends a low top score to review and a very low one to none', () => {
    expect(decide([hit('a', 'a1', 0.55), hit('b', 'b1', 0.2)], opts).status).toBe('review');
    expect(decide([hit('a', 'a1', 0.25), hit('b', 'b1', 0.1)], opts).status).toBe('none');
    expect(decide([], opts).status).toBe('none');
  });

  it('sends a close second card to review, whatever the top score', () => {
    const d = decide([hit('a', 'a1', 0.9), hit('b', 'b1', 0.85), hit('c', 'c1', 0.5)], opts);
    expect(d.status).toBe('review');
    expect(d.card).toBeNull();
    expect(d.candidates.map((c) => c.oracle_id)).toEqual(['a', 'b', 'c']);
  });

  it('applies the thresholds inclusively', () => {
    const d = decide([hit('a', 'a1', 0.75), hit('b', 'b1', 0.625)], { ...opts, accept: 0.75, margin: 0.125 });
    expect(d.status).toBe('match');
  });

  it('uses the lowest hit as the runner-up bound when no other card is in the hits', () => {
    const d = decide([hit('a', 'a1', 0.9), hit('a', 'a2', 0.85)], opts);
    expect(d.margin).toBeCloseTo(0.05, 6);
    expect(d.status).toBe('review');
  });

  it('does not count other printings of the same card against the margin', () => {
    const d = decide([hit('a', 'a1', 0.9), hit('a', 'a2', 0.89), hit('a', 'a3', 0.88), hit('b', 'b1', 0.7)], opts);
    expect(d.status).toBe('match');
    expect(d.margin).toBeCloseTo(0.2, 6);
  });

  it('returns at most three distinct candidates with their best printing', () => {
    const d = decide([hit('a', 'a1', 0.5), hit('a', 'a2', 0.49), hit('b', 'b1', 0.48), hit('c', 'c1', 0.4), hit('d', 'd1', 0.35)], opts);
    expect(d.candidates.map((c) => [c.oracle_id, c.printing.scryfall_id])).toEqual([['a', 'a1'], ['b', 'b1'], ['c', 'c1']]);
  });

  it('sorts unsorted hits first', () => {
    const d = decide([hit('b', 'b1', 0.5), hit('a', 'a1', 0.9)], opts);
    expect(d.card?.oracle_id).toBe('a');
  });
});

describe('printing verdict', () => {
  const expected = (id: string, art: string | null) => () => ({ scryfall_id: id, illustration_id: art });

  it('is exact when the expected printing wins', () => {
    const d = decide([hit('a', 'a1', 0.9), hit('a', 'a2', 0.88), hit('b', 'b1', 0.5)], { ...opts, expected: expected('a1', 'art-a1') });
    expect(d.verdict).toBe('exact');
  });

  it('is exact when the back face of the expected printing wins', () => {
    const d = decide([hit('a', 'a1', 0.9, 'back-art', 'back'), hit('b', 'b1', 0.5)], { ...opts, expected: expected('a1', 'front-art') });
    expect(d.verdict).toBe('exact');
  });

  it('is same art when a reprint with the expected illustration wins', () => {
    const d = decide([hit('a', 'a2', 0.9, 'shared'), hit('a', 'a1', 0.89, 'shared'), hit('b', 'b1', 0.5)], {
      ...opts,
      expected: expected('a1', 'shared'),
    });
    expect(d.verdict).toBe('same art');
    expect(d.printing?.scryfall_id).toBe('a2');
  });

  it('matches the expected back illustration too', () => {
    const v = printingVerdict([hit('a', 'a9', 0.9, 'back-shared', 'back')], { scryfall_id: 'a1', illustration_id: 'front', back_illustration_id: 'back-shared' }, 0.05, 0.1);
    expect(v).toBe('same art');
  });

  it('is other art when another illustration wins by the printing margin', () => {
    const d = decide([hit('a', 'a2', 0.9, 'new'), hit('a', 'a1', 0.8, 'old'), hit('b', 'b1', 0.5)], { ...opts, expected: expected('a1', 'old') });
    expect(d.verdict).toBe('other art');
  });

  it('is ambiguous when another illustration wins by less than the printing margin', () => {
    const d = decide([hit('a', 'a2', 0.9, 'new'), hit('a', 'a1', 0.87, 'old'), hit('b', 'b1', 0.5)], { ...opts, expected: expected('a1', 'old') });
    expect(d.verdict).toBe('ambiguous');
  });

  it('bounds a missing expected printing by the lowest hit', () => {
    expect(printingVerdict([hit('a', 'a2', 0.9, 'new')], { scryfall_id: 'a1', illustration_id: 'old' }, 0.05, 0.7)).toBe('other art');
    expect(printingVerdict([hit('a', 'a2', 0.9, 'new')], { scryfall_id: 'a1', illustration_id: 'old' }, 0.05, 0.88)).toBe('ambiguous');
  });

  it('does not treat two missing illustrations as the same art', () => {
    const v = printingVerdict([hit('a', 'a2', 0.9, null), hit('a', 'a1', 0.8, null)], { scryfall_id: 'a1', illustration_id: null }, 0.05, 0.1);
    expect(v).toBe('other art');
  });
});

describe('votes', () => {
  it('sums scores per printing across frames and ranks by the mean', () => {
    const f1 = [hit('a', 'a1', 0.7), hit('b', 'b1', 0.68)];
    const f2 = [hit('b', 'b1', 0.6), hit('a', 'a1', 0.75)];
    const v = votes([f1, f2]);
    expect(v[0].scryfall_id).toBe('a1');
    expect(v[0].total).toBeCloseTo(1.45, 6);
    expect(v[0].score).toBeCloseTo(0.725, 6);
    expect(v[0].frames).toBe(2);
    expect(v[1].total).toBeCloseTo(1.28, 6);
  });

  it('counts a printing missing from a frame as zero there', () => {
    const v = votes([[hit('a', 'a1', 0.8)], [hit('b', 'b1', 0.7)]]);
    expect(v.map((h) => [h.scryfall_id, h.score])).toEqual([
      ['a1', 0.4],
      ['b1', 0.35],
    ]);
  });

  it('keeps front and back faces apart and feeds decide', () => {
    const v = votes([[hit('a', 'a1', 0.8), hit('a', 'a1', 0.6, 'x', 'back'), hit('b', 'b1', 0.5)]]);
    expect(v).toHaveLength(3);
    expect(decide(v, opts).status).toBe('match');
    expect(groupByCard(v).map((c) => c.oracle_id)).toEqual(['a', 'b']);
  });
});
