import { useState } from "react";
import { flattenPatchLeaves } from "./patchFields.js";

// ConfirmPill — Lane A / R1 & R4. Renders one parsed confirm block (see
// confirmBlocks.js) as a clickable pill inline in the interview transcript.
//
// - authorization / company_add / companies_suggest / candidate_patch /
//   evidence_claim: single-click inline pills. Labels are code-owned
//   (CONFIRM_LABELS below, plus candidatePatchPillLabel/flattenPatchLeaves
//   for candidate_patch's field list); the model's own `summary` MAY render
//   alongside that label, but never replaces it.
// - consent_mode / consent_capability: the pill click opens a SECOND
//   confirmation dialog (reusing the app's existing centered-overlay
//   convention — see .confirm-dialog-overlay/.confirm-dialog in app.css,
//   modeled on .packet-viewer-overlay/.packet-viewer). Every word in that
//   dialog is code-owned copy; the model's `summary` is never shown for
//   these two kinds, so the AI can never phrase its own consent language.
//   consent_capability is offered only for a concrete task. Confirming it
//   also enables the internal automation mode, so there is no separate
//   Basic/Advanced decision in onboarding.
//
// ConfirmDialog itself is exported so InterviewSurface.jsx can reuse the
// exact same overlay for its own "change engine mid-setup" confirmation —
// one dialog convention, not two.
//
// Every proposal needs a resolution path. Sensitive-answer prompts use
// "I'd rather not say" and persist that decline; optional consent uses
// "Not now"; ordinary candidate/company/evidence proposals use "Dismiss"
// and make no canonical write. Leaving a rejected proposal permanently
// pending would strand the completion gate and make typo correction
// impossible.
const PRIVATE_DECLINE_KINDS = new Set(["authorization", "consent_mode"]);

function declineLabel(kind) {
  if (PRIVATE_DECLINE_KINDS.has(kind)) return "I'd rather not say";
  if (kind === "consent_capability") return "Not now";
  return "Dismiss";
}

// candidate_patch labels list the patch's own leaf fields inline (see
// candidatePatchPillLabel below) — capped so a patch with many fields can't
// blow the pill out to three lines. The rest collapse into a trailing
// "+N more" rather than being dropped silently.
const MAX_VISIBLE_PATCH_FIELDS = 3;

// The label and summary share one fixed-width pill (app.css caps
// .confirm-pill's max-width). The label is code-owned and load-bearing, so
// it always wins the room; once it's claimed most of the pill's rough
// character budget, flex-shrink alone would crush the summary down to an
// unreadable stub ("A.") rather than a real word. Better to not render it
// at all than to render a rendering-bug-looking fragment, so it's dropped
// in JS whenever the label hasn't left it a legible amount of room. app.css
// also floors the summary's CSS min-width to the same figure as a second
// line of defense for whatever room estimate turns out to be optimistic.
const PILL_LABEL_SUMMARY_CHAR_BUDGET = 100;
const MIN_LEGIBLE_SUMMARY_CHARS = 20;

function summaryHasRoom(label) {
  return PILL_LABEL_SUMMARY_CHAR_BUDGET - (label || "").length >= MIN_LEGIBLE_SUMMARY_CHARS;
}

const CONFIRM_LABELS = {
  authorization: "Work authorization",
  company_add: "Use as focus example",
  companies_suggest: "Suggest companies",
  evidence_claim: "Save evidence",
};

// candidate_patch's payload.doc is the closed CANDIDATE_PATCH_DOCS enum from
// confirmBlocks.js — this is the code-owned label per doc, never the
// model's own wording for which file it's writing to.
const CANDIDATE_PATCH_DOC_LABELS = {
  profile: "personal details",
  targeting: "job preferences",
  honesty: "boundaries",
  "form-defaults": "application answers",
};

function candidatePatchPillLabel(block) {
  const doc = CANDIDATE_PATCH_DOC_LABELS[block.payload?.doc] || "details";
  return `Save ${doc}`;
}

const CONSENT_MODE_COPY = {
  basic: {
    title: "Keep automation basic?",
    body: "Every external capability stays off: read-only and manual. You can switch to advanced permissions later from Settings.",
  },
  advanced: {
    title: "Turn on advanced permissions?",
    body: "This unlocks individual capability and platform opt-ins below. Nothing turns on by itself. You still approve each platform separately.",
  },
};

