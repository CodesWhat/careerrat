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
import { ChipInput, Field, TextArea, TextField } from "../components/form.jsx";
import { PaperclipIcon, SearchIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  getDeepIngestState,
  removeDeepIngestConfirmedItem,
  removeEvidenceClaim,
  saveCandidateFile,
  updateDeepIngestConfirmedItem,
} from "../lib/api.js";
import { emitDashboardChanged } from "../lib/dashboard-events.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";
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

// Edit-in-place field maps, one per card kind — field names match the raw
// values library-snapshot.mjs's card builders already attach at
// `card.metadata` (evidence: evidence.schema.json's CLAIM_FIELDS; the other
// four: the exact flat field names their own summary/title derivation reads
// off the confirmed deep_ingest_* row). "chips" fields use the same ChipInput
// idiom as Settings' guardrail/company-list chip editors; "textarea"/"text"
// use TextArea/TextField exactly like JobDrawer's CompFitCard note editor.
const EVIDENCE_EDIT_FIELDS = [
  { key: "claim", label: "Claim", type: "textarea" },
  { key: "evidence", label: "Evidence", type: "textarea" },
  { key: "metrics", label: "Metrics", type: "chips" },
  { key: "links", label: "Links", type: "chips" },
  { key: "allowed_wording", label: "Allowed wording", type: "chips" },
  { key: "forbidden_wording", label: "Forbidden wording", type: "chips" },
];

const STORY_EDIT_FIELDS = [
  { key: "title", label: "Title", type: "text" },
  { key: "situation", label: "Situation", type: "textarea" },
  { key: "task", label: "Task", type: "textarea" },
  { key: "action", label: "Action", type: "textarea" },
  { key: "result", label: "Result", type: "textarea" },
  { key: "reflection", label: "Reflection", type: "textarea" },
  { key: "metrics", label: "Metrics", type: "chips" },
  { key: "landed", label: "Landed", type: "chips" },
  { key: "open_questions", label: "Open questions", type: "chips" },
  { key: "competencies", label: "Competencies", type: "chips" },
  { key: "role_signals", label: "Role signals", type: "chips" },
  { key: "prompts", label: "Prompts", type: "chips" },
];

const VOICE_EDIT_FIELDS = [
  { key: "summary", label: "Summary", type: "textarea" },
  { key: "doPhrases", label: "Do phrases", type: "chips" },
  { key: "avoidPhrases", label: "Avoid phrases", type: "chips" },
];

const HONESTY_EDIT_FIELDS = [
  { key: "text", label: "Boundary text", type: "textarea" },
  { key: "reason", label: "Reason", type: "textarea" },
  { key: "boundaryType", label: "Boundary type", type: "text" },
  { key: "allowedWording", label: "Allowed wording", type: "text" },
  { key: "forbiddenWording", label: "Forbidden wording", type: "text" },
];

const ROLE_SIGNAL_EDIT_FIELDS = [
  { key: "text", label: "Signal text", type: "textarea" },
  { key: "roleFamily", label: "Role family", type: "text" },
  { key: "signalType", label: "Signal type", type: "text" },
  { key: "rationale", label: "Rationale", type: "textarea" },
];

const CARD_EDIT_FIELDS = {
  evidence: EVIDENCE_EDIT_FIELDS,
  story: STORY_EDIT_FIELDS,
  voice: VOICE_EDIT_FIELDS,
  honesty: HONESTY_EDIT_FIELDS,
  role_signal: ROLE_SIGNAL_EDIT_FIELDS,
};

// Deep-ingest confirmed-item lane per card kind — matches the item 15
// endpoints' {lane, id, ...fields} contract. Evidence isn't here: it saves
// through the existing candidate evidence merge/remove routes instead (see
// saveCard/deleteCard below).
const CARD_LANE_BY_KIND = {
  story: "story_bank",
  voice: "writing_voice",
  honesty: "honesty_boundaries",
  role_signal: "role_signals",
};

// Item 17's disclaimer copy, updated for the promotion pipeline (see
// .internal/promotion-pipeline-design-2026-07-19.md "UI copy"): every
// confirmed lane is now read into live generation/scoring, not just browsed
// here — these lines tell the candidate what changes going forward without
// implying past documents get rewritten.
const CARD_KIND_DISCLAIMER = {
  story:
    "Used automatically in future cover letters and answers (and as résumé theme hints) when job-relevant. Existing documents don't change.",
  voice: "Shapes the tone of every future generated document. Existing documents don't change.",
  honesty:
    "Its forbidden wording is enforced on every future generated document, but education policy and confirmed tools still live only in Settings → Honesty boundaries.",
  role_signal:
    "Applied to matching role families in fit checks, sourced-job scoring, and document framing. Existing results don't change.",
};

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
// {kind, note, path} artifacts across every job, each tagged with the parent
// job's company/role/detailId so a row can link back into that job's own
// drawer (the job drawer already renders the artifact; this list is a
// finder, not a second viewer). Miss a job source (applications vs. sourced)
// and rows silently vanish, the same risk collectCalendarEvents() calls out.
// `note` is jobDetailFromRow()'s short human-readable label (never a raw
// workspace path); `path`, when present, is the raw workspace path, kept
// only for DocumentRow's "Technical details" disclosure.
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
        path: artifact.path || "",
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

