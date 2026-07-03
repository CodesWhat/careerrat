import { NavLink } from "react-router-dom";
import {
  CalendarIcon,
  HomeIcon,
  JobsIcon,
  LibraryIcon,
  OnboardingIcon,
  SettingsIcon,
} from "../components/icons.jsx";

// The M7→M10 route stub map (see the M7 design memo's migration table).
// "/" and "/settings" are real M7 pages; the rest render a working
// ComingSoonPage stub so the nav never links to a 404 before its milestone lands.
const ITEMS = [
  { to: "/", label: "Home", icon: HomeIcon, end: true },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
  { to: "/onboarding", label: "Onboarding", icon: OnboardingIcon, badge: "M8" },
  { to: "/jobs", label: "Jobs", icon: JobsIcon, badge: "M10" },
  { to: "/library", label: "Library", icon: LibraryIcon, badge: "M10" },
  { to: "/calendar", label: "Calendar", icon: CalendarIcon, badge: "M10" },
];

export function NavList() {
  return (
    <ul className="nav-list">
      {ITEMS.map(({ to, label, icon: Icon, end, badge }) => (
        <li key={to}>
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
      ))}
    </ul>
  );
}
