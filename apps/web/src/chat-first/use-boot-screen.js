import { useEffect, useState } from "react";

// Once the boot screen is shown, keep it up for at least this long so a fast
// probe/gate check never reads as a flicker instead of a deliberate screen.
export const BOOT_SCREEN_MIN_VISIBLE_MS = 400;

// `active` is the raw "should we be booting" condition (a gate check, a
// runtime probe, ...). The returned value stays true for at least
// `minVisibleMs` after `active` first goes true, even if `active` flips back
// to false sooner, so callers never need their own delay-on-fetch logic.
export function useMinimumBootScreen(active, minVisibleMs = BOOT_SCREEN_MIN_VISIBLE_MS) {
  const [visible, setVisible] = useState(active);

  useEffect(() => {
    if (active) {
      setVisible(true);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(false), minVisibleMs);
    return () => clearTimeout(timer);
  }, [active, minVisibleMs]);

  return visible;
}
