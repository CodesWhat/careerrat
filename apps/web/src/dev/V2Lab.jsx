import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import "./V2Lab.css";

// V2Lab — dev-only design test page at /dev/v2 (see ../App.jsx +
// ./devTools.js for the runtime gate). Two full-viewport skins ("Studio", a
// Photoshop-style pro workspace, and "asciiwerxOS", an ASCII terminal
// desktop) built entirely against the app's existing CSS custom properties
// from ../styles/tokens.css — no new hardcoded colors, so the AccentLab
// accent picker live-drives both. Self-contained: no imports from app
// pages, all data below is fictional.

const SKIN_STORAGE_KEY = "rolester-v2lab-skin";

function readStoredSkin() {
  try {
    const stored = localStorage.getItem(SKIN_STORAGE_KEY);
    if (stored === "studio" || stored === "ascii") return stored;
  } catch {
    /* localStorage unavailable — fall back to default */
  }
  return "studio";
}

// Shared fictional dataset — a small tracked-role roster spanning all three
// fit bands (>=85, 70-84, <70) so both skins can demonstrate fit-driven
// color coding. Halcyon Systems is the "selected" job in both skins.
const FICTIONAL_JOBS = [
  { company: "Halcyon Systems", role: "Staff Platform Engineer", fit: 87, stage: "Technical" },
  { company: "Nimbus Labs", role: "Senior Frontend Engineer", fit: 91, stage: "Onsite" },
  { company: "Meridian Health", role: "Principal Engineer", fit: 88, stage: "Onsite" },
  { company: "Fernbank Robotics", role: "Senior Backend Engineer", fit: 81, stage: "Technical" },
  { company: "Query Peak", role: "Senior Data Engineer", fit: 74, stage: "Offer" },
  { company: "Cobalt Analytics", role: "Engineering Manager", fit: 78, stage: "Screen" },
  { company: "Driftwood Media", role: "Staff Software Engineer", fit: 69, stage: "Screen" },
  { company: "Thistle & Co", role: "Senior Full-Stack Engineer", fit: 63, stage: "Screen" },
];

const FUNNEL_STAGES = [
  { label: "Sourced", count: 29 },
  { label: "Screen", count: 12 },
  { label: "Technical", count: 7 },
  { label: "Onsite", count: 4 },
  { label: "Offer", count: 2 },
  { label: "Closed", count: 1 },
];

const HISTORY = [
  { time: "2h ago", text: "Moved to Technical — Halcyon Systems" },
  { time: "1d ago", text: "Recruiter reply — Nimbus Labs" },
  { time: "2d ago", text: "Tailored resume sent — Meridian Health" },
  { time: "4d ago", text: "Screen scheduled — Cobalt Analytics" },
  { time: "6d ago", text: "Sourced — Query Peak" },
];

const SELECTED_COMPANY = "Halcyon Systems";

