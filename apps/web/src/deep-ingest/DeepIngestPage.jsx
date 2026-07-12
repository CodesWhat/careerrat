// apps/web/src/deep-ingest/DeepIngestPage.jsx — the /deep-ingest workbench.
// Reads/writes the six-endpoint surface in src/cli/deep-ingest-route.mjs
// through the wrappers in ../lib/api.js: a source (paste, link, or file)
// gets scanned into per-lane proposals (evidence, story, honesty, writing
// voice, role signal, or an open gap), a reviewer works the review queue in
// the proposal editor, and stuck lanes/sources get an explicit manual
// fallback (enter it yourself, retry the scan, defer the lane, or mark it
// not available) rather than silently blocking readiness. Every write here
// re-reads getDeepIngestState() afterward instead of trying to merge a
// partial response into local state — same "server stays the single source
// of truth" discipline AiSearchPrompts.jsx and IntakeCard.jsx already use.
//
// `initialState` is accepted directly (not just read from an effect) so this
// page renders every contract string synchronously — the route contract test
// uses renderToStaticMarkup, which never runs effects.

import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button.jsx";
import { TextArea, TextField } from "../components/form.jsx";
import { ListIcon, UploadIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  decideDeepIngestProposal,
  getDeepIngestState,
  submitDeepIngestSource,
  updateDeepIngestLaneState,
  uploadDeepIngestFile,
} from "../lib/api.js";

// The six target lanes a source can feed. "paste"/"link" are also valid
// DEEP_INGEST_TARGET_SHAPES server-side (they route to the open_gaps lane
// when the candidate doesn't know which lane material belongs to yet) but
// aren't offered here as a lane choice — "Auto" already covers that case.
const TARGET_SHAPE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "evidence", label: "Evidence" },
  { value: "story", label: "Story" },
  { value: "writing_voice", label: "Writing voice" },
  { value: "honesty_boundary", label: "Honesty" },
  { value: "role_signal", label: "Role signal" },
];

const TARGET_SHAPE_LABEL = Object.fromEntries(
  TARGET_SHAPE_OPTIONS.map((option) => [option.value, option.label])
);

const INPUT_KIND_OPTIONS = [
  { value: "paste", label: "Paste" },
  { value: "url", label: "Link" },
];

const SOURCE_KIND_LABEL = {
  paste: "Paste",
  text: "Paste",
  note: "Note",
  url: "Link",
  linkedin: "LinkedIn",
  portfolio: "Portfolio",
  project_link: "Project link",
  file: "File",
  repo: "Repository",
  local_path: "Local path",
  recruiter_context: "Recruiter context",
  job_context: "Job context",
};

const REVIEW_FILTERS = [
  { value: "all", label: "All" },
  { value: "review_needed", label: "Needs review" },
  { value: "blocked", label: "Blocked" },
  { value: "confirmed", label: "Confirmed" },
];

const LANE_STATUS_LABEL = {
  not_started: "Not started",
  needs_source: "Needs source",
  scanning: "Scanning",
  review_needed: "Needs review",
  gap: "Gap",
  completed: "Completed",
  deferred: "Deferred",
  not_available: "Not available",
  failed: "Failed",
};

const LANE_STATUS_TONE = {
  completed: "badge--ok",
  review_needed: "badge--warn",
  gap: "badge--warn",
  failed: "badge--error",
  deferred: "badge--muted",
  not_available: "badge--muted",
  needs_source: "badge--muted",
  scanning: "badge--muted",
  not_started: "badge--muted",
};

// Mirrors evaluateDeepIngestReadiness()'s per-lane terminal rule
// (src/core/deep-ingest/readiness.mjs) client-side, for lane rows that don't
// already carry a computed `terminal` flag. buildDeepIngestViewModel sets
// one server-side; this keeps the page correct either way rather than
// importing a server module into the frontend bundle for a 3-value set.
const TERMINAL_LANE_STATUSES = new Set(["completed", "deferred", "not_available"]);
const REASON_REQUIRED_LANE_STATUSES = new Set(["deferred", "not_available"]);

