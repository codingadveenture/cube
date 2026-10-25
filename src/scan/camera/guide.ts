// guide.ts: the guide box over the live video, in 63:88 card proportion (88:63 when turned for
// slips that lie sideways). Stored relative to the video frame, so it survives a change of
// camera resolution: the centre as fractions of the frame's width and height, and the box
// height as a fraction of the frame height. Pure geometry, in video pixels.
import type { Rect } from '../vision/preprocess';

export const CARD_W = 63;
export const CARD_H = 88;
/** The smallest box, as a fraction of the frame height. */
export const MIN_H = 0.15;

export interface Guide {
  cx: number;
  cy: number;
  h: number;
  /** True when the box is turned sideways (88:63). */
  landscape: boolean;
}

export const DEFAULT_GUIDE: Guide = { cx: 0.5, cy: 0.5, h: 0.6, landscape: false };

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

/** Width over height of the box. */
export function guideAspect(g: Pick<Guide, 'landscape'>): number {
  return g.landscape ? CARD_H / CARD_W : CARD_W / CARD_H;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The guide moved and sized so that the whole box lies inside the frame. */
export function clampGuide(g: Guide, vw: number, vh: number): Guide {
  const a = guideAspect(g);
  const maxH = Math.min(vh, vw / a);
  const minH = Math.min(maxH, vh * MIN_H);
  const hPx = clamp((Number.isFinite(g.h) ? g.h : DEFAULT_GUIDE.h) * vh, minH, maxH);
  const wPx = hPx * a;
  const cx = clamp((Number.isFinite(g.cx) ? g.cx : 0.5) * vw, wPx / 2, vw - wPx / 2) / vw;
  const cy = clamp((Number.isFinite(g.cy) ? g.cy : 0.5) * vh, hPx / 2, vh - hPx / 2) / vh;
  return { cx, cy, h: hPx / vh, landscape: g.landscape };
}

/** The box in video pixels. */
export function guideRect(g: Guide, vw: number, vh: number): Rect {
  const c = clampGuide(g, vw, vh);
  const height = c.h * vh;
  const width = height * guideAspect(c);
  return { x: c.cx * vw - width / 2, y: c.cy * vh - height / 2, width, height };
}

function fromRect(r: Rect, vw: number, vh: number, landscape: boolean): Guide {
  return clampGuide({ cx: (r.x + r.width / 2) / vw, cy: (r.y + r.height / 2) / vh, h: r.height / vh, landscape }, vw, vh);
}

/** The box dragged by (dx, dy) video pixels. */
export function moveGuide(g: Guide, dx: number, dy: number, vw: number, vh: number): Guide {
  const r = guideRect(g, vw, vh);
  return fromRect({ ...r, x: r.x + dx, y: r.y + dy }, vw, vh, g.landscape);
}

/**
 * The box resized by dragging one corner by (dx, dy) video pixels: the opposite corner stays put
 * and the proportion is kept, following whichever direction of the drag asks for the larger box.
 */
export function resizeGuide(g: Guide, corner: Corner, dx: number, dy: number, vw: number, vh: number): Guide {
  const r = guideRect(g, vw, vh);
  const a = guideAspect(g);
  const east = corner[1] === 'e';
  const south = corner[0] === 's';
  const ax = east ? r.x : r.x + r.width;
  const ay = south ? r.y : r.y + r.height;
  const px = (east ? r.x + r.width : r.x) + dx;
  const py = (south ? r.y + r.height : r.y) + dy;
  const fromY = south ? py - ay : ay - py;
  const fromX = (east ? px - ax : ax - px) / a;
  let h = Math.max(fromY, fromX, vh * MIN_H);
  h = Math.min(h, south ? vh - ay : ay, (east ? vw - ax : ax) / a);
  const w = h * a;
  return fromRect({ x: east ? ax : ax - w, y: south ? ay : ay - h, width: w, height: h }, vw, vh, g.landscape);
}

/** The box turned a quarter: same centre, the old width becomes the new height. */
export function turnGuide(g: Guide, vw: number, vh: number): Guide {
  const r = guideRect(g, vw, vh);
  return clampGuide({ cx: g.cx, cy: g.cy, h: r.width / vh, landscape: !g.landscape }, vw, vh);
}

export function parseGuide(raw: unknown): Guide {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GUIDE };
  const r = raw as Partial<Record<keyof Guide, unknown>>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : d);
  return { cx: num(r.cx, DEFAULT_GUIDE.cx), cy: num(r.cy, DEFAULT_GUIDE.cy), h: num(r.h, DEFAULT_GUIDE.h), landscape: r.landscape === true };
}
