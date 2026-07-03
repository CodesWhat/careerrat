import { IconButton } from "../components/Button.jsx";
import { MoonIcon, SunIcon } from "../components/icons.jsx";
import { useTheme } from "../lib/theme.js";
import { ActivityBell } from "./ActivityBell.jsx";
import { CaptureBar } from "./CaptureBar.jsx";
import { DashboardProvider } from "./DashboardContext.jsx";
import { NavList } from "./NavList.jsx";

// AppShell — fixed left nav + content region, plus (M9) a docked capture bar
// pinned under the content on every route. Mirrors the visual language of
// src/core/tracker/dashboard-shell.html's header chrome (translucent
// surface, Geist type), not its markup — the SPA hand-writes its own CSS
// against the copied token set (see ../styles/tokens.css).
//
// M10: DashboardProvider wraps everything below it — same "mounted once,
// cross-cutting" precedent as CaptureBar/NavList's needsYouCount badge — so
// Home/Jobs/Calendar and the header ActivityBell all read one shared
// GET /api/data/dashboard poll (see DashboardContext.jsx).
export function AppShell({ children }) {
  const { theme, toggle } = useTheme();

  return (
    <DashboardProvider>
      <div className="app-shell">
        <nav className="app-shell__nav" aria-label="Primary">
          <div className="app-shell__brand">Rolester</div>
          <NavList />
          <div className="app-shell__nav-footer">
            <ActivityBell />
            <IconButton
              label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={toggle}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </IconButton>
          </div>
        </nav>
        <div className="app-shell__main">
          <main className="app-shell__content">{children}</main>
          <CaptureBar />
        </div>
      </div>
    </DashboardProvider>
  );
}