// The Edit form's starting values for one card: the raw fields listed in
// CARD_EDIT_FIELDS, read off card.metadata (never the derived title/summary/
// note — those are lossy one-way projections, see library-snapshot.mjs).
// Missing fields fall back to an empty string/array per field type so every
// controlled input always has a defined value.
function editableValuesFromCard(card) {
  const fields = CARD_EDIT_FIELDS[card?.kind] || [];
  const metadata = card?.metadata || {};
  const values = {};
  for (const field of fields) {
    const raw = metadata[field.key];
    values[field.key] = field.type === "chips" ? asStringArray(raw) : String(raw || "");
  }
  return values;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function buildLibraryModel(library, filters) {
  const typeOptions = typeOptionsForLibrary(library);
  // `id` becomes a synthetic display id when the snapshot row had none (keys,
  // open-card deep links) — `storedId` stays null in that case so Edit/Delete
  // only ever target a real persisted row, never a fabricated id.
  const cards = asArray(library?.cards).map((card, index) => ({
    ...card,
    id: cardId(card, index),
    storedId: card?.id ? String(card.id) : null,
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
  const { data, loading, error, noDatabase, refetch } = useDashboardSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);
  const [docQuery, setDocQuery] = useState("");
  const [docKind, setDocKind] = useState("all");
  const [deepIngestProgress, setDeepIngestProgress] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [actionError, setActionError] = useState(null);

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

  // Mirrors JobDrawer.jsx's runWrite: one busy key per in-flight action, a
  // single actionError surfaced via InlineAlert, and a post-write refetch so
  // the drawer/cards reflect server truth rather than an optimistic guess.
  async function runWrite(key, fn) {
    setBusyKey(key);
    setActionError(null);
    try {
      await fn();
      emitDashboardChanged();
      await refetch();
    } catch (err) {
      const resolved = resolveErrorCopy(err);
      setActionError(
        resolved.action?.retry
          ? { ...resolved, action: { ...resolved.action, onRetry: () => runWrite(key, fn) } }
          : resolved
      );
    } finally {
      setBusyKey(null);
    }
  }

  // Evidence saves through the existing candidate evidence merge route
  // (id-match path updates in place — see candidateEvidenceMerge). It writes
  // whatever object it's handed as the row's complete new data, so edits
  // spread onto card.metadata.raw (the untouched stored claim), never onto
  // the curated edit-form fields alone, or fields the form doesn't expose
  // (role_signals, sourceId, …) would be dropped. The four deep-ingest lanes
  // save through the item 15 confirmed-item update route instead, which
  // merges {...current, ...fields} server-side, so only the edited fields
  // need to be sent.
  function saveCard(card, values) {
    return runWrite(`save-${card.id}`, async () => {
      if (card.kind === "evidence") {
        await saveCandidateFile("evidence", {
          claims: [{ ...card.metadata?.raw, ...values, id: card.storedId }],
        });
        return;
      }
      const lane = CARD_LANE_BY_KIND[card.kind];
      await updateDeepIngestConfirmedItem({ lane, id: card.storedId, ...values });
    });
  }

  function deleteCard(card) {
    return runWrite(`delete-${card.id}`, async () => {
      if (card.kind === "evidence") {
        await removeEvidenceClaim(card.storedId);
      } else {
        const lane = CARD_LANE_BY_KIND[card.kind];
        await removeDeepIngestConfirmedItem({ lane, id: card.storedId });
      }
      closeDrawer();
    });
  }

  if (noDatabase) {
    return (
      <div className="library">
        <InlineAlert message="This workspace hasn't finished setup yet. Finish setup, then reload." />
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

      {error && !model.preview ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
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
          actionError={actionError}
          busyKey={busyKey}
          card={openCard}
          copied={copied}
          onClose={closeDrawer}
          onCopy={() => copyCard(openCard)}
          onDeleteCard={deleteCard}
          onSaveCard={saveCard}
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
        voice so CareerRat has a durable bank to browse here.
      </p>
    </div>
  );
}

function LibraryDocuments({ docKind, documents, onDocKindChange, onQueryChange, query, total }) {
  return (
    <section aria-label="Documents" className="library__documents">
      <header className="library__panel-header library__panel-header--documents">
        <h2 aria-label="Documents">
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
        back into that job's drawer. The artifact isn't duplicated here.
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
        {doc.path ? (
          <details className="library__doc-technical">
            <summary>Technical details</summary>
            <span className="library__doc-path">{doc.path}</span>
          </details>
        ) : null}
      </span>
      {doc.detailId ? (
        <Link className="library__doc-link" to={`/jobs?open=${encodeURIComponent(doc.detailId)}`}>
          Open job
        </Link>
      ) : null}
    </div>
  );
}

function LibraryDrawer({
  actionError,
  busyKey,
  card,
  copied,
  onClose,
  onCopy,
  onDeleteCard,
  onSaveCard,
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState(() => editableValuesFromCard(card));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [syncedCardId, setSyncedCardId] = useState(card.id);

  // DashboardContext.jsx's ~10s poll hands this drawer a brand-new `card`
  // object every tick even when the underlying record hasn't changed (see
  // ISSUE-017) — keying this reset on the `card` object itself reset an
  // in-progress edit or a pending delete confirmation on every poll tick,
  // not just when the candidate actually opened a different card. Keying on
  // `card.id` instead means poll churn on the *same* card id never clobbers
  // `editing`/`confirmingDelete`/in-progress `values`. Opening a genuinely
  // different card (id changes) still resets everything to the clean read
  // view. When the id is unchanged and the drawer is in the read view (not
  // mid-edit), `values` still re-syncs from the fresh card so a real
  // server-side update elsewhere is reflected next time it's viewed
  // read-only — mirrors CompFitCard's own re-sync effect on the fields it
  // can't own locally.
  useEffect(() => {
    if (card.id !== syncedCardId) {
      setSyncedCardId(card.id);
      setEditing(false);
      setConfirmingDelete(false);
      setValues(editableValuesFromCard(card));
      return;
    }
    if (!editing) {
      setValues(editableValuesFromCard(card));
    }
  }, [card, editing, syncedCardId]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Legacy (non-DB) mode's singular writing-voice card is a derived summary
  // with no candidate_evidence_claims/deep_ingest_* row behind it — no
  // stored row for Save/Delete to target — so the affordance stays hidden
  // rather than posting a made-up id that can only 404. Gate on storedId,
  // not id: buildLibraryModel assigns every card a synthetic display id.
  const editable = Boolean(card.storedId);
  const editFields = editable ? CARD_EDIT_FIELDS[card.kind] || [] : [];
  const savingKey = `save-${card.id}`;
  const deletingKey = `delete-${card.id}`;
  const disclaimer = CARD_KIND_DISCLAIMER[card.kind];

  function updateValue(key, value) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

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
          {disclaimer ? <p className="field__hint">{disclaimer}</p> : null}
        </div>

        {actionError ? (
          <InlineAlert
            message={actionError.message}
            action={actionError.action}
            detail={actionError.detail}
          />
        ) : null}

        <section className="library__drawer-section">
          <h3>Reusable text</h3>
          <p>{card.note || card.summary || "No reusable note captured yet."}</p>
          <Button onClick={onCopy} variant="primary">
            {copied ? "Copied" : "Copy reusable text"}
          </Button>
        </section>

        {editFields.length ? (
          <section className="library__drawer-section">
            <h3>Edit</h3>
            {editing ? (
              <>
                <div className="library__edit-fields">
                  {editFields.map((field) => (
                    <Field
                      htmlFor={`library-edit-${field.key}`}
                      key={field.key}
                      label={field.label}
                    >
                      {field.type === "chips" ? (
                        <ChipInput
                          id={`library-edit-${field.key}`}
                          onChange={(next) => updateValue(field.key, next)}
                          values={values[field.key] || []}
                        />
                      ) : field.type === "textarea" ? (
                        <TextArea
                          id={`library-edit-${field.key}`}
                          onChange={(next) => updateValue(field.key, next)}
                          value={values[field.key] || ""}
                        />
                      ) : (
                        <TextField
                          id={`library-edit-${field.key}`}
                          onChange={(next) => updateValue(field.key, next)}
                          value={values[field.key] || ""}
                        />
                      )}
                    </Field>
                  ))}
                </div>
                <div className="job-drawer__inline-actions">
                  <Button
                    disabled={busyKey === savingKey}
                    onClick={() => {
                      onSaveCard(card, values);
                      setEditing(false);
                    }}
                  >
                    {busyKey === savingKey ? "Saving…" : "Save"}
                  </Button>
                  <Button onClick={() => setEditing(false)} variant="secondary">
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button
                onClick={() => {
                  setValues(editableValuesFromCard(card));
                  setEditing(true);
                }}
                variant="secondary"
              >
                Edit
              </Button>
            )}
          </section>
        ) : null}

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

        {editable ? (
          <section className="library__drawer-section">
            <h3>Remove</h3>
            {confirmingDelete ? (
              <>
                <InlineAlert message="Remove this from your library? This can't be undone." />
                <div className="job-drawer__inline-actions">
                  <Button
                    disabled={busyKey === deletingKey}
                    onClick={() => onDeleteCard(card)}
                    variant="secondary"
                  >
                    {busyKey === deletingKey ? "Removing…" : "Confirm remove"}
                  </Button>
                  <Button onClick={() => setConfirmingDelete(false)} variant="secondary">
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button onClick={() => setConfirmingDelete(true)} variant="secondary">
                Remove from library
              </Button>
            )}
          </section>
        ) : null}
      </aside>
    </div>
  );
}
