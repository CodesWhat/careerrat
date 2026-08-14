import { Link } from "react-router-dom";

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

export function InlineAlert({ message, tone = "error", action, detail }) {
  if (!message) return null;
  return (
    <div className={`inline-alert inline-alert--${tone}`} role="alert">
      {message}
      {action?.label ? <InlineAlertAction action={action} /> : null}
      {detail ? (
        <details className="inline-alert__detail">
          <summary>Technical details</summary>
          {detail}
        </details>
      ) : null}
    </div>
  );
}

function InlineAlertAction({ action }) {
  if (action.to) {
    return (
      <Link to={action.to} className="inline-alert__action">
        {action.label}
      </Link>
    );
  }
  if (action.retry) {
    return (
      <button type="button" className="inline-alert__action" onClick={action.onRetry}>
        {action.label}
      </button>
    );
  }
  return null;
}
