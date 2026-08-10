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
//   consent_capability is only actionable once automationStatus.mode is
//   "advanced" — mayRun()'s own hard AND already requires advanced mode
//   server-side, so a pill that could fire before that is just a dead click.
//
// ConfirmDialog itself is exported so InterviewSurface.jsx can reuse the
// exact same overlay for its own "change engine mid-setup" confirmation —
// one dialog convention, not two.
//
// Decline UX (spec's "Decline UX (settled)" section): authorization and
// consent_mode are the two kinds a candidate can legitimately decline from
// the chat itself — the agent has no write tools, so without a decline
// affordance here a user who says "I'd rather not say" mid-interview has no
// way to get that decline actually recorded. DECLINABLE_KINDS below gates a
// second, visually secondary "I'd rather not say" action beside the primary
// pill (single click, no second dialog — the dialog requirement is for the
// consent GRANT, not the decline). consent_capability and the company kinds
// never get this: there's nothing to "decline" about suggesting or tracking
// a company, and consent_capability's decline is just "leave it off," which
// not clicking the pill already means.

const DECLINABLE_KINDS = new Set(["authorization", "consent_mode"]);

const CONFIRM_LABELS = {
  authorization: "Work authorization",
  company_add: "Track company",
  companies_suggest: "Suggest companies",
  evidence_claim: "Save evidence",
};

// candidate_patch's payload.doc is the closed CANDIDATE_PATCH_DOCS enum from
// confirmBlocks.js — this is the code-owned label per doc, never the
// model's own wording for which file it's writing to.
const CANDIDATE_PATCH_DOC_LABELS = {
  profile: "profile",
  targeting: "targeting",
  honesty: "honesty",
  "form-defaults": "form defaults",
};

function candidatePatchPillLabel(block) {
  const doc = CANDIDATE_PATCH_DOC_LABELS[block.payload?.doc] || "details";
  return `Update ${doc}`;
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
    const advanced = automationStatus?.mode === "advanced";
    const label = capability?.label || capabilityKey;
    const platformName = platformLabel(platform);
    return (
      <>
        <ConfirmPillButton
          label={`Allow ${label} on ${platformName}`}
          status={block.status}
          error={block.error}
          disabled={!advanced}
          disabledHint={advanced ? null : "Requires advanced mode"}
          onClick={() => setDialogOpen(true)}
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
      </>
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
  const displayLabel =
    block.kind === "company_add" && block.payload?.name
      ? `${codeLabel} · ${block.payload.name}`
      : block.kind === "candidate_patch" && patchFields.length
        ? [codeLabel, ...patchFields.map((leaf) => `${leaf.label}: ${leaf.value}`)].join(" · ")
        : codeLabel;
  const pillButton = (
    <ConfirmPillButton
      label={displayLabel}
      summary={block.summary}
      status={block.status}
      error={block.error}
      onClick={onConfirm}
    />
  );
  if (!DECLINABLE_KINDS.has(block.kind)) return pillButton;
  return (
    <span className="confirm-pill-group">
      {pillButton}
      <DeclinePillButton status={block.status} onClick={onDecline} />
    </span>
  );
}

function DeclinePillButton({ status, onClick }) {
  return (
    <button
      type="button"
      className="confirm-pill__decline"
      onClick={onClick}
      disabled={status === "saving"}
    >
      I'd rather not say
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
