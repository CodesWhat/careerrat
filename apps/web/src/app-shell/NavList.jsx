import { NavLink } from "react-router-dom";
import {
  CalendarIcon,
  HomeIcon,
  InboxIcon,
  JobsIcon,
  LibraryIcon,
  OnboardingIcon,
  SettingsIcon,
} from "../components/icons.jsx";
import { useNeedsYouCount } from "./useNeedsYouCount.js";

// The M7→M10 route stub map (see the M7 design memo's migration table).
// "/", "/settings", "/onboarding", and (M9) "/inbox" are real pages now; the
// rest render a working ComingSoonPage stub so the nav never links to a 404
// before its milestone lands.
const STUB_ITEMS = [
  { to: "/", label: "Home", icon: HomeIcon, end: true },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  { to: "/onboarding", label: "Onboarding", icon: OnboardingIcon },
  { to: "/jobs", label: "Jobs", icon: JobsIcon, badge: "M10" },
  { to: "/library", label: "Library", icon: LibraryIcon, badge: "M10" },
  { to: "/calendar", label: "Calendar", icon: CalendarIcon, badge: "M10" },
];

export function NavList() {
  // Unlike every static "M10" placeholder above, /inbox's badge is a LIVE
  // needs_you count (M9 decisions memo, §5) — hidden entirely at 0 rather
  // than showing a "0" pill, so the nav stays quiet when there's nothing
  // that needs a human.
  const needsYouCount = useNeedsYouCount();

  return (
    <ul className="nav-list">
      {STUB_ITEMS.slice(0, 3).map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
      <NavItem
        to="/inbox"
        label="Inbox"
        icon={InboxIcon}
        badge={needsYouCount > 0 ? String(needsYouCount) : null}
      />
      {STUB_ITEMS.slice(3).map((item) => (
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
