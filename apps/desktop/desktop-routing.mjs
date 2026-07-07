// desktop-routing.mjs — pure route decisions for the Electron shell.
//
// Kept out of main.mjs so route policy is testable without importing
// Electron. The desktop shell is app-first: existing workspaces open the SPA
// Home route, while first-run workspaces open the SPA onboarding wizard. Source
// dev launches can force onboarding while the first-run experience is being
// designed against real Electron chrome. A dev route override is intentionally
// explicit so design review can jump to a product page without changing the
// first-run default.
export function chooseDesktopRoute({
  hasCandidateSetup,
  forceOnboarding = false,
  routeOverride = "",
} = {}) {
  const override = normalizeDesktopRoute(routeOverride);
  if (override) return override;
  if (forceOnboarding) return "/app/onboarding";
  return hasCandidateSetup ? "/app" : "/app/onboarding";
}

export function normalizeDesktopRoute(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/app")) return raw;
  if (raw.startsWith("/")) return `/app${raw}`;
  return `/app/${raw}`;
}
