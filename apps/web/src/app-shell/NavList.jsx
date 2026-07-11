import { NavLink } from "react-router-dom";

// Canonical /app product route map: every visible nav item is a React SPA page
// served off the shared GET /api/data/dashboard snapshot where it needs app data.
export const PRIMARY_NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/calendar", label: "Calendar" },
  { to: "/jobs", label: "Jobs" },
  { to: "/network", label: "Network" },
  { to: "/library", label: "Library" },
];

export function NavList() {
  return (
    <ul className="nav-list">
      {PRIMARY_NAV_ITEMS.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
    </ul>
  );
}

function NavItem({ to, label, end }) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}
      >
        <span className="nav-item__label">{label}</span>
      </NavLink>
    </li>
  );
}
