export const ASK_BAR_REQUEST_EVENT = "careerrat:ask-request";

export function requestAskBar(text) {
  const value = String(text || "").trim();
  if (!value || typeof document === "undefined" || typeof CustomEvent === "undefined") return false;
  document.dispatchEvent(new CustomEvent(ASK_BAR_REQUEST_EVENT, { detail: { text: value } }));
  return true;
}

// Submits a typed intent straight into the durable workspace thread, instead
// of just prefilling the bar's text — for a contextual CTA (e.g. the
// Dashboard's strategy-review trigger) that already knows exactly which
// action to run. AskBar's onAskRequest listener runs it through the same
// commitAction path a click on an ACTION preview row would, so the result
// lands in the thread with no extra Enter/click needed.
export function requestAskAction({ label, intent } = {}) {
  if (!intent?.type || typeof document === "undefined" || typeof CustomEvent === "undefined") {
    return false;
  }
  document.dispatchEvent(
    new CustomEvent(ASK_BAR_REQUEST_EVENT, { detail: { action: { label, intent } } })
  );
  return true;
}
