function list(value) {
  return Array.isArray(value) ? value : [];
}

function pendingProposal(proposal) {
  return Boolean(proposal?.proposalId) && !proposal?.decision;
}

export function companyProposalReviewForArtifact(artifact) {
  if (artifact?.kind !== "company_proposals" || !artifact?.batchId) return null;
  return {
    ...artifact,
    proposals: list(artifact.proposals).filter(pendingProposal),
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

function ProposalCard({ artifact, proposal, busy, onIntent }) {
  const company = proposal?.company || {};
  const canTrack = Boolean(companyProposalDecisionIntent(artifact, proposal, "track"));

  function decide(action) {
    const intent = companyProposalDecisionIntent(artifact, proposal, action);
    if (intent) onIntent?.(intent);
  }

  return (
    <article className="company-proposal-review__card">
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
      <div className="company-proposal-review__actions">
        {canTrack ? (
          <button
            className="chat-first-pill chat-first-pill--lime"
            type="button"
            disabled={busy}
            onClick={() => decide("track")}
          >
            Track
          </button>
        ) : null}
        <button
          className="chat-first-pill chat-first-pill--outline"
          type="button"
          disabled={busy}
          onClick={() => decide("skip")}
        >
          Skip
        </button>
      </div>
    </article>
  );
}

export function CompanyProposalReview({ artifact, busy = false, onIntent, onClose }) {
  const review = companyProposalReviewForArtifact(artifact);
  if (!review) return null;

  return (
    <div className="packet-viewer-overlay">
      <section
        className="packet-viewer company-proposal-review"
        role="dialog"
        aria-modal="true"
        aria-label={review.title || "Company proposal review"}
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
          {review.proposals.length ? (
            review.proposals.map((proposal) => (
              <ProposalCard
                artifact={review}
                proposal={proposal}
                busy={busy}
                onIntent={onIntent}
                key={proposal.proposalId}
              />
            ))
          ) : (
            <p className="company-proposal-review__empty">All company proposals are reviewed.</p>
          )}
        </div>
      </section>
    </div>
  );
}
