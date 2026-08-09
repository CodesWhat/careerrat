// apps/web/src/deep-ingest/DeepIngestPage.jsx — the /deep-ingest wizard.
//
// One-step-at-a-time rebuild (2026-07-20 redesign, see
// .internal/deep-ingest-wizard-redesign-2026-07-20.md): Material -> Evidence
// -> Stories -> Honesty -> Voice -> Role signals -> Done, matching the
// onboarding flow's visual grammar (step label / step card / media+content /
// nav buttons / progress rail) — but rendered INSIDE the app shell (top nav
// stays visible), so this deliberately does NOT import OnboardingShell
// itself (it hard-wires its own full-bleed OnboardingTopBar). Only
// OnboardingNavButton (a plain icon button, no header) gets imported from
// onboarding; the step rail and the back/next stage are rebuilt locally (the
// rail reuses onboarding's `.onboarding-progress`/`__case*` pill classes
// verbatim — see DeepWizardRail below); everything else lives under a
// `deep-wizard__*` class namespace in app.css.
//
// Data plumbing is unchanged from the previous five-panel layout: same six
// endpoints via ../lib/api.js (state read, source submit/upload, proposal
// build, proposal decisions, lane state), same "every write re-reads
// getDeepIngestState() afterward" discipline. What changed is what the UI
// does with the response:
//
// - The proposals table stores each row as an OUTER wrapper
//   ({id, sourceId, lane, status, version, proposal: {...}, decision,
//   reason}) around an INNER AI-authored (or mechanically-stubbed) row. The
//   outer `.lane` is already a full lane-table key (evidence_claims/
//   story_bank/honesty_boundaries/writing_voice/role_signals/open_gaps) —
//   no alias table needed to group proposals by wizard step. The inner
//   `.proposal.payload` is genuinely schema-free (the AI decides its shape
//   per lane; see core/deep-ingest/proposals/shared.mjs), and inner
//   `.proposal.supportingQuote` is the one fixed-schema content field — see
//   proposalDisplaySummary/proposalDisplayTitle/proposalQuote below for how
//   a title/summary get derived from that instead of read off nonexistent
//   flat fields (the previous layout read `proposal.title` directly off the
//   OUTER row, which never existed — the literal cause of the "empty editor
//   fields" bug this redesign fixes).
// - A source's mechanical scan-stub proposal (created the instant a source
//   is ingested, before any AI runs — summary "Source scanned and ready for
//   review.") is tagged `validation.status === "source_scanned"` on the
//   INNER row. A drafted claim the honesty/grounding check couldn't support
//   is tagged `validation.status === "blocked"` and collapses to an empty
//   payload. Neither is ever a reviewable card anywhere in this wizard —
//   see isUnreviewableProposal.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button.jsx";
import { TextArea, TextField } from "../components/form.jsx";
import { UploadIcon } from "../components/icons.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  buildDeepIngestProposals,
  decideDeepIngestProposal,
  getDeepIngestState,
  removeDeepIngestSource,
  submitDeepIngestSource,
  updateDeepIngestLaneState,
  uploadDeepIngestFile,
} from "../lib/api.js";
import { OnboardingNavButton } from "../onboarding/OnboardingShell.jsx";

const INPUT_KIND_OPTIONS = [
  { value: "paste", label: "Paste" },
  { value: "url", label: "Link" },
];

// Honesty-calibrated payoff copy per lane — verbatim reuse of the strings
// the previous layout's LANE_PAYOFF_LINE shipped (deep-dive plan §3 item 5 /
// promotion-pipeline design "UI copy"), now doubling as each lane step's
// hero one-liner.
const LANE_PAYOFF_LINE = {
  evidence_claims:
    "Powers every tailored résumé, cover letter, and answer you generate from here on.",
  story_bank:
    "Feeds your tailored cover letters and answers — the most job-relevant confirmed stories are pulled in automatically, and résumés use them as theme hints.",
  honesty_boundaries:
    "Enforced on every tailored résumé, cover letter, and answer — its forbidden wording is blocked alongside your Settings honesty boundaries.",
  writing_voice:
    "Shapes the tone and phrasing of every tailored résumé, cover letter, and answer you generate from here on.",
  role_signals:
    "Sharpens fit checks and sourced-job scores for matching role families, and steers what your documents lean into or away from.",
};

