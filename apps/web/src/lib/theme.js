// apps/web/src/lib/theme.js — dark-mode toggle. Mirrors the mechanism
// src/core/tracker/dashboard-shell.html already uses: a "data-theme"
// attribute on <html> ("light"|"dark"), driven by localStorage +
// prefers-color-scheme on first load. Shares the exact same localStorage key
// ("rolester-theme") so a theme choice made in the legacy dashboard or the
// SPA is remembered in both. apps/web/index.html applies the initial value
// before paint (see its inline <script>); this hook only owns runtime toggling.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "rolester-theme";

function readInitialTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    /* localStorage unavailable — fall through to media-query detection */
  }
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* best-effort persistence only */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggle };
}
