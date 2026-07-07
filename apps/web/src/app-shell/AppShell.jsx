import { NavLink } from "react-router-dom";
import {
  RolesterSignInButton,
  RolesterUserButton,
  useRolesterUser,
} from "../auth/clerkControls.jsx";
import { IconButton } from "../components/Button.jsx";
import { MoonIcon, SettingsIcon, SunIcon } from "../components/icons.jsx";
import { useTheme } from "../lib/theme.js";
import { ActivityBell } from "./ActivityBell.jsx";
import { CaptureBar } from "./CaptureBar.jsx";
import { DashboardProvider } from "./DashboardContext.jsx";
import { NavList } from "./NavList.jsx";

const HEADER_AVATAR_SIZE = "48px";
const HEADER_USER_BUTTON_APPEARANCE = {
  elements: {
    userButtonTrigger: {
      width: HEADER_AVATAR_SIZE,
      height: HEADER_AVATAR_SIZE,
      minWidth: HEADER_AVATAR_SIZE,
      minHeight: HEADER_AVATAR_SIZE,
      padding: "0",
      borderRadius: "999px",
      overflow: "hidden",
      boxShadow: "none",
    },
    userButtonAvatarBox: {
      width: HEADER_AVATAR_SIZE,
      height: HEADER_AVATAR_SIZE,
      borderRadius: "999px",
      overflow: "hidden",
    },
    avatarBox: {
      width: HEADER_AVATAR_SIZE,
      height: HEADER_AVATAR_SIZE,
      borderRadius: "999px",
      overflow: "hidden",
    },
    avatarImage: {
      width: "100%",
      height: "100%",
      objectFit: "cover",
    },
  },
};

// AppShell — top product navigation + content region, plus (M9) the Roland
// floating capture surface on every route. Mirrors the visual language of
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
        <header className="app-shell__header">
          <div className="app-shell__brand-lockup">
            <div className="app-shell__brand">Rolester</div>
          </div>
          <nav className="app-shell__primary" aria-label="Primary navigation">
            <NavList />
          </nav>
          <div className="app-shell__right">
            <ActivityBell />
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `icon-btn app-shell__utility${isActive ? " app-shell__utility--active" : ""}`
              }
              aria-label="Settings"
              title="Settings"
            >
              <SettingsIcon />
            </NavLink>
            <IconButton
              className="app-shell__utility"
              label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              onClick={toggle}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </IconButton>
            <div className="app-shell__account">
              <HeaderAccount />
            </div>
          </div>
        </header>
        <div className="app-shell__main">
          <main className="app-shell__content">{children}</main>
          <CaptureBar />
        </div>
      </div>
    </DashboardProvider>
  );
}

function HeaderAccount() {
  const { isLoaded, isSignedIn } = useRolesterUser();

  if (!isLoaded) return null;
  if (isSignedIn) {
    return (
      <span className="app-shell__avatar">
        <RolesterUserButton afterSignOutUrl="/app" appearance={HEADER_USER_BUTTON_APPEARANCE} />
      </span>
    );
  }

  return (
    <RolesterSignInButton mode="modal">
      <button type="button" className="app-shell__login">
        Log in
      </button>
    </RolesterSignInButton>
  );
}
