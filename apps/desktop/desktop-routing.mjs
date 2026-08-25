// desktop-routing.mjs — pure route decisions for the Electron shell.
//
// Kept out of main.mjs so route policy is testable without importing
// Electron. The React app owns first-run state inside the same chat-first
// workspace, so the desktop shell always opens one product route. A dev route
// override remains available for focused review of a real chat-first route.
export function chooseDesktopRoute({ routeOverride = "" } = {}) {
  const override = normalizeDesktopRoute(routeOverride);
  if (override) return override;
  return "/app";
}

export function normalizeDesktopRoute(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/app")) return raw;
  if (raw.startsWith("/")) return `/app${raw}`;
  return `/app/${raw}`;
}

export function rendererRouteFromDesktopRoute(value) {
  const desktopRoute = normalizeDesktopRoute(value) || "/app";
  const route = desktopRoute.slice("/app".length);
  return route || "/";
}