// The five review lanes, in wizard order (steps 2-6). `key` matches both a
// proposal row's outer `.lane` and a lane row's `.key`/`.lane` directly — no
// short-vocabulary aliasing needed (see the file header comment).
const LANE_STEPS = [
  { key: "evidence_claims", pill: "Evidence", emoji: "🧾", heading: "Evidence claims" },
  { key: "story_bank", pill: "Stories", emoji: "📖", heading: "Story bank" },
  { key: "honesty_boundaries", pill: "Honesty", emoji: "🚫", heading: "Honesty boundaries" },
  { key: "writing_voice", pill: "Voice", emoji: "✍️", heading: "Writing voice" },
  { key: "role_signals", pill: "Role signals", emoji: "🎯", heading: "Role signals" },
];

// Confirmed-lane row arrays live under these keys in state.confirmed (see
// buildDeepIngestViewModel) — evidence_claims is the odd one out (it lands
// in candidate_evidence_claims, keyed `evidence`, not `evidence_claims`).
const LANE_CONFIRMED_COUNT_KEY = {
  evidence_claims: "evidence",
  story_bank: "storyBank",
  honesty_boundaries: "honestyBoundaries",
  writing_voice: "writingVoice",
  role_signals: "roleSignals",
};

// Short draft-noun per lane for the "No ___ drafts…" empty-state message —
// "evidence claims drafts"/"honesty boundaries drafts" reads broken, so this
// is deliberately not just laneLabel.toLowerCase().
const LANE_DRAFT_NOUN = {
  evidence_claims: "evidence",
  story_bank: "story",
  honesty_boundaries: "honesty",
  writing_voice: "voice",
  role_signals: "role-signal",
};

const MATERIAL_STEP = {
  id: "material",
  pill: "Material",
  emoji: "📥",
  heading: "Feed the machine",
  payoff: "Everything you give CareerRat here makes every application hit harder.",
  laneKey: null,
};

const DONE_STEP = {
  id: "done",
  pill: "Done",
  emoji: "✅",
  heading: "That's the deep stuff",
  payoff: "Confirmed material now feeds every résumé, cover letter, and answer.",
  laneKey: null,
};

const WIZARD_STEPS = [
  MATERIAL_STEP,
  ...LANE_STEPS.map((lane) => ({
    id: lane.key,
    pill: lane.pill,
    emoji: lane.emoji,
    heading: lane.heading,
    payoff: LANE_PAYOFF_LINE[lane.key],
    laneKey: lane.key,
  })),
  DONE_STEP,
];

// Fixed, honest, non-placeholder reason strings for the wizard's one-click
// skip affordances — the server still requires a non-empty reason for
// reject/deferred/not_available, but the redesign drops the old free-text
// reason-chip picker in favor of two quiet links doing exactly what they say.
const PROPOSAL_DISCARD_REASON = "Not relevant to me";
const LANE_DEFER_REASON = "Deferring this for later.";
const LANE_NOT_AVAILABLE_REASON = "Nothing to add here.";

const URL_LIKE_SOURCE_KINDS = new Set(["url", "linkedin", "portfolio", "project_link"]);
const FILE_LIKE_SOURCE_KINDS = new Set(["file", "repo", "local_path"]);

