// apps/web/src/components/icons.jsx — inline SVG icons only, never a
// material-symbols-outlined-style ligature span. The legacy dashboard shell
// ships a class named ".material-symbols-outlined" that is actually styled
// as plain Geist Mono TEXT (no icon font is shipped) — ligatures render as
// raw words. The SPA must not repeat that mistake; every icon here is a real
// stroke-based <svg>, matching the visual language already used throughout
// dashboard-shell.html's header icons.

function Svg({ children, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" />
    </Svg>
  );
}

export function SettingsIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2M12 18.5v2M4.8 6.3l1.4 1.4M17.8 16.3l1.4 1.4M3.5 12h2M18.5 12h2M4.8 17.7l1.4-1.4M17.8 7.7l1.4-1.4" />
    </Svg>
  );
}

export function OnboardingIcon(props) {
  return (
    <Svg {...props}>
      <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M14 4v5h5" />
      <path d="M8.5 13.5h7M8.5 17h5" />
    </Svg>
  );
}

export function JobsIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="7.5" width="17" height="12" rx="1.5" />
      <path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5" />
      <path d="M3.5 12.5h17" />
    </Svg>
  );
}

export function LibraryIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 4.5h5.5v15H4.5z" />
      <path d="M13.2 5.1l5 1.4-3.9 14.5-5-1.4z" />
    </Svg>
  );
}

export function CalendarIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="1.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </Svg>
  );
}

// M9 — the docked capture bar + /inbox nav entry.
export function InboxIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 12.5h5l1.8 3h3.4l1.8-3h5" />
      <path d="M5.5 6.5h13l2 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19V12.5z" />
    </Svg>
  );
}

export function SunIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </Svg>
  );
}

export function MoonIcon(props) {
  return (
    <Svg {...props}>
      <path d="M20 14.2A8.5 8.5 0 1 1 9.8 4a6.8 6.8 0 0 0 10.2 10.2Z" />
    </Svg>
  );
}

// M8 onboarding wizard additions — same inline-stroke-SVG convention as
// every icon above (never a ligature-font glyph).

export function CheckIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </Svg>
  );
}

export function UploadIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

// M10 additions — the Jobs/Calendar/Activity-bell surfaces. Same inline-SVG
// convention as every icon above.

export function BellIcon(props) {
  return (
    <Svg {...props}>
      <path d="M7 9a5 5 0 0 1 10 0c0 4.5 1.5 6 2 6.5H5c.5-.5 2-2 2-6.5Z" />
      <path d="M10.3 19a1.8 1.8 0 0 0 3.4 0" />
    </Svg>
  );
}

export function SendIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5 20 4l-8.5 15.5-2-6.5-6.5-2Z" />
      <path d="M11.5 12.5 20 4" />
    </Svg>
  );
}

export function StarIcon(props) {
  return (
    <Svg {...props}>
      <path d="m12 4 2.5 5.2 5.7.8-4.1 4 1 5.7L12 17l-5.1 2.7 1-5.7-4.1-4 5.7-.8Z" />
    </Svg>
  );
}

export function FlagIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 20V4" />
      <path d="M6 5h11l-2.5 4L17 13H6" />
    </Svg>
  );
}

export function PhoneIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 4.5 5.1 1.5 1.5 0 0 1 6 3.5Z" />
    </Svg>
  );
}

export function MailIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4.5 7 7.5 6 7.5-6" />
    </Svg>
  );
}

export function SearchIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m19.5 19.5-4.3-4.3" />
    </Svg>
  );
}

export function ClockIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function AlertIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 4 2.5 20h19Z" />
      <path d="M12 10v4M12 16.5v.1" />
    </Svg>
  );
}

export function ChatIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5h15v10h-8l-4 3v-3h-3Z" />
    </Svg>
  );
}

export function BuildingIcon(props) {
  return (
    <Svg {...props}>
      <rect x="5" y="3.5" width="10" height="17" rx="1" />
      <rect x="15" y="9.5" width="4.5" height="11" rx="1" />
      <path d="M8 7.5h.01M11.5 7.5h.01M8 11h.01M11.5 11h.01M8 14.5h.01M11.5 14.5h.01" />
    </Svg>
  );
}

export function TruckIcon(props) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="7.5" width="11" height="9" rx="1" />
      <path d="M13.5 10.5H17l3 3v3h-6.5Z" />
      <circle cx="7" cy="18.5" r="1.5" />
      <circle cx="16.5" cy="18.5" r="1.5" />
    </Svg>
  );
}

export function ListIcon(props) {
  return (
    <Svg {...props}>
      <path d="M8 6.5h12M8 12h12M8 17.5h12" />
      <path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
    </Svg>
  );
}

export function CheckCircleIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.3 2.5 2.5 5-5.2" />
    </Svg>
  );
}

export function ChevronDownIcon(props) {
  return (
    <Svg {...props}>
      <path d="m5.5 8.5 6.5 7 6.5-7" />
    </Svg>
  );
}

// Keyed lookup for icon strings the server-derived view model carries
// (dashboard-data.js row.modeIcon/sourceIcon, jobs.funnel[].icon,
// drawer.timeline[].icon, calendar event kinds). Not every legacy icon key is
// covered — only the ones the M10 surfaces actually render; unknown keys fall
// back to ListIcon rather than throwing, since a missing icon key is a
// cosmetic gap, not a functional error.
const ICON_BY_KEY = {
  send: SendIcon,
  star: StarIcon,
  flag: FlagIcon,
  home: HomeIcon,
  hybrid: BuildingIcon,
  phone: PhoneIcon,
  mail: MailIcon,
  search: SearchIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  alert: AlertIcon,
  chat: ChatIcon,
  "building-2": BuildingIcon,
  truck: TruckIcon,
  check: CheckIcon,
  list: ListIcon,
};

export function KeyIcon({ iconKey, ...props }) {
  const Icon = ICON_BY_KEY[iconKey] || ListIcon;
  return <Icon {...props} />;
}
