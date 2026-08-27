import { useRef } from "react";

import {
  handleSourceReviewKeyDown,
  resolveReviewMutationSelection,
  useReviewDialog,
} from "./source-review.jsx";

const REVIEW_BATCH_SIZE = 4;
export const handleCompanyProposalReviewKeyDown = handleSourceReviewKeyDown;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function pendingProposal(proposal) {
  return Boolean(proposal?.proposalId) && !proposal?.decision;
}

export function companyProposalReviewForArtifact(artifact) {
  if (artifact?.kind !== "company_proposals" || !artifact?.batchId) return null;
  const proposals = list(artifact.proposals);
  return {
    ...artifact,
    proposals: proposals.filter(pendingProposal),
    resolvedProposals: proposals.filter((proposal) => proposal?.proposalId && proposal?.decision),
  };
}

export function companyProposalReviewFromResult(result) {
  const messages = list(result?.data?.messages).length
    ? list(result.data.messages)
    : list(result?.messages);
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const artifacts = list(messages[messageIndex]?.artifacts);
    for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
      const review = companyProposalReviewForArtifact(artifacts[artifactIndex]);
      if (review) return review;
    }
  }
  return null;
}

export function companyProposalDecisionIntent(artifact, proposal, decision) {
  const review = companyProposalReviewForArtifact(artifact);
  const proposalId = String(proposal?.proposalId || "").trim();
  const expectedVersion = Number(proposal?.version);
  if (
    !review ||
    !proposalId ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    proposal?.decision
  ) {
    return null;
  }

  const action =
    decision === "skip"
      ? "reject"
      : decision === "track" &&
          proposal?.classification === "supported_ats" &&
          proposal?.atsProvider &&
          proposal?.jobBoardUrl
        ? "approve-supported-ats"
        : null;
  if (!action) return null;

  return {
    type: "company.proposal-decide",
    entity: { type: "company-proposal", id: proposalId },
    input: {
      batchId: review.batchId,
      action,
      expectedVersion,
    },
  };
}

export function companyProposalBatchIntents(
  artifact,
  selectedOptionIds,
  batchSize = REVIEW_BATCH_SIZE
) {
  const review = companyProposalReviewForArtifact(artifact);
  if (!review) return null;
  const batch = review.proposals.slice(0, batchSize);
  if (!batch.length) return [];
  const selected = new Set(Array.isArray(selectedOptionIds) ? selectedOptionIds.map(String) : []);
  const batchIds = new Set(batch.map((proposal) => String(proposal.proposalId)));
  if ([...selected].some((id) => !batchIds.has(id))) return null;
  const intents = batch.map((proposal) =>
    companyProposalDecisionIntent(
      review,
      proposal,
      selected.has(String(proposal.proposalId)) ? "track" : "skip"
    )
  );
  return intents.some((intent) => !intent) ? null : intents;
}

export function companyProposalTextSelection(artifact, text, batchSize = REVIEW_BATCH_SIZE) {
  const review = companyProposalReviewForArtifact(artifact);
  if (!review) return null;
  return resolveReviewMutationSelection(
    text,
    review.proposals.slice(0, batchSize).map((proposal) => ({
      id: String(proposal.proposalId),
      aliases: [proposal.company?.name, proposal.company?.domain],
    })),
    {
      positiveVerbs: ["track", "add", "save", "select", "include", "keep", "approve"],
      negativeVerbs: ["skip", "reject", "discard", "exclude", "remove"],
    }
  );
}

export async function submitCompanyProposalBatch({ artifact, selectedOptionIds, onIntent } = {}) {
  const intents = companyProposalBatchIntents(artifact, selectedOptionIds);
  if (!intents?.length || typeof onIntent !== "function") return false;
  for (const intent of intents) {
    const completed = await onIntent(intent);
    if (completed === false) return false;
  }
  return true;
}

