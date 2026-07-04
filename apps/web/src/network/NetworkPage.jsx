import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button, IconButton } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { Chip } from "../components/Chip.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { ChatIcon, ChevronDownIcon, ClockIcon, NetworkIcon } from "../components/icons.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import "./NetworkPage.css";

const STATE_BADGE = {
  safe: "badge--ok",
  caution: "badge--warn",
  closed: "badge--muted",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatNetworkDate(value) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "No activity yet";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function stateBadgeClass(company) {
  return STATE_BADGE[company?.reuseState] || "badge--muted";
}

function findOpenCompany(companies, openName) {
  if (!openName) return null;
  return companies.find((company) => company.company === openName) || null;
}

export function NetworkPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();
  const network = data?.network;
  const companies = asArray(network?.companies);
  const openCompany = findOpenCompany(companies, searchParams.get("open"));

  function openDrawer(company) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", company.company);
      return next;
    });
  }

  function closeDrawer() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    });
  }

  if (noDatabase) {
    return (
      <PageScaffold title="Network">
        <InlineAlert message="No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload." />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Network"
      subtitle="Company relationships, warm paths, and safe routing context."
      wide
    >
      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p>Loading…</p> : null}

      {network ? (
        <>
          <NetworkMetrics metrics={network.metrics} />

          {companies.length ? (
            <Card title="Relationship records">
              <div className="network-record-list">
                {companies.map((company) => (
                  <NetworkCompanyRow key={company.company} company={company} onOpen={openDrawer} />
                ))}
              </div>
            </Card>
          ) : (
            <NetworkEmptyState />
          )}

          <NetworkSignals network={network} />
        </>
      ) : null}

      {openCompany ? <NetworkDrawer company={openCompany} onClose={closeDrawer} /> : null}
    </PageScaffold>
  );
}

function NetworkMetrics({ metrics = {} }) {
  const tiles = [
    { label: "Warm Paths", value: metrics.warmPaths || 0 },
    { label: "Companies", value: metrics.companies || 0 },
    { label: "Dormant", value: metrics.dormant || 0 },
  ];
  return (
    <div className="network-metrics">
      {tiles.map((tile) => (
        <div className="network-metric" key={tile.label}>
          <strong>{tile.value}</strong>
          <span>{tile.label}</span>
        </div>
      ))}
    </div>
  );
}

function NetworkCompanyRow({ company, onOpen }) {
  const contactCount = asArray(company.contacts).length;
  return (
    <button type="button" className="network-company-row" onClick={() => onOpen(company)}>
      <CompanyAvatar name={company.company} domain={company.domain} />
      <span className="network-company-row__main">
        <span className="network-company-row__title">
          <span className="network-company-row__company">{company.company}</span>
          <span className={`badge ${stateBadgeClass(company)}`}>{company.stateLabel}</span>
        </span>
        <span className="network-company-row__role">
          {company.role} · {company.status}
        </span>
      </span>
      <span className="network-company-row__meta">
        <Chip>{pluralize(contactCount, "contact")}</Chip>
        <span className="network-company-row__latest">
          <ClockIcon />
          {formatNetworkDate(company.latestAt)}
        </span>
      </span>
      <span className="network-company-row__open">
        <span>Open details</span>
        <ChevronDownIcon />
      </span>
    </button>
  );
}

function NetworkEmptyState() {
  return (
    <Card title="No relationship records yet">
      <p className="network-empty__title">No warm paths are tracked yet.</p>
      <p className="field__hint">
        Incoming communications capture adds recruiter and hiring-team threads here; relationship
        sourcing adds reviewed people once a company needs a contact path.
      </p>
    </Card>
  );
}

function NetworkSignals({ network }) {
  const coverage = network.coverage || {};
  const gaps = asArray(network.gaps);
  const guardrails = asArray(network.guardrails);
  const objections = asArray(network.objections);
  const reviewLeads = asArray(network.sourcing?.reviewLeads);
  const targets = asArray(network.sourcing?.targets);
  const hasSourcingRows = reviewLeads.length || targets.length;
  const hasRoutingRows = guardrails.length || objections.length;

  return (
    <div className="network-secondary-grid">
      <Card title="Coverage">
        <div className="network-coverage">
          <span>
            <strong>{coverage.recruiters || 0}</strong>
            <span>Recruiters</span>
          </span>
          <span>
            <strong>{coverage.hiringManagers || 0}</strong>
            <span>Hiring managers</span>
          </span>
          <span>
            <strong>{coverage.signals || 0}</strong>
            <span>Signals</span>
          </span>
        </div>
        <NetworkTextList title="Map gaps" items={gaps} />
      </Card>

      {hasRoutingRows ? (
        <Card title="Routing guardrails">
          <NetworkTextList title="Use when" items={guardrails} />
          <NetworkTextList title="Memory" items={objections} />
        </Card>
      ) : null}

      {hasSourcingRows ? (
        <Card title="Relationship sourcing">
          <SourcingRows rows={reviewLeads} emptyLabel="No relationship leads waiting for review." />
          <SourcingRows rows={targets} emptyLabel="No unconnected active rows need sourcing." />
        </Card>
      ) : null}
    </div>
  );
}

