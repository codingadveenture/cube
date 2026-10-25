// preprocess.ts: from a guide-box crop to the Milo input tensor.
//
// Follows research/collectorvision-integration.md, "Exact preprocessing", which reads
// collector_vision/embedders/neural.py (lines 19-20, 23-27, 30-49) and
// examples/web_scanner/scanner.worker.mjs (lines 26-31, 508-522, 884-917) at commit 8b295ab of
// https://github.com/HanClinto/CollectorVision (AGPL-3.0-or-later):
//   1. a landscape crop is rotated 90 degrees counter-clockwise to portrait (PIL ROTATE_90);
//   2. it is squashed to 448x448 with no crop or padding, so the 63:88 card becomes 1:1;
//   3. RGB order, divided by 255;
//   4. ImageNet mean subtracted and divided by the ImageNet std, per channel;
//   5. written planar (R plane, G plane, B plane) into a Float32Array of 1x3x448x448 (NCHW).
// The model output is L2-normalised afterwards (l2Normalize).
//
// Step 2 uses our own resampler instead of canvas drawImage: it reproduces Pillow's
// Image.resize(..., BILINEAR), a triangle filter whose support widens with the downscale
// factor (so it antialiases) and which rounds to 8 bits after each pass. The hosted catalog was
// embedded with Pillow, and a browser's drawImage uses a different, unspecified filter (open
// question in the research file, section 7). Doing it in code also lets node scripts run the
// exact same steps. This module has no imports so node can load it directly.

export const MILO_SIZE = 448;
export const MILO_MEAN = [0.485, 0.456, 0.406] as const;
export const MILO_STD = [0.229, 0.224, 0.225] as const;

/** RGBA pixels, 4 bytes per pixel, row-major: the shape of ImageData. Alpha is ignored. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Copies a rectangle out of an image; the rectangle is clipped to the image. */
export function cropImage(img: RgbaImage, rect: Rect): RgbaImage {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.round(rect.y + rect.height));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { data, width, height };
}

export interface RefineOptions {
  /** A pixel belongs to the slip when a channel differs from the sheet by more than this. */
  threshold?: number;
  /** A row or column belongs to the slip when at least this fraction of it does. */
  minFraction?: number;
  /**
   * The sheet colour, taken from the empty guide box. When given, the crop's outer ring must
   * match it (every channel within `threshold`), or the whole crop is returned.
   */
  sheet?: readonly [number, number, number];
  /** The ring counts as sheet only when its median luminance is at least this (0-255). */
  minSheetLuminance?: number;
  /** The ring counts as sheet only when at least this fraction of it is within `threshold` of its median. */
  minRingFraction?: number;
}

/**
 * Finds the slip inside a guide-box crop on a light sheet: the bounding box of the rows and
 * columns that differ from the sheet colour, taken as the median colour of the crop's outer
 * ring. Milo was trained on crops that end at the card edge, and the offline eval
 * (research/art-catalog-eval.md) found that a margin of 2 percent of sheet around the card, or
 * cutting 2 percent off it, lowers the score of the right card from about 0.99 to about 0.74.
 *
 * The ring is trusted as sheet only when it is light, nearly uniform and, if `sheet` is given,
 * the colour of the empty guide box. Otherwise the slip fills the crop (the ring is the card's
 * own border) and the whole crop is returned, because cutting the border off costs as much as a
 * margin. Returns the whole crop too when nothing stands out. A white-bordered slip on a white
 * sheet cannot be told from the sheet by colour, so its border is cut off; the eval measures it.
 */
export function refineCardBox(img: RgbaImage, options: RefineOptions = {}): Rect {
  const threshold = options.threshold ?? 40;
  const minFraction = options.minFraction ?? 0.3;
  const minSheetLuminance = options.minSheetLuminance ?? 150;
  const minRingFraction = options.minRingFraction ?? 0.75;
  const { width: w, height: h, data } = img;
  const whole = { x: 0, y: 0, width: w, height: h };
  if (w < 3 || h < 3) return whole;
  const ring: number[][] = [[], [], []];
  const addRing = (x: number, y: number) => {
    const p = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) ring[c].push(data[p + c]);
  };
  for (let x = 0; x < w; x++) {
    addRing(x, 0);
    addRing(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    addRing(0, y);
    addRing(w - 1, y);
  }
  const median = ring.map((v) => [...v].sort((a, b) => a - b)[v.length >> 1]);
  // Is the ring really sheet? Light, nearly uniform, and the reference colour when there is one.
  if (0.299 * median[0] + 0.587 * median[1] + 0.114 * median[2] < minSheetLuminance) return whole;
  const n = ring[0].length;
  let near = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(ring[0][i] - median[0]), Math.abs(ring[1][i] - median[1]), Math.abs(ring[2][i] - median[2]));
    if (d <= threshold) near++;
  }
  if (near < minRingFraction * n) return whole;
  if (options.sheet && median.some((v, c) => Math.abs(v - options.sheet![c]) > threshold)) return whole;
  const sheet = median;
  const rows = new Float32Array(h);
  const cols = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = Math.max(Math.abs(data[p] - sheet[0]), Math.abs(data[p + 1] - sheet[1]), Math.abs(data[p + 2] - sheet[2]));
      if (d > threshold) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;
  while (top < h && rows[top] < minFraction * w) top++;
  while (bottom > top && rows[bottom] < minFraction * w) bottom--;
  while (left < w && cols[left] < minFraction * h) left++;
  while (right > left && cols[right] < minFraction * h) right--;
  if (top >= bottom || left >= right) return whole;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Standard deviation of the luminance (0-255): near 0 for an empty sheet, high for a card. */
