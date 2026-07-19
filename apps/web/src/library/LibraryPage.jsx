// apps/web/src/library/LibraryPage.jsx — the calm, two-view library page.
// Renders fields the way DashboardContext.jsx's data contract requires:
// `data.library` is the unmodified output of buildLibraryStatus()
// (src/core/tracker/dashboard-data.js), itself fed by
// buildLibrarySnapshot()/buildSnapshotFromDeepIngest()
// (src/core/tracker/library-snapshot.mjs) — every card's `kind`, `tags`, and
// `note` is rendered as-is, never re-derived. Client-side work here is
// limited to filtering an already-built list (same contract
// CalendarPage.jsx follows for `data.calendar`).
//
// Structure is deliberately flat: one hero title, a top Internal|External
// toggle (`?tab=`), and under it either the reusable-material bank (the
// `data.library` cards, filtered by a single type line + search) or the
// outward documents list. No scoreboard, no colored family/lane chip rows,
// no readiness/guardrails summary panels — those were cut as clutter; see
// the CSS file header for the full list of what was removed and why.
//
// The Documents view is the one place this page does real aggregation:
// collectLibraryDocuments() gathers each job row's already-computed
// `row.drawer.artifacts` (built once per row by jobDetailFromRow(),
// dashboard-data.js:3861, and attached to every entry of `data.jobs.rows` by
// buildJobs(), dashboard-data.js:4690) into one flat, cross-job list. That
// mirrors CalendarPage's collectCalendarEvents() — a plain gather of
// fields the server already computed, scattered across many rows, with no
// business rule invented here (no restaging, no re-deriving which artifacts
// exist).
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button, IconButton } from "../components/Button.jsx";
import { PaperclipIcon, SearchIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { getDeepIngestState } from "../lib/api.js";
import { PREVIEW_DOCUMENTS, PREVIEW_LIBRARY } from "./libraryPreviewData.js";
import "./LibraryPage.css";

const TAB_OPTIONS = [
  { key: "internal", label: "Internal" },
  { key: "external", label: "External" },
];

const TYPE_OPTIONS = [
  { key: "all", label: "All" },
  { key: "evidence", label: "Evidence" },
  { key: "story", label: "Stories" },
  { key: "voice", label: "Voice" },
];

const DEEP_INGEST_TYPE_OPTIONS = [
  { key: "honesty", label: "Honesty" },
  { key: "role_signal", label: "Role signal" },
];

const DOC_KIND_OPTIONS = [
  { key: "all", label: "All" },
  { key: "resume", label: "Resumes" },
  { key: "cover-letter", label: "Cover letters" },
];

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const TONE_NAMES = new Set(["teal", "sky", "gold", "plum", "coral"]);

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function formatNumber(value) {
  return NUMBER_FORMAT.format(Number(value) || 0);
}

function safeTone(tone) {
  return TONE_NAMES.has(tone) ? tone : "teal";
}

function cardId(card, index = 0) {
  if (card?.id) return String(card.id);
  const base = [card?.kind, card?.title || card?.summary || index]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || `library-card-${index}`;
}

function tagLabels(card) {
  return asArray(card?.tags)
    .map((tag) => String(tag.label || "").trim())
    .filter(Boolean);
}

function cardHaystack(card) {
  return normalize(
    [card?.kind, card?.label, card?.title, card?.summary, card?.note, ...tagLabels(card)].join(" ")
  );
}

export function filterLibraryCards(cards, filters = {}) {
  const type = normalize(filters.type || "all");
  const query = normalize(filters.query);

  return asArray(cards).filter((card) => {
    const kind = normalize(card.kind || "evidence");
    if (type && type !== "all" && kind !== type) return false;
    if (query && !cardHaystack(card).includes(query)) return false;
    return true;
  });
}

function hasLibraryContent(library) {
  return asArray(library?.cards).length > 0;
}

// Same "gate the dev fallback, never leak it into prod" contract as
// CalendarPage's calendarForPage(): a genuinely empty bank in production
// still shows the honest empty state, not silent mock data.
function libraryForPage(library) {
  if (hasLibraryContent(library)) return library;
  return import.meta.env.DEV ? PREVIEW_LIBRARY : library;
}

// Re-entry nudge for the hero: mirrors the terminalCount/requiredCount shape
// evaluateDeepIngestReadiness() returns (src/core/deep-ingest/readiness.mjs),
// the same fields DeepIngestPage's own lane-progress header reads off
// getDeepIngestState(). Returns null once readiness.ready is true (or the
// state shape is missing/empty) so the pill simply doesn't render — no
// separate "hide" flag needed.
function deepIngestProgressFromState(state) {
  const readiness = state?.readiness;
  if (!readiness || readiness.ready) return null;
  const requiredCount = Number(readiness.requiredCount) || 0;
  if (!requiredCount) return null;
  return { terminalCount: Number(readiness.terminalCount) || 0, requiredCount };
}

function isDeepIngestLibrary(metrics) {
  return metrics?.honesty !== undefined || metrics?.roleSignals !== undefined;
}

function typeOptionsForLibrary(library) {
  return isDeepIngestLibrary(library?.metrics)
    ? [...TYPE_OPTIONS, ...DEEP_INGEST_TYPE_OPTIONS]
    : TYPE_OPTIONS;
}

function normalizeType(type, options) {
  return options.some((option) => option.key === type) ? type : "all";
}

function normalizeTab(value) {
  return value === "external" ? "external" : "internal";
}

function findOpenCard(cards, openId) {
  if (!openId) return null;
  return cards.find((card) => card.id === openId) || null;
}

function updateParam(setSearchParams, key, value, fallback = "") {
  setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    return next;
  });
}