function errorMessage(err, fallback) {
  const apiMessage = String(err?.body?.error || "").trim();
  if (apiMessage) return apiMessage;
  return err instanceof Error ? err.message : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function emptyDraft() {
  return { kind: "paste", text: "", url: "" };
}

function draftIsValid(draft) {
  if (draft.kind === "paste") return draft.text.trim().length > 0;
  if (draft.kind === "url") return /^https?:\/\/\S+/i.test(draft.url.trim());
  return false;
}

// A proposal row's mechanical scan-stub marker (source-scanner.mjs writes
// this the instant a source is ingested, before "Draft proposals" ever
// runs) — hard-banned from every list in the wizard per the redesign spec.
function isMechanicalScanStub(row) {
  return row?.proposal?.validation?.status === "source_scanned";
}

// The honesty/grounding check can block a drafted claim outright
// (validation.status === "blocked" — the AI found something but couldn't
// support it from the source material). The payload collapses to
// {blocked: true}: no title, summary, or quote survive. There is nothing
// reviewable to show and nothing meaningful to "Confirm" — same failure
// mode as the mechanical stub (a card the user would confirm blind), so it
// gets the same hard ban.
function isBlockedProposal(row) {
  return row?.proposal?.validation?.status === "blocked";
}

function isUnreviewableProposal(row) {
  return isMechanicalScanStub(row) || isBlockedProposal(row);
}

// A "real" AI-authored draft: not a stub/blocked row, and not one of the
// admin fallback shapes (`manual_fallback` = the AI call failed and never
// produced content; `gap` = the AI explicitly punted this finding to manual
// review). Used to decide whether a source shows "Drafts ready".
function isRealDraftRow(row) {
  if (isUnreviewableProposal(row)) return false;
  const inner = row?.proposal;
  if (!inner || typeof inner !== "object") return false;
  return inner.status !== "manual_fallback" && inner.status !== "gap";
}

function sourceHasDrafts(sourceId, proposals) {
  return proposals.some((row) => row.sourceId === sourceId && isRealDraftRow(row));
}

// A source stays "proposal_ready" even after proposals are drafted for it —
// the server doesn't flip its status again on draft — so gating on status
// alone leaves "Draft proposals" hot forever and a re-click appends
// duplicate proposals for the same source. Only a source with no real drafts
// yet is actually draftable.
function sourceIsReadyToDraft(source, proposals) {
  return source.status === "proposal_ready" && !sourceHasDrafts(source.id, proposals);
}

function sourceNeedsReview(source, proposals) {
  if (sourceHasDrafts(source.id, proposals)) return false;
  return ["captured", "scanning", "proposal_ready", "manual_fallback", "failed"].includes(
    source.status
  );
}

function domainFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Human label per the redesign spec: file name for file-like sources, link
// domain for url-like sources, "Pasted notes" + the first ~6 words of the
// scanned preview for everything else. `textPreview` is the 240-char preview
// the scan route persists onto every source row (see
// src/cli/deep-ingest-route.mjs's persistScannedSource) — the only place raw
// pasted text survives on the source itself.
function sourceDisplayLabel(source) {
  const kind = source.sourceKind || source.kind || "";
  if (FILE_LIKE_SOURCE_KINDS.has(kind)) {
    return source.label || "Uploaded file";
  }
  if (URL_LIKE_SOURCE_KINDS.has(kind)) {
    return domainFromUrl(source.metadata?.url) || source.label || "Linked page";
  }
  const words = String(source.textPreview || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return words ? `Pasted notes — ${words}` : "Pasted notes";
}

function sourceStatusMeta(source, hasDrafts) {
  const status = source.status;
  if (status === "captured" || status === "scanning") {
    return { label: "Reading…", tone: "badge--muted" };
  }
  if (status === "manual_fallback" || status === "failed") {
    return { label: "Couldn't draft — needs a look", tone: "badge--warn" };
  }
  if (hasDrafts) return { label: "Drafts ready", tone: "badge--ok" };
  if (status === "proposal_ready") return { label: "Ready to draft", tone: "badge--muted" };
  if (status === "deferred" || status === "not_available") {
    return { label: "Skipped", tone: "badge--muted" };
  }
  return { label: "Couldn't draft — needs a look", tone: "badge--warn" };
}

function firstWords(text, count) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  const slice = words.slice(0, count).join(" ");
  return words.length > count ? `${slice}…` : slice;
}

function proposalPayload(row) {
  const payload = row?.proposal?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function proposalQuote(row) {
  const quote = row?.proposal?.supportingQuote;
  return typeof quote === "string" ? quote : "";
}

// payload has no fixed schema (the AI decides its shape per lane) — try the
// field names a summary is most likely to land under, then fall back to the
// first string-valued entry present at all, then "" (an empty card, which
// the inline edit form lets the reviewer fill in by hand). Never renders
// "[object Object]" — non-string payload entries are skipped outright.
function proposalDisplaySummary(row) {
  const payload = proposalPayload(row);
  const preferredKeys = [
    "summary",
    "claim",
    "description",
    "boundary",
    "signal",
    "sample",
    "body",
    "text",
  ];
  for (const key of preferredKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const firstString = Object.values(payload).find(
    (value) => typeof value === "string" && value.trim()
  );
  return firstString ? firstString.trim() : "";
}

function proposalDisplayTitle(row, summary) {
  const payload = proposalPayload(row);
  if (typeof payload.title === "string" && payload.title.trim()) return payload.title.trim();
  return firstWords(summary, 9);
}

// deepIngestConfirmProposal/deepIngestProposalDecision (src/core/db/verbs/
// deep-ingest.mjs) only ever read `edits.items` — an array of per-item rows
// — and writeConfirmedLaneOutput spreads each item's fields verbatim into
// the confirmed row. The wizard's edit form only surfaces title/summary/
// quote, but the AI payload carries lane-specific structure beyond that
// (situation/task/action/result for stories, boundaryType/allowedWording/
// forbiddenWording for honesty, roleFamily/signalType for role signals) —
// so this starts from the full payload and layers the reviewer's edits (or
// their AI-derived defaults) on top, instead of sending only three fields
// and silently dropping the rest on confirm.
function proposalEditItem(row, edits) {
  const summary = edits.summary ?? proposalDisplaySummary(row);
  const title = edits.title ?? proposalDisplayTitle(row, summary);
  const supportingQuote = edits.supportingQuote ?? proposalQuote(row);
  return {
    ...proposalPayload(row),
    ...edits,
    sourceId: row.sourceId,
    title,
    summary,
    supportingQuote,
  };
}

function gapDisplayText(gapRow) {
  const inner = gapRow?.proposal || {};
  const text = inner.payload?.reason || gapRow.reason || inner.reason || "";
  const trimmed = String(text || "").trim();
  return trimmed || "Needs another look.";
}

// A lane's footer pill goes done once it's settled: an explicit lane-level
// skip (deferred/not_available/completed), at least one confirmed item, or
// every real (non-stub) proposal ever drafted for it has moved off
// "review_needed". An untouched lane (no proposals, no lane-state write)
// stays not-done — same "only real data lights up a data-step pill" rule
// onboarding's own deriveDoneFlags uses, so the rail doesn't render all
// green before anything's actually been reviewed.
function isLaneSettled(laneKey, { lanes, proposals, confirmed }) {
  const lane = lanes.find((l) => (l.key || l.lane) === laneKey);
  if (lane && ["completed", "deferred", "not_available"].includes(lane.status)) return true;
  const countKey = LANE_CONFIRMED_COUNT_KEY[laneKey];
  if (countKey && asArray(confirmed?.[countKey]).length > 0) return true;
  const laneProposals = proposals.filter((p) => p.lane === laneKey && !isUnreviewableProposal(p));
  if (!laneProposals.length) return false;
  return laneProposals.every((p) => p.status !== "review_needed");
}

export function DeepIngestPage({ initialState = null }) {
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(!initialState);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [busySourceId, setBusySourceId] = useState(null);
  const [draftingAll, setDraftingAll] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [expandedProposalIds, setExpandedProposalIds] = useState(() => new Set());
  const [editsByProposal, setEditsByProposal] = useState({});
  const [busyProposalId, setBusyProposalId] = useState(null);
  const [busyLane, setBusyLane] = useState(null);
  const fileInputRef = useRef(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetch-on-mount only when no initialState was handed in; refresh() covers every later reload
  useEffect(() => {
    if (initialState) return undefined;
    let cancelled = false;
    getDeepIngestState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
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

  async function handleAddSource() {
    setSubmitting(true);
    setError(null);
    try {
      const payload = { targetShape: "auto", sourceKind: draft.kind };
      if (draft.kind === "paste") payload.text = draft.text;
      if (draft.kind === "url") payload.url = draft.url;
      await submitDeepIngestSource(payload);
      await refresh();
      setDraft(emptyDraft());
    } catch (err) {
      setError(errorMessage(err, "Could not add that source."));
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
      await uploadDeepIngestFile(file, { targetShape: "auto" });
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

  async function handleRemoveSource(source) {
    setBusySourceId(source.id);
    setError(null);
    try {
      await removeDeepIngestSource({ sourceId: source.id });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not remove that source."));
    } finally {
      setBusySourceId(null);
    }
  }

  async function handleDraftProposals() {
    const ready = sources.filter((source) => sourceIsReadyToDraft(source, proposals));
    if (!ready.length) return;
    setDraftingAll(true);
    setError(null);
    try {
      for (const source of ready) {
        await buildDeepIngestProposals({
          sourceId: source.id,
          targetShape: source.targetShape || "auto",
        });
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Could not draft proposals for one or more sources."));
    } finally {
      setDraftingAll(false);
    }
  }

  function setProposalEditField(proposalId, field, value) {
    setEditsByProposal((prev) => ({
      ...prev,
      [proposalId]: { ...(prev[proposalId] || {}), [field]: value },
    }));
  }

  function toggleExpandedProposal(proposalId) {
    setExpandedProposalIds((prev) => {
      const next = new Set(prev);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  }

  async function handleSaveProposalEdits(proposal) {
    const edits = editsByProposal[proposal.id] || {};
    setBusyProposalId(proposal.id);
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
      setError(errorMessage(err, "Could not save those edits."));
    } finally {
      setBusyProposalId(null);
    }
  }

  // Auto-advance: once the lane the wizard is currently showing has zero
  // real (non-stub) proposals left in "review_needed", the wizard owns its
  // own step index and just moves on — no server "terminal" flag involved
  // (confirming even one proposal already marks the underlying lane
  // completed server-side, which would advance too eagerly if we read that
  // instead of counting what's actually still pending here).
  async function refreshAndMaybeAdvanceLane(laneKey) {
    const next = await refresh();
    if (!next) return;
    const remaining = asArray(next.proposals).filter(
      (row) =>
        row.lane === laneKey && !isUnreviewableProposal(row) && row.status === "review_needed"
    ).length;
    if (remaining === 0) {
      setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
    }
  }

  async function handleConfirmProposal(proposal, laneKey) {
    const edits = editsByProposal[proposal.id] || {};
    setBusyProposalId(proposal.id);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "confirm",
        edits: { items: [proposalEditItem(proposal, edits)] },
      });
      setEditsByProposal((prev) => {
        const next = { ...prev };
        delete next[proposal.id];
        return next;
      });
      await refreshAndMaybeAdvanceLane(laneKey);
    } catch (err) {
      setError(errorMessage(err, "Could not confirm that proposal."));
    } finally {
      setBusyProposalId(null);
    }
  }

  async function handleDiscardProposal(proposal, laneKey) {
    setBusyProposalId(proposal.id);
    setError(null);
    try {
      await decideDeepIngestProposal({
        proposalId: proposal.id,
        expectedVersion: proposal.version,
        decision: "reject",
        reason: PROPOSAL_DISCARD_REASON,
      });
      await refreshAndMaybeAdvanceLane(laneKey);
    } catch (err) {
      setError(errorMessage(err, "Could not discard that proposal."));
    } finally {
      setBusyProposalId(null);
    }
  }

  async function handleLaneQuickSkip(laneKey, status, reason) {
    setBusyLane(laneKey);
    setError(null);
    try {
      await updateDeepIngestLaneState({ lane: laneKey, status, reason });
      await refresh();
      setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
    } catch (err) {
      setError(errorMessage(err, "Could not update that lane."));
    } finally {
      setBusyLane(null);
    }
  }

  function handleContinue() {
    if (stepIndex === 0) {
      setStepIndex(sources.length === 0 ? WIZARD_STEPS.length - 1 : 1);
      return;
    }
    setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  }

  function handleBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  const lanes = asArray(state?.lanes);
  const sources = asArray(state?.sources);
  const proposals = asArray(state?.proposals);
  const confirmed = state?.confirmed || {};
  const openGaps = asArray(state?.openGaps);

  const doneFlags = WIZARD_STEPS.map((step, index) => {
    if (index === 0) return stepIndex > 0;
    if (!step.laneKey) return false;
    return isLaneSettled(step.laneKey, { lanes, proposals, confirmed });
  });

  const currentStep = WIZARD_STEPS[stepIndex];
  const laneProposalsAll = currentStep.laneKey
    ? proposals.filter((row) => row.lane === currentStep.laneKey && !isUnreviewableProposal(row))
    : [];
  const laneReviewedCount = laneProposalsAll.filter((row) => row.status !== "review_needed").length;
  const lanePendingProposals = laneProposalsAll.filter((row) => row.status === "review_needed");
  const materialContinueEnabled =
    sources.length === 0 || sources.some((s) => sourceHasDrafts(s.id, proposals));

  return (
    <div className="deep-wizard">
      {error ? <InlineAlert message={error} /> : null}
      {loading ? (
        <p className="deep-wizard__loading">Loading…</p>
      ) : (
        <>
          <div className="deep-wizard__stack">
            <div className="deep-wizard__step-label-row">
              <span className="deep-wizard__step-label">Step {stepIndex + 1}</span>
              {currentStep.laneKey && laneProposalsAll.length ? (
                <span className="deep-wizard__reviewed-count">
                  {laneReviewedCount} of {laneProposalsAll.length} reviewed
                </span>
              ) : null}
            </div>

            <div className="deep-wizard__stage">
              <section
                className="deep-wizard__step-card"
                aria-labelledby={`deep-wizard-heading-${currentStep.id}`}
              >
                <div className="deep-wizard__step-card-media">
                  <div className="deep-wizard__mark" aria-hidden="true">
                    {currentStep.emoji}
                  </div>
                  <div className="deep-wizard__media-copy">
                    <h1 id={`deep-wizard-heading-${currentStep.id}`}>{currentStep.heading}</h1>
                    {currentStep.payoff ? <p>{currentStep.payoff}</p> : null}
                  </div>
                </div>

                <div className="deep-wizard__step-card-content">
                  {stepIndex === 0 ? (
                    <MaterialStepContent
                      draft={draft}
                      setDraft={setDraft}
                      submitting={submitting}
                      onAddSource={handleAddSource}
                      fileInputRef={fileInputRef}
                      onFileChange={handleFileChange}
                      sources={sources}
                      proposals={proposals}
                      busySourceId={busySourceId}
                      onRetry={handleRetrySource}
                      onRemove={handleRemoveSource}
                      draftingAll={draftingAll}
                      onDraftProposals={handleDraftProposals}
                    />
                  ) : currentStep.laneKey ? (
                    <LaneStepContent
                      laneKey={currentStep.laneKey}
                      laneLabel={currentStep.heading}
                      pendingProposals={lanePendingProposals}
                      expandedIds={expandedProposalIds}
                      editsByProposal={editsByProposal}
                      busyProposalId={busyProposalId}
                      busyLane={busyLane === currentStep.laneKey}
                      onToggleExpand={toggleExpandedProposal}
                      onEditField={setProposalEditField}
                      onSave={handleSaveProposalEdits}
                      onConfirm={(row) => handleConfirmProposal(row, currentStep.laneKey)}
                      onDiscard={(row) => handleDiscardProposal(row, currentStep.laneKey)}
                      onDefer={() =>
                        handleLaneQuickSkip(currentStep.laneKey, "deferred", LANE_DEFER_REASON)
                      }
                      onNotAvailable={() =>
                        handleLaneQuickSkip(
                          currentStep.laneKey,
                          "not_available",
                          LANE_NOT_AVAILABLE_REASON
                        )
                      }
                    />
                  ) : (
                    <DoneStepContent
                      confirmed={confirmed}
                      openGaps={openGaps}
                      sources={sources}
                      proposals={proposals}
                      onAddMoreMaterial={() => setStepIndex(0)}
                    />
                  )}
                </div>
              </section>

              <div className="deep-wizard__nav-actions">
                <OnboardingNavButton
                  direction="back"
                  label="Back"
                  onClick={handleBack}
                  disabled={stepIndex === 0}
                />
                {stepIndex !== WIZARD_STEPS.length - 1 ? (
                  <OnboardingNavButton
                    direction="next"
                    label="Continue"
                    onClick={handleContinue}
                    disabled={stepIndex === 0 && !materialContinueEnabled}
                  />
                ) : null}
              </div>
            </div>
          </div>

          <div className="deep-wizard__rail">
            <DeepWizardRail
              steps={WIZARD_STEPS}
              activeIndex={stepIndex}
              doneFlags={doneFlags}
              onSelect={setStepIndex}
            />
          </div>
        </>
      )}
    </div>
  );
}

// The step rail — a glanceable, always-clickable pill row (progress is
// derived from server state, not a locked linear sequence, so a returning
// user can jump straight back to any step, same as the rest of the wizard
// always allowed). Reuses onboarding's own progress-footer pill grammar
// verbatim (.onboarding-progress/__case/__case-icon/__case-label —
// see OnboardingShell.jsx's OnboardingProgressTrail) so it looks identical,
// but renders in normal document flow under the step card instead of
// onboarding's viewport-fixed footer — this page scrolls inside the app
// shell, not full-bleed.
function DeepWizardRail({ steps, activeIndex, doneFlags, onSelect }) {
  return (
    <div className="onboarding-progress">
      {steps.map((step, i) => {
        const active = i === activeIndex;
        const filled = !!doneFlags[i] || active;
        const className =
          "onboarding-progress__case onboarding-progress__case--clickable" +
          (filled ? " onboarding-progress__case--filled" : "") +
          (active ? " onboarding-progress__case--active" : "");
        return (
          <button
            key={step.id}
            type="button"
            className={className}
            aria-label={`Go to ${step.pill}`}
            title={`Go to ${step.pill}`}
            onClick={() => onSelect(i)}
          >
            <span className="onboarding-progress__case-icon" aria-hidden="true">
              {step.emoji}
            </span>
            <span className="onboarding-progress__case-label">{step.pill}</span>
          </button>
        );
      })}
    </div>
  );
}

function MaterialStepContent({
  draft,
  setDraft,
  submitting,
  onAddSource,
  fileInputRef,
  onFileChange,
  sources,
  proposals,
  busySourceId,
  onRetry,
  onRemove,
  draftingAll,
  onDraftProposals,
}) {
  const readyCount = sources.filter((source) => sourceIsReadyToDraft(source, proposals)).length;

  return (
    <>
      <div className="deep-wizard__segmented" aria-label="Source input kind" role="tablist">
        {INPUT_KIND_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            role="tab"
            aria-selected={draft.kind === option.value}
            className={`deep-wizard__segment${
              draft.kind === option.value ? " deep-wizard__segment--active" : ""
            }`}
            onClick={() => setDraft((prev) => ({ ...prev, kind: option.value }))}
          >
            {option.label}
          </button>
        ))}
      </div>

      {draft.kind === "paste" ? (
        <TextArea
          id="deep-wizard-paste"
          rows={5}
          value={draft.text}
          onChange={(value) => setDraft((prev) => ({ ...prev, text: value }))}
          placeholder="Paste profile material to ingest…"
          aria-label="Source text"
        />
      ) : (
        <TextField
          id="deep-wizard-link"
          type="url"
          value={draft.url}
          onChange={(value) => setDraft((prev) => ({ ...prev, url: value }))}
          placeholder="https://…"
          aria-label="Source link"
        />
      )}

      <button
        type="button"
        className="dropzone deep-wizard__dropzone"
        onClick={() => fileInputRef.current?.click()}
      >
        <span className="dropzone__icon" aria-hidden="true">
          <UploadIcon />
        </span>
        <span>Drop a file to upload</span>
        <small>Click to select</small>
      </button>
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={onFileChange} />

      <div className="deep-wizard__form-actions">
        <Button
          variant="secondary"
          disabled={submitting || !draftIsValid(draft)}
          onClick={onAddSource}
        >
          {submitting ? "Adding…" : "Add source"}
        </Button>
      </div>

      {sources.length ? (
        <div className="deep-wizard__source-list">
          {sources.map((source) => (
            <MaterialSourceRow
              key={source.id}
              source={source}
              hasDrafts={sourceHasDrafts(source.id, proposals)}
              busy={busySourceId === source.id}
              onRetry={() => onRetry(source)}
              onRemove={() => onRemove(source)}
            />
          ))}
        </div>
      ) : (
        <p className="deep-wizard__empty">
          Nothing to add right now? You can come back from Library any time.
        </p>
      )}

      {sources.length ? (
        <div className="deep-wizard__form-actions">
          <Button disabled={draftingAll || readyCount === 0} onClick={onDraftProposals}>
            {draftingAll ? "Drafting… usually under a minute." : "Draft proposals"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function MaterialSourceRow({ source, hasDrafts, busy, onRetry, onRemove }) {
  const meta = sourceStatusMeta(source, hasDrafts);
  const canRetry = source.status === "manual_fallback" || source.status === "failed";
  const canRemove = !hasDrafts;
  return (
    <div className="deep-wizard__source-row">
      <div className="deep-wizard__source-main">
        <span className="deep-wizard__source-title">{sourceDisplayLabel(source)}</span>
        <span className={`badge ${meta.tone}`}>{meta.label}</span>
        <details className="deep-wizard__source-details">
          <summary>Details</summary>
          <span>
            {source.sourceKind || source.kind || "source"}
            {source.textLength ? ` · ${source.textLength} characters` : ""}
          </span>
        </details>
      </div>
      <div className="deep-wizard__source-actions">
        {canRetry ? (
          <button
            type="button"
            className="deep-wizard__quiet-link"
            disabled={busy}
            onClick={onRetry}
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            className="deep-wizard__quiet-link"
            disabled={busy}
            onClick={onRemove}
          >
            {busy ? "Removing…" : "Remove source"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LaneStepContent({
  laneKey,
  laneLabel,
  pendingProposals,
  expandedIds,
  editsByProposal,
  busyProposalId,
  busyLane,
  onToggleExpand,
  onEditField,
  onSave,
  onConfirm,
  onDiscard,
  onDefer,
  onNotAvailable,
}) {
  return (
    <>
      {pendingProposals.length ? (
        <div className="deep-wizard__proposal-list">
          {pendingProposals.map((row) => (
            <ProposalCard
              key={row.id}
              row={row}
              expanded={expandedIds.has(row.id)}
              edits={editsByProposal[row.id] || {}}
              busy={busyProposalId === row.id}
              onToggle={() => onToggleExpand(row.id)}
              onEditField={(field, value) => onEditField(row.id, field, value)}
              onSave={() => onSave(row)}
              onConfirm={() => onConfirm(row)}
              onDiscard={() => onDiscard(row)}
            />
          ))}
        </div>
      ) : (
        <p className="deep-wizard__empty">
          No {LANE_DRAFT_NOUN[laneKey] || laneLabel.toLowerCase()} drafts from your material yet.
          Add more in Material, or move on.
        </p>
      )}
      <div className="deep-wizard__quiet-links">
        <button
          type="button"
          className="deep-wizard__quiet-link"
          disabled={busyLane}
          onClick={onDefer}
        >
          Defer this for later
        </button>
        <button
          type="button"
          className="deep-wizard__quiet-link"
          disabled={busyLane}
          onClick={onNotAvailable}
        >
          Nothing to add here
        </button>
      </div>
    </>
  );
}

function ProposalCard({
  row,
  expanded,
  edits,
  busy,
  onToggle,
  onEditField,
  onSave,
  onConfirm,
  onDiscard,
}) {
  const summary = edits.summary ?? proposalDisplaySummary(row);
  const title = edits.title ?? proposalDisplayTitle(row, summary);
  const quote = edits.supportingQuote ?? proposalQuote(row);
  const payload = proposalPayload(row);
  const honestyFields =
    row.lane === "honesty_boundaries"
      ? [
          { field: "boundaryType", label: "Boundary type", rows: 1 },
          { field: "text", label: "Canonical boundary", rows: 3 },
          { field: "allowedWording", label: "Allowed wording", rows: 2 },
          { field: "forbiddenWording", label: "Forbidden wording", rows: 2 },
          { field: "reason", label: "Enforcement reason", rows: 2 },
        ]
      : [];

  return (
    <article className="deep-wizard__proposal-card">
      <button
        type="button"
        className="deep-wizard__proposal-main"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="deep-wizard__proposal-title">{title || "Untitled draft"}</span>
        {summary ? <p className="deep-wizard__proposal-summary">{summary}</p> : null}
        {quote ? <blockquote className="deep-wizard__proposal-quote">“{quote}”</blockquote> : null}
      </button>
      {expanded ? (
        <div className="deep-wizard__proposal-edit">
          <TextField
            id={`deep-wizard-proposal-title-${row.id}`}
            value={title}
            onChange={(value) => onEditField("title", value)}
            aria-label="Title"
            placeholder="Title"
          />
          <TextArea
            id={`deep-wizard-proposal-summary-${row.id}`}
            rows={3}
            value={summary}
            onChange={(value) => onEditField("summary", value)}
            aria-label="Summary"
            placeholder="Summary"
          />
          <TextArea
            id={`deep-wizard-proposal-quote-${row.id}`}
            rows={2}
            value={quote}
            onChange={(value) => onEditField("supportingQuote", value)}
            aria-label="Supporting quote"
            placeholder="Supporting quote"
          />
          {honestyFields.map(({ field, label, rows }) => {
            const value = edits[field] ?? payload[field] ?? "";
            return rows === 1 ? (
              <TextField
                key={field}
                id={`deep-wizard-proposal-${field}-${row.id}`}
                value={value}
                onChange={(next) => onEditField(field, next)}
                aria-label={label}
                placeholder={label}
              />
            ) : (
              <TextArea
                key={field}
                id={`deep-wizard-proposal-${field}-${row.id}`}
                rows={rows}
                value={value}
                onChange={(next) => onEditField(field, next)}
                aria-label={label}
                placeholder={label}
              />
            );
          })}
          <div className="deep-wizard__form-actions">
            <Button variant="secondary" disabled={busy} onClick={onSave}>
              {busy ? "Saving…" : "Save edits"}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="deep-wizard__proposal-actions">
        <Button disabled={busy} onClick={onConfirm}>
          {busy ? "Confirming…" : "Confirm"}
        </Button>
        <button
          type="button"
          className="deep-wizard__quiet-link"
          disabled={busy}
          onClick={onDiscard}
        >
          Discard
        </button>
      </div>
    </article>
  );
}

function DoneStepContent({ confirmed, openGaps, sources, proposals, onAddMoreMaterial }) {
  // Only genuine AI-punted gaps belong under "Still thin". manual_fallback
  // rows in the open_gaps lane carry provider-error reasons, not content.
  const thinGaps = openGaps.filter(
    (row) => !isUnreviewableProposal(row) && row?.proposal?.status === "gap"
  );
  const pendingSourceCount = asArray(sources).filter((source) =>
    sourceNeedsReview(source, asArray(proposals))
  ).length;

  return (
    <>
      <ul className="deep-wizard__done-list">
        {LANE_STEPS.map((lane) => {
          const count = asArray(confirmed?.[LANE_CONFIRMED_COUNT_KEY[lane.key]]).length;
          return (
            <li key={lane.key}>
              <strong>{lane.heading}</strong> — {count} confirmed.
            </li>
          );
        })}
      </ul>
      {pendingSourceCount ? (
        <div className="deep-wizard__gaps deep-wizard__pending-sources">
          <p className="deep-wizard__gaps-label">
            {pendingSourceCount} {pendingSourceCount === 1 ? "source" : "sources"} still needs
            review.
          </p>
          <p>
            Draft or remove {pendingSourceCount === 1 ? "it" : "them"} in Material before this
            intake is complete.
          </p>
          <Button variant="secondary" onClick={onAddMoreMaterial}>
            Review material
          </Button>
        </div>
      ) : null}
      {thinGaps.length ? (
        <div className="deep-wizard__gaps">
          <p className="deep-wizard__gaps-label">Still thin:</p>
          <ul>
            {thinGaps.map((gap) => (
              <li key={gap.id}>{gapDisplayText(gap)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="deep-wizard__done-actions">
        <Link className="btn btn--primary" to="/">
          Back to Dashboard
        </Link>
        <Button variant="secondary" onClick={onAddMoreMaterial}>
          Add more material
        </Button>
      </div>
    </>
  );
}
