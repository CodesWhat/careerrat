import { automationStatus } from "../core/automation/consent.mjs";
import { sendJson } from "./skill-run-route.mjs";

export function mountAutomationRoutes({ addRoute, repoRoot } = {}) {
  addRoute("GET", "/api/settings/automation", (_req, res) => {
    sendJson(res, 200, automationStatus({ root: repoRoot }));
  });
}
