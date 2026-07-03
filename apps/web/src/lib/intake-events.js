// apps/web/src/lib/intake-events.js — a tiny in-page pub/sub so the docked
// capture bar (app-shell/CaptureBar.jsx), the nav's needs-you badge
// (app-shell/useNeedsYouCount.js), and the /inbox queue (inbox/InboxPage.jsx)
// all react to the same intake mutations without prop-drilling through
// AppShell or introducing a context/state-management dependency this
// codebase doesn't otherwise use (see App.jsx/lib/api.js's own "no parallel
// store" convention). Nothing is passed through the bus itself — every
// listener re-fetches its own data from GET /api/intake/* on notification;
// this is purely a "something changed, go refetch" signal.
const listeners = new Set();

export function subscribeIntakeChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Call after any capture/classify/confirm/dismiss/reclassify that could move
// an item's status (and therefore the needs-you count or the Inbox list).
export function emitIntakeChanged() {
  for (const fn of listeners) fn();
}
