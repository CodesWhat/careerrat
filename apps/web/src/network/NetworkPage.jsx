// apps/web/src/network/NetworkPage.jsx — the person-first list from
// docs/NETWORK_UX_RESEARCH.md ("The target shape"). Renders network.* fields
// the way DashboardContext.jsx's data contract requires: `data.network` is
// the unmodified output of buildNetwork() (src/core/tracker/dashboard-data.js)
// — every company's `reuseState/reuseTitle/reuseBody/reuseScope/nextTouch` is
// rendered as-is, never re-derived. Flattening `company.contacts[]` into one
// card per person (buildPeopleCards) and the needs-touch sort are the only
// client-side reshaping, lifted from NetworkV2Page.jsx's already-correct
// logic; both derive nothing the server doesn't already own — see
// NETWORK_UX_RESEARCH.md's "Data" section. Everything else that page and its
// predecessors carried (metrics hero, Coverage panel, Next Touch panel,
// Relationship Memory panel) is cut per the research verdict: REDUCE to one
// list, not KEEP the scaffolding around it.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button, IconButton } from "../components/Button.jsx";
import { CompanyAvatar } from "../components/CompanyAvatar.jsx";
import { ArrowRightIcon, CheckIcon, ClockIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { setRelationshipLeadStatus } from "../lib/api.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
import { PREVIEW_NETWORK } from "./networkPreviewData.js";
import "./NetworkPage.css";

const STATE_LABEL = { safe: "Warm path", caution: "In process", closed: "Closed" };
const STATE_ICON = { safe: ArrowRightIcon, caution: ClockIcon, closed: CheckIcon };
const PLATFORM_LABEL = {
  email: "Email",
  linkedin: "LinkedIn",
  wellfound: "Wellfound",
  portal: "Portal",
  phone: "Phone",
  sms: "SMS",
  other: "Other",
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const ABS_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  return NUMBER_FORMAT.format(Number(value) || 0);
}

// "The relative latest-activity date" (NETWORK_UX_RESEARCH.md, target shape
// §2) — pure display formatting over a server timestamp, same kind of
// client-side date math CalendarPage.jsx does for bucket placement; it
// derives no state the server doesn't already own.
function formatRelativeDate(value, now = new Date()) {
  if (!value) return "No activity";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "No activity";
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOfDay(now) - startOfDay(date)) / dayMs);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return ABS_DATE_FORMAT.format(date);
}

function platformLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return PLATFORM_LABEL[text.toLowerCase()] || text.charAt(0).toUpperCase() + text.slice(1);
}

function personInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

// Harmonized hues (same saturation/lightness family) so the monograms read as a
// varied-but-tasteful set rather than a sea of identical coral circles. The hue
// is picked by a stable hash of the name, so a given person always keeps theirs.
const AVATAR_HUES = [4, 20, 34, 48, 150, 172, 196, 214, 250, 286, 316, 338];

function avatarStyle(name) {
  const label = String(name || "");
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  return {
    background: `hsl(${hue} 55% 48%)`,
  };
}

function stateKey(company) {
  return company?.reuseState || "closed";
}

function stateLabel(company) {
  return company?.stateLabel || STATE_LABEL[stateKey(company)] || "Tracked";
}

// nextTouch copy is server-generated from a small fixed set of phrases
// (networkDueLabel(), dashboard-data.js) — this regex is a heuristic standing
// in for a real boolean; NETWORK_UX_RESEARCH.md recommends the server emit
// `company.needsTouch` directly, flagged there, kept as-is here.
function needsTouch(card) {
  return /today|now|after|follow|ask|reply|due/i.test(card.nextTouch || "");
}

