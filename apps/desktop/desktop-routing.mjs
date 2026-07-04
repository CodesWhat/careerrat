// desktop-routing.mjs — pure route decisions for the Electron shell.
//
// Kept out of main.mjs so route policy is testable without importing
// Electron. The desktop shell is app-first: existing workspaces open the SPA
// Home route, while first-run workspaces open the SPA onboarding wizard.
export function chooseDesktopRoute({ hasCandidateSetup } = {}) {
  return hasCandidateSetup ? "/app" : "/app/onboarding";
}