export function V2Lab() {
  const [skin, setSkin] = useState(readStoredSkin);

  useEffect(() => {
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, skin);
    } catch {
      /* best-effort persistence only */
    }
  }, [skin]);

  return (
    <div className="v2lab">
      <div className="v2lab__toggle">
        <button
          type="button"
          className={`v2lab__toggle-btn ${skin === "studio" ? "v2lab__toggle-btn--active" : ""}`}
          onClick={() => setSkin("studio")}
        >
          Studio
        </button>
        <button
          type="button"
          className={`v2lab__toggle-btn ${skin === "ascii" ? "v2lab__toggle-btn--active" : ""}`}
          onClick={() => setSkin("ascii")}
        >
          asciiwerxOS
        </button>
        <Link className="v2lab__exit" to="/">
          Exit ✕
        </Link>
      </div>
      {skin === "studio" ? <StudioSkin /> : <AsciiSkin />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared icon primitive — inline SVGs only, never an icon-font ligature (see
// ../components/icons.jsx for why: the legacy dashboard's ".material-symbols-
// outlined" class renders as raw Geist Mono text with no font shipped).

function Icon({ children, size = 16, ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
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

function ChevronIcon(props) {
  return (
    <Icon size={12} {...props}>
      <path d="m5.5 8.5 6.5 7 6.5-7" />
    </Icon>
  );
}

// ---------------------------------------------------------------------------
// Skin A — "Studio": a Photoshop-style pro workspace.

const TOOLS = [
  {
    key: "pointer",
    label: "Move tool",
    render: () => (
      <>
        <path d="M3 3 10.07 19.97 12.58 12.58 19.97 10.07Z" />
        <path d="M13 13l6 6" />
      </>
    ),
  },
  {
    key: "search",
    label: "Search",
    render: () => (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m19.5 19.5-4.3-4.3" />
      </>
    ),
  },
  {
    key: "funnel",
    label: "Funnel",
    render: () => <path d="M4 4h16l-6.5 8.5v7l-3 1.5v-8.6Z" />,
  },
  {
    key: "doc",
    label: "Document",
    render: () => (
      <>
        <path d="M6.5 3.5h7l4 4v13a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
        <path d="M13.5 3.5v4h4" />
      </>
    ),
  },
  {
    key: "calendar",
    label: "Calendar",
    render: () => (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="1.5" />
        <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
      </>
    ),
  },
  {
    key: "chart",
    label: "Chart",
    render: () => (
      <>
        <path d="M4 20V4" />
        <path d="M4 20h16" />
        <path d="M8 16.5v-5" />
        <path d="M12.5 16.5V8" />
        <path d="M17 16.5V9" />
      </>
    ),
  },
  {
    key: "mail",
    label: "Mail",
    render: () => (
      <>
        <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
        <path d="m4.5 7 7.5 6 7.5-6" />
      </>
    ),
  },
  {
    key: "gear",
    label: "Settings",
    render: () => (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.38.62.98 1 1.56 1H21a2 2 0 1 1 0 4h-.08a1.7 1.7 0 0 0-1.52 1Z" />
      </>
    ),
  },
];

const SELECTED_JOB = FICTIONAL_JOBS.find((job) => job.company === SELECTED_COMPANY);

function StudioSkin() {
  return (
    <div className="studio">
      <div className="studio__menubar">
        <span className="studio__brand">Rolester Studio</span>
        <div className="studio__menu">
          {["File", "Edit", "View", "Pipeline", "Window", "Help"].map((label) => (
            <button key={label} type="button" className="studio__menu-item">
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="studio__rail">
        {TOOLS.map((tool, index) => (
          <button
            key={tool.key}
            type="button"
            className={`studio__tool ${index === 0 ? "studio__tool--active" : ""}`}
            aria-label={tool.label}
            title={tool.label}
          >
            <Icon>{tool.render()}</Icon>
          </button>
        ))}
      </div>

      <div className="studio__canvas">
        <div className="studio-doc-wrap">
          <span className="studio-doc-wrap__handle studio-doc-wrap__handle--tl" />
          <span className="studio-doc-wrap__handle studio-doc-wrap__handle--tr" />
          <span className="studio-doc-wrap__handle studio-doc-wrap__handle--bl" />
          <span className="studio-doc-wrap__handle studio-doc-wrap__handle--br" />
          <div className="studio-doc">
            <div className="studio-doc__header">
              <div className="studio-doc__name">Jordan Ellery</div>
              <div className="studio-doc__role">
                {SELECTED_JOB.role} — {SELECTED_JOB.company}
              </div>
            </div>
            <div className="studio-doc__section">
              <div className="studio-doc__section-title">Summary</div>
              <div className="studio-doc__line" style={{ width: "92%" }} />
              <div className="studio-doc__line" style={{ width: "78%" }} />
              <div className="studio-doc__line" style={{ width: "84%" }} />
            </div>
            <div className="studio-doc__section">
              <div className="studio-doc__section-title">Experience</div>
              <div className="studio-doc__line studio-doc__line--strong">
                Nimbus Labs — Senior Platform Engineer
              </div>
              <div className="studio-doc__line" style={{ width: "88%" }} />
              <div className="studio-doc__line" style={{ width: "70%" }} />
              <div className="studio-doc__line studio-doc__line--strong">
                Cobalt Analytics — Platform Engineer II
              </div>
              <div className="studio-doc__line" style={{ width: "80%" }} />
            </div>
          </div>
        </div>
      </div>

      <div className="studio__panels">
        <div className="studio__panel">
          <div className="studio__panel-header">
            <span>Inspector</span>
            <ChevronIcon />
          </div>
          <div className="studio__panel-body">
            <div className="studio__kv">
              <span className="studio__kv-key">Fit</span>
              <span className="studio__kv-value studio__kv-value--fit">{SELECTED_JOB.fit}</span>
            </div>
            <div className="studio__kv">
              <span className="studio__kv-key">Stage</span>
              <span className="studio__stage-pill">{SELECTED_JOB.stage}</span>
            </div>
            <div className="studio__kv">
              <span className="studio__kv-key">Comp band</span>
              <span className="studio__kv-value">$190k–$225k</span>
            </div>
            <div className="studio__kv">
              <span className="studio__kv-key">Source</span>
              <span className="studio__kv-value">Warm intro</span>
            </div>
          </div>
        </div>

        <div className="studio__panel">
          <div className="studio__panel-header">
            <span>Stages</span>
            <ChevronIcon />
          </div>
          <div className="studio__panel-body studio__layers">
            {FUNNEL_STAGES.map((stage) => (
              <div
                key={stage.label}
                className={`studio__layer-row ${
                  stage.label === SELECTED_JOB.stage ? "studio__layer-row--selected" : ""
                }`}
              >
                <Icon size={14} className="studio__layer-eye">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                  <circle cx="12" cy="12" r="3" />
                </Icon>
                <span className="studio__layer-name">{stage.label}</span>
                <span className="studio__layer-count">{stage.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="studio__panel">
          <div className="studio__panel-header">
            <span>History</span>
            <ChevronIcon />
          </div>
          <div className="studio__panel-body">
            {HISTORY.map((entry) => (
              <div key={entry.text} className="studio__history-row">
                <span className="studio__history-time">{entry.time}</span>
                <span className="studio__history-text">{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="studio__status">
        <div className="studio__status-group">
          <span>100%</span>
          <span>halcyon-systems—resume.pdf</span>
          <span>3.2 MB</span>
        </div>
        <div className="studio__status-group">
          <span>
            fit {SELECTED_JOB.fit} · {FUNNEL_STAGES[0].count} tracked
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skin B — "asciiwerxOS": an ASCII terminal-OS desktop.

function fitToneClass(fit) {
  if (fit >= 85) return "ascii-fit--teal";
  if (fit >= 70) return "ascii-fit--mustard";
  return "ascii-fit--coral";
}

function AsciiWindow({ title, className = "", children }) {
  return (
    <div className={`ascii-window ${className}`}>
      <div className="ascii-window__titlebar">
        <span className="ascii-window__title">── {title} ──</span>
        <span className="ascii-window__controls">[x] [□]</span>
      </div>
      <div className="ascii-window__content">{children}</div>
    </div>
  );
}

function AsciiPipelineTable() {
  return (
    <pre className="ascii-table">
      <div className="ascii-table__header">
        {" ".padEnd(1)}
        {"COMPANY".padEnd(19)}
        {"ROLE".padEnd(29)}
        {"FIT".padEnd(5)}
        STAGE
      </div>
      <div className="ascii-table__rule">{"─".repeat(62)}</div>
      {FICTIONAL_JOBS.map((job) => (
        <div
          key={job.company}
          className={`ascii-table__row ${
            job.company === SELECTED_COMPANY ? "ascii-table__row--selected" : ""
          }`}
        >
          <span className="ascii-table__prompt">
            {job.company === SELECTED_COMPANY ? ">" : " "}
          </span>
          <span>{job.company.padEnd(19)}</span>
          <span>{job.role.padEnd(29)}</span>
          <span className={fitToneClass(job.fit)}>{String(job.fit).padStart(3).padEnd(5)}</span>
          <span>{job.stage}</span>
        </div>
      ))}
    </pre>
  );
}

function AsciiFunnelChart() {
  const rows = FUNNEL_STAGES.slice(1);
  const maxCount = Math.max(...rows.map((stage) => stage.count));
  const barWidth = 16;
  return (
    <pre className="ascii-bars">
      {rows.map((stage) => {
        const filled = Math.max(1, Math.round((stage.count / maxCount) * barWidth));
        const empty = barWidth - filled;
        return (
          <div key={stage.label} className="ascii-bars__row">
            <span className="ascii-bars__label">{stage.label.toUpperCase().padEnd(9)}</span>
            <span
              className={`ascii-bars__blocks ${
                stage.label === SELECTED_JOB.stage ? "ascii-bars__blocks--highlight" : ""
              }`}
            >
              {"█".repeat(filled)}
              <span className="ascii-bars__empty">{"░".repeat(empty)}</span>
            </span>
            <span className="ascii-bars__count"> {stage.count}</span>
          </div>
        );
      })}
    </pre>
  );
}

const ACCENT_ROWS = [
  { name: "accent", token: "var(--mustard)" },
  { name: "danger", token: "var(--coral)" },
  { name: "success", token: "var(--teal)" },
  { name: "info", token: "var(--sky)" },
  { name: "highlight", token: "var(--plum)" },
];

function AsciiAccentConfig() {
  return (
    <pre className="ascii-config">
      <div className="ascii-config__comment"># tweak via the Accent chip ↘</div>
      {ACCENT_ROWS.map((row) => (
        <div key={row.name} className="ascii-config__line">
          <span>{row.name.padEnd(12)}=</span>
          <span className="ascii-config__value">{row.token}</span>
          <span className="ascii-config__swatch" style={{ background: row.token }} />
        </div>
      ))}
    </pre>
  );
}

function AsciiSkin() {
  return (
    <div className="ascii">
      <div className="ascii__topbar">
        <span className="ascii__topbar-left">
          [ asciiwerxOS
          ]&nbsp;&nbsp;File&nbsp;&nbsp;Edit&nbsp;&nbsp;View&nbsp;&nbsp;Net&nbsp;&nbsp;Help
        </span>
        <span className="ascii__topbar-clock">13:37</span>
      </div>

      <div className="ascii__desktop">
        <AsciiWindow title="pipeline.txt" className="ascii-window--pipeline">
          <AsciiPipelineTable />
        </AsciiWindow>
        <AsciiWindow title="funnel.dat" className="ascii-window--funnel">
          <AsciiFunnelChart />
        </AsciiWindow>
        <AsciiWindow title="accent.cfg" className="ascii-window--accent">
          <AsciiAccentConfig />
        </AsciiWindow>
      </div>

      <div className="ascii__prompt">
        <span>you@rolester:~$</span>
        <span className="ascii__cursor">▌</span>
      </div>
    </div>
  );
}
