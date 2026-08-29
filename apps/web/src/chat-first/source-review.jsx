import { CircleCheck, CircleX, Globe2, Rss, Search } from "lucide-react";
import { useEffect, useRef } from "react";

import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import { handleArtifactViewerKeyDown } from "../jobs/ArtifactViewerModal.jsx";

export const handleSourceReviewKeyDown = handleArtifactViewerKeyDown;
const REVIEW_BATCH_SIZE = 4;

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

export function sourceReviewForArtifact(artifact) {
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

function normalizedOptionText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveVisibleOptionNames(text, options) {
  const normalized = normalizedOptionText(text);
  if (!normalized) return null;
  const haystack = ` ${normalized} `;
  const matches = [];
  for (const option of Array.isArray(options) ? options : []) {
    const aliases = [...new Set((option.aliases || []).map(normalizedOptionText).filter(Boolean))];
    const matchedAliases = aliases.filter((alias) => haystack.includes(` ${alias} `));
    if (matchedAliases.length) matches.push({ id: option.id, aliases: matchedAliases });
  }
  const ambiguous = matches.some((match, index) =>
    matches.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        match.aliases.some((alias) =>
          candidate.aliases.some(
            (candidateAlias) =>
              alias === candidateAlias || ` ${candidateAlias} `.includes(` ${alias} `)
          )
        )
    )
  );
  return matches.length && !ambiguous ? matches.map((match) => match.id) : null;
}

function explicitReviewMutation(text, { positiveVerbs, negativeVerbs }) {
  const normalized = normalizedOptionText(text);
  if (!normalized || /\b(?:don t|do not|not|except)\b/.test(normalized)) return null;
  const verbs = [...new Set([...positiveVerbs, ...negativeVerbs].map(normalizedOptionText))];
  const command = normalized.match(
    /^(?:(?:yes|yeah|yep|sure|okay|ok)\s+)?(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:d\s+like|would\s+like|want)\s+to\s+|i\s+d\s+|let\s+s\s+|go\s+ahead\s+(?:and\s+)?)?([a-z]+)\b/
  );
  const verb = command?.[1];
  if (!verb || !verbs.includes(verb)) return null;

  const hasPositiveVerb = positiveVerbs.some((candidate) =>
    new RegExp(`\\b${normalizedOptionText(candidate)}\\b`).test(normalized)
  );
  const hasNegativeVerb = negativeVerbs.some((candidate) =>
    new RegExp(`\\b${normalizedOptionText(candidate)}\\b`).test(normalized)
  );
  if (hasPositiveVerb && hasNegativeVerb) return null;
  return positiveVerbs.map(normalizedOptionText).includes(verb) ? "select" : "exclude";
}

export function resolveReviewMutationSelection(text, options, { positiveVerbs, negativeVerbs }) {
  const visibleOptions = Array.isArray(options) ? options : [];
  const mode = explicitReviewMutation(text, { positiveVerbs, negativeVerbs });
  if (!mode) return null;
  const matchedIds = resolveVisibleOptionNames(text, visibleOptions);
  if (!matchedIds) return null;
  if (mode === "select") return matchedIds;
  const excluded = new Set(matchedIds);
  return visibleOptions.map((option) => option.id).filter((id) => !excluded.has(id));
}

function proposedCandidates(review) {
  return review.candidates
    .filter((candidate) => candidate.status === "proposed")
    .sort(
      (left, right) => Number(right.confidence === "high") - Number(left.confidence === "high")
    );
}

function pendingCandidates(review) {
  return proposedCandidates(review).filter(
    (candidate) => candidate.decision?.status !== "completed"
  );
}

export function sourceReviewFromMessages(messages) {
  for (
    let messageIndex = (Array.isArray(messages) ? messages.length : 0) - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const artifacts = Array.isArray(messages[messageIndex]?.artifacts)
      ? messages[messageIndex].artifacts
      : [];
    for (let artifactIndex = artifacts.length - 1; artifactIndex >= 0; artifactIndex -= 1) {
      const review = sourceReviewForArtifact(artifacts[artifactIndex]);
      if (review && pendingCandidates(review).length) return review;
    }
  }
  return null;
}

export function sourceReviewTextSelection(artifact, text, batchSize = REVIEW_BATCH_SIZE) {
  const review = sourceReviewForArtifact(artifact);
  if (!review) return null;
  const batch = pendingCandidates(review).slice(0, batchSize);
  return resolveReviewMutationSelection(
    text,
    batch.map((candidate) => ({ id: candidate.id, aliases: [candidate.label] })),
    {
      positiveVerbs: ["add", "save", "select", "track", "include", "keep", "use"],
      negativeVerbs: ["skip", "reject", "discard", "exclude", "remove"],
    }
  );
}

