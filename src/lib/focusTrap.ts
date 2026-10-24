// focusTrapTarget: where Tab moves focus inside a modal dialog, so focus never leaves it.

/**
 * The trap's decision for one Tab press: 'first' or 'last' to move focus to that stop (and stop the
 * browser's own move), or null to let the browser move it. `index` is the focused element's
 * position among the dialog's focusable stops (-1 when it is not one), `count` how many stops
 * there are. Focus on the heading (tabIndex -1) or outside the dialog is not a stop, so Tab wraps
 * from there too: forwards to the first stop, backwards to the last.
 */
export function focusTrapTarget(index: number, count: number, shift: boolean, onHeading: boolean): 'first' | 'last' | null {
  if (count < 1) return null;
  const onStop = !onHeading && index >= 0 && index < count;
  if (shift) return !onStop || index === 0 ? 'last' : null;
  return !onStop || index === count - 1 ? 'first' : null;
}
