// The Cube view's layout, Spoiler (a grid of card images) or List (compact rows), remembered on
// the device. Storage may be missing or throw (private windows, blocked site data): the default wins.

export type CubeLayout = 'spoiler' | 'list';

export const CUBE_LAYOUT_KEY = 'cube.layout.v1';
export const DEFAULT_CUBE_LAYOUT: CubeLayout = 'spoiler';

type LayoutStorage = Pick<Storage, 'getItem' | 'setItem'>;

function deviceStorage(): LayoutStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered layout, or Spoiler when nothing valid is stored or storage cannot be read. */
export function readCubeLayout(storage: LayoutStorage | null = deviceStorage()): CubeLayout {
  try {
    const value = storage?.getItem(CUBE_LAYOUT_KEY);
    return value === 'list' || value === 'spoiler' ? value : DEFAULT_CUBE_LAYOUT;
  } catch {
    return DEFAULT_CUBE_LAYOUT;
  }
}

/** Remembers the layout; false when it could not be stored (the choice then lasts this visit only). */
export function writeCubeLayout(layout: CubeLayout, storage: LayoutStorage | null = deviceStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(CUBE_LAYOUT_KEY, layout);
    return true;
  } catch {
    return false;
  }
}
