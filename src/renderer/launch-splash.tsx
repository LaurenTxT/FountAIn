import { useEffect, useRef, useState } from 'react';

const DISPERSE_START_S = 2.85;
const DISPERSE_DUR_S = 1.22;
const TOTAL_MS = Math.round((DISPERSE_START_S + DISPERSE_DUR_S) * 1000);
const MAX_WAIT_MS = TOTAL_MS + 1400;

interface OrbSpec {
  id: string;
  /** Matches PALETTE index in room-backdrop.tsx: 0=blue, 1=purple, 2=orange, 3=indigo */
  paletteIdx: number;
  orbitPhase: number;
  tx: number;
  ty: number;
  r: number;
  light: string;
  mid: string;
  dark: string;
  glow: string;
}

// Exact 4-orb geometry & palette from build/fountain.png (grows from 18px in Act 1 to 33px final emblem)
const ORBS: OrbSpec[] = [
  { id: 'blue',   paletteIdx: 0, orbitPhase: -Math.PI / 2, tx:   0, ty: -36, r: 16.5, light: '#8eb4ff', mid: '#4472e8', dark: '#2742a3', glow: 'rgba(82, 136, 255, 0.72)' },
  { id: 'orange', paletteIdx: 2, orbitPhase:  Math.PI / 2, tx:   0, ty:   4, r: 16.5, light: '#ffb380', mid: '#ee773c', dark: '#ae453c', glow: 'rgba(240, 124, 68, 0.65)' },
  { id: 'indigo', paletteIdx: 3, orbitPhase:  Math.PI,     tx: -36, ty:  28, r: 16.5, light: '#b3adff', mid: '#7d74db', dark: '#4f48a3', glow: 'rgba(130, 122, 232, 0.62)' },
  { id: 'purple', paletteIdx: 1, orbitPhase:  0,           tx:  36, ty:  28, r: 16.5, light: '#dca3ff', mid: '#a75ce3', dark: '#7232a8', glow: 'rgba(176, 102, 240, 0.62)' },
];

// Exact 4-color palette from room-backdrop.tsx so the dispersed dots hand off seamlessly
const BACKDROP_COLORS = [
  '60, 102, 217',   // 0: Blue
  '163, 91, 219',   // 1: Purple
  '217, 105, 47',   // 2: Orange
  '123, 111, 214',  // 3: Indigo
] as const;