// clipboard.writeText is the primary path; a hidden-textarea + execCommand
// fallback covers browsers/contexts where the async Clipboard API is
// unavailable or blocked (non-secure context, permission denial) so "Copy
// reusable text" still works rather than silently failing.
async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy fallback below.
  }
  if (typeof document === "undefined") return false;
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// The gather described in the file header comment — one flat list of
// {kind, note} artifacts across every job, each tagged with the parent job's
// company/role/detailId so a row can link back into that job's own drawer
// (the job drawer already renders the artifact; this list is a finder, not a
// second viewer). Miss a job source (applications vs. sourced) and rows
// silently vanish, the same risk collectCalendarEvents() calls out.
export function collectLibraryDocuments(jobs) {
  const rows = Array.isArray(jobs?.rows) ? jobs.rows : [];
  const documents = [];
  for (const row of rows) {
    const artifacts = Array.isArray(row?.drawer?.artifacts) ? row.drawer.artifacts : [];
    artifacts.forEach((artifact, index) => {
      if (!artifact?.kind) return;
      documents.push({
        id: `${row.drawerId || row.id || "job"}-${index}-${normalize(artifact.kind)}`,
        kind: artifact.kind,
        note: artifact.note || "",
        company: row.company || "Unknown company",
        role: row.role || "Open role",
        detailId: row.drawerId || row.id || "",
      });
    });
  }
  return documents;
}

function hasDocumentContent(documents) {
  return documents.length > 0;
}

function documentsForPage(jobs) {
  const documents = collectLibraryDocuments(jobs);
  if (hasDocumentContent(documents)) return documents;
  return import.meta.env.DEV ? PREVIEW_DOCUMENTS : documents;
}

function docKindSlug(kind) {
  const value = normalize(kind);
  if (value.includes("resume")) return "resume";
  if (value.includes("cover")) return "cover-letter";
  return "jd";
}