function laneIsTerminal(lane) {
  if (typeof lane?.terminal === "boolean") return lane.terminal;
  const status = lane?.status;
  if (status === "completed") return true;
  if (!TERMINAL_LANE_STATUSES.has(status)) return false;
  if (REASON_REQUIRED_LANE_STATUSES.has(status)) return Boolean(lane?.reason);
  return true;
}

const SOURCE_STATUS_TONE = {
  proposal_ready: "badge--ok",
  manual_fallback: "badge--warn",
  gap: "badge--warn",
  failed: "badge--error",
  deferred: "badge--muted",
  not_available: "badge--muted",
};

const PROPOSAL_STATUS_LABEL = {
  review_needed: "Needs review",
  blocked: "Blocked",
  confirmed: "Confirmed",
  deferred: "Deferred",
  not_available: "Not available",
  rejected: "Rejected",
};

const PROPOSAL_STATUS_TONE = {
  review_needed: "badge--warn",
  blocked: "badge--error",
  confirmed: "badge--ok",
  deferred: "badge--muted",
  not_available: "badge--muted",
  rejected: "badge--muted",
};

function errorMessage(err, fallback) {
  return err instanceof Error ? err.message : fallback;
}

function emptyDraft() {
  return { targetShape: "auto", kind: "paste", text: "", url: "" };
}

