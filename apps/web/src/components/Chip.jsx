// Chip — a small removable tag (target titles, keep/cut signals, tracked
// companies) and SuggestionChip — a suggestion chip the user must
// explicitly accept or dismiss before it becomes real data (never
// auto-committed — see the M8 onboarding wizard's own "suggestions only fill
// the draft" convention). Neither ever renders a colored left edge — state is
// conveyed by background/text color only, same rule as Card.

export function Chip({ children, onRemove }) {
  return (
    <span className="chip">
      <span className="chip__label">{children}</span>
      {onRemove ? (
        <button type="button" className="chip__remove" onClick={onRemove} aria-label="Remove">
          ×
        </button>
      ) : null}
    </span>
  );
}

export function SuggestionChip({ children, onAccept, onDismiss }) {
  return (
    <span className="chip chip--suggestion">
      <span className="chip__label">{children}</span>
      <button
        type="button"
        className="chip__accept"
        onClick={onAccept}
        aria-label="Accept suggestion"
      >
        +
      </button>
      <button
        type="button"
        className="chip__remove"
        onClick={onDismiss}
        aria-label="Dismiss suggestion"
      >
        ×
      </button>
    </span>
  );
}
