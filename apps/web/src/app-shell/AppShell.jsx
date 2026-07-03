import { IconButton } from "../components/Button.jsx";
import { MoonIcon, SunIcon } from "../components/icons.jsx";
import { useTheme } from "../lib/theme.js";
import { NavList } from "./NavList.jsx";

// AppShell — fixed left nav + content region. Mirrors the visual language of
// src/core/tracker/dashboard-shell.html's header chrome (translucent
// surface, Geist type), not its markup — the SPA hand-writes its own CSS
// against the copied token set (see ../styles/tokens.css).
export function AppShell({ children }) {
  const { theme, toggle } = useTheme();

  return (
    <div className="app-shell">
      <nav className="app-shell__nav" aria-label="Primary">
        <div className="app-shell__brand">Rolester</div>
        <NavList />
        <div className="app-shell__nav-footer">
          <IconButton
            label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggle}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconButton>
        </div>
      </nav>
      <main className="app-shell__content">{children}</main>
    </div>
  );
}
