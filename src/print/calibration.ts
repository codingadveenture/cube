// Calibration: from the measured lengths of the test page's two lines to printer correction factors.
import { TEST_LINE_X, TEST_LINE_Y } from './layout';

/** More than this relative error means the print dialog is still scaling the page. */
export const SCALING_TOLERANCE = 0.02;

export type CalibrationVerdict =
  | { kind: 'invalid'; message: string }
  | { kind: 'still-scaling'; deviationX: number; deviationY: number; message: string }
  | { kind: 'ok'; fx: number; fy: number; message: string };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parse(v: number | string): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v.replace(',', '.')) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * fx = 180 / measured_x and fy = 260 / measured_y. When either line is off by more than 2 percent,
 * the print dialog is still scaling: no factors, fix the setting and print the test page again.
 */
export function calibrate(measuredX: number | string, measuredY: number | string): CalibrationVerdict {
  const mx = parse(measuredX);
  const my = parse(measuredY);
  if (mx === null || my === null) return { kind: 'invalid', message: 'Enter both measured lengths in mm.' };
  const fx = TEST_LINE_X / mx;
  const fy = TEST_LINE_Y / my;
  const deviationX = fx - 1;
  const deviationY = fy - 1;
  if (Math.abs(deviationX) > SCALING_TOLERANCE || Math.abs(deviationY) > SCALING_TOLERANCE) {
    const pct = (d: number) => `${(Math.abs(d) * 100).toFixed(1)} percent`;
    return {
      kind: 'still-scaling',
      deviationX: round4(deviationX),
      deviationY: round4(deviationY),
      message: `Off by ${pct(mx / TEST_LINE_X - 1)} across and ${pct(my / TEST_LINE_Y - 1)} down: the print dialog is still scaling. Set the scale to 100 percent or Actual size and print the test page again.`,
    };
  }
  return {
    kind: 'ok',
    fx: round4(fx),
    fy: round4(fy),
    message: `Within 2 percent. Correction factors: fx ${round4(fx).toFixed(4)}, fy ${round4(fy).toFixed(4)}.`,
  };
}
