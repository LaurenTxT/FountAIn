import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { RoomMessage } from '../shared/types';
import type { Team } from './members';

interface RailItem {
  id: string;
  isUser: boolean;
  color: string;
  authorLabel: string;
  preview: string;
}

const FALLBACK_COLORS: Record<string, string> = {
  gemini: '#a35bdb',
  claude: '#d9692f',
  codex: '#7b6fd6',
  dsh: '#3c66d9',
  qwen: '#4f6fd6',
  kimi: '#5f6bc0',
  glm: '#45546a',
  grok: '#b5563c',
  minimax: '#df6b62',
};

const STEP_PX = 9; // Fixed vertical pitch per segment (3px bar + 6px gap)
const VIEW_HEIGHT = 310; // Compact bounded window height so it never overlaps header/composer

export function MessageScrollRail({
  listRef,
  messages,
  team,
  name,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  messages: RoomMessage[];
  team: Team;
  name: (message: RoomMessage) => string;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const dragging = useRef(false);
  const railRef = useRef<HTMLDivElement>(null);

  const items = useMemo<RailItem[]>(() => {
    return messages
      .filter(
        m =>
          !m.contextOnly &&
          !m.discussionControl &&
          !m.system &&
          m.author !== 'system' &&
          !(m.status === 'passed' && m.reaction),
      )
      .map(m => {
        const isUser = m.author === 'user';
        const member = isUser ? undefined : team.get(m.author);
        const color = isUser
          ? 'var(--ink)'
          : member?.color || FALLBACK_COLORS[m.author] || '#8ea2c8';
        const raw = (m.text || '').replace(/\s+/g, ' ').trim();
        const preview = raw ? (raw.length > 34 ? `${raw.slice(0, 34)}…` : raw) : '（流程卡片 / 附件）';
        return {
          id: m.id,
          isUser,
          color,
          authorLabel: name(m),
          preview,
        };
      });
  }, [messages, team, name]);

  useEffect(() => {
    const container = listRef.current;
    if (!container || items.length < 2) return;
    let raf = 0;
    const syncActive = () => {
      raf = 0;
      const rect = container.getBoundingClientRect();
      const targetY = rect.top + rect.height * 0.42;
      const nodes = container.querySelectorAll<HTMLElement>('[data-message-id]');
      let bestId = '';
      let bestDist = Infinity;
      nodes.forEach(node => {
        const id = node.dataset.messageId;
        if (!id) return;
        const r = node.getBoundingClientRect();
        const mid = (r.top + r.bottom) * 0.5;
        const dist = Math.abs(mid - targetY);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      });
      if (bestId) {
        const idx = items.findIndex(item => item.id === bestId);
        if (idx !== -1) setActiveIdx(idx);
      }
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(syncActive);
    };
    syncActive();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [listRef, items]);

  const jumpToIndex = (idx: number, smooth = true) => {
    const item = items[idx];
    const container = listRef.current;
    if (!item || !container) return;
    const el = container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    setActiveIdx(idx);
  };

  if (items.length < 2) return null;

  const clampedActive = Math.min(items.length - 1, Math.max(0, activeIdx));
  const focusIdx = hoveredIdx ?? clampedActive;
  const totalH = items.length * STEP_PX;
  const windowH = Math.min(VIEW_HEIGHT, Math.max(44, totalH + 16));
  const needsScroll = totalH > windowH - 12;

  // Keep the active segment smoothly centered inside the bounded fade window
  const rawOffset = windowH / 2 - (clampedActive + 0.5) * STEP_PX;
  const minOffset = windowH - totalH - 8;
  const maxOffset = 8;
  const translateY = needsScroll
    ? Math.max(minOffset, Math.min(maxOffset, rawOffset))
    : (windowH - totalH) / 2;

  const scrubAt = (clientY: number) => {
    const rail = railRef.current;
    if (!rail || !items.length) return;
    const rect = rail.getBoundingClientRect();
    const localY = clientY - rect.top - translateY;
    const idx = Math.max(0, Math.min(items.length - 1, Math.floor(localY / STEP_PX)));
    setHoveredIdx(idx);
    jumpToIndex(idx, false);
  };

  const hoveredItem = hoveredIdx !== null ? items[hoveredIdx] : null;

  return (
    <nav
      ref={railRef}
      className="message-scroll-rail"
      style={{ height: `${windowH}px` }}
      aria-label="对话分段导航"
      onPointerDown={e => {
        if (e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        scrubAt(e.clientY);
      }}
      onPointerMove={e => {
        if (!dragging.current) return;
        scrubAt(e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerLeave={() => {
        if (!dragging.current) setHoveredIdx(null);
      }}
    >
      {hoveredItem && (
        <div className="message-rail-tooltip" role="status">
          <span className="message-rail-dot" style={{ background: hoveredItem.color }} />
          <strong>{hoveredItem.authorLabel}</strong>
          <span>{hoveredItem.preview}</span>
        </div>
      )}
      <div className={`message-rail-viewport ${needsScroll ? 'masked' : ''}`}>
        <div
          className="message-rail-track"
          style={{ transform: `translate3d(0, ${translateY.toFixed(1)}px, 0)` }}
        >
          {items.map((item, idx) => {
            const dist = Math.abs(idx - focusIdx);
            const active = idx === clampedActive;
            // Fisheye wave: largest & brightest at focus, tapering smoothly with distance
            const baseW =
              dist === 0 ? 17 :
              dist === 1 ? 12.5 :
              dist === 2 ? 9.5 :
              dist === 3 ? 7 :
              5;
            const w = baseW + (item.isUser ? 2 : 0);
            const h = dist === 0 ? 3.4 : dist === 1 ? 3 : 2.6;
            const op =
              dist === 0 ? 1 :
              dist === 1 ? 0.78 :
              dist === 2 ? 0.56 :
              dist === 3 ? 0.38 :
              0.24;

            return (
              <button
                key={item.id}
                type="button"
                className={`message-rail-seg ${item.isUser ? 'user' : 'ai'} ${active ? 'active' : ''}`}
                style={{
                  '--seg-color': item.color,
                  width: `${w}px`,
                  height: `${h}px`,
                  opacity: op,
                } as CSSProperties}
                aria-label={`跳转到 ${item.authorLabel}：${item.preview}`}
                onMouseEnter={() => setHoveredIdx(idx)}
                onClick={e => {
                  e.stopPropagation();
                  jumpToIndex(idx, true);
                }}
              />
            );
          })}
        </div>
      </div>
    </nav>
  );
}