interface GridTarget {
  hx: number;
  hy: number;
  colorIdx: number;
  baseR: number;
  delay: number;
  swirl: number;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function drawSphere(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  orb: OrbSpec,
  alpha = 1,
  pulse = 0,
) {
  if (r <= 0.5 || alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = orb.glow;
  ctx.shadowBlur = 16 + pulse * 16;
  const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.34, r * 0.08, x, y, r);
  g.addColorStop(0, orb.light);
  g.addColorStop(0.58, orb.mid);
  g.addColorStop(1, orb.dark);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + pulse * 0.18})`;
  ctx.beginPath();
  ctx.ellipse(x - r * 0.28, y - r * 0.32, r * 0.32, r * 0.18, -Math.PI / 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function buildBackdropTargets(W: number, H: number): GridTarget[] {
  // Exact pixel alignment with .studio-welcome > .room-backdrop (left: 268px on desktop)
  const left = W > 760 ? 268 : 0;
  const bw = Math.max(1, W - left);
  const spacing = 21;
  const cols = Math.ceil(bw / spacing) + 2;
  const rows = Math.ceil(H / spacing) + 2;
  const offsetX = left + (bw - (cols - 1) * spacing) * 0.5;
  const offsetY = (H - (rows - 1) * spacing) * 0.5;
  const cx = W / 2;
  const cy = H / 2 - 36;
  const maxDist = Math.hypot(bw * 0.6, H * 0.6) || 1;
  const list: GridTarget[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hx = offsetX + c * spacing + (r % 2 === 0 ? 0 : spacing * 0.48);
      const hy = offsetY + r * spacing;
      const band = Math.sin(c * 0.14 + r * 0.10) + Math.cos(r * 0.13 - c * 0.09);
      const colorIdx = Math.abs(Math.floor((band + 2.2) * 1.45 + (c + r) * 0.20)) % 4;
      const dist = Math.hypot(hx - cx, hy - cy) / maxDist;
      list.push({
        hx,
        hy,
        colorIdx,
        baseR: 1.55 + ((c * 7 + r * 13) % 5) * 0.17,
        delay: Math.min(0.18, dist * 0.14),
        swirl: (((c * 31 + r * 17) % 11) - 5) * 0.022,
      });
    }
  }
  return list;
}

export function LaunchSplash({ ready }: { ready: boolean }) {
  const [dispersing, setDispersing] = useState(false);
  const [gone, setGone] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const skipRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const tMax = window.setTimeout(() => setGone(true), MAX_WAIT_MS + 4000);
    return () => window.clearTimeout(tMax);
  }, []);

  useEffect(() => {
    if (gone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ') {
        skipRef.current = true;
        setDispersing(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gone]);

  useEffect(() => {
    if (gone) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let dpr = 1;
    let gridTargets: GridTarget[] = [];

    const syncSize = () => {
      const cw = Math.round(canvas.clientWidth || window.innerWidth);
      const ch = Math.round(canvas.clientHeight || window.innerHeight);
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (cw === W && ch === H && nextDpr === dpr && canvas.width === Math.round(cw * nextDpr) && canvas.height === Math.round(ch * nextDpr)) {
        return;
      }
      W = cw;
      H = ch;
      dpr = nextDpr;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridTargets = buildBackdropTargets(W, H);
    };
    syncSize();
    window.addEventListener('resize', syncSize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncSize) : undefined;
    ro?.observe(canvas);

    let raf = 0;
    let warmup = 0;
    let lastNow: number | null = null;
    let elapsed = 0;
    let disperseAt: number | null = null;
    // Snapshot the exact 4 orb positions at the moment dispersion begins so there is zero jump
    const snapPos: Record<number, { x: number; y: number; r: number }> = {};

    const frame = (now: number) => {
      syncSize();
      // Wait until the Electron window is actually visible & warm before advancing elapsed time
      if (document.hidden || W < 10 || H < 10) {
        lastNow = null;
        raf = window.requestAnimationFrame(frame);
        return;
      }
      if (warmup < 2) {
        warmup++;
        lastNow = now;
        raf = window.requestAnimationFrame(frame);
        return;
      }
      // Clamp per-frame delta to 50ms so cold-start CPU spikes never cause Act 1/2 jumps or glitches
      const step = lastNow === null ? 0 : Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
      lastNow = now;
      elapsed += step;
      const t = elapsed;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const cx = W / 2;
      const cy = H / 2 - 36;

      // Start dispersion when ready & breathing finished, or user clicked/pressed skip
      if (disperseAt === null && ((t >= DISPERSE_START_S && readyRef.current) || skipRef.current)) {
        disperseAt = t;
        setDispersing(true);
      }

      // ─── Act 4: Disperse the 4 spheres smoothly into the pixel-aligned 4-color RoomBackdrop lattice ───
      if (disperseAt !== null) {
        const dt = t - disperseAt;
        const p = Math.min(1, dt / DISPERSE_DUR_S);

        // Smoothly melt the 4 hero spheres over 0.42s as their dots glide outward
        const heroFade = Math.max(0, 1 - easeOutCubic(Math.min(1, dt / 0.42)));
        if (heroFade > 0.01) {
          for (const orb of ORBS) {
            const origin = snapPos[orb.paletteIdx] ?? { x: cx + orb.tx, y: cy + orb.ty, r: orb.r };
            drawSphere(ctx, origin.x, origin.y, origin.r * (0.85 + heroFade * 0.15), orb, heroFade, (1 - heroFade) * 0.5);
          }
        }

        // Batch all gliding dots into 4 ctx.fill() calls; reach true 0 alpha by p=0.90 so unmount causes zero color shift
        const introAlpha = Math.min(1, p / 0.16);
        const settleFade = p > 0.52 ? Math.max(0, 1 - easeInOutCubic(Math.min(1, (p - 0.52) / 0.38))) : 1;
        const dotAlpha = introAlpha * (0.25 + 0.36 * (1 - easeOutCubic(p))) * settleFade;

        if (dotAlpha > 0.006) {
          for (let ci = 0; ci < 4; ci++) {
            const origin = snapPos[ci] ?? { x: cx, y: cy, r: 16.5 };
            ctx.fillStyle = `rgba(${BACKDROP_COLORS[ci]}, ${dotAlpha.toFixed(3)})`;
            ctx.beginPath();
            for (let i = 0; i < gridTargets.length; i++) {
              const g = gridTargets[i];
              if (g.colorIdx !== ci) continue;
              const localP = Math.max(0, Math.min(1, (p - g.delay) / (0.78 - g.delay)));
              if (localP <= 0) continue;
              const ease = easeInOutCubic(localP);
              const dx = g.hx - origin.x;
              const dy = g.hy - origin.y;
              const arc = Math.sin(localP * Math.PI) * g.swirl;
              const px = origin.x + dx * ease - dy * arc;
              const py = origin.y + dy * ease + dx * arc;
              const r = g.baseR + (4.2 - g.baseR) * Math.pow(1 - ease, 1.5);
              ctx.moveTo(px + r, py);
              ctx.arc(px, py, r, 0, Math.PI * 2);
            }
            ctx.fill();
          }
        }

        if (p >= 1) {
          setGone(true);
          return;
        }
        raf = window.requestAnimationFrame(frame);
        return;
      }

      // ─── Act 1 (0.00s → 0.82s): 3D elevated orbit around white pillar ───
      // ─── Act 2 (0.82s → 1.74s): Camera pitches flat + 4 orbs recompose into 33px fountain.png icon ───
      // ─── Act 3 (1.74s → 4.15s): Two calm, lively floating & breathing cycles ───
      const appear = easeOutCubic(Math.min(1, t / 0.45));
      const morphRaw = t <= 0.82 ? 0 : Math.min(1, (t - 0.82) / 0.92);
      const morph = easeInOutCubic(morphRaw);
      const settled = t >= 1.74;
      const holdAge = Math.max(0, t - 1.74);
      const settlePulse = settled ? Math.max(0, Math.sin(Math.min(1, holdAge / 0.42) * Math.PI)) : 0;
      const breathBlend = settled ? easeOutCubic(Math.min(1, holdAge / 0.35)) : 0;

      const spinAngle = t <= 0.82
        ? t * 3.1
        : 0.82 * 3.1 + easeOutCubic(morphRaw) * 2.2;

      const ellipseY = 0.42 + 0.58 * morph;
      const orbitR = 36 * appear;

      const pillarAlpha = Math.max(0, 1 - easeInOutCubic(Math.min(1, Math.max(0, (t - 0.88) / 0.52))));

      // Single clean white ring connecting the 4 spheres while orbiting the central pillar in Act 1
      if (pillarAlpha > 0.01 && orbitR > 1) {
        ctx.save();
        ctx.strokeStyle = `rgba(235, 242, 255, ${0.24 * appear * pillarAlpha})`;
        ctx.lineWidth = 1.2;
        ctx.shadowColor = `rgba(210, 226, 255, ${0.32 * pillarAlpha})`;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.ellipse(cx, cy, orbitR, orbitR * ellipseY, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const items: {
        kind: 'orb' | 'pillar';
        z: number;
        orb?: OrbSpec;
        x?: number;
        y?: number;
        r?: number;
        alpha?: number;
      }[] = [];

      if (pillarAlpha > 0.01) {
        items.push({ kind: 'pillar', z: 0 });
      }

      ORBS.forEach((orb, idx) => {
        const a = orb.orbitPhase + spinAngle;
        const ox = Math.cos(a) * orbitR;
        const oz = Math.sin(a) * orbitR;
        const oy = oz * ellipseY;

        const depthScale = (0.545 + 0.455 * morph) * (1 + (oz / 36) * 0.22 * (1 - morph));
        const depthAlpha = (0.78 + ((oz / 36 + 1) / 2) * 0.22) * (1 - morph) + morph;

        const floatY = breathBlend * Math.sin(holdAge * 3.4 + idx * 0.9) * 3.0;
        const breathScale = 1 + breathBlend * Math.sin(holdAge * 3.0 + idx * 0.65) * 0.048;

        const x = cx + ox * (1 - morph) + orb.tx * morph;
        const y = cy + oy * (1 - morph) + orb.ty * morph + floatY;
        const r = orb.r * appear * depthScale * (1 + settlePulse * 0.05) * breathScale;

        snapPos[orb.paletteIdx] = { x, y, r };

        items.push({
          kind: 'orb',
          z: oz * (1 - morph) + (orb.id === 'orange' ? 0.5 : 0),
          orb,
          x,
          y,
          r,
          alpha: Math.min(1, appear * 1.3) * depthAlpha,
        });
      });

      items.sort((a, b) => a.z - b.z);

      for (const item of items) {
        if (item.kind === 'pillar') {
          const rise = easeOutCubic(Math.min(1, t / 0.4));
          const shrink = 1 - morph * 0.65;
          const stemH = 44 * rise * shrink;
          const baseY = cy + 24 * (1 - morph) + 3 * morph;
          const topY = baseY - stemH;

          const grad = ctx.createLinearGradient(cx, baseY, cx, topY);
          grad.addColorStop(0, `rgba(175, 196, 255, ${0.1 * pillarAlpha})`);
          grad.addColorStop(0.55, `rgba(232, 240, 255, ${0.82 * pillarAlpha})`);
          grad.addColorStop(1, `rgba(255, 255, 255, ${0.98 * pillarAlpha})`);

          ctx.save();
          ctx.strokeStyle = grad;
          ctx.lineWidth = 3 * (1 - morph * 0.3);
          ctx.lineCap = 'round';
          ctx.shadowColor = `rgba(205, 220, 255, ${0.85 * pillarAlpha})`;
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.moveTo(cx, baseY);
          ctx.lineTo(cx, topY);
          ctx.stroke();

          ctx.fillStyle = `rgba(255, 255, 255, ${pillarAlpha})`;
          ctx.beginPath();
          ctx.arc(cx, topY, 3.8 * (1 - morph * 0.35), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (item.orb) {
          const glowPulse = settlePulse + breathBlend * (0.28 + 0.28 * Math.sin(holdAge * 3.0));
          drawSphere(ctx, item.x!, item.y!, item.r!, item.orb, item.alpha!, glowPulse);
        }
      }

      raf = window.requestAnimationFrame(frame);
    };

    raf = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      ro?.disconnect();
    };
  }, [gone]);

  if (gone) return null;

  return (
    <div
      className={`launch-splash ${dispersing ? 'dispersing' : ''}`}
      role="status"
      aria-label="正在启动 FountAIn"
      onClick={() => {
        skipRef.current = true;
        setDispersing(true);
      }}
    >
      <div className="launch-splash-bg" aria-hidden="true" />
      <div className="launch-splash-glow" aria-hidden="true" />
      <canvas ref={canvasRef} className="launch-canvas-full" aria-hidden="true" />
      <div className="launch-splash-core launch-splash-text">
        <h1 className="launch-brand">FountAIn</h1>
      </div>
    </div>
  );
}
