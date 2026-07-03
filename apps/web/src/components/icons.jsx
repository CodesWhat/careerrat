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
