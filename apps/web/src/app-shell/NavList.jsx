import { NavLink } from "react-router-dom";
import {
  CalendarIcon,
  HomeIcon,
  InboxIcon,
  JobsIcon,
  LibraryIcon,
  NetworkIcon,
  OnboardingIcon,
  SettingsIcon,
} from "../components/icons.jsx";
import { useNeedsYouCount } from "./useNeedsYouCount.js";

// Canonical /app product route map: every visible nav item is a React SPA page
// served off the shared GET /api/data/dashboard snapshot where it needs app data.
const NAV_ITEMS = [
  { to: "/", label: "Home", icon: HomeIcon, end: true },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  { to: "/onboarding", label: "Onboarding", icon: OnboardingIcon },
  { to: "/jobs", label: "Jobs", icon: JobsIcon },
  { to: "/calendar", label: "Calendar", icon: CalendarIcon },
  { to: "/network", label: "Network", icon: NetworkIcon },
  { to: "/library", label: "Library", icon: LibraryIcon },
];

export function NavList() {
  // /inbox's badge is a LIVE needs_you count (M9 decisions memo, §5) — hidden
  // entirely at 0 rather than showing a "0" pill, so the nav stays quiet when
  // there's nothing that needs a human.
  const needsYouCount = useNeedsYouCount();

  return (
    <ul className="nav-list">
      {NAV_ITEMS.slice(0, 3).map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
      <NavItem
        to="/inbox"
        label="Inbox"
        icon={InboxIcon}
        badge={needsYouCount > 0 ? String(needsYouCount) : null}
      />
      {NAV_ITEMS.slice(3).map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </ul>
  );
}

function NavItem({ to, label, icon: Icon, end, badge }) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}
      >
        <Icon className="nav-item__icon" />
        <span className="nav-item__label">{label}</span>
        {badge ? <span className="nav-item__badge">{badge}</span> : null}
      </NavLink>
    </li>
  );
}
