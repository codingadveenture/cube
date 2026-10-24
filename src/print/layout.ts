// Print sheet geometry, all in mm on A4 portrait. Pure: no React, no jsPDF, no storage.
// The PDF builder (pdf.ts) draws exactly what these functions return.
import type { PrintSettings } from './settings';

export const A4 = { w: 210, h: 297 } as const;
export const COLS = 3;
export const ROWS = 3;
export const PER_PAGE = COLS * ROWS;
export const CROP_LEN = 4;
export const CROP_WIDTH = 0.2;
/** Light grey for crop marks, as 0-255 RGB. */
export const CROP_GREY = 170;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type Geometry = Pick<PrintSettings, 'slipW' | 'slipH' | 'gap' | 'profile'>;

/** The drawn size of one slip: the target size times the printer profile's factors. */
export function slipSize(s: Geometry): { w: number; h: number } {
  return { w: s.slipW * s.profile.fx, h: s.slipH * s.profile.fy };
}

/** The size of the 3 x 3 block of slips with its gaps, in mm. */
export function blockSize(s: Geometry): { w: number; h: number } {
  const { w, h } = slipSize(s);
  return { w: COLS * w + (COLS - 1) * s.gap, h: ROWS * h + (ROWS - 1) * s.gap };
}

/** The smallest margin a printer can be trusted to print into, and room for the label and marks. */
export const MIN_MARGIN = 5;

/** The margin left on each side of the centred block (left and right, top and bottom), in mm. */
export function sheetMargins(s: Geometry): { x: number; y: number } {
  const b = blockSize(s);
  return { x: (A4.w - b.w) / 2, y: (A4.h - b.h) / 2 };
}

/** Whether the 3 x 3 block fits on A4 with at least MIN_MARGIN mm on every side. */
export function fits(s: Geometry): boolean {
  const m = sheetMargins(s);
  return m.x >= MIN_MARGIN - 1e-9 && m.y >= MIN_MARGIN - 1e-9;
}

/** The nine slip rectangles of a page, row by row, the 3 x 3 block centred on A4. */
export function slipRects(s: Geometry): Rect[] {
  const { w, h } = slipSize(s);
  const { w: blockW, h: blockH } = blockSize(s);
  const x0 = (A4.w - blockW) / 2;
  const y0 = (A4.h - blockH) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) out.push({ x: x0 + c * (w + s.gap), y: y0 + r * (h + s.gap), w, h });
  }
  return out;
}

const EPS = 1e-9;

/** Positive-length overlap of two closed intervals. */
function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a2, b2) - Math.max(a1, b1) > EPS;
}

/**
 * Cut a mark that starts at (x, y) and runs `len` mm in direction (dx, dy) (one of them 0) where
 * it would first enter a slip, counting the line's own width. Returns the end point.
 */
function clipMark(x: number, y: number, dx: number, dy: number, len: number, slips: Rect[]): Line {
  const half = CROP_WIDTH / 2;
  let reach = len;
  for (const r of slips) {
    if (dy === 0) {
      // Horizontal: the band y +- half must overlap the slip's rows.
      if (!overlaps(y - half, y + half, r.y, r.y + r.h)) continue;
      const entry = dx > 0 ? r.x - x : x - (r.x + r.w);
      const exit = dx > 0 ? r.x + r.w - x : x - r.x;
      if (exit > EPS && entry < reach) reach = Math.max(0, entry);
    } else {
      if (!overlaps(x - half, x + half, r.x, r.x + r.w)) continue;
      const entry = dy > 0 ? r.y - y : y - (r.y + r.h);
      const exit = dy > 0 ? r.y + r.h - y : y - r.y;
      if (exit > EPS && entry < reach) reach = Math.max(0, entry);
    }
  }
  // Keep the mark on the page.
  if (dx > 0) reach = Math.min(reach, A4.w - x);
  if (dx < 0) reach = Math.min(reach, x);
  if (dy > 0) reach = Math.min(reach, A4.h - y);
  if (dy < 0) reach = Math.min(reach, y);
  return { x1: x, y1: y, x2: x + dx * reach, y2: y + dy * reach };
}

const MIN_MARK = 1;

/**
 * Crop marks for the given slips: from each slip corner, a CROP_LEN mm line outward along each
 * edge, cut short where it would run into another slip and dropped when less than 1 mm is left.
 * With no gap, the marks between slips vanish and only those in the page margin remain.
 */
