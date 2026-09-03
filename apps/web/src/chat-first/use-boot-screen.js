import { useEffect, useState } from "react";

// Once the boot screen is shown, keep it up for at least this long so a fast
// probe/gate check never reads as a flicker instead of a deliberate screen.
export const BOOT_SCREEN_MIN_VISIBLE_MS = 400;

// `active` is the raw "should we be booting" condition (a gate check, a
// runtime probe, ...). The returned value stays true until at least
// `minVisibleMs` has passed since the screen first appeared, so a check that
// already took longer than that hands off immediately and a fast one holds
// for the remainder. Callers never need their own delay-on-fetch logic.
export function useMinimumBootScreen(active, minVisibleMs = BOOT_SCREEN_MIN_VISIBLE_MS) {
  const [visible, setVisible] = useState(active);
  // A mutable holder in state rather than a ref, so the timing survives
  // re-renders without ever triggering one.
  const [shown] = useState(() => ({ at: active ? Date.now() : null }));

  useEffect(() => {
    if (active) {
      if (shown.at === null) shown.at = Date.now();
      setVisible(true);
      return undefined;
    }
    if (shown.at === null) {
      setVisible(false);
      return undefined;
    }
    const remaining = Math.max(0, minVisibleMs - (Date.now() - shown.at));
    const timer = setTimeout(() => {
      shown.at = null;
      setVisible(false);
    }, remaining);
    return () => clearTimeout(timer);
  }, [active, minVisibleMs, shown]);

  return visible;
}
