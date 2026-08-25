import { CircleCheck, CircleX, Globe2, Rss, Search } from "lucide-react";
import { useEffect, useRef } from "react";

import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import { handleArtifactViewerKeyDown } from "../jobs/ArtifactViewerModal.jsx";

export const handleSourceReviewKeyDown = handleArtifactViewerKeyDown;

function sourceIcon(type, size = 15) {
  const Icon = type === "rss" ? Rss : type === "browser" ? Globe2 : Search;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} />;
}

function normalizeDecision(value) {
  if (!value || !["save", "discard"].includes(value.action)) return null;
  if (!["completed", "failed"].includes(value.status)) return null;
  return {
    action: value.action,
    status: value.status,
    ...(typeof value.resultText === "string" ? { resultText: value.resultText } : {}),
  };
}

function sourceReviewForArtifact(artifact) {
  const review = normalizeSourceReviewArtifact(artifact);
  if (!review) return null;
  const originals = new Map(
    (Array.isArray(artifact?.candidates) ? artifact.candidates : []).map((candidate) => [
      candidate?.url,
      candidate,
    ])
  );
  return {
    ...review,
    candidates: review.candidates.map((candidate) => ({
      ...candidate,
      decision: normalizeDecision(originals.get(candidate.url)?.decision),
    })),
    completion: {
      ...review.completion,
      decision: normalizeDecision(artifact?.completion?.decision),
    },
  };
}

function proposedCandidates(review) {
  return review.candidates
    .filter((candidate) => candidate.status === "proposed")
    .sort(
      (left, right) => Number(right.confidence === "high") - Number(left.confidence === "high")
    );
}

export function SourceReviewSummaryCard({ artifact, onOpen }) {
  const review = sourceReviewForArtifact(artifact);
  if (!review) return null;
  const preview = proposedCandidates(review).slice(0, 4);
  return (
    <article className="chat-first-artifact-card source-review-summary">
      <span className="chat-first-artifact-card__icon" aria-hidden="true">
        <Search size={17} strokeWidth={1.9} />
      </span>
      <div className="chat-first-artifact-card__copy source-review-summary__copy">
        <strong>
          {review.proposalCount} source{review.proposalCount === 1 ? "" : "s"} found
        </strong>
        <span>
          {review.highConfidenceCount} strong match
          {review.highConfidenceCount === 1 ? "" : "es"}
          {review.borderlineCount ? ` · ${review.borderlineCount} need a closer look` : ""}
        </span>
        <ul className="source-review-summary__sources" aria-label="Strongest source matches">
          {preview.map((candidate) => (
            <li className="source-review-summary__source" key={candidate.id}>
              {sourceIcon(candidate.sourceType, 13)}
              {candidate.label}
            </li>
          ))}
        </ul>
      </div>
      <button
        className="chat-first-pill chat-first-pill--lime source-review-summary__action"
        type="button"
        onClick={() => onOpen?.(review)}
      >
        Review sources
      </button>
    </article>
  );
}

function decisionCopy(candidate) {
  if (candidate.decision?.status === "failed") return "Try again";
  if (candidate.decision?.action === "save") return "Added";
  if (candidate.decision?.action === "discard") return "Skipped";
  return null;
}

