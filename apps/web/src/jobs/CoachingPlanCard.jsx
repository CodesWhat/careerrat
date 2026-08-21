// apps/web/src/jobs/CoachingPlanCard.jsx — the Jobs drawer's Coaching panel
// (Phase 1 coaching loop), sibling of PacketGateCard.jsx: same Card/chip-row
// idioms, no new visual language. Renders the plan a "Coach me on this fit"
// click (the button lives on PacketGateCard, beside Re-evaluate) produced —
// one row per gap, the gap text verbatim, and either a grounded
// evidence-claim draft or an honest "no honest way to close this one yet."
// Presentation-only, same contract as PacketGateCard: no fetch, no local
// error surface (JobDrawer's shared InlineAlert owns that). Self-hides when
// there is no plan yet, the same "own gate" convention InterviewDossierCard
// uses.

import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";

const STATUS_LABELS = { closed: "Added to evidence", dismissed: "Skipped" };

export function CoachingPlanCard({ plan, busyGapId, onAddToEvidence, onSkip }) {
  if (!plan?.gaps?.length) return null;

  return (
    <Card title="Coaching">
      {plan.gaps.map((gap) => {
        const canAddEvidence =
          gap.suggestion?.kind === "evidence-claim" && gap.suggestion.draftClaim;
        const gapBusy = busyGapId === gap.id;
        return (
          <div className="job-drawer__coaching-gap" key={gap.id}>
            <p>
              <strong>{gap.gapText}</strong>
            </p>
            {canAddEvidence ? (
              <>
                <p>{gap.suggestion.draftClaim.claim}</p>
                <p className="field__hint">{gap.suggestion.draftClaim.evidence}</p>
              </>
            ) : (
              <p className="field__hint">No honest way to close this one yet.</p>
            )}
            {gap.suggestion?.rationale ? (
              <p className="field__hint">{gap.suggestion.rationale}</p>
            ) : null}
            {gap.status === "open" ? (
              <div className="chip-row">
                {canAddEvidence ? (
                  <Button disabled={gapBusy} onClick={() => onAddToEvidence(gap)}>
                    {gapBusy ? "Saving…" : "Add to evidence"}
                  </Button>
                ) : null}
                <Button variant="secondary" disabled={gapBusy} onClick={() => onSkip(gap)}>
                  Skip
                </Button>
              </div>
            ) : (
              <span className="badge badge--muted">{STATUS_LABELS[gap.status] || gap.status}</span>
            )}
          </div>
        );
      })}
    </Card>
  );
}