function NetworkTextList({ title, items }) {
  const values = asArray(items);
  if (!values.length) return null;
  return (
    <div className="network-text-list">
      <p className="field__label">{title}</p>
      <ul className="job-drawer__list">
        {values.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function SourcingRows({ rows, emptyLabel }) {
  const values = asArray(rows);
  if (!values.length) {
    return <p className="field__hint">{emptyLabel}</p>;
  }
  return (
    <div className="network-sourcing-list">
      {values.map((row) => (
        <div className="network-sourcing-row" key={row.id || `${row.company}-${row.name}`}>
          <span className="badge badge--muted">{row.label || "Review lead"}</span>
          <span>
            <strong>{row.name || row.company}</strong>
            <span className="field__hint">
              {row.company}
              {row.title || row.type ? ` · ${row.title || row.type}` : ""}
            </span>
          </span>
          <span className="field__hint">{row.note || row.summary || row.platform}</span>
        </div>
      ))}
    </div>
  );
}

function NetworkDrawer({ company, onClose }) {
  const contacts = asArray(company.contacts);
  const notes = asArray(company.notes);
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop; Escape (above) is the keyboard equivalent
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop; Escape (above) is the keyboard equivalent
    <div className="job-drawer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops the backdrop's click-to-close from firing; not itself an interactive control */}
      <aside
        className="job-drawer network-drawer"
        role="dialog"
        aria-label="Relationship detail"
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton label="Close network detail" className="job-drawer__close" onClick={onClose}>
          ×
        </IconButton>
        <div className="job-drawer__header">
          <CompanyAvatar name={company.company} domain={company.domain} size={36} />
          <div className="job-drawer__header-text">
            <h2 className="job-drawer__company">Relationship detail</h2>
            <p className="job-drawer__role">{company.company}</p>
          </div>
          <span className={`badge ${stateBadgeClass(company)}`}>{company.stateLabel}</span>
        </div>

        <Card title="Company context">
          <div className="network-detail-grid">
            <span>
              <span className="field__label">Role</span>
              <strong>{company.role}</strong>
            </span>
            <span>
              <span className="field__label">Status</span>
              <strong>{company.status}</strong>
            </span>
            <span>
              <span className="field__label">Latest activity</span>
              <strong>{formatNetworkDate(company.latestAt)}</strong>
            </span>
          </div>
        </Card>

        <Card title="Contacts">
          {contacts.length ? (
            <div className="network-contact-list">
              {contacts.map((contact) => (
                <div className="network-contact" key={`${contact.type}-${contact.name}`}>
                  <span className="network-contact__icon">
                    <NetworkIcon />
                  </span>
                  <span>
                    <span className="badge badge--muted">{contact.type || "Contact"}</span>
                    <strong>{contact.name || "Contact"}</strong>
                    <span className="field__hint">
                      {contact.note || "Relationship context captured."}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="field__hint">
              No named contacts yet. Human thread details will appear after they are captured.
            </p>
          )}
        </Card>

        <Card title="Conversation timeline">
          {notes.length ? (
            <ul className="job-drawer__timeline">
              {notes.map((note, index) => (
                <li className="job-drawer__timeline-item" key={note}>
                  <span className="job-drawer__timeline-icon">
                    <ChatIcon />
                  </span>
                  <span>
                    <span className="job-drawer__timeline-title">Signal {index + 1}</span>
                    <span className="job-drawer__timeline-desc">{note}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field__hint">No captured conversation notes yet.</p>
          )}
        </Card>

        <Card title={company.reuseTitle || "Relationship routing"}>
          <p>{company.reuseBody || "Use this relationship only when the ask is specific."}</p>
          <div className="chip-row">
            <Chip>{company.reuseScope || "Same-company routing"}</Chip>
            <Chip>Next safe touch: {company.nextTouch || "When specific"}</Chip>
          </div>
        </Card>

        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </aside>
    </div>
  );
}