function SourceCandidateCard({ candidate, busy, onDecision }) {
  const decided = candidate.decision?.status === "completed";
  const decision = decisionCopy(candidate);
  return (
    <article className="source-review__card">
      <div className="source-review__heading">
        <span className="source-review__source-icon">{sourceIcon(candidate.sourceType)}</span>
        <div>
          <strong>{candidate.label}</strong>
          <span>{candidate.sourceType === "url-query" ? "Search page" : candidate.sourceType}</span>
        </div>
        <span
          className={`source-review__confidence source-review__confidence--${candidate.confidence}`}
        >
          {candidate.confidence === "high" ? "Strong match" : "Needs a closer look"}
        </span>
      </div>
      <p>{candidate.why}</p>
      <span className="source-review__url">{candidate.url}</span>
      <div className="source-review__actions">
        {decided ? (
          <span className="source-review__decision">
            <CircleCheck aria-hidden="true" size={15} /> {decision}
          </span>
        ) : (
          <>
            <button
              className="chat-first-pill chat-first-pill--outline"
              type="button"
              disabled={busy}
              onClick={() => onDecision?.(candidate, "discard")}
            >
              Skip
            </button>
            <button
              className="chat-first-pill chat-first-pill--lime"
              type="button"
              disabled={busy}
              onClick={() => onDecision?.(candidate, "save")}
            >
              Add source
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function SourceReview({ artifact, busy = false, onDecision, onComplete, onClose }) {
  const reviewId = sourceReviewForArtifact(artifact)?.id;
  if (!reviewId) return null;

  return (
    <SourceReviewDialog
      artifact={artifact}
      busy={busy}
      onDecision={onDecision}
      onComplete={onComplete}
      onClose={onClose}
      reviewId={reviewId}
    />
  );
}

function SourceReviewDialog({ artifact, busy, onDecision, onComplete, onClose, reviewId }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!reviewId) return undefined;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    dialog?.focus();
    function onKeyDown(event) {
      handleSourceReviewKeyDown({
        event,
        onClose: () => onCloseRef.current?.(),
        dialog,
        activeElement: document.activeElement,
      });
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [reviewId]);

  return (
    <SourceReviewContent
      artifact={artifact}
      busy={busy}
      onDecision={onDecision}
      onComplete={onComplete}
      onClose={onClose}
      dialogRef={dialogRef}
    />
  );
}

export function SourceReviewContent({
  artifact,
  busy = false,
  onDecision,
  onComplete,
  onClose,
  dialogRef,
}) {
  const review = sourceReviewForArtifact(artifact);

  if (!review) return null;
  const proposed = proposedCandidates(review);
  const rejected = review.candidates.filter((candidate) => candidate.status === "rejected");
  const pendingCount = proposed.filter(
    (candidate) => candidate.decision?.status !== "completed"
  ).length;
  const complete = review.completion?.decision?.status === "completed";

  return (
    <div className="packet-viewer-overlay">
      <section
        ref={dialogRef}
        className="packet-viewer source-review"
        role="dialog"
        aria-modal="true"
        aria-label="Source review"
        tabIndex={-1}
      >
        <header className="packet-viewer__toolbar">
          <div className="source-review__toolbar-copy">
            <span className="chat-first-eyebrow">JOB BOARD DISCOVERY</span>
            <strong className="packet-viewer__title">
              {review.proposalCount} source{review.proposalCount === 1 ? "" : "s"} to review
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
        <div className="packet-viewer__stage source-review__stage">
          <div className="source-review__list">
            {proposed.map((candidate) => (
              <SourceCandidateCard
                candidate={candidate}
                busy={busy}
                onDecision={onDecision}
                key={candidate.id}
              />
            ))}
          </div>
          {rejected.length ? (
            <section className="source-review__rejected" aria-label="Rejected during screening">
              <h3>Rejected during screening</h3>
              {rejected.map((candidate) => (
                <div className="source-review__rejected-row" key={candidate.id}>
                  <CircleX aria-hidden="true" size={15} />
                  <div>
                    <strong>{candidate.label}</strong>
                    <span>{candidate.rejectionReason}</span>
                    <small>{candidate.why}</small>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <footer className="source-review__footer">
            <span>
              {complete
                ? "Board discovery is complete"
                : pendingCount
                  ? `${pendingCount} source${pendingCount === 1 ? "" : "s"} still need a decision`
                  : "Every source has a decision"}
            </span>
            {!complete && pendingCount === 0 ? (
              <button
                className="chat-first-pill chat-first-pill--lime"
                type="button"
                disabled={busy}
                onClick={() => onComplete?.(review.completion)}
              >
                Finish board discovery
              </button>
            ) : null}
          </footer>
        </div>
      </section>
    </div>
  );
}
