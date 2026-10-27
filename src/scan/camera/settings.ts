// settings.ts: the camera setup (kept across sessions) and the camera session's small record,
// both in localStorage. The shots themselves are in IndexedDB (db.ts).
import type { Baseline } from './capture';
import { parseGuide, type Guide } from './guide';
import { initialOrientation, parseOrientation, type OrientationState } from './orientation';

export const SETTINGS_KEY = 'cube.camera-settings.v1';
export const CAMERA_SESSION_KEY = 'cube.camera-session.v1';

/**
 * Slips are counted off in stacks of this size: the phone marks every multiple with a long double
 * buzz, so a stack counted by hand before it is fed shows at once whether a slip was missed.
 */
export const COUNT_EVERY = 25;

/** What the phone says while feeding: nothing, the count at each checkpoint, or each card's name. */
export type Speak = 'off' | 'count' | 'names';

export interface CameraSettings {
  guide: Guide;
  /** The empty sheet, from "Set the empty sheet"; null until it has been set. */
  baseline: Baseline | null;
  /** Rotate the view 180 degrees, for reading it on the rig. */
  flipped: boolean;
  /** A short beep on capture, after the first tap. */
  beep: boolean;
  speak: Speak;
  orientation: OrientationState;
  /** Running mean of the time of one recognition pass, in ms. */
  passMs: number | null;
}

export function defaultSettings(): CameraSettings {
  return { guide: parseGuide(null), baseline: null, flipped: false, beep: false, speak: 'off', orientation: initialOrientation(), passMs: null };
}

export function parseSpeak(raw: unknown): Speak {
  return raw === 'count' || raw === 'names' ? raw : 'off';
}

/**
 * Whether the slip count crossed a checkpoint (a multiple of `every`) on its way from `before` to
 * `count`. Judged when a slip settles, against the count at the previous settle, so a multiple
 * reached in between (a photo from Try a photo, a copy kept in Review) is still marked on the next
 * slip, a count that fell (a shot deleted in Review) marks nothing, and climbing back over the same
 * multiple marks it again, since the stack's last slip is then a different slip.
 */
export function crossedCheckpoint(before: number, count: number, every: number = COUNT_EVERY): boolean {
  return every > 0 && count > before && Math.floor(count / every) > Math.floor(before / every);
}

function parseBaseline(raw: unknown): Baseline | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Baseline>;
  const sheet = r.sheet;
  if (typeof r.spread !== 'number' || typeof r.mean !== 'number' || !Array.isArray(sheet) || sheet.length !== 3) return null;
  if (!sheet.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) return null;
  return { spread: r.spread, mean: r.mean, sheet: [sheet[0]!, sheet[1]!, sheet[2]!] };
}

export function parseSettings(raw: string | null): CameraSettings {
  const d = defaultSettings();
  if (!raw) return d;
  try {
    const r = JSON.parse(raw) as Partial<Record<keyof CameraSettings, unknown>>;
    return {
      guide: parseGuide(r.guide),
      baseline: parseBaseline(r.baseline),
      flipped: r.flipped === true,
      beep: r.beep === true,
      speak: parseSpeak(r.speak),
      orientation: parseOrientation(r.orientation),
      passMs: typeof r.passMs === 'number' && r.passMs > 0 ? r.passMs : null,
    };
  } catch {
    return d;
  }
}

/** A running mean that follows the latest passes. */
export function nextPassMs(prev: number | null, sample: number): number {
  return prev === null ? sample : prev * 0.7 + sample * 0.3;
}

export interface CameraSessionMeta {
  startedAt: string;
  /** The last export to the Scan session, if any. */
  exported: { at: string; label: string; cards: number } | null;
}

export function parseCameraSession(raw: string | null, now: Date = new Date()): CameraSessionMeta {
  const fresh = { startedAt: now.toISOString(), exported: null };
  if (!raw) return fresh;
  try {
    const r = JSON.parse(raw) as Partial<CameraSessionMeta>;
    const e = r.exported;
    return {
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : fresh.startedAt,
      exported:
        e && typeof e.at === 'string' && typeof e.label === 'string' && typeof e.cards === 'number'
          ? { at: e.at, label: e.label, cards: e.cards }
          : null,
    };
  } catch {
    return fresh;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the setting lasts until the page is closed.
  }
}

export const loadSettings = () => parseSettings(read(SETTINGS_KEY));
export const saveSettings = (s: CameraSettings) => write(SETTINGS_KEY, s);
export const loadCameraSession = () => parseCameraSession(read(CAMERA_SESSION_KEY));
export const saveCameraSession = (m: CameraSessionMeta) => write(CAMERA_SESSION_KEY, m);
