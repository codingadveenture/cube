// The guide box drawn over the live video. In setup it can be moved (drag inside) and resized
// (drag a corner) by touch or mouse; while scanning it only shows the loop's state.
import { useRef, type PointerEvent } from 'react';
import { guideRect, moveGuide, resizeGuide, type Corner, type Guide } from '../../scan/camera/guide';

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

export function GuideOverlay({
  guide,
  vw,
  vh,
  editable,
  flipped,
  tone,
  onChange,
}: {
  guide: Guide;
  vw: number;
  vh: number;
  editable: boolean;
  /** The view is rotated 180 degrees, so screen drags run the other way in the video. */
  flipped: boolean;
  tone: 'idle' | 'empty' | 'settling' | 'unclear' | 'captured';
  onChange: (g: Guide) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: Guide; kind: 'move' | Corner } | null>(null);
  const r = guideRect(guide, vw, vh);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  function down(e: PointerEvent<HTMLElement>, kind: 'move' | Corner) {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: guide, kind };
  }
  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !layer.current) return;
    const box = layer.current.getBoundingClientRect();
    const scale = box.width ? vw / box.width : 1;
    const sign = flipped ? -1 : 1;
    const dx = (e.clientX - d.x) * scale * sign;
    const dy = (e.clientY - d.y) * scale * sign;
    onChange(d.kind === 'move' ? moveGuide(d.start, dx, dy, vw, vh) : resizeGuide(d.start, d.kind, dx, dy, vw, vh));
  }
  function up(e: PointerEvent<HTMLElement>) {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }

  return (
    <div className="guide-layer" ref={layer}>
      <div
        className={`guide-box tone-${tone}${editable ? ' editable' : ''}`}
        style={{ left: pct(r.x, vw), top: pct(r.y, vh), width: pct(r.width, vw), height: pct(r.height, vh) }}
        onPointerDown={(e) => down(e, 'move')}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label={editable ? 'Guide box: drag to move' : 'Guide box'}
      >
        {editable &&
          CORNERS.map((c) => (
            <span
              key={c}
              className={`guide-handle ${c}`}
              onPointerDown={(e) => down(e, c)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              aria-hidden="true"
            />
          ))}
      </div>
    </div>
  );
}
