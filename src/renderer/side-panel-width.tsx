import { useRef, useState, type CSSProperties } from 'react';

const MIN_WIDTH = 240;
const STEP = 24;

export function useSidePanelWidth(storageKey: string) {
  const [width, setWidth] = useState<number>();
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : undefined;
    } catch { return undefined; }
  });
  const drag = useRef<{ startX: number; startWidth: number; latest?: number } | undefined>(undefined);

  function save(value?: number) {
    setWidth(undefined);
    setPreferredWidth(value);
    try {
      if (value === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(value));
    } catch { /* The width still works for the current view. */ }
  }

  function limit(handle: HTMLElement, requested: number) {
    const available = handle.parentElement?.clientWidth ?? 0;
    const maximum = Math.min(available * 0.72, available - 296);
    return Math.round(Math.min(Math.max(MIN_WIDTH, maximum), Math.max(MIN_WIDTH, requested)));
  }

  const effectiveWidth = width ?? preferredWidth;
  const style = effectiveWidth === undefined ? undefined : {
    '--preferred-panel-width': effectiveWidth + 'px',
  } as CSSProperties;

  const separator = <div className="project-panel-resize"
    role="separator" aria-label="调整右侧面板宽度" aria-orientation="vertical" tabIndex={0}
    title="左右拖动调整宽度，双击恢复默认"
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const panel = event.currentTarget.nextElementSibling;
      if (!panel) return;
      drag.current = { startX: event.clientX, startWidth: panel.getBoundingClientRect().width };
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={event => {
      if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const { startX, startWidth } = drag.current;
      drag.current.latest = limit(event.currentTarget, startWidth + startX - event.clientX);
      setWidth(drag.current.latest);
    }}
    onPointerCancel={() => { drag.current = undefined; setWidth(undefined); }}
    onLostPointerCapture={() => {
      const latest = drag.current?.latest;
      drag.current = undefined;
      if (latest !== undefined) save(latest);
    }}
    onDoubleClick={() => save()}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') { save(); return; }
      const current = event.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? MIN_WIDTH;
      const requested = event.key === 'End' ? Infinity : current + (event.key === 'ArrowLeft' ? STEP : -STEP);
      save(limit(event.currentTarget, requested));
    }}
  />;
  return { style, separator };
}
