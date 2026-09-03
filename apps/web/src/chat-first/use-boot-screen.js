import { useEffect, useState } from "react";

// Once the boot screen is shown, keep it up for at least this long so a fast
// probe/gate check never reads as a flicker instead of a deliberate screen.
export const BOOT_SCREEN_MIN_VISIBLE_MS = 400;

// One clock per page load. App shows the boot screen during its gate check
// and FirstRunController shows it again during the runtime probe; both count
// the minimum from the first time either of them painted it, so a fast start
// pays the minimum once, not once per stage.
let bootShownAt = null;

export function resetBootScreenClock() {
  bootShownAt = null;
}

// `active` is the raw "should we be booting" condition (a gate check, a
// runtime probe, ...). The result is true whenever `active` is, and stays
// true afterwards only until the shared minimum has elapsed, so a check that
// already took longer hands off at once and a fast one holds the remainder.
export function useMinimumBootScreen(active, minVisibleMs = BOOT_SCREEN_MIN_VISIBLE_MS) {
  const [holding, setHolding] = useState(active);
  if (active && bootShownAt === null) bootShownAt = Date.now();

  useEffect(() => {
    if (active) {
      setHolding(true);
      return undefined;
    }
    if (bootShownAt === null) {
      setHolding(false);
      return undefined;
    }
    const remaining = Math.max(0, minVisibleMs - (Date.now() - bootShownAt));
    const timer = setTimeout(() => setHolding(false), remaining);
    return () => clearTimeout(timer);
  }, [active, minVisibleMs]);

  return active || holding;
}
