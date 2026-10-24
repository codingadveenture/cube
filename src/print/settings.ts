// Print sheet settings, printer profiles and the print history in cubes/main/meta/print.
// Pure apart from the small localStorage helpers at the end.

export type Quality = 'standard' | 'best';

export interface PrinterProfile {
  name: string;
  /** Correction factors: the slip is drawn at slip_w * fx by slip_h * fy. */
  fx: number;
  fy: number;
}

export interface PrintSettings {
  /** Slip size in mm. */
  slipW: number;
  slipH: number;
  /** Gap between slips in mm. */
  gap: number;
  cropMarks: boolean;
  quality: Quality;
  profile: PrinterProfile;
}

export const DEFAULT_PROFILE: PrinterProfile = { name: 'Default', fx: 1, fy: 1 };

export const DEFAULT_SETTINGS: PrintSettings = {
  slipW: 63,
  slipH: 88,
  gap: 0,
  cropMarks: true,
  quality: 'standard',
  profile: DEFAULT_PROFILE,
};

/** One entry of the print history (the last 50 are kept). */
export interface PrintHistoryEntry {
  date: string;
  count: number;
  printer: string;
  names: string[];
  /** When the entry was written (ISO time), so two equal prints on one day stay two entries. */
  at?: string;
}

export const HISTORY_LIMIT = 50;

/** cubes/main/meta/print as read. */
export interface PrintMeta {
  settings: PrintSettings | null;
  /** Saved printer profiles, by name. */
  profiles: Record<string, PrinterProfile>;
  history: PrintHistoryEntry[];
}

export const EMPTY_PRINT_META: PrintMeta = { settings: null, profiles: {}, history: [] };

/** The allowed range of each number setting, inclusive; anything outside keeps the old value. */
export const RANGES = {
  slipW: { min: 30, max: 100 },
  slipH: { min: 30, max: 130 },
  gap: { min: 0, max: 10 },
  factor: { min: 0.8, max: 1.25 },
} as const;

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A printer profile from stored data, or null when it is not usable. */
export function toProfile(v: unknown, fallbackName = DEFAULT_PROFILE.name): PrinterProfile | null {
  const o = obj(v);
  if (!o) return null;
  const fx = num(o.fx, RANGES.factor.min, RANGES.factor.max);
  const fy = num(o.fy, RANGES.factor.min, RANGES.factor.max);
  if (fx === null || fy === null) return null;
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : fallbackName;
  return { name, fx, fy };
}

/**
 * Lay stored settings over a base (the defaults unless given). Each field is taken only when it
 * is valid, so a damaged or partial doc never breaks the layout.
 */
export function mergeSettings(stored: unknown, base: PrintSettings = DEFAULT_SETTINGS): PrintSettings {
  const o = obj(stored);
  if (!o) return { ...base, profile: { ...base.profile } };
  return {
    slipW: num(o.slipW, RANGES.slipW.min, RANGES.slipW.max) ?? base.slipW,
    slipH: num(o.slipH, RANGES.slipH.min, RANGES.slipH.max) ?? base.slipH,
    gap: num(o.gap, RANGES.gap.min, RANGES.gap.max) ?? base.gap,
    cropMarks: typeof o.cropMarks === 'boolean' ? o.cropMarks : base.cropMarks,
    quality: o.quality === 'standard' || o.quality === 'best' ? o.quality : base.quality,
    profile: toProfile(o.profile, base.profile.name) ?? { ...base.profile },
  };
}

/** The settings a viewer works with: defaults, then the Owner's shared settings, then this device's (visitors only). */
export function effectiveSettings(shared: unknown, local: unknown, isOwner: boolean): PrintSettings {
  const fromShared = mergeSettings(shared);
  return isOwner || !local ? fromShared : mergeSettings(local, fromShared);
}

export function toPrintMeta(d: unknown): PrintMeta {
  const o = obj(d);
  if (!o) return EMPTY_PRINT_META;
  const profiles: Record<string, PrinterProfile> = {};
  const rawProfiles = obj(o.profiles);
  if (rawProfiles) {
    for (const [name, v] of Object.entries(rawProfiles)) {
      const p = toProfile(v, name);
      if (p) profiles[name] = { ...p, name };
    }
  }
  const history = Array.isArray(o.history)
    ? o.history
        .map((h): PrintHistoryEntry | null => {
          const e = obj(h);
          if (!e || typeof e.date !== 'string') return null;
          return {
            date: e.date,
            count: typeof e.count === 'number' ? e.count : 0,
            printer: typeof e.printer === 'string' ? e.printer : '',
            names: Array.isArray(e.names) ? e.names.filter((x): x is string => typeof x === 'string') : [],
            ...(typeof e.at === 'string' ? { at: e.at } : {}),
          };
        })
        .filter((x): x is PrintHistoryEntry => x !== null)
        .slice(-HISTORY_LIMIT)
    : [];
  return { settings: o.settings ? mergeSettings(o.settings) : null, profiles, history };
}

/** The history with `entry` appended, keeping the last HISTORY_LIMIT entries. */
export function appendHistory(history: PrintHistoryEntry[], entry: PrintHistoryEntry): PrintHistoryEntry[] {
  return [...history, entry].slice(-HISTORY_LIMIT);
}

/**
 * The stored history entries to remove (exactly as stored, for arrayRemove) so that one appended
 * entry leaves at most `limit`: the oldest ones. Removing an entry that is already gone does
 * nothing, so a stale list can never delete newer entries.
 */
export function historyTrim(storedHistory: unknown, limit = HISTORY_LIMIT): unknown[] {
  if (!Array.isArray(storedHistory)) return [];
  const extra = storedHistory.length + 1 - limit;
  return extra > 0 ? storedHistory.slice(0, extra) : [];
}

/**
 * A typed number field's text as a number within [min, max], or null. Accepts a comma as the
 * decimal mark ("63,5"); rejects trailing junk ("63mm") and empty text.
 */
export function parseSetting(text: string, min: number, max: number): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^[+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Settings equal field by field (profile included). */
export function sameSettings(a: PrintSettings, b: PrintSettings): boolean {
  return (
    a.slipW === b.slipW &&
    a.slipH === b.slipH &&
    a.gap === b.gap &&
    a.cropMarks === b.cropMarks &&
    a.quality === b.quality &&
    a.profile.name === b.profile.name &&
    a.profile.fx === b.profile.fx &&
    a.profile.fy === b.profile.fy
  );
}

// Per-device storage: visitors' settings and profiles, the batch extras and tokens, unticked reprints.

export const LOCAL_SETTINGS_KEY = 'cube.print.settings.v1';
export const LOCAL_PROFILES_KEY = 'cube.print.profiles.v1';
export const EXTRAS_KEY = 'cube.print.extras.v1';
export const TOKENS_KEY = 'cube.print.tokens.v1';
export const UNCHECKED_KEY = 'cube.print.unchecked.v1';

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A convenience only.
  }
}
