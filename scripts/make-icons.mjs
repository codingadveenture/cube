// make-icons.mjs: draw public/icon-192.png and public/icon-512.png to match public/icon.svg.
// Pure Node (zlib for PNG compression), no native dependencies.
// Usage: node scripts/make-icons.mjs

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BG = [0xfb, 0xfa, 0xf7];
const WHITE = [0xff, 0xff, 0xff];
const BLACK = [0, 0, 0];

// Signed distance to a rounded rectangle (centre cx,cy, half sizes hw,hh, radius r).
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance to a segment with round caps.
function sdSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Colour of one point in the 512x512 design space (same shapes as icon.svg).
function shade(x, y) {
  const card = sdRoundRect(x, y, 256, 264, 120, 168, 20);
  if (card > 12) return BG;
  if (card > -12) return BLACK; // 24-wide outer stroke centred on the edge
  const art = sdRoundRect(x, y, 256, 196, 88, 64, 6);
  if (Math.abs(art) <= 6) return BLACK;
  if (sdSegment(x, y, 168, 300, 344, 300) <= 6) return BLACK;
  if (sdSegment(x, y, 168, 340, 304, 340) <= 6) return BLACK;
  return WHITE;
}

function render(size) {
  const ss = 4;
  const scale = 512 / size;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let py = 0; py < size; py++) {
    raw[o++] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) * scale, (py + (sy + 0.5) / ss) * scale);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = ss * ss;
      raw[o++] = Math.round(r / n);
      raw[o++] = Math.round(g / n);
      raw[o++] = Math.round(b / n);
    }
  }
  return png(size, size, raw);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = join(ROOT, 'public', `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
