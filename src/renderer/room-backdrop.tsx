import { useEffect, useRef, useState } from 'react';

const KEY = 'fountain.room.backdrop', CHANGED = 'fountain:room-backdrop';
/** The four FountAIn AI signature colors: DeepSeek blue, Gemini purple, Claude orange, ChatGPT indigo. */
const PALETTE = [
  [60, 102, 217],   // DeepSeek #3c66d9
  [163, 91, 219],   // Gemini   #a35bdb
  [217, 105, 47],   // Claude   #d9692f
  [123, 111, 214],  // ChatGPT  #7b6fd6
] as const;

interface Dot {
  hx: number; hy: number;
  x: number; y: number;
  vx: number; vy: number;
  colorIdx: number;
  phase: number;
  baseR: number;
}
interface Ripple {
  x: number; y: number;
  radius: number;
  maxRadius: number;
  speed: number;
  strength: number;
}

/** A per-machine display preference; on unless the user turned it off. */
export function roomBackdropEnabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } }
export function setRoomBackdropEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* Still applies until the window reloads. */ }
  window.dispatchEvent(new Event(CHANGED));
}

/** Interactive 4-color flowing particle dot-ripple backdrop ("FountAIn" water-ripple field). */
export function RoomBackdrop() {
  const [on, setOn] = useState(roomBackdropEnabled);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const sync = () => setOn(roomBackdropEnabled());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, []);

  useEffect(() => {
    if (!on) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let width = 0, height = 0, dpr = 1;
    let dots: Dot[] = [];
    const ripples: Ripple[] = [];
    const pointer = { x: -9999, y: -9999, active: false, lastRippleX: -9999, lastRippleY: -9999, lastRippleAt: 0 };

    const rebuildGrid = () => {
      const cw = canvas.clientWidth || canvas.getBoundingClientRect().width;
      const ch = canvas.clientHeight || canvas.getBoundingClientRect().height;
      width = Math.max(1, cw);
      height = Math.max(1, ch);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const spacing = 21;
      const cols = Math.ceil(width / spacing) + 2;
      const rows = Math.ceil(height / spacing) + 2;
      const offsetX = (width - (cols - 1) * spacing) * 0.5;
      const offsetY = (height - (rows - 1) * spacing) * 0.5;
      const next: Dot[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const hx = offsetX + c * spacing + (r % 2 === 0 ? 0 : spacing * 0.48);
          const hy = offsetY + r * spacing;
          // Assign 4 colors in smooth flowing organic bands so clusters drift harmoniously
          const band = Math.sin(c * 0.14 + r * 0.10) + Math.cos(r * 0.13 - c * 0.09);
          const colorIdx = Math.abs(Math.floor((band + 2.2) * 1.45 + (c + r) * 0.20)) % PALETTE.length;
          next.push({
            hx, hy, x: hx, y: hy, vx: 0, vy: 0,
            colorIdx,
            phase: c * 0.20 + r * 0.16,
            baseR: 1.55 + ((c * 7 + r * 13) % 5) * 0.17,
          });
        }
      }
      dots = next;
    };

    rebuildGrid();
    const ro = new ResizeObserver(rebuildGrid);
    ro.observe(canvas);

    const pushRipple = (clientX: number, clientY: number, strength: number, maxRadius: number, speed: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < -120 || y < -120 || x > rect.width + 120 || y > rect.height + 120) return;
      ripples.push({ x, y, radius: 6, maxRadius, speed, strength });
      if (ripples.length > 14) ripples.shift();
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      pointer.x = x;
      pointer.y = y;
      pointer.active = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
      if (!pointer.active || reducedMotion) return;
      const now = performance.now();
      const dist = Math.hypot(x - pointer.lastRippleX, y - pointer.lastRippleY);
      if (dist > 34 && now - pointer.lastRippleAt > 65) {
        pointer.lastRippleX = x;
        pointer.lastRippleY = y;
        pointer.lastRippleAt = now;
        pushRipple(e.clientX, e.clientY, 1.0, 230, 3.6);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (reducedMotion) return;
      pushRipple(e.clientX, e.clientY, 1.75, 340, 4.6);
    };
    const onPointerLeave = () => { pointer.active = false; };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('blur', onPointerLeave);

    const TAU = Math.PI * 2;
    let raf = 0;
    let start = performance.now();
    let lastNow = start;
    let smoothX = -9999;
    let smoothY = -9999;
    let pointerFade = 0;
    const baseFillDark = PALETTE.map(([r, g, b]) => `rgba(${r},${g},${b},0.34)`);
    const baseFillLight = PALETTE.map(([r, g, b]) => `rgba(${r},${g},${b},0.30)`);
    const energized: { x: number; y: number; r: number; a: number; c: number; glow: boolean }[] = [];

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) { lastNow = now; return; }
      const dt = Math.min(Math.max((now - lastNow) / 16.667, 0.25), 2.2);
      lastNow = now;
      const cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1;
      const curDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (Math.abs(cw - width) > 1 || Math.abs(ch - height) > 1 || curDpr !== dpr) {
        rebuildGrid();
      }
      const t = (now - start) * 0.001;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const isLight = document.documentElement.dataset.theme === 'light'
        || (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: light)').matches);

      // Smooth pointer tracking so wake glides like silk
      if (pointer.active && !reducedMotion) {
        if (smoothX < -1000) { smoothX = pointer.x; smoothY = pointer.y; }
        const lerp = 1 - Math.pow(0.76, dt);
        smoothX += (pointer.x - smoothX) * lerp;
        smoothY += (pointer.y - smoothY) * lerp;
        pointerFade = Math.min(1, pointerFade + 0.12 * dt);
      } else {
        pointerFade = Math.max(0, pointerFade - 0.08 * dt);
      }

      // Advance expanding water ripples (delta-time normalized)
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i];
        rp.radius += rp.speed * dt;
        if (rp.radius > rp.maxRadius) ripples.splice(i, 1);
      }

      // Soft ambient fountain glow under pointer
      if (pointerFade > 0.01 && !reducedMotion) {
        const g = ctx.createRadialGradient(smoothX, smoothY, 0, smoothX, smoothY, 195);
        g.addColorStop(0, isLight ? `rgba(123,111,214,${(0.10 * pointerFade).toFixed(3)})` : `rgba(163,91,219,${(0.12 * pointerFade).toFixed(3)})`);
        g.addColorStop(0.55, isLight ? `rgba(60,102,217,${(0.04 * pointerFade).toFixed(3)})` : `rgba(60,102,217,${(0.05 * pointerFade).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(smoothX - 195, smoothY - 195, 390, 390);
      }

      const stiffness = 0.095 * dt;
      const damping = Math.pow(0.84, dt);
      const hasRipples = ripples.length > 0;
      const hasPointer = pointerFade > 0.01 && !reducedMotion;

      // Batch calm dots by color (4 draw calls total -> locked 60/120 FPS!)
      const buckets: Dot[][] = [[], [], [], []];
      energized.length = 0;

      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const waveX = reducedMotion ? 0 : Math.sin(t * 0.65 + d.phase + d.hy * 0.0055) * 6.5 + Math.cos(t * 0.38 - d.hx * 0.0045) * 3.2;
        const waveY = reducedMotion ? 0 : Math.cos(t * 0.58 + d.phase + d.hx * 0.0055) * 6.5 + Math.sin(t * 0.42 + d.hy * 0.0038) * 3.2;
        let tx = d.hx + waveX;
        let ty = d.hy + waveY;
        let energy = 0;

        if (hasPointer) {
          const dx = d.x - smoothX;
          const dy = d.y - smoothY;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0.01 && d2 < 21025) { // 145^2
            const dist = Math.sqrt(d2);
            const pull = (1 - dist / 145) * pointerFade;
            const push = pull * pull * 18;
            tx += (dx / dist) * push;
            ty += (dy / dist) * push;
            energy = pull;
          }
        }

        if (hasRipples) {
          for (let r = 0; r < ripples.length; r++) {
            const rp = ripples[r];
            const dx = d.x - rp.x;
            const dy = d.y - rp.y;
            const dist = Math.hypot(dx, dy);
            const ringDelta = dist - rp.radius;
            const bandWidth = 52;
            if (Math.abs(ringDelta) < bandWidth && dist > 0.1) {
              const fade = 1 - rp.radius / rp.maxRadius;
              const crest = Math.cos((ringDelta / bandWidth) * (Math.PI * 0.5));
              const amp = crest * crest * fade * rp.strength;
              const push = amp * 18;
              tx += (dx / dist) * push;
              ty += (dy / dist) * push;
              if (amp * 1.15 > energy) energy = amp * 1.15;
            }
          }
        }

        d.vx = (d.vx + (tx - d.x) * stiffness) * damping;
        d.vy = (d.vy + (ty - d.y) * stiffness) * damping;
        d.x += d.vx * dt;
        d.y += d.vy * dt;

        if (energy > 0.08) {
          const r = d.baseR + 0.4 + energy * 2.5;
          const a = (isLight ? 0.28 : 0.32) + Math.min(0.62, energy * 0.62);
          energized.push({ x: d.x, y: d.y, r, a, c: d.colorIdx, glow: energy > 0.22 });
        } else {
          buckets[d.colorIdx].push(d);
        }
      }

      const fills = isLight ? baseFillLight : baseFillDark;
      for (let c = 0; c < 4; c++) {
        const list = buckets[c];
        if (!list.length) continue;
        ctx.beginPath();
        for (let i = 0; i < list.length; i++) {
          const d = list[i];
          ctx.moveTo(d.x + d.baseR, d.y);
          ctx.arc(d.x, d.y, d.baseR, 0, TAU);
        }
        ctx.fillStyle = fills[c];
        ctx.fill();
      }

      for (let i = 0; i < energized.length; i++) {
        const e = energized[i];
        const [cr, cg, cb] = PALETTE[e.c];
        if (e.glow) {
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * 2.1, 0, TAU);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(e.a * 0.22).toFixed(3)})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, TAU);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${e.a.toFixed(3)})`;
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onPointerLeave);
    };
  }, [on]);

  if (!on) return null;
  return <div className="room-backdrop fountain-backdrop" aria-hidden="true">
    <canvas ref={canvasRef} className="fountain-canvas" />
  </div>;
}
