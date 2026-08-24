import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTOMATION_FILE,
  AUTOMATION_SCHEMA,
  AUTOMATION_TEMPLATE,
  atomicWriteFile,
  automationStatus,
  ensureAutomationFile,
  loadAutomation,
  planSessionEdit,
} from "../core/automation/consent.mjs";
import { PROVIDERS } from "../core/automation/session.mjs";
import { candidateConfigPatch } from "../core/db/verbs/candidate.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 16 * 1024;

function routeError(message, code, status = 400, details = []) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function setAutomationSessionProvider({ repoRoot, env = process.env, provider } = {}) {
  if (!PROVIDERS[provider]) {
    throw routeError(
      `unknown automation provider "${provider || ""}"`,
      "AUTOMATION_PROVIDER_UNKNOWN"
    );
  }

  const loaded = loadAutomation({ root: repoRoot, env });
  if (loaded.source === "db") {
    candidateConfigPatch({
      repoRoot,
      env,
      name: "automation",
      patch: { session: { provider } },
    });
    return automationStatus({ root: repoRoot, env });
  }

  const pathContext = { repoRoot, env };
  const candidatePath = userPath(pathContext, AUTOMATION_FILE);
  const templatePath = join(repoRoot, AUTOMATION_TEMPLATE);
  const schemaPath = join(repoRoot, AUTOMATION_SCHEMA);
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
  const baseText = readFileSync(existsSync(candidatePath) ? candidatePath : templatePath, "utf8");
  let plan = planSessionEdit({ provider, currentText: baseText, schema });
  if (!plan.ok) throw routeError(plan.error, "AUTOMATION_PROVIDER_INVALID");
  if (!plan.valid) {
    throw routeError(
      "automation provider change would invalidate candidate settings",
      "AUTOMATION_SETTINGS_INVALID",
      422,
      plan.errors
    );
  }
  if (plan.changed) {
    ensureAutomationFile({ root: repoRoot, env });
    const currentText = readFileSync(candidatePath, "utf8");
    if (currentText !== baseText) {
      plan = planSessionEdit({ provider, currentText, schema });
      if (!plan.ok || !plan.valid) {
        throw routeError(
          plan.error || "automation settings changed while saving",
          "AUTOMATION_SETTINGS_INVALID",
          409,
          plan.errors
        );
      }
    }
    if (plan.changed) atomicWriteFile(candidatePath, plan.nextText);
  }
  return automationStatus({ root: repoRoot, env });
}

export function mountAutomationRoutes({ addRoute, repoRoot, env = process.env } = {}) {
  addRoute("GET", "/api/settings/automation", (_req, res) => {
    sendJson(res, 200, automationStatus({ root: repoRoot, env }));
  });

  addRoute("POST", "/api/settings/automation/session", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const automation = setAutomationSessionProvider({
        repoRoot,
        env,
        provider: String(body?.provider || "").trim(),
      });
      sendJson(res, 200, { ok: true, automation });
    } catch (error) {
      sendJson(res, error.status || 500, {
        ok: false,
        code: error.code || "AUTOMATION_SETTINGS_WRITE_FAILED",
        error: error.message || "automation settings could not be saved",
        ...(error.details?.length ? { details: error.details } : {}),
      });
    }
  });
}