export function luminanceSpread(img: RgbaImage): number {
  const n = img.width * img.height;
  if (!n) return 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const l = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
    sum += l;
    sq += l * l;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** Rotates 90 degrees counter-clockwise when the image is landscape (PIL ROTATE_90). */
export function toPortrait(img: RgbaImage): RgbaImage {
  if (img.width <= img.height) return img;
  const { width: w, height: h } = img;
  // The new image is h wide and w tall; new (x', y') comes from old (w - 1 - y', x').
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) {
      const src = (x * w + (w - 1 - y)) * 4;
      const dst = (y * h + x) * 4;
      data[dst] = img.data[src];
      data[dst + 1] = img.data[src + 1];
      data[dst + 2] = img.data[src + 2];
      data[dst + 3] = img.data[src + 3];
    }
  }
  return { data, width: h, height: w };
}

/** Rotates 180 degrees (the pass for a slip fed upside down). */
export function rotate180(img: RgbaImage): RgbaImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const src = i * 4;
    const dst = (n - 1 - i) * 4;
    data[dst] = img.data[src];
    data[dst + 1] = img.data[src + 1];
    data[dst + 2] = img.data[src + 2];
    data[dst + 3] = img.data[src + 3];
  }
  return { data, width: img.width, height: img.height };
}

interface Coeffs {
  start: Int32Array;
  count: Int32Array;
  weights: Float64Array;
  ksize: number;
}

// Pillow's precompute_coeffs (src/libImaging/Resample.c) for the bilinear (triangle) filter,
// whose support is 1 pixel, widened by the scale when downscaling.
function coefficients(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const weights = new Float64Array(outSize * ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0);
    const xmax = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin;
    let total = 0;
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) / filterScale);
      const w = t < 1 ? 1 - t : 0;
      weights[xx * ksize + x] = w;
      total += w;
    }
    if (total) for (let x = 0; x < xmax; x++) weights[xx * ksize + x] /= total;
    start[xx] = xmin;
    count[xx] = xmax;
  }
  return { start, count, weights, ksize };
}

const clamp8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/**
 * Resizes RGB with Pillow's BILINEAR filter: horizontal pass, then vertical pass, rounding to
 * 8 bits after each. The output alpha is 255.
 */
export function resizeBilinear(img: RgbaImage, outWidth: number, outHeight: number): RgbaImage {
  const { width: inW, height: inH } = img;
  if (!inW || !inH) throw new Error('cannot resize an empty image');
  // Horizontal pass: inH rows of outWidth pixels, RGB only.
  const h = coefficients(inW, outWidth);
  const mid = new Uint8ClampedArray(outWidth * inH * 3);
  for (let y = 0; y < inH; y++) {
    const row = y * inW * 4;
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const k = x * h.ksize;
      const s = h.start[x];
      for (let i = 0; i < h.count[x]; i++) {
        const w = h.weights[k + i];
        const p = row + (s + i) * 4;
        r += img.data[p] * w;
        g += img.data[p + 1] * w;
        b += img.data[p + 2] * w;
      }
      const o = (y * outWidth + x) * 3;
      mid[o] = clamp8(r);
      mid[o + 1] = clamp8(g);
      mid[o + 2] = clamp8(b);
    }
  }
  // Vertical pass.
  const v = coefficients(inH, outHeight);
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const k = y * v.ksize;
    const s = v.start[y];
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < v.count[y]; i++) {
        const w = v.weights[k + i];
        const p = ((s + i) * outWidth + x) * 3;
        r += mid[p] * w;
        g += mid[p + 1] * w;
        b += mid[p + 2] * w;
      }
      const o = (y * outWidth + x) * 4;
      data[o] = clamp8(r);
      data[o + 1] = clamp8(g);
      data[o + 2] = clamp8(b);
      data[o + 3] = 255;
    }
  }
  return { data, width: outWidth, height: outHeight };
}

/** Normalises an image into planar NCHW float32 (length 3 * width * height). */
export function toTensorData(img: RgbaImage): Float32Array {
  const plane = img.width * img.height;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    out[i] = (img.data[p] / 255 - MILO_MEAN[0]) / MILO_STD[0];
    out[plane + i] = (img.data[p + 1] / 255 - MILO_MEAN[1]) / MILO_STD[1];
    out[2 * plane + i] = (img.data[p + 2] / 255 - MILO_MEAN[2]) / MILO_STD[2];
  }
  return out;
}

export interface PreprocessOptions {
  /** Embed the crop upside down (the second pass, for a slip fed the other way round). */
  rotate180?: boolean;
}

/** The whole pipeline: crop in, Milo input data out (to be shaped [1, 3, 448, 448]). */
export function preprocess(img: RgbaImage, options: PreprocessOptions = {}): Float32Array {
  let square = resizeBilinear(toPortrait(img), MILO_SIZE, MILO_SIZE);
  if (options.rotate180) square = rotate180(square);
  return toTensorData(square);
}

/** Scales a vector to unit length (a zero vector is returned unchanged). */
export function l2Normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = norm ? v[i] / norm : 0;
  return out;
}
