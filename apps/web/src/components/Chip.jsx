// Chip — a small removable tag (target titles, keep/cut signals, tracked
// companies). Never renders a colored left edge — state is conveyed by
// background/text color only, same rule as Card.

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
