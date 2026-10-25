// float16.ts: IEEE 754 half-precision conversion for the art catalog.
//
// The catalog file public/data/art-catalog.bin holds rows of 128 little-endian float16 values,
// the same layout as the CollectorVision hosted catalog (research/collectorvision-integration.md,
// "Binary layout"). This module has no imports so node scripts can load it directly
// (node strips the types).

/** Converts one float16 bit pattern to a number. */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * frac * 2 ** -24; // zero and subnormals
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

let table: Float32Array | null = null;

/** A 65,536-entry lookup table from float16 bits to float32, built once. */
export function halfTable(): Float32Array {
  if (!table) {
    table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) table[h] = halfToFloat(h);
  }
  return table;
}

/**
 * Decodes little-endian float16 bytes into a Float32Array. byteOffset and byteLength select a
 * slice of the buffer; byteLength must be even.
 */
export function decodeFloat16(
  buffer: ArrayBuffer | ArrayBufferView,
  byteOffset = 0,
  byteLength?: number,
): Float32Array {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const length = byteLength ?? bytes.length - byteOffset;
  if (length % 2) throw new Error(`float16 data has an odd byte length (${length})`);
  const lut = halfTable();
  const out = new Float32Array(length / 2);
  for (let i = 0, b = byteOffset; i < out.length; i++, b += 2) {
    out[i] = lut[bytes[b] | (bytes[b + 1] << 8)];
  }
  return out;
}

/** Converts a number to the nearest float16 bit pattern (round half to even). */
export function floatToHalf(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const a = Math.abs(value);
  if (a === Infinity) return sign | 0x7c00;
  if (a >= 65520) return sign | 0x7c00; // rounds to infinity
  if (a < 2 ** -25) return sign; // rounds to zero
  if (a < 2 ** -14) {
    // subnormal: units of 2^-24
    return sign | roundEven(a * 2 ** 24);
  }
  let exp = Math.floor(Math.log2(a));
  // guard against log2 rounding at powers of two
  if (2 ** exp > a) exp--;
  else if (2 ** (exp + 1) <= a) exp++;
  let frac = roundEven((a / 2 ** exp - 1) * 1024);
  if (frac === 1024) {
    frac = 0;
    exp++;
  }
  if (exp > 15) return sign | 0x7c00;
  return sign | ((exp + 15) << 10) | frac;
}

function roundEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 ? f + 1 : f;
}

/** Encodes numbers as little-endian float16 bytes. */
export function encodeFloat16(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    const h = floatToHalf(values[i]);
    out[2 * i] = h & 0xff;
    out[2 * i + 1] = h >> 8;
  }
  return out;
}
