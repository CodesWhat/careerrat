// Settings writes are synchronous request/response, not a queue — a single
// toast/inline banner is sufficient here, no notification-stack framework.

export function Toast({ message, tone = "success", onDismiss }) {
  if (!message) return null;
  return (
    <div className={`toast toast--${tone}`} role="status">
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" className="toast__dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function InlineAlert({ message, tone = "error" }) {
  if (!message) return null;
  return (
    <div className={`inline-alert inline-alert--${tone}`} role="alert">
      {message}
    </div>
  );
}
