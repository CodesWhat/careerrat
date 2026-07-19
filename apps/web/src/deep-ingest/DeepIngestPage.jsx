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
import { Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { TextArea, TextField } from "../components/form.jsx";
import { ListIcon, UploadIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  buildDeepIngestProposals,
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

// One-lane-focus stepper: picks the lane the page should point at next. Given
// `null` (nothing focused yet) it's also the initial-focus computation —
// first non-terminal lane in server order, matching the "Start here" ranking.
// Given the currently focused key it holds position while that lane is still
// open, and only advances (wrapping past the end) once that lane has gone
// terminal — deferred/not_available/completed all count, same as everywhere
// else on this page. Returns null once every lane is terminal, which is the
// completion-panel signal.
function advanceFocusedLane(currentKey, lanes) {
  const list = asArray(lanes);
  if (!list.length) return currentKey;
  const currentIndex = list.findIndex((lane) => (lane.key || lane.lane) === currentKey);
  const current = currentIndex >= 0 ? list[currentIndex] : null;
  if (current && !laneIsTerminal(current)) return currentKey;
  const ordered =
    currentIndex >= 0
      ? [...list.slice(currentIndex + 1), ...list.slice(0, currentIndex + 1)]
      : list;
  const next = ordered.find((lane) => !laneIsTerminal(lane));
  return next ? next.key || next.lane : null;
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

// Preset reasons for the lane skip picker (Defer lane / Mark not available).
// A custom-text fallback still lives alongside these in LaneRow's reason
// TextField — the server keeps requiring a non-empty reason for deferred/
// not_available lane states regardless of how it was typed in.
const REASON_CHIP_PRESETS = ["Not relevant to me", "Don't have this yet", "I'll do it later"];

// Honesty-calibrated payoff copy per lane (deep-dive plan §3 item 5):
// evidence_claims is the only lane any generated artifact reads today; the
// other four confirmed-item lanes only feed Library. source_coverage/
// open_gaps intentionally have no line — pure scaffolding, no real
// downstream consumer to promise.
const LANE_PAYOFF_LINE = {
  evidence_claims:
    "Powers every tailored résumé, cover letter, and answer you generate from here on.",
  story_bank: "Saved to your Library as reference material you can browse and copy from.",
  writing_voice: "Saved to your Library as reference material you can browse and copy from.",
  honesty_boundaries: "Saved to your Library as reference material you can browse and copy from.",
  role_signals: "Saved to your Library as reference material you can browse and copy from.",
};

// Completion panel rows: one per confirmed-item lane, in the same order the
// lane rail renders them. `countKey` matches buildDeepIngestViewModel's
// `confirmed` payload (src/core/deep-ingest/view-model.mjs) so the counts
// shown here are read straight off the server, never recomputed client-side.
const COMPLETION_LANE_ROWS = [
  { key: "evidence_claims", countKey: "evidence", noun: ["claim", "claims"] },
  { key: "story_bank", countKey: "storyBank", noun: ["story", "stories"] },
  { key: "writing_voice", countKey: "writingVoice", noun: ["sample", "samples"] },
  { key: "honesty_boundaries", countKey: "honestyBoundaries", noun: ["boundary", "boundaries"] },
  { key: "role_signals", countKey: "roleSignals", noun: ["signal", "signals"] },
];

// Reverse of source-normalize.mjs's TARGET_SHAPE_TO_LANE — clicking a lane
// row re-points the "Add a source" segmented picker at the target shape
// that feeds it, so the next source you add already lands in the lane you
// just clicked. source_coverage/open_gaps have no single target shape of
// their own (open_gaps is where unmatched auto/paste/link sources land), so
// they're left out rather than guessed at.
const LANE_KEY_TO_TARGET_SHAPE = {
  evidence_claims: "evidence",
  story_bank: "story",
  writing_voice: "writing_voice",
  honesty_boundaries: "honesty_boundary",
  role_signals: "role_signal",
};

// deepIngestProposalPut always stores the full lane-table key (see
// src/cli/deep-ingest-route.mjs's proposalLane()), but proposal builders
// (src/core/deep-ingest/proposals/shared.mjs) internally use the shorter
// DEEP_INGEST_PROPOSAL_LANES vocabulary — this covers both so the "Will:"
// line's lane lookup never falls through to a raw, unlabeled key.
const LANE_KEY_ALIASES = {
  evidence: "evidence_claims",
  story: "story_bank",
  honesty: "honesty_boundaries",
  role_signal: "role_signals",
  gap: "open_gaps",
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

// deepIngestConfirmProposal/deepIngestProposalDecision (src/core/db/verbs/
// deep-ingest.mjs) only ever read `edits.items` — an array of per-item rows —
// never a flat {title, summary, supportingQuote} object. This wraps the
// editor's three fields (the only ones this page exposes, regardless of
// lane) into that one-item array, falling back to the proposal's own values
// for anything the reviewer hasn't touched. `sourceId` rides along so the
// grounding/evidence-claim extraction on the backend has it even if a lane's
// row shape doesn't already carry it.
function proposalEditItem(proposal, edits) {
  return {
    sourceId: proposal.sourceId,
    title: edits.title ?? proposal.title,
    summary: edits.summary ?? proposal.summary,
    supportingQuote: edits.supportingQuote ?? proposal.supportingQuote,
  };
}

// Verbatim reuse of IntakeCard's "Extracted entities" idiom (apps/web/src/
// inbox/IntakeCard.jsx) — a proposal's real AI extraction lives in its
// opaque `payload` object, which has no fixed schema (the AI decides the
// shape per lane). Nested objects/arrays are omitted rather than rendered
// as "[object Object]": this is a read-only preview of what got extracted,
// not a full structured editor.
function payloadEntries(payload) {
  return Object.entries(payload || {}).filter(
    ([, value]) =>
      value !== null && value !== undefined && value !== "" && typeof value !== "object"
  );
}

// Matches a proposal's `lane` field back to the same label already shown in
// the Lane progress panel, so "Will: save to your {label}" never drifts
// from the lane rows above it. Falls back to a humanized raw lane key
// rather than throwing if a lane can't be found — this line is a
// client-side convenience, not a server-derived guarantee.
function laneLabelForProposal(proposal, lanes) {
  const laneKey = LANE_KEY_ALIASES[proposal?.lane] || proposal?.lane;
  const match = lanes.find((lane) => (lane.key || lane.lane) === laneKey);
  if (match?.label) return match.label;
  return String(proposal?.lane || "library").replace(/_/g, " ");
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
  const [laneSkipDraft, setLaneSkipDraft] = useState(null);
  const [laneQueueFilter, setLaneQueueFilter] = useState(null);
  // One-lane-focus stepper state. `focusedLaneKey` starts at the first
  // non-terminal lane in `initialState` (null when there's no initialState
  // yet — the mount effect below fills it in once the real fetch lands).
  // `showAllLanes` is the "Focused"/"All lanes" escape hatch: flipping it
  // renders every lane expanded at once, i.e. the pre-stepper flat layout,
  // without duplicating the lane list.
  const [focusedLaneKey, setFocusedLaneKey] = useState(() =>
    advanceFocusedLane(null, initialState?.lanes)
  );
  const [showAllLanes, setShowAllLanes] = useState(false);
  const fileInputRef = useRef(null);
  const addSourceRef = useRef(null);

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
        setFocusedLaneKey((prev) => (prev === null ? advanceFocusedLane(null, next?.lanes) : prev));
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
      // Auto-advance: every write path re-reads state through here, so this
      // is the one place that needs to check whether the focused lane just
      // went terminal (last pending proposal decided, lane deferred, lane
      // marked not available) and, if so, step to the next open lane —
      // wrapping past the end, landing on null (completion state) once none
      // remain. Holds position untouched while the focused lane is still open.
      const nextFocusedLane = advanceFocusedLane(focusedLaneKey, next?.lanes);
      if (nextFocusedLane !== focusedLaneKey) {
        setFocusedLaneKey(nextFocusedLane);
        setLaneQueueFilter(nextFocusedLane);
      }
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

  // Reveals the inline reason-chip picker for a lane's Defer/Mark-not-
  // available action instead of the old free-text globalThis.prompt() —
  // submitLaneSkip below still sends a required, non-empty reason, same as
  // the server has always demanded.
  function revealLaneSkip(laneKey, status) {
    setLaneSkipDraft({ laneKey, status, reason: "" });
  }

  function cancelLaneSkip() {
    setLaneSkipDraft(null);
  }

  function setLaneSkipReason(reason) {
    setLaneSkipDraft((prev) => (prev ? { ...prev, reason } : prev));
  }

  async function submitLaneSkip() {
    const draft = laneSkipDraft;
    if (!draft?.reason.trim()) return;
    setBusyLane(draft.laneKey);
    setError(null);
    try {
      await updateDeepIngestLaneState({
        lane: draft.laneKey,
        status: draft.status,
        reason: draft.reason.trim(),
      });
      await refresh();
      setLaneSkipDraft(null);
    } catch (err) {
      setError(errorMessage(err, "Could not update that lane."));
    } finally {
      setBusyLane(null);
    }
  }

  // Re-points "Add a source" at this lane's target shape and narrows the
  // Review queue to this lane's own proposals, then scrolls the Add-source
  // panel into view — the simplest mechanism that actually moves the user
  // toward the lane's next step rather than just highlighting the row.
  function focusLane(laneKey) {
    const targetShape = LANE_KEY_TO_TARGET_SHAPE[laneKey];
    if (targetShape) setDraft((prev) => ({ ...prev, targetShape }));
    setFocusedLaneKey(laneKey);
    setLaneQueueFilter(laneKey);
    addSourceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleSaveEdits(proposal) {
    setBusyProposalAction(true);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "save_edits",
        edits: { items: [proposalEditItem(proposal, edits)] },
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
        edits: { items: [proposalEditItem(proposal, edits)] },
      });
      await refresh();
      setEdits({});
    } catch (err) {
      setError(errorMessage(err, "Could not confirm that proposal."));
    } finally {
      setBusyProposalAction(false);
    }
  }

  // "reopen" (deepIngestProposalDecision's PROPOSAL_DECISION_TO_STATUS map,
  // src/core/db/verbs/deep-ingest.mjs) moves a confirmed proposal back to
  // review_needed without touching its stored payload/edits — this is the
  // affordance the plan asks for on confirmed proposals, through the same
  // decision endpoint save/confirm already use.
  async function handleReopenProposal(proposal) {
    setBusyProposalAction(true);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "reopen",
      });
      await refresh();
      setEdits({});
    } catch (err) {
      setError(errorMessage(err, "Could not reopen that proposal."));
    } finally {
      setBusyProposalAction(false);
    }
  }

  async function handleGenerateProposals(source) {
    setBusySourceId(source.id);
    setError(null);
    try {
      await buildDeepIngestProposals({ sourceId: source.id, targetShape: source.targetShape });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not generate proposals for that source."));
    } finally {
      setBusySourceId(null);
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
  const filteredProposals = proposals.filter((p) => {
    if (reviewFilter !== "all" && p.status !== reviewFilter) return false;
    if (laneQueueFilter && p.lane !== laneQueueFilter) return false;
    return true;
  });
  const editorProposal = selectedProposalId
    ? proposals.find((p) => p.id === selectedProposalId) || null
    : null;
  const editorTitle = edits.title ?? editorProposal?.title ?? "";
  const editorSummary = edits.summary ?? editorProposal?.summary ?? "";
  const editorQuote = edits.supportingQuote ?? editorProposal?.supportingQuote ?? "";
  const editorPayload = payloadEntries(editorProposal?.payload);
  const editorLaneLabel = editorProposal ? laneLabelForProposal(editorProposal, lanes) : null;
  const editorConfirmed = editorProposal?.status === "confirmed";
  const hasEdits = Object.keys(edits).length > 0;
  const confirmDisabled =
    !editorProposal || busyProposalAction || (editorProposal.status === "blocked" && !hasEdits);
  const laneQueueFilterLabel = laneQueueFilter
    ? lanes.find((lane) => (lane.key || lane.lane) === laneQueueFilter)?.label || laneQueueFilter
    : null;

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
        <p className="deep-ingest__hero-progress">
          {readiness.terminalCount ?? 0} of {readiness.requiredCount ?? lanes.length} lanes settled
        </p>
      </header>

      {error ? <InlineAlert message={error} /> : null}
      {loading ? <p className="deep-ingest__loading">Loading…</p> : null}

      {readiness.ready ? (
        <DeepIngestCompletionPanel lanes={lanes} confirmed={state?.confirmed} />
      ) : (
        <section className="card deep-ingest__panel" aria-label="Lane progress">
          <header className="card__header">
            <h2 className="card__title">
              <span className="deep-ingest__panel-icon" aria-hidden="true">
                <ListIcon />
              </span>
              <span>Lane progress</span>
            </h2>
            <div className="deep-ingest__lane-header-actions">
              <span className="deep-ingest__progress-text">
                {readiness.terminalCount ?? 0} of {readiness.requiredCount ?? lanes.length} lanes
                terminal
              </span>
              <div className="deep-ingest__segmented" aria-label="Lane view" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!showAllLanes}
                  className={`deep-ingest__segment${
                    !showAllLanes ? " deep-ingest__segment--active" : ""
                  }`}
                  onClick={() => setShowAllLanes(false)}
                >
                  Focused
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showAllLanes}
                  className={`deep-ingest__segment${
                    showAllLanes ? " deep-ingest__segment--active" : ""
                  }`}
                  onClick={() => setShowAllLanes(true)}
                >
                  All lanes
                </button>
              </div>
            </div>
          </header>
          <div className="card__body deep-ingest__lane-grid">
            {lanes.map((lane) => {
              const laneKey = lane.key || lane.lane;
              const focused = laneKey === focusedLaneKey;
              return (
                <LaneRow
                  key={laneKey}
                  lane={lane}
                  expanded={showAllLanes || focused}
                  focused={focused}
                  busy={busyLane === laneKey}
                  skipDraft={
                    laneSkipDraft && laneSkipDraft.laneKey === laneKey ? laneSkipDraft : null
                  }
                  onSelectLane={() => focusLane(laneKey)}
                  onRevealSkip={(status) => revealLaneSkip(laneKey, status)}
                  onSkipReasonChange={setLaneSkipReason}
                  onSubmitSkip={submitLaneSkip}
                  onCancelSkip={cancelLaneSkip}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="card deep-ingest__panel" aria-label="Add a source" ref={addSourceRef}>
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
                  onGenerateProposals={() => handleGenerateProposals(source)}
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

          {laneQueueFilter ? (
            <p className="field__hint">
              Filtered to {laneQueueFilterLabel} —{" "}
              <button
                type="button"
                className="deep-ingest__clear-lane-filter"
                onClick={() => setLaneQueueFilter(null)}
              >
                Show all lanes
              </button>
            </p>
          ) : null}

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
              {editorPayload.length ? (
                <div className="chip-row">
                  {editorPayload.map(([key, value]) => (
                    <span className="chip" key={key}>
                      <span className="field__label">{key}:</span>&nbsp;
                      {String(value)}
                    </span>
                  ))}
                </div>
              ) : null}
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
              {!editorConfirmed ? (
                <p className="intake-card__dispatch">Will: save to your {editorLaneLabel}</p>
              ) : null}
              <div className="deep-ingest__form-actions">
                {editorConfirmed ? (
                  <Button
                    variant="secondary"
                    disabled={busyProposalAction}
                    onClick={() => handleReopenProposal(editorProposal)}
                  >
                    {busyProposalAction ? "Reopening…" : "Reopen"}
                  </Button>
                ) : (
                  <>
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
                  </>
                )}
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

function LaneRow({
  lane,
  expanded,
  focused,
  busy,
  skipDraft,
  onSelectLane,
  onRevealSkip,
  onSkipReasonChange,
  onSubmitSkip,
  onCancelSkip,
}) {
  const laneKey = lane.key || lane.lane;
  const terminal = laneIsTerminal(lane);
  const showStartHere = laneKey === "evidence_claims" && !terminal;
  const payoffLine = LANE_PAYOFF_LINE[laneKey];
  const rowClassName = [
    "deep-ingest__lane-row",
    expanded ? null : "deep-ingest__lane-row--compact",
    focused ? "deep-ingest__lane-row--focused" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={rowClassName}>
      <button type="button" className="deep-ingest__lane-main" onClick={onSelectLane}>
        <span className="deep-ingest__lane-label">{lane.label || laneKey}</span>
        <span className="deep-ingest__lane-badges">
          {showStartHere ? <span className="badge badge--ok">Start here</span> : null}
          <span className={`badge ${LANE_STATUS_TONE[lane.status] || "badge--muted"}`}>
            {LANE_STATUS_LABEL[lane.status] || lane.status}
          </span>
        </span>
      </button>
      {expanded && payoffLine ? <p className="deep-ingest__lane-payoff">{payoffLine}</p> : null}
      {expanded && lane.reason ? <p className="deep-ingest__lane-reason">{lane.reason}</p> : null}
      {expanded && !terminal && skipDraft ? (
        <div className="deep-ingest__lane-skip">
          <div className="chip-row">
            {REASON_CHIP_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset}
                className={`chip${
                  skipDraft.reason === preset ? " deep-ingest__reason-chip--active" : ""
                }`}
                aria-pressed={skipDraft.reason === preset}
                onClick={() => onSkipReasonChange(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <TextField
            id={`deep-ingest-lane-skip-reason-${laneKey}`}
            value={skipDraft.reason}
            onChange={onSkipReasonChange}
            placeholder="Or write your own reason…"
            aria-label="Skip reason"
          />
          <p className="field__hint">
            Skipping is fine — come back anytime from the Dashboard, Library, or this page.
          </p>
          <div className="deep-ingest__form-actions">
            <Button disabled={busy || !skipDraft.reason.trim()} onClick={onSubmitSkip}>
              {busy
                ? "Saving…"
                : skipDraft.status === "deferred"
                  ? "Defer lane"
                  : "Mark not available"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={onCancelSkip}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {expanded && !terminal && !skipDraft ? (
        <div className="deep-ingest__lane-actions">
          <Button variant="secondary" disabled={busy} onClick={() => onRevealSkip("deferred")}>
            Defer lane
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onRevealSkip("not_available")}>
            Mark not available
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SourceRow({
  source,
  selected,
  busy,
  onSelect,
  onEnterManually,
  onRetry,
  onGenerateProposals,
}) {
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
            <>
              <Button variant="secondary" onClick={onSelect}>
                Review proposals
              </Button>
              <Button variant="secondary" disabled={busy} onClick={onGenerateProposals}>
                {busy ? "Generating…" : "Generate proposals"}
              </Button>
            </>
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

// Replaces the "Lane progress" stepper once readiness.ready is true. Counts
// come straight off buildDeepIngestViewModel's `confirmed` payload (never
// recomputed from proposals here), and copy reuses the exact LANE_PAYOFF_LINE
// strings every lane row already shows — same calibration, just read once
// the work is done: evidence powers generation, the rest is saved reference
// material.
function DeepIngestCompletionPanel({ lanes, confirmed }) {
  return (
    <section className="card deep-ingest__panel" aria-label="Deep ingest complete">
      <header className="card__header">
        <h2 className="card__title">
          <span className="deep-ingest__panel-icon" aria-hidden="true">
            <ListIcon />
          </span>
          <span>All lanes settled</span>
        </h2>
      </header>
      <div className="card__body">
        <ul className="deep-ingest__completion-list">
          {COMPLETION_LANE_ROWS.map((row) => {
            const label =
              lanes.find((lane) => (lane.key || lane.lane) === row.key)?.label ||
              row.key.replace(/_/g, " ");
            const count = asArray(confirmed?.[row.countKey]).length;
            const noun = count === 1 ? row.noun[0] : row.noun[1];
            return (
              <li key={row.key}>
                <strong>{label}:</strong> {count} {noun} captured. {LANE_PAYOFF_LINE[row.key]}
              </li>
            );
          })}
        </ul>
        <div className="deep-ingest__form-actions">
          <Link className="btn btn--secondary" to="/library">
            Browse your Library
          </Link>
          <Link className="btn btn--secondary" to="/">
            Back to Dashboard
          </Link>
        </div>
      </div>
    </section>
  );
}
