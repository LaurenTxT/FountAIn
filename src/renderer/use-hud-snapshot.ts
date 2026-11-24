import { useEffect, useState } from 'react';
import type { HudSnapshot } from '../shared/desktop-hud';

export function useHudSnapshot(enabled = true) {
  const [status, setStatus] = useState<HudSnapshot>();
  useEffect(() => {
    const bridge = window.fountain;
    if (!enabled || !bridge) return;
    let active = true;
    let timer: number | undefined;
    let previous: string | undefined;
    async function refresh() {
      const next = await bridge.invoke<HudSnapshot>('hud.snapshot').catch(() => undefined);
      if (!active) return;
      const signature = next && JSON.stringify(next);
      if (next && signature !== previous) {
        previous = signature;
        setStatus(next);
      }
      timer = window.setTimeout(refresh, 1800);
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled]);
  return status;
}