export function sourceReviewBatchDecisions(
  artifact,
  selectedOptionIds,
  batchSize = REVIEW_BATCH_SIZE
) {
  const review = sourceReviewForArtifact(artifact);
  if (!review) return null;
  const batch = pendingCandidates(review).slice(0, batchSize);
  if (!batch.length) return [];
  const selected = new Set(Array.isArray(selectedOptionIds) ? selectedOptionIds.map(String) : []);
  const batchIds = new Set(batch.map((candidate) => candidate.id));
  if ([...selected].some((id) => !batchIds.has(id))) return null;
  return batch.map((candidate) => ({
    candidate,
    action: selected.has(candidate.id) ? "save" : "discard",
  }));
}

export async function submitSourceReviewBatch({
  artifact,
  selectedOptionIds,
  onDecision,
  onComplete,
} = {}) {
  const review = sourceReviewForArtifact(artifact);
  const decisions = sourceReviewBatchDecisions(artifact, selectedOptionIds);
  if (!review || !decisions?.length || typeof onDecision !== "function") return false;
  for (const { candidate, action } of decisions) {
    const completed = await onDecision(candidate, action);
    if (completed === false) return false;
  }
  if (pendingCandidates(review).length === decisions.length) {
    await onComplete?.(review.completion);
  }
  return true;
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
        <small>
          or type the board names you want to add; the others in this batch will be skipped
        </small>
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

function SourceCandidateCard({ candidate, busy }) {
  return (
    <label className="source-review__card">
      <input
        className="source-review__checkbox"
        type="checkbox"
        name="source-option"
        value={candidate.id}
        disabled={busy}
      />
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
    </label>
  );
}

export function useReviewDialog({ dialogRef, reviewId, onClose }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!reviewId) return undefined;
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
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
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.();
    };
  }, [dialogRef, reviewId]);
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
  useReviewDialog({ dialogRef, reviewId, onClose });

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

function SourceReviewContent({
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
  const pending = pendingCandidates(review);
  const batch = pending.slice(0, REVIEW_BATCH_SIZE);
  const rejected = review.candidates.filter((candidate) => candidate.status === "rejected");
  const pendingCount = pending.length;
  const decided = proposed.filter((candidate) => candidate.decision?.status === "completed");
  const addedCount = decided.filter((candidate) => candidate.decision?.action === "save").length;
  const skippedCount = decided.filter(
    (candidate) => candidate.decision?.action === "discard"
  ).length;
  const complete = review.completion?.decision?.status === "completed";

  async function submitBatch(event) {
    event.preventDefault();
    const selectedOptionIds = new FormData(event.currentTarget).getAll("source-option");
    await submitSourceReviewBatch({ artifact, selectedOptionIds, onDecision, onComplete });
  }

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
          {decided.length ? (
            <p className="review-batch__resolved" aria-live="polite">
              <CircleCheck aria-hidden="true" size={15} /> {decided.length} reviewed · {addedCount}
              added · {skippedCount} skipped
            </p>
          ) : null}
          {batch.length ? (
            <form className="review-batch" onSubmit={submitBatch}>
              <fieldset disabled={busy}>
                <legend>Which sources should CareerRat add?</legend>
                <p className="review-batch__help">
                  Select the useful boards. Saving skips the unselected ones in this batch.
                  {pendingCount > batch.length
                    ? ` Showing ${batch.length} of ${pendingCount}.`
                    : ""}
                </p>
                <div className="source-review__list">
                  {batch.map((candidate) => (
                    <SourceCandidateCard candidate={candidate} busy={busy} key={candidate.id} />
                  ))}
                </div>
                <footer className="source-review__footer">
                  <span>
                    {pendingCount > batch.length
                      ? `${pendingCount - batch.length} more after this batch`
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
          ) : null}
          {rejected.length ? (
            <details className="source-review__rejected">
              <summary>{rejected.length} rejected during screening</summary>
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
            </details>
          ) : null}
          {!batch.length ? (
            <footer className="source-review__footer">
              <span>
                {complete ? "Board discovery is complete" : "Every source has a decision"}
              </span>
              {!complete ? (
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
          ) : null}
        </div>
      </section>
    </div>
  );
}
