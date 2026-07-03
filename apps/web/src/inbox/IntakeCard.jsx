import { useState } from "react";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import { confirmIntake, dismissIntake, reclassifyIntake } from "../lib/api.js";
import { ChatPanel } from "../onboarding/ChatPanel.jsx";
import { formatDispatchSummary, kindLabel, statusLabel } from "./dispatch-summary.js";

const RAW_PREVIEW_MAX = 320;

const ENTITY_LABELS = {
  company: "Company",
  role: "Role",
  url: "URL",
  statusTo: "New status",
  statusNote: "Note",
  contactName: "Contact",
  contactEmail: "Email",
  interviewDate: "Date",
};

function entityEntries(entities) {
  return Object.entries(entities || {}).filter(([, value]) => value !== null && value !== "");
}

function truncate(text, max = RAW_PREVIEW_MAX) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function statusBadgeTone(status) {
  if (status === "error") return "badge--error";
  if (status === "needs_you") return "badge--warn";
  if (status === "done") return "badge--ok";
  return "badge--muted";
}

// Mirrors executeLaneA/executeLaneB's own result shapes (intake-route.mjs) —
// the confirm response's `result` is whatever that lane wrote, not a
// generic envelope, so this reads the two shapes that exist today rather
// than rendering a raw JSON dump.
function describeResult(item) {
  if (item.dispatch?.action === "app_set_status") {
    return `Status updated to "${item.result?.to ?? "?"}".`;
  }
  if (item.dispatch?.action === "run_skill") {
    return item.result?.ok === false
      ? "Skill run finished with an error — see below."
      : `${item.dispatch.params.skill} finished.`;
  }
  return "Completed.";
}

// IntakeCard — one preview card per intake_items row. Kind + extracted
// entities + tracker match (with company history) + the exact proposed
// action, per the M9 decisions memo's confirm-card contract — never a
// vague "something will happen," always the literal dispatch the confirm
// button is about to fire.
export function IntakeCard({ item, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const entities = entityEntries(item.classification?.entities);
  const dispatchSummary = formatDispatchSummary(item.dispatch);
  const match = item.trackerMatch;
  const otherHistory = match?.companyHistory || [];

  async function run(action, label) {
    setBusy(true);
    setActionError(null);
    try {
      const { item: updated } = await action(item.id);
      onChanged(updated);
    } catch (err) {
      setActionError(err?.body?.error || (err instanceof Error ? err.message : `${label} failed`));
    } finally {
      setBusy(false);
    }
  }

  const handleConfirm = () => run(confirmIntake, "Confirm");
  const handleDismiss = () => run(dismissIntake, "Dismiss");
  const handleReclassify = () => run(reclassifyIntake, "Reclassify");

  const canConfirm = item.status === "proposed";
  const canDismiss = ["proposed", "needs_you", "error"].includes(item.status);
  const canReclassify = ["needs_you", "error"].includes(item.status);

  return (
    <Card
      title={kindLabel(item.kind)}
      actions={
        <span className={`badge ${statusBadgeTone(item.status)}`}>{statusLabel(item.status)}</span>
      }
    >
      <p className="intake-card__raw">{truncate(item.rawInput)}</p>

      {entities.length ? (
        <div className="chip-row">
          {entities.map(([key, value]) => (
            <span className="chip" key={key}>
              <span className="field__label">{ENTITY_LABELS[key] || key}:</span>&nbsp;
              {String(value)}
            </span>
          ))}
        </div>
      ) : null}

      {match?.matched ? (
        <div className="intake-card__match">
          <p>{match.summary}</p>
          {otherHistory.length ? (
            <p className="field__hint">
              Also at this company:{" "}
              {otherHistory
                .map(
                  (h) =>
                    `${h.role || "an unnamed role"} (${h.status || "unknown"}${h.appliedAt ? `, ${h.appliedAt}` : ""})`
                )
                .join("; ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {item.status === "needs_you" ? (
        <InlineAlert
          tone="error"
          message={`Needs you: ${item.classification?.needsUserReason || "review manually."}`}
        />
      ) : item.classification?.proposedAction ? (
        <p className="field__hint">{item.classification.proposedAction}</p>
      ) : null}

      {dispatchSummary && (item.status === "proposed" || item.status === "confirmed") ? (
        <p className="intake-card__dispatch">Will: {dispatchSummary}</p>
      ) : null}

      {item.status === "running" && item.dispatch?.lane === "C" ? (
        <div className="intake-card__chat">
          <ChatPanel
            skill={item.dispatch.params.skill}
            kickoffLabel={`Continue in ${item.dispatch.params.skill}`}
            initialChatId={item.result?.chatId}
          />
        </div>
      ) : null}

      {item.status === "running" && item.dispatch?.lane === "B" ? (
        <p className="field__hint">
          Running {item.dispatch.params.skill}… this can take a minute — the card updates on its own
          once it finishes.
        </p>
      ) : null}

      {item.status === "done" ? <p className="field__hint">{describeResult(item)}</p> : null}

      {item.status === "error" ? (
        <InlineAlert message={item.error || "The confirmed action failed."} />
      ) : null}

      {actionError ? <InlineAlert message={actionError} /> : null}

      {canConfirm || canDismiss || canReclassify ? (
        <div className="intake-card__actions">
          {canConfirm ? (
            <Button onClick={handleConfirm} disabled={busy}>
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          ) : null}
          {canReclassify ? (
            <Button variant="secondary" onClick={handleReclassify} disabled={busy}>
              {busy ? "Working…" : "Reclassify"}
            </Button>
          ) : null}
          {canDismiss ? (
            <Button variant="secondary" onClick={handleDismiss} disabled={busy}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
