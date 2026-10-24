// The Compare overlay: every member of a Cycle side by side in a full-screen grid, for one candidate
// Print run or for the current Wanted Printings.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cellCaption, compareColumns, compareImage, type CompareCell } from '../../printings/compare';
import { focusTrapTarget } from '../../lib/focusTrap';

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** Locks the page behind the overlay; keeps the width the scrollbar took so nothing shifts. */
function useScrollLock() {
  useEffect(() => {
    const body = document.body;
    const { overflow, paddingRight } = body.style;
    const bar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (bar > 0) body.style.paddingRight = `${bar}px`;
    return () => {
      body.style.overflow = overflow;
      body.style.paddingRight = paddingRight;
    };
  }, []);
}

export function CompareGrid({
  cycleLabel,
  runLabel,
  detail,
  cells,
  actions,
  onClose,
}: {
  cycleLabel: string;
  runLabel: string;
  /** A line under the title, for example the set name and whether the run is complete. */
  detail?: ReactNode;
  cells: CompareCell[];
  /** The Owner's action for the run, shown under the grid. */
  actions?: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const width = useViewportWidth();
  const cols = compareColumns(width);
  useScrollLock();

  // Escape closes; Tab stays inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]')];
        const active = document.activeElement;
        const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
        const onHeading = !!active && active === document.getElementById(titleId);
        const target = focusTrapTarget(index, focusable.length, e.shiftKey, onHeading);
        if (target) {
          e.preventDefault();
          focusable[target === 'first' ? 0 : focusable.length - 1]!.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, titleId]);

  // Focus moves to the title and returns to whatever had it (the opening button) on close, without
  // scrolling the page: an overlay opened by hover may have left focus on a button far away.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.getElementById(titleId)?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [titleId]);

  return createPortal(
    <div className="compare-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="compare" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="compare-head">
          <div className="compare-title">
            <h2 id={titleId} tabIndex={-1}>
              {cycleLabel}: {runLabel}
            </h2>
            {detail && <p className="printing">{detail}</p>}
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="compare-body">
          <ul className="compare-grid" data-cols={cols} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {cells.map((c) => (
              <li key={c.oracle_id} className={c.missing ? 'compare-cell missing' : 'compare-cell'}>
                {c.image_normal && !c.missing ? (
                  <img className="compare-img" src={compareImage(c.image_normal, width)} alt="" loading="lazy" decoding="async" width={488} height={680} />
                ) : (
                  <span className="compare-img compare-empty" aria-hidden="true" />
                )}
                <span className="row-name">{c.name}</span>
                {c.missing ? <span className="marker">{c.missing}</span> : <span className="num muted">{cellCaption(c)}</span>}
              </li>
            ))}
          </ul>
        </div>
        {actions && <div className="compare-foot">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
