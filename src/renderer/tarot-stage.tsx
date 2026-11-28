import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { ProviderInfo } from '../shared/types';
import { MOOD_TEXT, Portrait, type Mood, type TeamMember } from './members';
import { providerSummary } from './ui';
import './tarot-stage.css';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const TAU = Math.PI * 2;

function normalizeAngle(rad: number): number {
  let a = rad % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export function TarotStage({
  members,
  providers,
  moods,
  onCard,
}: {
  members: TeamMember[];
  providers: ProviderInfo[];
  moods: Record<string, Mood>;
  onCard: (memberId: string, anchor: Element) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(900);
  const [angle, setAngle] = useState(0);
  const [autoSpin, setAutoSpin] = useState(() => {
    if (typeof window === 'undefined') return true;
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  });

  // Mutable animation state for silky 60fps loop without React effect restarts
  const angleRef = useRef(0);
  const targetRef = useRef<number | null>(null);
  const velocityRef = useRef(0);
  const hoveringRef = useRef(false);
  const draggingRef = useRef<{ startX: number; startAngle: number; lastX: number; lastT: number; moved: boolean } | null>(null);
  const autoSpinRef = useRef(autoSpin);
  autoSpinRef.current = autoSpin;

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 120) setStageWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (members.length <= 1) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      let changed = false;
      if (!draggingRef.current) {
        if (targetRef.current !== null) {
          const diff = normalizeAngle(targetRef.current - angleRef.current);
          if (Math.abs(diff) < 0.0025) {
            angleRef.current = targetRef.current;
            targetRef.current = null;
          } else {
            angleRef.current += diff * Math.min(1, dt * 8.5);
          }
          changed = true;
        } else if (Math.abs(velocityRef.current) > 0.004) {
          angleRef.current += velocityRef.current * dt;
          velocityRef.current *= Math.pow(0.08, dt);
          changed = true;
        } else if (autoSpinRef.current && !hoveringRef.current) {
          // Gentle tarot orbit speed (~0.18 rad/sec ≈ 35s per full revolution)
          angleRef.current += 0.18 * dt;
          changed = true;
        }
      }

      if (changed) setAngle(angleRef.current);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [members.length]);

  const count = members.length;
  if (!count) return null;

  // Determine which card is currently closest to the front center (theta ≈ 0)
  let frontIndex = 0;
  let bestCos = -2;
  for (let i = 0; i < count; i++) {
    const c = Math.cos(angle + (i / count) * TAU);
    if (c > bestCos) {
      bestCos = c;
      frontIndex = i;
    }
  }

  const focusIndex = (idx: number) => {
    const desired = -(idx / count) * TAU;
    const diff = normalizeAngle(desired - angleRef.current);
    velocityRef.current = 0;
    targetRef.current = angleRef.current + diff;
  };

  const stepBy = (delta: number) => {
    const next = (frontIndex + delta + count) % count;
    focusIndex(next);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button.tarot-ctrl-btn, button.tarot-dot-btn')) return;
    targetRef.current = null;
    velocityRef.current = 0;
    draggingRef.current = {
      startX: e.clientX,
      startAngle: angleRef.current,
      lastX: e.clientX,
      lastT: performance.now(),
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = draggingRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 6) d.moved = true;
    const now = performance.now();
    const dt = Math.max(0.008, (now - d.lastT) / 1000);
    const step = (e.clientX - d.lastX) * 0.0055;
    velocityRef.current = step / dt;
    d.lastX = e.clientX;
    d.lastT = now;
    angleRef.current = d.startAngle + dx * 0.0055;
    setAngle(angleRef.current);
  };

  const onPointerUp = () => {
    draggingRef.current = null;
  };

  const radiusX = count === 1 ? 0 : Math.min(350, Math.max(175, stageWidth * 0.34));
  const frontMember = members[frontIndex];

  return (
    <div
      ref={stageRef}
      className="tarot-stage"
      role="region"
      aria-label="团队成员立绘轮盘"
      onMouseEnter={() => { hoveringRef.current = true; }}
      onMouseLeave={() => { hoveringRef.current = false; draggingRef.current = null; }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="tarot-aura"
        aria-hidden="true"
        style={{ '--aura-color': frontMember?.color || 'var(--accent)' } as CSSProperties}
      />

      <div className="tarot-viewport" role="list">
        {members.map((member, index) => {
          const theta = count === 1 ? 0 : angle + (index / count) * TAU;
          const sin = Math.sin(theta);
          const cos = Math.cos(theta);
          const depth = (cos + 1) / 2; // 1 = front center, 0 = far back
          const isFront = index === frontIndex;

          const x = sin * radiusX;
          const y = (1 - depth) * -22;
          const scale = 0.62 + depth * 0.42;
          const rotY = -sin * 34;
          const blur = isFront && depth > 0.96 ? 0 : Math.pow(1 - depth, 1.5) * 5.2;
          const opacity = isFront ? 1 : 0.36 + Math.pow(depth, 1.15) * 0.6;
          const brightness = isFront ? 1.02 : 0.64 + depth * 0.36;
          const zIndex = Math.round(depth * 100) + (isFront ? 20 : 0);

          const info = providers.find((item) => item.id === member.executor);
          const mood = moods[member.id];
          const statusLabel =
            mood === 'resting' || mood === 'working' || mood === 'waiting'
              ? MOOD_TEXT[mood]
              : providerSummary(info);

          const cardStyle: CSSProperties = {
            transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) perspective(1400px) scale(${scale.toFixed(3)}) rotateY(${rotY.toFixed(1)}deg)`,
            opacity: Number(opacity.toFixed(3)),
            filter: `blur(${blur.toFixed(2)}px) brightness(${brightness.toFixed(2)})`,
            zIndex,
          };

          return (
            <div
              key={member.id}
              role="listitem"
              className={`tarot-card member-${member.id} ${mood ? `mood-${mood}` : ''} ${isFront ? 'is-front' : 'is-back'}`}
              style={cardStyle}
            >
              <button
                type="button"
                className="tarot-card-hit"
                aria-haspopup="dialog"
                aria-label={isFront ? `查看 ${member.name} 的人物卡片` : `将 ${member.name} 转到正面`}
                onClick={(event) => {
                  if (draggingRef.current?.moved) return;
                  if (!isFront && count > 1) {
                    focusIndex(index);
                  } else {
                    onCard(member.id, event.currentTarget.parentElement ?? event.currentTarget);
                  }
                }}
              />
              <div className="tarot-frame" aria-hidden="true">
                <span className="tarot-numeral">{ROMAN[index] ?? String(index + 1)}</span>
                <span className="tarot-corner tr">✦</span>
                <span className="tarot-corner bl">✦</span>
                <span className="tarot-corner br">✦</span>
              </div>
              <Portrait member={member} className="tarot-portrait" />
              <div className="tarot-caption">
                <div className="tarot-caption-head">
                  <strong>{member.name}</strong>
                  <small>{member.product}</small>
                </div>
                <span className="tarot-status">{statusLabel}</span>
                {member.motto && <p className="tarot-motto">「{member.motto}」</p>}
              </div>
            </div>
          );
        })}
      </div>

      {count > 1 && (
        <div className="tarot-controls" aria-label="立绘轮盘控制">
          <button type="button" className="tarot-ctrl-btn" title="上一位" onClick={() => stepBy(1)}>
            <ChevronLeft size={15} />
          </button>
          <div className="tarot-dots">
            {members.map((member, index) => (
              <button
                key={member.id}
                type="button"
                className={`tarot-dot-btn member-${member.id} ${index === frontIndex ? 'active' : ''}`}
                title={`转到 ${member.name}`}
                onClick={() => focusIndex(index)}
              >
                <span className="tarot-dot-pip" />
                <span>{member.name}</span>
              </button>
            ))}
          </div>
          <button type="button" className="tarot-ctrl-btn" title="下一位" onClick={() => stepBy(-1)}>
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="tarot-ctrl-btn"
            title={autoSpin ? '暂停自动旋转' : '继续自动旋转'}
            onClick={() => setAutoSpin((v) => !v)}
          >
            {autoSpin ? <Pause size={13} /> : <Play size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}