function ProposalCard({ artifact, proposal, busy }) {
  const company = proposal?.company || {};
  const canTrack = Boolean(companyProposalDecisionIntent(artifact, proposal, "track"));

  return (
    <label className="company-proposal-review__card">
      <input
        className="company-proposal-review__checkbox"
        type="checkbox"
        name="company-option"
        value={proposal.proposalId}
        disabled={busy || !canTrack}
      />
      <div className="company-proposal-review__heading">
        <strong>{company.name || "Company"}</strong>
        {company.domain ? <span>{company.domain}</span> : null}
      </div>
      {proposal.roleSeen ? (
        <p className="company-proposal-review__role">Role seen: {proposal.roleSeen}</p>
      ) : null}
      {proposal.why ? <p>{proposal.why}</p> : null}
      <dl className="company-proposal-review__evidence">
        <div className="company-proposal-review__evidence-item">
          <dt>ATS</dt>
          <dd>{proposal.atsProvider || "Needs review"}</dd>
        </div>
        <div className="company-proposal-review__evidence-item">
          <dt>Evidence</dt>
          <dd>{proposal.jobBoardUrl || "No public board URL captured"}</dd>
        </div>
      </dl>
      {!canTrack ? (
        <span className="review-batch__unavailable">
          CareerRat can't track this board automatically.
        </span>
      ) : null}
    </label>
  );
}

export function CompanyProposalReview({ artifact, busy = false, onIntent, onClose }) {
  const review = companyProposalReviewForArtifact(artifact);
  if (!review) return null;

  return (
    <CompanyProposalReviewDialog
      artifact={artifact}
      busy={busy}
      onIntent={onIntent}
      onClose={onClose}
      reviewId={review.batchId}
    />
  );
}

function CompanyProposalReviewDialog({ artifact, busy, onIntent, onClose, reviewId }) {
  const dialogRef = useRef(null);
  useReviewDialog({ dialogRef, reviewId, onClose });
  return (
    <CompanyProposalReviewContent
      artifact={artifact}
      busy={busy}
      onIntent={onIntent}
      onClose={onClose}
      dialogRef={dialogRef}
    />
  );
}

export function CompanyProposalReviewContent({
  artifact,
  busy = false,
  onIntent,
  onClose,
  dialogRef,
}) {
  const review = companyProposalReviewForArtifact(artifact);
  if (!review) return null;
  const batch = review.proposals.slice(0, REVIEW_BATCH_SIZE);
  const resolvedCount = review.resolvedProposals.length;

  async function submitBatch(event) {
    event.preventDefault();
    const selectedOptionIds = new FormData(event.currentTarget).getAll("company-option");
    await submitCompanyProposalBatch({ artifact, selectedOptionIds, onIntent });
  }

  return (
    <div className="packet-viewer-overlay">
      <section
        ref={dialogRef}
        className="packet-viewer company-proposal-review"
        role="dialog"
        aria-modal="true"
        aria-label={review.title || "Company proposal review"}
        tabIndex={-1}
      >
        <header className="packet-viewer__toolbar">
          <div className="company-proposal-review__toolbar-copy">
            <span className="chat-first-eyebrow">COMPANY DISCOVERY</span>
            <strong className="packet-viewer__title">
              {review.title || "Company proposals to review"}
            </strong>
          </div>
          <button
            className="chat-first-pill chat-first-pill--outline"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Back
          </button>
        </header>
        <div className="packet-viewer__stage company-proposal-review__stage">
          {resolvedCount ? (
            <p className="review-batch__resolved" aria-live="polite">
              {resolvedCount} reviewed · {review.proposals.length} remaining
            </p>
          ) : null}
          {batch.length ? (
            <form className="review-batch" onSubmit={submitBatch}>
              <fieldset disabled={busy}>
                <legend>Which companies should CareerRat track?</legend>
                <p className="review-batch__help">
                  Select the companies whose job boards belong in your search. Saving skips the
                  unselected ones in this batch.
                  {review.proposals.length > batch.length
                    ? ` Showing ${batch.length} of ${review.proposals.length}.`
                    : ""}
                </p>
                <div className="company-proposal-review__list">
                  {batch.map((proposal) => (
                    <ProposalCard
                      artifact={review}
                      proposal={proposal}
                      busy={busy}
                      key={proposal.proposalId}
                    />
                  ))}
                </div>
                <footer className="company-proposal-review__footer">
                  <span>
                    {review.proposals.length > batch.length
                      ? `${review.proposals.length - batch.length} more after this batch`
                      : "This is the last batch"}
                  </span>
                  <button
                    className="chat-first-pill chat-first-pill--lime"
                    type="submit"
                    disabled={busy}
                  >
                    Save choices
                  </button>
                </footer>
              </fieldset>
            </form>
          ) : (
            <p className="company-proposal-review__empty">All company proposals are reviewed.</p>
          )}
        </div>
      </section>
    </div>
  );
}
