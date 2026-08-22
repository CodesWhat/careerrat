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

function HomeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9" />
    </Svg>
  );
}

export function SettingsIcon(props) {
  return (
    <Svg data-icon="settings" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.38.62.98 1 1.56 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z" />
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

export function PulseIcon(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 12h3l2-5.5 4.5 12 2.4-6.5h5.1" />
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

export function PaperclipIcon(props) {
  return (
    <Svg {...props}>
      <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 1 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </Svg>
  );
}

export function InfoIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 10.8v5.2" />
      <path d="M12 8h.01" />
    </Svg>
  );
}

export function ArrowLeftIcon(props) {
  return (
    <Svg {...props}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Svg>
  );
}

export function ArrowRightIcon(props) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
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

function SendIcon(props) {
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

function FlagIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 20V4" />
      <path d="M6 5h11l-2.5 4L17 13H6" />
    </Svg>
  );
}

function PhoneIcon(props) {
  return (
    <Svg {...props}>
      <path d="M6 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 4.5 5.1 1.5 1.5 0 0 1 6 3.5Z" />
    </Svg>
  );
}

function MailIcon(props) {
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

function AlertIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 4 2.5 20h19Z" />
      <path d="M12 10v4M12 16.5v.1" />
    </Svg>
  );
}

function ChatIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 5.5h15v10h-8l-4 3v-3h-3Z" />
    </Svg>
  );
}

function BuildingIcon(props) {
  return (
    <Svg {...props}>
      <rect x="5" y="3.5" width="10" height="17" rx="1" />
      <rect x="15" y="9.5" width="4.5" height="11" rx="1" />
      <path d="M8 7.5h.01M11.5 7.5h.01M8 11h.01M11.5 11h.01M8 14.5h.01M11.5 14.5h.01" />
    </Svg>
  );
}

function TruckIcon(props) {
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

export function ChevronDownIcon(props) {
  return (
    <Svg {...props}>
      <path d="m5.5 8.5 6.5 7 6.5-7" />
    </Svg>
  );
}

// W3 — the ask bar's send control (28px cobalt circle, up-arrow glyph).
export function ArrowUpIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </Svg>
  );
}

// Chat activity icons — see onboarding/chatActivity.jsx's tool-name -> icon
// map. Same inline-stroke-SVG convention as every icon above.

export function EyeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function GlobeIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5Z" />
    </Svg>
  );
}

export function PencilIcon(props) {
  return (
    <Svg {...props}>
      <path d="m4 20 .9-4.2L15.8 5 19 8.2 8.1 19.1 4 20Z" />
      <path d="m13.8 6.9 3.3 3.3" />
    </Svg>
  );
}

export function TerminalIcon(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <path d="m6.5 9.5 3.5 2.5-3.5 2.5" />
      <path d="M12.5 15.5h5" />
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