function platformLabel(platform) {
  return String(platform || "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function findCapability(automationStatus, capabilityKey) {
  return (automationStatus?.capabilities || []).find((c) => c.capability === capabilityKey) || null;
}

function authorizationPillLabel(block) {
  const { work_authorized: authorized, requires_sponsorship: sponsorship } = block.patch || {};
  if (authorized === true) return `Authorized to work${sponsorship ? " · needs sponsorship" : ""}`;
  return `Not authorized${sponsorship ? " · needs sponsorship" : ""}`;
}

export function ConfirmPill({ block, automationStatus, onConfirm, onDecline }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  if (block.status === "resolved") {
    return (
      <span className="confirm-pill confirm-pill--resolved">{block.resultSummary || "Saved"}</span>
    );
  }

  if (block.kind === "consent_mode") {
    const copy = CONSENT_MODE_COPY[block.payload] || CONSENT_MODE_COPY.basic;
    return (
      <span className="confirm-pill-group">
        <ConfirmPillButton
          label={block.payload === "advanced" ? "Turn on advanced mode" : "Keep basic mode"}
          status={block.status}
          error={block.error}
          onClick={() => setDialogOpen(true)}
        />
        <DeclinePillButton status={block.status} onClick={onDecline} />
        {dialogOpen ? (
          <ConfirmDialog
            title={copy.title}
            body={copy.body}
            busy={block.status === "saving"}
            onCancel={() => setDialogOpen(false)}
            onConfirm={async () => {
              setDialogOpen(false);
              await onConfirm();
            }}
          />
        ) : null}
      </span>
    );
  }

  if (block.kind === "consent_capability") {
    const { capability: capabilityKey, platform } = block.payload || {};
    const capability = findCapability(automationStatus, capabilityKey);
    const label = capability?.label || capabilityKey;
    const platformName = platformLabel(platform);
    return (
      <span className="confirm-pill-group">
        <ConfirmPillButton
          label={`Allow ${label} on ${platformName}`}
          status={block.status}
          error={block.error}
          onClick={() => setDialogOpen(true)}
        />
        <DeclinePillButton
          label={declineLabel(block.kind)}
          status={block.status}
          onClick={onDecline}
        />
        {dialogOpen ? (
          <ConfirmDialog
            title={`Allow ${label} on ${platformName}?`}
            body={`${capability?.summary || "This capability"} This turns the capability and platform on together and records your consent to ${platformName}'s automation terms.`}
            busy={block.status === "saving"}
            onCancel={() => setDialogOpen(false)}
            onConfirm={async () => {
              setDialogOpen(false);
              await onConfirm();
            }}
          />
        ) : null}
      </span>
    );
  }

  // Single-click kinds — authorization, company_add, companies_suggest,
  // candidate_patch, evidence_claim.
  const codeLabel =
    block.kind === "authorization"
      ? authorizationPillLabel(block)
      : block.kind === "candidate_patch"
        ? candidatePatchPillLabel(block)
        : CONFIRM_LABELS[block.kind];
  // candidate_patch shows WHAT it's about to save (leaf field paths/values)
  // right in the label, so the click is informed without opening a second
  // dialog — the model's own summary still renders alongside it, same as
  // every other single-click kind, but the field list itself is code-owned.
  const patchFields =
    block.kind === "candidate_patch" ? flattenPatchLeaves(block.payload?.patch) : [];
  const visiblePatchFields = patchFields.slice(0, MAX_VISIBLE_PATCH_FIELDS);
  const hiddenPatchFieldCount = patchFields.length - visiblePatchFields.length;
  const displayLabel =
    block.kind === "company_add" && block.payload?.name
      ? `${codeLabel} · ${block.payload.name}`
      : block.kind === "candidate_patch" && patchFields.length
        ? [
            codeLabel,
            ...visiblePatchFields.map((leaf) => `${leaf.label}: ${leaf.value}`),
            ...(hiddenPatchFieldCount > 0 ? [`+${hiddenPatchFieldCount} more`] : []),
          ].join(" · ")
        : codeLabel;
  const visibleSummary = summaryHasRoom(displayLabel) ? block.summary : null;
  const pillButton = (
    <ConfirmPillButton
      label={displayLabel}
      summary={visibleSummary}
      status={block.status}
      error={block.error}
      onClick={onConfirm}
    />
  );
  return (
    <span className="confirm-pill-group">
      {pillButton}
      <DeclinePillButton
        label={declineLabel(block.kind)}
        status={block.status}
        onClick={onDecline}
      />
    </span>
  );
}

function DeclinePillButton({ label = "I'd rather not say", status, onClick }) {
  return (
    <button
      type="button"
      className="confirm-pill__decline"
      onClick={onClick}
      disabled={status === "saving"}
    >
      {label}
    </button>
  );
}

function ConfirmPillButton({ label, summary, status, error, disabled, disabledHint, onClick }) {
  const saving = status === "saving";
  const errored = status === "error";
  return (
    <span className="confirm-pill-wrap">
      <button
        type="button"
        className={`confirm-pill${errored ? " confirm-pill--error" : ""}${disabled ? " confirm-pill--disabled" : ""}`}
        onClick={onClick}
        disabled={disabled || saving}
      >
        <span className="confirm-pill__label">{label}</span>
        {summary ? <span className="confirm-pill__summary">{summary}</span> : null}
        <span className="confirm-pill__action">
          {saving ? "Saving…" : disabled ? disabledHint : errored ? "Retry" : "Confirm"}
        </span>
      </button>
      {errored && error ? <span className="confirm-pill__error-text">{error}</span> : null}
    </span>
  );
}

export function ConfirmDialog({ title, body, busy, onCancel, onConfirm }) {
  return (
    <div className="confirm-dialog-overlay">
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {title}
        </h2>
        <p className="confirm-dialog__body">{body}</p>
        <div className="confirm-dialog__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
