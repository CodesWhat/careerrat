import { NavLink } from "react-router-dom";
import {
  CalendarIcon,
  HomeIcon,
  InboxIcon,
  JobsIcon,
  LibraryIcon,
  ListIcon,
  NetworkIcon,
  OnboardingIcon,
  SettingsIcon,
} from "../components/icons.jsx";
import { useNeedsYouCount } from "./useNeedsYouCount.js";

// Route map: every nav item is a real SPA page served off the shared
// GET /api/data/dashboard snapshot. Network and Library now have SPA views
// (retirement-gate work); the Classic item stays a genuine EXTERNAL link to
// the legacy dashboard (`/tracker`, still served by tracker-dev.mjs) until
// the remaining retirement gates clear (Sankey + the demo bundle).
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
      <ExternalNavItem href="/tracker" label="Classic" icon={ListIcon} />
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

// A genuine full-navigation link-out (leaves the SPA for the legacy
// dashboard's own HTML page) — a plain <a>, never a react-router <NavLink>,
// so the browser does a real navigation instead of a client-route no-op.
function ExternalNavItem({ href, label, icon: Icon }) {
  return (
    <li>
      <a href={href} className="nav-item" title={`${label} (legacy dashboard)`}>
        <Icon className="nav-item__icon" />
        <span className="nav-item__label">{label}</span>
      </a>
    </li>
  );
}
