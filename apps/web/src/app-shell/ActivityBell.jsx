// apps/web/src/app-shell/ActivityBell.jsx — the M10 Activity Pulse header
// bell (M10 design doc §1: "cross-cutting chrome in AppShell.jsx, not a
// route... read-only (activityCta() always "", never render a button on a
// pulse row)"). Feed is `dashboardData.activity` — buildActivityPulse's
// output, already carried on the shared GET /api/data/dashboard payload
// (see DashboardContext.jsx) rather than a second independent poll.
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../components/Button.jsx";
import { BellIcon, KeyIcon } from "../components/icons.jsx";
import { useDashboardSnapshot } from "./DashboardContext.jsx";

// buildActivityPulse's `type` enum (dashboard-data.js's ACTIVITY_TYPE_STYLE)
// mapped to one of icons.jsx's KeyIcon keys — the payload's own `iconPath` is
// raw SVG path markup meant for the legacy dashboard's dangerouslySetInnerHTML
// render; this repo's own icon set covers the same semantics without that.
const TYPE_ICON = {
  sourced: "search",
  evaluated: "check",
  tailored: "chat",
  drafted: "mail",
  applied: "send",
  research: "search",
  negotiation: "chat",
  status_change: "clock",
  message: "mail",
  interview: "calendar",
  system: "list",
  offer: "star",
  failure: "alert",
};

export function ActivityBell() {
  const { data } = useDashboardSnapshot();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const events = data?.activity || [];

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="activity-bell" ref={rootRef}>
      <IconButton
        label="Activity"
        className="app-shell__utility"
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
      </IconButton>
      {open ? (
        <div className="activity-bell__popover">
          <div className="activity-bell__header">Activity</div>
          {events.length === 0 ? (
            <p className="field__hint" style={{ margin: "0 12px 12px" }}>
              Nothing tracked yet — activity shows up here as the tracker changes.
            </p>
          ) : (
            <ul className="activity-bell__list">
              {events.map((e) => (
                <li key={e.id} className="activity-bell__item">
                  <span className={`activity-bell__dot ${e.dotClass || ""}`.trim()}>
                    <KeyIcon iconKey={TYPE_ICON[e.type] || "list"} className={e.iconClass} />
                  </span>
                  <span className="activity-bell__body">
                    <span className="activity-bell__title">{e.title}</span>
                    {e.summary ? <span className="activity-bell__summary">{e.summary}</span> : null}
                    <span className="activity-bell__meta">{e.relTime}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