export function cropMarks(slips: Rect[]): Line[] {
  const out: Line[] = [];
  const seen = new Set<string>();
  for (const r of slips) {
    const corners: [number, number, number, number][] = [
      [r.x, r.y, -1, -1],
      [r.x + r.w, r.y, 1, -1],
      [r.x, r.y + r.h, -1, 1],
      [r.x + r.w, r.y + r.h, 1, 1],
    ];
    for (const [x, y, sx, sy] of corners) {
      for (const [dx, dy] of [
        [sx, 0],
        [0, sy],
      ] as const) {
        const l = clipMark(x, y, dx, dy, CROP_LEN, slips);
        if (Math.hypot(l.x2 - l.x1, l.y2 - l.y1) < MIN_MARK) continue;
        const key = [l.x1, l.y1, l.x2, l.y2].map((v) => v.toFixed(4)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
      }
    }
  }
  return out;
}

export type SlipGroup = 'front' | 'back' | 'token';

export const GROUP_LABEL: Record<SlipGroup, string> = {
  front: 'Fronts',
  back: 'Back pool',
  token: 'Tokens',
};

const GROUP_ORDER: SlipGroup[] = ['front', 'back', 'token'];

export interface SlipPage<T> {
  group: SlipGroup;
  /** The small label in the top margin, for example "Back pool, page 1 of 2". */
  label: string;
  items: T[];
}

/**
 * Pages of slips: fronts in batch order, then the Back pool, then Tokens, each group starting on a
 * new page, at most nine slips per page. The test page (always page 1) is not included.
 */
export function slipPages<T extends { group: SlipGroup }>(slips: T[]): SlipPage<T>[] {
  const pages: SlipPage<T>[] = [];
  for (const group of GROUP_ORDER) {
    const items = slips.filter((s) => s.group === group);
    const n = Math.ceil(items.length / PER_PAGE);
    for (let i = 0; i < n; i++) {
      pages.push({
        group,
        label: n > 1 ? `${GROUP_LABEL[group]}, page ${i + 1} of ${n}` : GROUP_LABEL[group],
        items: items.slice(i * PER_PAGE, (i + 1) * PER_PAGE),
      });
    }
  }
  return pages;
}

/** Where the group label goes: in the top margin, above the crop marks, left-aligned with the block. */
export function labelPosition(slips: Rect[]): { x: number; y: number } {
  const top = Math.min(...slips.map((r) => r.y));
  const left = Math.min(...slips.map((r) => r.x));
  // Baseline halfway between the paper edge and the top of the crop marks, at least 4 mm down.
  return { x: Math.max(4, left), y: Math.max(4, (top - CROP_LEN) / 2 + 1) };
}

// The test page.

export const TEST_LINE_X = 180;
export const TEST_LINE_Y = 260;

export interface TestPageGeometry {
  /** The 180 mm horizontal line, drawn at its true length (no printer factors). */
  horizontal: Line;
  /** The 260 mm vertical line, drawn at its true length. */
  vertical: Line;
  /** Short end ticks on both lines, so the ends are easy to find with a ruler. */
  ticks: Line[];
  /** One slip at the target size, with the printer profile applied like the slips. */
  slip: Rect;
  horizontalLabel: { x: number; y: number };
  verticalLabel: { x: number; y: number };
  slipLabel: { x: number; y: number };
  /** Where the text block (profile, date, instructions) starts, and how wide it may be. */
  text: { x: number; y: number; w: number };
}

export function testPageGeometry(s: Geometry): TestPageGeometry {
  const hy = 26;
  const hx1 = 20;
  const horizontal = { x1: hx1, y1: hy, x2: hx1 + TEST_LINE_X, y2: hy };
  const vx = 12;
  const vy1 = (A4.h - TEST_LINE_Y) / 2;
  const vertical = { x1: vx, y1: vy1, x2: vx, y2: vy1 + TEST_LINE_Y };
  const t = 1.5;
  const ticks: Line[] = [
    { x1: horizontal.x1, y1: hy - t, x2: horizontal.x1, y2: hy + t },
    { x1: horizontal.x2, y1: hy - t, x2: horizontal.x2, y2: hy + t },
    { x1: vx - t, y1: vertical.y1, x2: vx + t, y2: vertical.y1 },
    { x1: vx - t, y1: vertical.y2, x2: vx + t, y2: vertical.y2 },
  ];
  const { w, h } = slipSize(s);
  const slip = { x: 24, y: 40, w, h };
  return {
    horizontal,
    vertical,
    ticks,
    slip,
    horizontalLabel: { x: hx1 + TEST_LINE_X / 2, y: hy - 3 },
    verticalLabel: { x: vx + 4.5, y: A4.h / 2 + 8 },
    slipLabel: { x: slip.x, y: slip.y + slip.h + 5 },
    text: { x: Math.max(slip.x + slip.w + 8, 100), y: 46, w: 196 - Math.max(slip.x + slip.w + 8, 100) },
  };
}
