import { describe, expect, it } from 'vitest';
import { focusTrapTarget } from './focusTrap';

describe('focusTrapTarget', () => {
  it('wraps Tab from the last stop to the first, and Shift+Tab from the first to the last', () => {
    expect(focusTrapTarget(2, 3, false, false)).toBe('first');
    expect(focusTrapTarget(0, 3, true, false)).toBe('last');
  });

  it('lets the browser move focus between inner stops', () => {
    expect(focusTrapTarget(0, 3, false, false)).toBeNull();
    expect(focusTrapTarget(1, 3, false, false)).toBeNull();
    expect(focusTrapTarget(1, 3, true, false)).toBeNull();
    expect(focusTrapTarget(2, 3, true, false)).toBeNull();
  });

  it('wraps from the heading or from outside the dialog', () => {
    expect(focusTrapTarget(-1, 3, false, true)).toBe('first');
    expect(focusTrapTarget(-1, 3, true, true)).toBe('last');
    expect(focusTrapTarget(-1, 3, false, false)).toBe('first');
    expect(focusTrapTarget(-1, 3, true, false)).toBe('last');
  });

  it('keeps a single stop focused and does nothing without stops', () => {
    expect(focusTrapTarget(0, 1, false, false)).toBe('first');
    expect(focusTrapTarget(0, 1, true, false)).toBe('last');
    expect(focusTrapTarget(-1, 0, false, true)).toBeNull();
    expect(focusTrapTarget(-1, 0, true, false)).toBeNull();
  });
});