function draftIsValid(draft) {
  if (draft.kind === "paste") return draft.text.trim().length > 0;
  if (draft.kind === "url") return /^https?:\/\/\S+/i.test(draft.url.trim());
  return false;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function DeepIngestPage({ initialState = null }) {
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(!initialState);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState(initialState?.selectedSourceId ?? null);
  const [selectedProposalId, setSelectedProposalId] = useState(
    initialState?.selectedProposalId ?? null
  );
  const [reviewFilter, setReviewFilter] = useState("all");
  const [edits, setEdits] = useState({});
  const [busyLane, setBusyLane] = useState(null);
  const [busySourceId, setBusySourceId] = useState(null);
  const [busyProposalAction, setBusyProposalAction] = useState(false);
  const fileInputRef = useRef(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch-on-mount only when no initialState was handed in; refresh() covers every later reload
  useEffect(() => {
    if (initialState) return undefined;
    let cancelled = false;
    getDeepIngestState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setSelectedSourceId(next?.selectedSourceId ?? null);
        setSelectedProposalId(next?.selectedProposalId ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err, "Could not load deep ingest state."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    try {
      const next = await getDeepIngestState();
      setState(next);
      return next;
    } catch (err) {
      setError(errorMessage(err, "Could not refresh deep ingest state."));
      return null;
    }
  }

  async function handleIngestSource() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = { targetShape: draft.targetShape, sourceKind: draft.kind };
      if (draft.kind === "paste") payload.text = draft.text;
      if (draft.kind === "url") payload.url = draft.url;
      await submitDeepIngestSource(payload);
      await refresh();
      setDraft(emptyDraft());
    } catch (err) {
      setError(errorMessage(err, "Could not ingest that source."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0] || null;
    event.target.value = "";
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      await uploadDeepIngestFile(file, { targetShape: draft.targetShape });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not upload that file."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRetrySource(source) {
    setBusySourceId(source.id);
    setError(null);
    try {
      const payload = {
        targetShape: source.targetShape || "auto",
        sourceKind: source.sourceKind || source.kind,
      };
      const text = source.metadata?.text ?? source.text;
      const url = source.metadata?.url ?? source.url;
      if (text) payload.text = text;
      if (url) payload.url = url;
      await submitDeepIngestSource(payload);
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not retry that source."));
    } finally {
      setBusySourceId(null);
    }
  }

  function handleEnterManually(source) {
    setDraft({ targetShape: source.targetShape || "auto", kind: "paste", text: "", url: "" });
  }

  async function handleLaneAction(laneKey, status) {
    let reason = null;
    if (status === "deferred" || status === "not_available") {
      reason = globalThis.prompt?.("Reason (required)?") || "";
      if (!reason.trim()) return;
    }
    setBusyLane(laneKey);
    setError(null);
    try {
      await updateDeepIngestLaneState({ lane: laneKey, status, reason: reason || null });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not update that lane."));
    } finally {
      setBusyLane(null);
    }
  }

  async function handleSaveEdits(proposal) {
    setBusyProposalAction(true);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "save_edits",
        edits: {
          title: edits.title ?? proposal.title,
          summary: edits.summary ?? proposal.summary,
          supportingQuote: edits.supportingQuote ?? proposal.supportingQuote,
        },
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not save proposal edits."));
    } finally {
      setBusyProposalAction(false);
    }
  }

  async function handleConfirmProposal(proposal) {
    setBusyProposalAction(true);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "confirm",
      });
      await refresh();
      setEdits({});
    } catch (err) {
      setError(errorMessage(err, "Could not confirm that proposal."));
    } finally {
      setBusyProposalAction(false);
    }
  }

  function selectSource(id) {
    setSelectedSourceId(id);
  }

  function selectProposal(id) {
    setSelectedProposalId(id);
    setEdits({});
  }

  const lanes = asArray(state?.lanes);
  const sources = asArray(state?.sources);
  const proposals = asArray(state?.proposals);
  const readiness = state?.readiness || {
    terminalCount: 0,
    requiredCount: lanes.length,
  };
  const filteredProposals =
    reviewFilter === "all" ? proposals : proposals.filter((p) => p.status === reviewFilter);
  const editorProposal = selectedProposalId
    ? proposals.find((p) => p.id === selectedProposalId) || null
    : null;
  const editorTitle = edits.title ?? editorProposal?.title ?? "";
  const editorSummary = edits.summary ?? editorProposal?.summary ?? "";
  const editorQuote = edits.supportingQuote ?? editorProposal?.supportingQuote ?? "";
  const hasEdits = Object.keys(edits).length > 0;
  const confirmDisabled =
    !editorProposal || busyProposalAction || (editorProposal.status === "blocked" && !hasEdits);

  return (
    <div className="deep-ingest">
      <header className="deep-ingest__hero">
        <div className="deep-ingest__title-block">
          <h1 className="deep-ingest__title">Deep ingest</h1>
          <p className="deep-ingest__subtitle">
            Paste, drop, or link profile material to create reviewable proposals for evidence,
            stories, honesty, voice, and role signals.
          </p>
        </div>
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="deep-ingest__loading">Loading…</p> : null}

      <section className="card deep-ingest__panel" aria-label="Lane progress">
        <header className="card__header">
          <h2 className="card__title">
            <span className="deep-ingest__panel-icon" aria-hidden="true">
              <ListIcon />
            </span>
            <span>Lane progress</span>
          </h2>
          <span className="deep-ingest__progress-text">
            {readiness.terminalCount ?? 0} of {readiness.requiredCount ?? lanes.length} lanes
            terminal
          </span>
        </header>
        <div className="card__body deep-ingest__lane-grid">
          {lanes.map((lane) => (
            <LaneRow
              key={lane.key || lane.lane}
              lane={lane}
              busy={busyLane === (lane.key || lane.lane)}
              onAction={handleLaneAction}
            />
          ))}
        </div>
      </section>

      <section className="card deep-ingest__panel" aria-label="Add a source">
        <header className="card__header">
          <h2 className="card__title">
            <span className="deep-ingest__panel-icon" aria-hidden="true">
              <UploadIcon />
            </span>
            <span>Add a source</span>
          </h2>
        </header>
        <div className="card__body">
          <div className="deep-ingest__segmented" aria-label="Target lane" role="tablist">
            {TARGET_SHAPE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                role="tab"
                aria-selected={draft.targetShape === option.value}
                className={`deep-ingest__segment${
                  draft.targetShape === option.value ? " deep-ingest__segment--active" : ""
                }`}
                onClick={() => setDraft((prev) => ({ ...prev, targetShape: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="deep-ingest__segmented" aria-label="Source input kind" role="tablist">
            {INPUT_KIND_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                role="tab"
                aria-selected={draft.kind === option.value}
                className={`deep-ingest__segment${
                  draft.kind === option.value ? " deep-ingest__segment--active" : ""
                }`}
                onClick={() => setDraft((prev) => ({ ...prev, kind: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>

          {draft.kind === "paste" ? (
            <TextArea
              id="deep-ingest-paste"
              rows={5}
              value={draft.text}
              onChange={(value) => setDraft((prev) => ({ ...prev, text: value }))}
              placeholder="Paste profile material to ingest…"
              aria-label="Source text"
            />
          ) : (
            <TextField
              id="deep-ingest-link"
              type="url"
              value={draft.url}
              onChange={(value) => setDraft((prev) => ({ ...prev, url: value }))}
              placeholder="https://…"
              aria-label="Source link"
            />
          )}

          <button
            type="button"
            className="dropzone deep-ingest__dropzone"
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="dropzone__icon" aria-hidden="true">
              <UploadIcon />
            </span>
            <span>Drop a file to upload</span>
            <small>Click to select</small>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          <div className="deep-ingest__form-actions">
            <Button disabled={submitting || !draftIsValid(draft)} onClick={handleIngestSource}>
              {submitting ? "Ingesting…" : "Ingest source"}
            </Button>
          </div>
        </div>
      </section>

      <section className="card deep-ingest__panel" aria-label="Source preview">
        <header className="card__header">
          <h2 className="card__title">Source preview</h2>
        </header>
        <div className="card__body">
          {sources.length ? (
            <div className="deep-ingest__source-list">
              {sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  selected={source.id === selectedSourceId}
                  busy={busySourceId === source.id}
                  onSelect={() => selectSource(source.id)}
                  onEnterManually={() => handleEnterManually(source)}
                  onRetry={() => handleRetrySource(source)}
                />
              ))}
            </div>
          ) : (
            <div className="deep-ingest__empty">No deep ingest sources yet</div>
          )}
        </div>
      </section>

      <section className="card deep-ingest__panel" aria-label="Review queue">
        <header className="card__header">
          <h2 className="card__title">Review queue</h2>
        </header>
        <div className="card__body">
          <div className="deep-ingest__segmented" aria-label="Review queue filters" role="tablist">
            {REVIEW_FILTERS.map((option) => (
              <button
                type="button"
                key={option.value}
                role="tab"
                aria-selected={reviewFilter === option.value}
                className={`deep-ingest__segment${
                  reviewFilter === option.value ? " deep-ingest__segment--active" : ""
                }`}
                onClick={() => setReviewFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {filteredProposals.length ? (
            <div className="deep-ingest__proposal-list">
              {filteredProposals.map((proposal) => (
                <ProposalRow
                  key={proposal.id}
                  proposal={proposal}
                  selected={proposal.id === selectedProposalId}
                  onSelect={() => selectProposal(proposal.id)}
                />
              ))}
            </div>
          ) : (
            <div className="deep-ingest__empty">No proposals match this filter.</div>
          )}
        </div>
      </section>

      <section className="card deep-ingest__panel" aria-label="Proposal editor">
        <header className="card__header">
          <h2 className="card__title">Proposal editor</h2>
          {editorProposal ? (
            <span
              className={`badge ${PROPOSAL_STATUS_TONE[editorProposal.status] || "badge--muted"}`}
            >
              {PROPOSAL_STATUS_LABEL[editorProposal.status] || editorProposal.status}
            </span>
          ) : null}
        </header>
        <div className="card__body">
          {editorProposal ? (
            <>
              <TextField
                id="deep-ingest-proposal-title"
                value={editorTitle}
                onChange={(value) => setEdits((prev) => ({ ...prev, title: value }))}
                aria-label="Proposal title"
              />
              <TextArea
                id="deep-ingest-proposal-summary"
                rows={3}
                value={editorSummary}
                onChange={(value) => setEdits((prev) => ({ ...prev, summary: value }))}
                aria-label="Proposal summary"
              />
              <TextArea
                id="deep-ingest-proposal-quote"
                rows={2}
                value={editorQuote}
                onChange={(value) => setEdits((prev) => ({ ...prev, supportingQuote: value }))}
                aria-label="Supporting quote"
              />
              <div className="deep-ingest__form-actions">
                <Button
                  variant="secondary"
                  disabled={busyProposalAction}
                  onClick={() => handleSaveEdits(editorProposal)}
                >
                  {busyProposalAction ? "Saving…" : "Save edits"}
                </Button>
                <Button
                  disabled={confirmDisabled}
                  onClick={() => handleConfirmProposal(editorProposal)}
                >
                  {busyProposalAction ? "Confirming…" : "Confirm proposal"}
                </Button>
              </div>
            </>
          ) : (
            <div className="deep-ingest__empty">
              Select a proposal from the review queue to edit it.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function LaneRow({ lane, busy, onAction }) {
  const laneKey = lane.key || lane.lane;
  const terminal = laneIsTerminal(lane);
  return (
    <div className="deep-ingest__lane-row">
      <div className="deep-ingest__lane-main">
        <span className="deep-ingest__lane-label">{lane.label || laneKey}</span>
        <span className={`badge ${LANE_STATUS_TONE[lane.status] || "badge--muted"}`}>
          {LANE_STATUS_LABEL[lane.status] || lane.status}
        </span>
      </div>
      {lane.reason ? <p className="deep-ingest__lane-reason">{lane.reason}</p> : null}
      {!terminal ? (
        <div className="deep-ingest__lane-actions">
          <Button variant="secondary" disabled={busy} onClick={() => onAction(laneKey, "deferred")}>
            Defer lane
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onAction(laneKey, "not_available")}
          >
            Mark not available
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SourceRow({ source, selected, busy, onSelect, onEnterManually, onRetry }) {
  return (
    <article
      className={`deep-ingest__source-row${selected ? " deep-ingest__source-row--active" : ""}`}
    >
      <button type="button" className="deep-ingest__source-main" onClick={onSelect}>
        <span className="deep-ingest__source-title">
          {source.title || source.label || source.id}
        </span>
        <span className="deep-ingest__source-meta">
          <span>
            {SOURCE_KIND_LABEL[source.kind] || SOURCE_KIND_LABEL[source.sourceKind] || source.kind}
          </span>
          <span>{TARGET_SHAPE_LABEL[source.targetShape] || source.targetShape}</span>
        </span>
        {source.preview ? <p className="deep-ingest__source-preview">{source.preview}</p> : null}
      </button>
      <div className="deep-ingest__source-side">
        <span className={`badge ${SOURCE_STATUS_TONE[source.status] || "badge--muted"}`}>
          {source.status}
        </span>
        <div className="deep-ingest__source-actions">
          {source.status === "proposal_ready" ? (
            <Button variant="secondary" onClick={onSelect}>
              Review proposals
            </Button>
          ) : null}
          {source.status === "manual_fallback" ? (
            <>
              <Button variant="secondary" onClick={onEnterManually}>
                Enter manually
              </Button>
              <Button variant="secondary" disabled={busy} onClick={onRetry}>
                {busy ? "Retrying…" : "Retry ingest"}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ProposalRow({ proposal, selected, onSelect }) {
  return (
    <button
      type="button"
      className={`deep-ingest__proposal-row${selected ? " deep-ingest__proposal-row--active" : ""}`}
      onClick={onSelect}
    >
      <span className="deep-ingest__proposal-title">{proposal.title || proposal.id}</span>
      <span className={`badge ${PROPOSAL_STATUS_TONE[proposal.status] || "badge--muted"}`}>
        {PROPOSAL_STATUS_LABEL[proposal.status] || proposal.status}
      </span>
      {proposal.summary ? (
        <p className="deep-ingest__proposal-summary">{proposal.summary}</p>
      ) : null}
    </button>
  );
}
