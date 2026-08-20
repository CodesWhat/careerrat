// apps/web/src/jobs/PacketGateCard.jsx — the Jobs drawer's "Evaluate"
// section (Phase B): an explicit-click POST /api/packet/gate call, rendered
// with the same Card/chip-row idioms JobDrawer.jsx already uses for Comp &
// fit / roleFit. evaluatePacketGate is a bounded AI call (seconds, not
// minutes) — no SSE, just a plain busy state while the request is in flight.

import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";

const GATE_LABELS = { keep: "Keep", review: "Review", cut: "Cut" };
const GATE_TONES = { keep: "ok", review: "warn", cut: "error" };

function gateTone(gate) {
  return GATE_TONES[String(gate || "").toLowerCase()] || "muted";
}

function gateLabel(gate) {
  return GATE_LABELS[String(gate || "").toLowerCase()] || "Unknown";
}

// Small badge reused on Pipeline-tab rows (JobsPage.jsx) and here in the
// drawer — same .badge/.badge--* pill idiom every other status badge in this
// app already uses (HealthBadge, StatusControl's own note), never a colored
// left-edge accent.
export function GateBadge({ gate, className = "" }) {
  if (!gate) return null;
  return (
    <span className={`badge badge--${gateTone(gate)} ${className}`.trim()}>{gateLabel(gate)}</span>
  );
}

function formatEvaluatedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  return d.toLocaleString();
}

export function PacketGateCard({ verdict, busy, onEvaluate }) {
  return (
    <Card title="Evaluate">
      {verdict ? (
        <>
          <div className="chip-row">
            <GateBadge gate={verdict.gate} />
            {verdict.fitScore != null ? (
              <span className="chip">
                <span className="field__label">Fit:</span>&nbsp;{verdict.fitScore} ·{" "}
                {verdict.fitBucket}
              </span>
            ) : null}
            {verdict.compensation?.status ? (
              <span className="chip">
                <span className="field__label">Comp:</span>&nbsp;{verdict.compensation.status}
              </span>
            ) : null}
            {verdict.confidence ? (
              <span className="chip">
                <span className="field__label">Confidence:</span>&nbsp;{verdict.confidence}
              </span>
            ) : null}
          </div>
          {verdict.fitSummary ? <p>{verdict.fitSummary}</p> : null}
          {verdict.compensation?.summary ? (
            <p className="field__hint">{verdict.compensation.summary}</p>
          ) : null}
          {verdict.fitReasons?.length ? (
            <ul className="job-drawer__list">
              {verdict.fitReasons.map((reason, i) => (
                // reasons is a flat AI-returned string list with no stable id.
                // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {verdict.fitRisks?.length ? (
            <ul className="job-drawer__list">
              {verdict.fitRisks.map((risk, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: flat typed list has no stable id
                <li key={i}>{risk}</li>
              ))}
            </ul>
          ) : null}
          {verdict.manual?.required ? (
            <p className="field__hint">
              {verdict.manual.reason || verdict.manual.action || "Needs manual review."}
            </p>
          ) : null}
          {verdict.evaluatedAt ? (
            <p className="field__hint">Evaluated {formatEvaluatedAt(verdict.evaluatedAt)}</p>
          ) : null}
        </>
      ) : (
        <p className="field__hint">
          Not evaluated yet. Run the packet gate to check fit and comp before generating documents.
        </p>
      )}
      <Button disabled={busy} onClick={onEvaluate}>
        {busy ? "Evaluating…" : verdict ? "Re-evaluate" : "Evaluate"}
      </Button>
    </Card>
  );
}
