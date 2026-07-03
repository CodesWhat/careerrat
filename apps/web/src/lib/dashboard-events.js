// apps/web/src/lib/dashboard-events.js — same tiny same-tab pub/sub as
// lib/intake-events.js, for the M10 dashboard snapshot
// (app-shell/DashboardContext.jsx). A Jobs-drawer write, a Home Focus action,
// or a Calendar write all need the SAME shared dashboard snapshot to refetch
// immediately rather than wait out the poll interval — this is purely a
// "something changed, go refetch" signal, nothing is passed through the bus
// itself.
const listeners = new Set();

export function subscribeDashboardChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Call after any of the six M10 writes (status change, follow-up complete,
// note edit, schedule interview, comm append/send, sourced promote).
export function emitDashboardChanged() {
  for (const fn of listeners) fn();
}