export function filterPeople(people, { query = "", state = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return asArray(people).filter((card) => {
    if (state === "needs-touch" && !needsTouch(card)) return false;
    if (state !== "all" && state !== "needs-touch" && card.state !== state) return false;
    if (!needle) return true;
    return [card.name, card.company, card.type, card.title, card.email]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
}

function hasNetworkContent(network) {
  return asArray(network?.companies).length > 0;
}

function networkForPage(network) {
  if (hasNetworkContent(network)) return network;
  return import.meta.env.DEV ? PREVIEW_NETWORK : network;
}

// Flattens network.companies[].contacts[] into one card per named person —
// falls back to a single "company memory" card when a tracked company has
// zero named contacts yet, a real gap signal worth keeping, not noise.
// Ported from NetworkV2Page.jsx's buildPeopleCards, which the research doc
// confirms is already correct.
function buildPeopleCards(network) {
  return asArray(network?.companies).flatMap((company) => {
    const contacts = asArray(company.contacts);
    if (!contacts.length) {
      return [
        {
          id: `${company.company}::company-memory`,
          name: `${company.company} memory`,
          type: "Company memory",
          company: company.company,
          domain: company.domain,
          warmth: company.warmth || 0,
          latestAt: company.latestAt,
          nextTouch: company.nextTouch || "When specific",
          state: stateKey(company),
          stateLabel: stateLabel(company),
          companyRecord: company,
        },
      ];
    }

    return contacts.map((contact) => ({
      id: `${company.company}::${contact.name || contact.type || "contact"}`,
      name: contact.name || `${company.company} contact`,
      type: contact.type || "Contact",
      company: company.company,
      domain: company.domain,
      warmth: company.warmth || 0,
      // Every contact at a company currently shows the COMPANY's latestAt,
      // not a per-contact date — company.contacts[] has no per-contact
      // timestamp field yet. Flagged in NETWORK_UX_RESEARCH.md's "Data"
      // section as a real gap; fixing it needs addNetworkContact()
      // (dashboard-data.js) to start tracking one, not solvable here in the
      // render layer.
      latestAt: company.latestAt,
      nextTouch: company.nextTouch || "When specific",
      state: stateKey(company),
      stateLabel: stateLabel(company),
      companyRecord: company,
      // Richer per-contact fields addNetworkContact() (dashboard-data.js) now
      // captures — thin data is normal here, the drawer hides whatever's absent.
      email: contact.email || "",
      title: contact.title || "",
      platform: contact.platform || "",
      note: contact.note || "",
      applicationId: company.applicationId || "",
      history: asArray(company.history),
    }));
  });
}

// Needs-touch first, then warmth, then recency — the ordering
// NetworkV2Page.jsx's sortedForAction used for its (now-cut) Next Touch
// panel; here it drives the one list directly instead.
function sortPeople(people) {
  return [...people].sort((a, b) => {
    const touchDelta = Number(needsTouch(b)) - Number(needsTouch(a));
    if (touchDelta) return touchDelta;
    const warmthDelta = (b.warmth || 0) - (a.warmth || 0);
    if (warmthDelta) return warmthDelta;
    return new Date(b.latestAt || 0).valueOf() - new Date(a.latestAt || 0).valueOf();
  });
}

function buildNetworkModel(network) {
  const people = sortPeople(buildPeopleCards(network));
  return {
    people,
    peopleCount: people.length,
    needsTouchCount: people.filter(needsTouch).length,
    reviewLeads: asArray(network?.sourcing?.reviewLeads),
    targets: asArray(network?.sourcing?.targets),
  };
}

function findOpenCard(people, openId) {
  if (!openId) return null;
  return people.find((card) => card.id === openId) || null;
}

export function NetworkPage() {
  const { data, loading, error, noDatabase, refetch } = useDashboardSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [state, setState] = useState("all");
  const [busyLeadId, setBusyLeadId] = useState(null);
  const [leadError, setLeadError] = useState(null);
  const network = data ? networkForPage(data.network) : null;
  const model = buildNetworkModel(network);
  const visiblePeople = filterPeople(model.people, { query, state });
  const openCard = findOpenCard(model.people, searchParams.get("open"));

  function openDrawer(card) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("open", card.id);
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

  async function decideLead(lead, status) {
    if (!lead?.id || busyLeadId) return;
    setBusyLeadId(lead.id);
    setLeadError(null);
    try {
      await setRelationshipLeadStatus({
        id: lead.id,
        status,
        ...(status === "rejected"
          ? { note: "Candidate rejected this lead from Network review." }
          : {}),
      });
      await refetch();
    } catch (err) {
      const resolved = resolveErrorCopy(err);
      setLeadError(
        resolved.action?.retry
          ? {
              ...resolved,
              action: { ...resolved.action, onRetry: () => decideLead(lead, status) },
            }
          : resolved
      );
    } finally {
      setBusyLeadId(null);
    }
  }

  if (noDatabase) {
    return (
      <div className="network">
        <InlineAlert message="This workspace hasn't finished setup yet. Finish setup, then reload." />
      </div>
    );
  }

  return (
    <div className="network">
      <NetworkHero needsTouchCount={model.needsTouchCount} peopleCount={model.peopleCount} />

      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      {loading ? <p className="dashboard-home__loading">Loading…</p> : null}

      <NetworkControls
        count={visiblePeople.length}
        onQueryChange={setQuery}
        onStateChange={setState}
        query={query}
        state={state}
      />

      <PeopleList
        emptyMessage={
          model.people.length && !visiblePeople.length
            ? "No relationships match this search and filter."
            : ""
        }
        onOpen={openDrawer}
        people={visiblePeople}
      />

      {leadError ? (
        <InlineAlert
          action={leadError.action}
          detail={leadError.detail}
          message={leadError.message}
        />
      ) : null}
      <SourcingSection
        busyLeadId={busyLeadId}
        leads={model.reviewLeads}
        onDecide={decideLead}
        targets={model.targets}
      />

      {openCard ? <NetworkDrawer card={openCard} onClose={closeDrawer} /> : null}
    </div>
  );
}

function NetworkControls({ query, state, count, onQueryChange, onStateChange }) {
  return (
    <div className="network__controls">
      <label className="network__search">
        <span className="sr-only">Search people and companies</span>
        <input
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search people, companies, or roles"
          type="search"
          value={query}
        />
      </label>
      <label className="network__filter">
        <span className="sr-only">Filter relationships</span>
        <select onChange={(event) => onStateChange(event.target.value)} value={state}>
          <option value="all">All relationships</option>
          <option value="needs-touch">Needs a touch</option>
          <option value="safe">Warm paths</option>
          <option value="caution">In process</option>
          <option value="closed">Closed</option>
        </select>
      </label>
      <span aria-live="polite" className="network__result-count">
        {formatNumber(count)} {count === 1 ? "person" : "people"}
      </span>
      <Button onClick={focusAskBar} variant="secondary">
        Capture relationship
      </Button>
    </div>
  );
}

// Hero — one eyebrow count, not a metrics grid (target shape §1): a 6-company
// ceiling doesn't earn a scoreboard the way Calendar's Due Today tile does.
function NetworkHero({ needsTouchCount, peopleCount }) {
  return (
    <header className="network__hero">
      <div>
        <span className="network__eyebrow">
          <strong>{formatNumber(peopleCount)}</strong> people ·{" "}
          <strong>{formatNumber(needsTouchCount)}</strong> need a touch
        </span>
        <h1 className="network__title">Network</h1>
      </div>
    </header>
  );
}

// Focuses the docked AskBar input from outside its own component tree. A
// direct DOM query is a small purpose-built escape hatch here — same pattern
// AppShell.jsx already uses for nav autoscroll (scrollActivePrimaryNavItem) —
// rather than standing up a shared event-bus module for one call site.
function focusAskBar() {
  document.querySelector(".ask-bar__input")?.focus();
}

// Zero companies at all is the only empty state the reduced list can hit —
// buildPeopleCards() always emits at least a "company memory" card per
// company, so a non-empty companies[] never produces an empty people[]. The
// real capture path isn't a form on this page (no "add contact" write verb
// exists) — it's pasting a recruiter/hiring-team message into the docked
// AskBar, which flips into capture mode and feeds this list automatically.
export function PeopleList({ emptyMessage = "", onOpen, people }) {
  if (!people.length) {
    return (
      <div className="network__empty">
        {emptyMessage ? (
          <p>{emptyMessage}</p>
        ) : (
          <>
            <p>
              Recruiters and hiring managers you've actually talked to will show up here once you
              capture a message from them. Automated application-portal emails don't count.
            </p>
            <Button onClick={focusAskBar} variant="secondary">
              Paste a message to capture a contact
            </Button>
          </>
        )}
      </div>
    );
  }
  return (
    <section aria-label="Network contacts" className="network__people-grid">
      {people.map((card) => (
        <PersonCard card={card} key={card.id} onOpen={onOpen} />
      ))}
    </section>
  );
}

function PersonCard({ card, onOpen }) {
  const StateIcon = STATE_ICON[card.state] || CheckIcon;
  return (
    <button
      aria-label={`Open relationship context for ${card.name}`}
      className={`network__person-card network__person-card--${card.state}`}
      onClick={() => onOpen(card)}
      type="button"
    >
      <span className="network__person-head">
        <span aria-hidden="true" className="network__person-avatar" style={avatarStyle(card.name)}>
          {personInitials(card.name)}
        </span>
        <span className="network__company-mark">
          <CompanyAvatar domain={card.domain} name={card.company} size={28} />
        </span>
      </span>
      <span className="network__person-main">
        <strong className="network__person-name">{card.name}</strong>
        <span className="network__person-role">
          {card.type} · {card.company}
        </span>
      </span>
      <span className="network__person-foot">
        <span className={`network__pill network__pill--${card.state}`}>
          <StateIcon />
          {card.stateLabel}
        </span>
        <span className="network__person-meta">
          <span>
            <span className="network__person-meta-label">Next:</span> {card.nextTouch}
          </span>
          <span>
            <ClockIcon />
            {formatRelativeDate(card.latestAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

// Sourcing — collapsed, and only rendered when non-empty; relationship-sourcing
// is opt-in, so most sessions carry zero leads (target shape §4). No empty
// shell for this section at all when both are empty.
export function SourcingSection({ busyLeadId = null, leads, onDecide = () => {}, targets }) {
  const rows = [
    ...leads.map((lead) => ({ ...lead, kind: "lead" })),
    ...targets.map((target) => ({ ...target, kind: "target" })),
  ];
  if (!rows.length) return null;

  return (
    <details className="network__sourcing">
      <summary>
        Sourcing · <strong>{formatNumber(rows.length)}</strong>
      </summary>
      <div className="network__sourcing-body">
        {rows.map((row) => (
          <SourcingRow
            busy={busyLeadId === row.id}
            key={`${row.kind}-${row.id}`}
            onDecide={onDecide}
            row={row}
          />
        ))}
      </div>
    </details>
  );
}

// Sourced-but-unverified rows read distinct from a real warm path (a "Review"
// pill, never the person-card's Warm path/In process/Closed vocabulary) so a
// candidate never mistakes an AI-found lead for someone they've actually
// talked to. Also fixes PORT_PARITY_AUDIT items 15 & 17: targets show
// role + fit instead of the company name twice, and leads show platform on
// its own line instead of behind a note || summary || platform fallback that
// hides it whenever a note exists.
function SourcingRow({ row, busy, onDecide }) {
  const isLead = row.kind === "lead";
  return (
    <div className="network__source-row">
      <span className="network__pill network__pill--review">Review</span>
      <span className="network__source-main">
        <strong>{isLead ? row.name : row.company}</strong>
        {isLead ? (
          <small>
            {row.company}
            {row.title ? ` · ${row.title}` : ""}
          </small>
        ) : (
          <small>
            {row.role || "Tracked role"} · {formatNumber(row.fit)} fit
          </small>
        )}
      </span>
      {isLead ? (
        <span className="network__source-platform">{row.platform || "linkedin"}</span>
      ) : null}
      <p>{isLead ? row.note : row.summary}</p>
      {isLead ? (
        <span className="network__source-actions">
          <Button
            disabled={busy}
            loading={busy}
            onClick={() => onDecide(row, "approved")}
            variant="secondary"
          >
            Approve lead
          </Button>
          <Button disabled={busy} onClick={() => onDecide(row, "rejected")} variant="ghost">
            Reject lead
          </Button>
        </span>
      ) : null}
    </div>
  );
}

// Only show the specific title/role when it says something the coarse type
// badge in the header doesn't already say (normalizeRelationshipLead falls
// back to the type string itself when no real title is known).
function distinctTitle(card) {
  const title = card.title || "";
  if (!title) return "";
  return title.trim().toLowerCase() === (card.type || "").trim().toLowerCase() ? "" : title;
}

function ContactSection({ card }) {
  const title = distinctTitle(card);
  const platform = platformLabel(card.platform);
  const lastContact = formatRelativeDate(card.latestAt);
  const rows = [
    title ? { label: "Role", value: title } : null,
    card.email
      ? {
          label: "Email",
          value: (
            <a className="network__contact-link" href={`mailto:${card.email}`}>
              {card.email}
            </a>
          ),
        }
      : null,
    platform ? { label: "Source", value: platform } : null,
    lastContact !== "No activity" ? { label: "Last contact", value: lastContact } : null,
    card.note ? { label: "Note", value: card.note } : null,
  ].filter(Boolean);

  if (!rows.length) return null;

  return (
    <section className="network__drawer-section">
      <h3>Contact</h3>
      <dl className="network__contact-grid">
        {rows.map((row) => (
          <div className="network__contact-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const NETWORK_DRAWER_FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function trapNetworkDrawerTab(dialog, event) {
  if (!dialog || event.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll(NETWORK_DRAWER_FOCUSABLE));
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || !dialog.contains(document.activeElement))
  ) {
    event.preventDefault();
    first.focus();
  }
}

function formatHistoryDate(value) {
  if (!value) return "Date not captured";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date not captured";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function NetworkDrawer({ card, onClose }) {
  const company = card.companyRecord || {};
  const history = asArray(card.history?.length ? card.history : company.history);
  const historySummaries = new Set(history.map((entry) => String(entry.summary || "").trim()));
  const notes = asArray(company.notes).filter(
    (note) => note && !historySummaries.has(String(note).trim())
  );
  const drawerRef = useRef(null);

  useEffect(() => {
    const drawer = drawerRef.current;
    const previouslyFocused = document.activeElement;
    drawer?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
      else trapNetworkDrawerTab(drawer, event);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop; Escape is handled above
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop; Escape is handled above
    <div className="job-drawer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop close; not itself interactive */}
      <aside
        aria-label="Relationship detail"
        aria-modal="true"
        className="job-drawer network__drawer"
        onClick={(event) => event.stopPropagation()}
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
      >
        <IconButton className="job-drawer__close" label="Close network detail" onClick={onClose}>
          ×
        </IconButton>
        <div className="network__drawer-header">
          <span
            className="network__person-avatar network__person-avatar--large"
            style={avatarStyle(card.name)}
          >
            {personInitials(card.name)}
          </span>
          <span>
            <h2>{card.name}</h2>
            <p>
              {card.type} · {card.company}
            </p>
          </span>
        </div>

        {/* Contact: the richer per-person fields addNetworkContact()
            (dashboard-data.js) now captures — email as a mailto: link (opens
            the user's mail client, never auto-sends), role/title distinct
            from the coarse type badge above, source platform/channel, and
            last-contact recency. Thin data is normal here; every row hides
            itself when the field is absent instead of rendering empty. */}
        <ContactSection card={card} />

        {/* Safe routing: reuseTitle/reuseBody/reuseScope/nextTouch, the one
            piece of state that actually changes a decision — kept as-is
            (target shape §3). The separate "Company context" card V1/V2
            carried is cut: role/status/latest-activity is already on the
            card that opened this drawer. */}
        <section className="network__drawer-section">
          <h3>{company.reuseTitle || "Safe routing"}</h3>
          <p>{company.reuseBody || "Use this relationship only when the ask is specific."}</p>
          <div className="network__chip-row">
            <span>{company.reuseScope || "Same-company routing"}</span>
            <span>Next touch: {card.nextTouch}</span>
          </div>
        </section>

        {card.applicationId || company.applicationId ? (
          <a
            className="network__job-link"
            href={`/app/jobs?open=${encodeURIComponent(card.applicationId || company.applicationId)}`}
          >
            Open owning job
            <ArrowRightIcon />
          </a>
        ) : null}

        <section className="network__drawer-section">
          <h3>Communication history</h3>
          {history.length ? (
            <ol className="network__history">
              {history.map((entry) => (
                <li key={entry.id || `${entry.at}-${entry.label}-${entry.summary}`}>
                  <span className="network__history-meta">
                    <strong>{entry.label || "Relationship activity"}</strong>
                    <time dateTime={entry.at || undefined}>{formatHistoryDate(entry.at)}</time>
                  </span>
                  {entry.subject ? <small>{entry.subject}</small> : null}
                  {entry.summary ? <p>{entry.summary}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>No dated messages or conversations are captured yet.</p>
          )}
        </section>

        {/* Notes: company.notes[] as a plain list — no "Conversation
            Timeline" framing and no Signal 1/Signal 2 numbering; notes[] is
            unordered free text extracted from comms summaries, not a
            timestamped sequence, so it shouldn't read as one. */}
        {notes.length ? (
          <section className="network__drawer-section">
            <h3>Other notes</h3>
            <ul className="network__drawer-list">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </aside>
    </div>
  );
}
