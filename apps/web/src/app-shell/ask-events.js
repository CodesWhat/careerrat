export const ASK_BAR_REQUEST_EVENT = "careerrat:ask-request";

export function requestAskBar(text) {
  const value = String(text || "").trim();
  if (!value || typeof document === "undefined" || typeof CustomEvent === "undefined") return false;
  document.dispatchEvent(new CustomEvent(ASK_BAR_REQUEST_EVENT, { detail: { text: value } }));
  return true;
}