function filterDocuments(documents, query, kind = "all") {
  const needle = normalize(query);
  return documents.filter((doc) => {
    if (kind !== "all" && docKindSlug(doc.kind) !== kind) return false;
    if (
      needle &&
      !normalize([doc.kind, doc.company, doc.role, doc.note].join(" ")).includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

function buildLibraryModel(library, filters) {
  const typeOptions = typeOptionsForLibrary(library);
  const cards = asArray(library?.cards).map((card, index) => ({
    ...card,
    id: cardId(card, index),
  }));
  const filteredCards = filterLibraryCards(cards, filters);

  return {
    preview: Boolean(library?.preview),
    typeOptions,
    cards,
    filteredCards,
  };
}

export function LibraryPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);
  const [docQuery, setDocQuery] = useState("");
  const [docKind, setDocKind] = useState("all");
  const [deepIngestProgress, setDeepIngestProgress] = useState(null);

  // Client-side read only, no new endpoint. Never surfaces an error — a
  // failed fetch just leaves the pill un-rendered, same as an already-complete
  // deep ingest.
  useEffect(() => {
    let cancelled = false;
    getDeepIngestState()
      .then((next) => {
        if (!cancelled) setDeepIngestProgress(deepIngestProgressFromState(next));
      })
      .catch(() => {
        if (!cancelled) setDeepIngestProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const library = libraryForPage(data?.library);
  const typeOptions = typeOptionsForLibrary(library);
  const tab = normalizeTab(searchParams.get("tab"));
  const type = normalizeType(searchParams.get("type") || "all", typeOptions);
  const query = searchParams.get("q") || "";

  const model = useMemo(() => buildLibraryModel(library, { type, query }), [library, type, query]);
  const openCard = findOpenCard(model.cards, searchParams.get("open"));

  const documents = useMemo(() => documentsForPage(data?.jobs), [data?.jobs]);
  const filteredDocuments = useMemo(
    () => filterDocuments(documents, docQuery, docKind),
    [documents, docQuery, docKind]
  );

  function setTab(nextTab) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", nextTab);
      return next;
    });
  }

  function resetFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("type");
      next.delete("q");
      return next;
    });
  }

  function openDrawer(card) {
    setCopied(false);
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

  async function copyCard(card) {
    const text = [card.title, card.summary, card.note].filter(Boolean).join("\n\n");
    setCopied(await copyTextToClipboard(text));
  }

  if (noDatabase) {
    return (
      <div className="library">
        <InlineAlert message="This workspace hasn't finished setup yet — finish setup, then reload." />
      </div>
    );
  }

  return (
    <div className="library">
      <LibraryHero
        deepIngestProgress={deepIngestProgress}
        preview={model.preview}
        setTab={setTab}
        tab={tab}
      />

      {error && !model.preview ? <InlineAlert message={error} /> : null}
      {loading && !data ? <p className="dashboard-home__loading">Loading…</p> : null}

      {tab === "internal" ? (
        model.cards.length ? (
          <LibraryBank
            model={model}
            onOpen={openDrawer}
            onReset={resetFilters}
            query={query}
            setSearchParams={setSearchParams}
            type={type}
          />
        ) : (
          <EmptyLibraryState />
        )
      ) : (
        <LibraryDocuments
          docKind={docKind}
          documents={filteredDocuments}
          onDocKindChange={setDocKind}
          onQueryChange={setDocQuery}
          query={docQuery}
          total={documents.length}
        />
      )}

      {openCard ? (
        <LibraryDrawer
          card={openCard}
          copied={copied}
          onClose={closeDrawer}
          onCopy={() => copyCard(openCard)}
        />
      ) : null}
    </div>
  );
}

function LibraryHero({ deepIngestProgress, preview, setTab, tab }) {
  return (
    <header className="library__hero">
      <div className="library__title-block">
        <span className="library__eyebrow">{preview ? "Preview data" : "Reusable bank"}</span>
        <h1 className="library__title">Story &amp; evidence bank</h1>
      </div>
      <div className="library__hero-actions">
        {deepIngestProgress ? (
          <Link className="btn btn--secondary" to="/deep-ingest">
            Continue deep dive ({deepIngestProgress.terminalCount}/
            {deepIngestProgress.requiredCount})
          </Link>
        ) : null}
        <div aria-label="Library mode" className="jobs__tabs" role="tablist">
          {TAB_OPTIONS.map((option) => (
            <button
              aria-selected={tab === option.key}
              className={`jobs__tab${tab === option.key ? " jobs__tab--active" : ""}`}
              key={option.key}
              onClick={() => setTab(option.key)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function LibraryBank({ model, onOpen, onReset, query, setSearchParams, type }) {
  return (
    <>
      <section aria-label="Library filters" className="library__toolbar">
        <div aria-label="Filter by material type" className="library__segments" role="tablist">
          {model.typeOptions.map((option) => (
            <button
              aria-selected={type === option.key}
              className={`library__segment${type === option.key ? " library__segment--active" : ""}`}
              key={option.key}
              onClick={() => updateParam(setSearchParams, "type", option.key, "all")}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="library__searchbox">
          <SearchIcon />
          <input
            aria-label="Search library"
            onChange={(event) => updateParam(setSearchParams, "q", event.target.value)}
            placeholder="Search proof, stories, voice…"
            type="search"
            value={query}
          />
        </label>

        {type !== "all" || query ? (
          <Button onClick={onReset} variant="secondary">
            Clear filters
          </Button>
        ) : null}
      </section>

      <div aria-live="polite" className="library__result-count">
        Showing {formatNumber(model.filteredCards.length)} of {formatNumber(model.cards.length)}
      </div>

      {model.filteredCards.length ? (
        <section aria-label="Library cards" className="library__card-grid">
          {model.filteredCards.map((card) => (
            <LibraryCard card={card} key={card.id} onOpen={onOpen} />
          ))}
        </section>
      ) : (
        <div className="library__no-results">
          <p>No matches. Clear search or filters to see the full bank.</p>
          <Button onClick={onReset} variant="secondary">
            Clear filters
          </Button>
        </div>
      )}
    </>
  );
}

function LibraryCard({ card, onOpen }) {
  const tags = asArray(card.tags);
  return (
    <button
      aria-label={`Open library card ${card.title || "Reusable material"}`}
      className="library__card"
      data-library-card={card.kind || "evidence"}
      onClick={() => onOpen(card)}
      type="button"
    >
      <span className="library__card-head">
        <span className={`library__kind library__kind--${card.kind || "evidence"}`}>
          {card.label || card.kind || "Evidence"}
        </span>
        <span className="library__card-open">Open</span>
      </span>
      <strong className="library__card-title">{card.title || "Reusable material"}</strong>
      {card.summary ? <span className="library__card-summary">{card.summary}</span> : null}
      {tags.length ? (
        <span className="library__tag-row">
          {tags.slice(0, 4).map((tag, index) => (
            <span
              className="library__tag"
              data-tone={safeTone(tag.tone)}
              // biome-ignore lint/suspicious/noArrayIndexKey: tag labels can repeat; no stable id available
              key={`${tag.label || "tag"}-${index}`}
            >
              {tag.label || "Tag"}
            </span>
          ))}
        </span>
      ) : null}
      {card.note ? <span className="library__card-note">{card.note}</span> : null}
    </button>
  );
}

function EmptyLibraryState() {
  return (
    <div className="library__empty-state">
      <h2>No reusable material yet</h2>
      <p>
        Finish <Link to="/onboarding">onboarding</Link> or{" "}
        <Link to="/deep-ingest">deep ingest</Link> to capture evidence, STAR stories, and writing
        voice so Rolester has a durable bank to browse here.
      </p>
    </div>
  );
}

function LibraryDocuments({ docKind, documents, onDocKindChange, onQueryChange, query, total }) {
  return (
    <section aria-label="Documents" className="library__documents">
      <header className="library__panel-header library__panel-header--documents">
        <h2>
          <span className="library__panel-icon">
            <PaperclipIcon />
          </span>
          Documents
        </h2>
        <span className="library__panel-meta">
          {formatNumber(documents.length)} of {formatNumber(total)}
        </span>
      </header>
      <p className="library__panel-note">
        Résumés, cover letters, and job descriptions gathered from every job's own artifacts. Opens
        back into that job's drawer — the artifact isn't duplicated here.
      </p>

      <div className="library__toolbar">
        <div aria-label="Filter by document type" className="library__segments" role="tablist">
          {DOC_KIND_OPTIONS.map((option) => (
            <button
              aria-selected={docKind === option.key}
              className={`library__segment${docKind === option.key ? " library__segment--active" : ""}`}
              key={option.key}
              onClick={() => onDocKindChange(option.key)}
              role="tab"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="library__searchbox">
          <SearchIcon />
          <input
            aria-label="Search documents"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search resumes, cover letters, job descriptions…"
            type="search"
            value={query}
          />
        </label>
      </div>

      {documents.length ? (
        <div className="library__doc-list">
          {documents.map((doc) => (
            <DocumentRow doc={doc} key={doc.id} />
          ))}
        </div>
      ) : total ? (
        <div className="library__empty-state library__empty-state--compact">
          <p>No documents match your search.</p>
        </div>
      ) : (
        <div className="library__empty-state library__empty-state--compact">
          <p>
            No documents captured on any job yet. Documents appear here once an application picks up
            a resume, cover letter, or saved job description.
          </p>
        </div>
      )}
    </section>
  );
}

function DocumentRow({ doc }) {
  return (
    <div className="library__doc-row">
      <span className="library__doc-kind" data-kind={docKindSlug(doc.kind)}>
        {doc.kind}
      </span>
      <span className="library__doc-copy">
        <strong>
          {doc.company} · {doc.role}
        </strong>
        {doc.note ? <small>{doc.note}</small> : null}
      </span>
      {doc.detailId ? (
        <Link className="library__doc-link" to={`/jobs?open=${encodeURIComponent(doc.detailId)}`}>
          Open job
        </Link>
      ) : null}
    </div>
  );
}

function LibraryDrawer({ card, copied, onClose, onCopy }) {
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only backdrop; Escape is handled above
    // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-only backdrop; Escape is handled above
    <div className="job-drawer-overlay" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop close; not itself interactive */}
      <aside
        aria-label="Library card detail"
        className="job-drawer library__drawer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <IconButton
          className="job-drawer__close"
          label="Close library card detail"
          onClick={onClose}
        >
          ×
        </IconButton>
        <div className="library__drawer-header">
          <span className={`library__kind library__kind--${card.kind || "evidence"}`}>
            {card.label || card.kind || "Evidence"}
          </span>
          <h2>{card.title || "Reusable material"}</h2>
          {card.summary ? <p>{card.summary}</p> : null}
        </div>

        <section className="library__drawer-section">
          <h3>Reusable text</h3>
          <p>{card.note || card.summary || "No reusable note captured yet."}</p>
          <Button onClick={onCopy} variant="primary">
            {copied ? "Copied" : "Copy reusable text"}
          </Button>
        </section>

        <section className="library__drawer-section">
          <h3>Tags</h3>
          <div className="library__tag-row">
            {asArray(card.tags).length ? (
              asArray(card.tags).map((tag, index) => (
                <span
                  className="library__tag"
                  data-tone={safeTone(tag.tone)}
                  // biome-ignore lint/suspicious/noArrayIndexKey: tag labels can repeat; no stable id available
                  key={`${tag.label || "tag"}-${index}`}
                >
                  {tag.label || "Tag"}
                </span>
              ))
            ) : (
              <span className="library__empty">No tags yet.</span>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
