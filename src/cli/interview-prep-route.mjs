import { requireDb } from "../core/db/connection.mjs";
import { buildInterviewDossier } from "../core/interview/dossier.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(error) {
  if (error?.code === "NO_DATABASE" || error?.code === "MISSING_JOB_BODY") return 409;
  if (error?.code === "NOT_FOUND" || error?.code === "DOSSIER_NOT_FOUND") return 404;
  if (error?.code === "BAD_REQUEST" || /^BAD_/.test(String(error?.code || ""))) return 400;
  return 500;
}

function respondError(res, error) {
  sendJson(res, statusForError(error), {
    ok: false,
    code: error?.code || "INTERVIEW_PREP_ERROR",
    error: { message: error?.message || "Interview preparation failed" },
  });
}

function readApplication(repoRoot, env, id) {
  const db = requireDb({ repoRoot, env });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(String(id));
  return row ? JSON.parse(row.data) : null;
}

export function mountInterviewPrepRoutes({ addRoute, repoRoot, env = process.env } = {}) {
  addRoute("POST", "/api/interview-prep/build", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      const data = buildInterviewDossier({
        repoRoot,
        env,
        applicationId: body?.applicationId,
        audience: body?.audience,
        inviteNotes: body?.inviteNotes,
        jobSignals: body?.jobSignals,
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      respondError(res, error);
    }
  });

  addRoute("GET", "/api/interview-prep", (req, res) => {
    try {
      const id = cleanId(queryParam(req, "id"));
      const app = readApplication(repoRoot, env, id);
      if (!app) {
        const error = new Error(`no application with id "${id}"`);
        error.code = "NOT_FOUND";
        throw error;
      }
      const dossier = app.artifacts?.interviewDossier;
      if (!dossier?.markdown) {
        const error = new Error("interview dossier has not been prepared yet");
        error.code = "DOSSIER_NOT_FOUND";
        throw error;
      }
      sendJson(res, 200, { ok: true, data: { applicationId: id, dossier } });
    } catch (error) {
      respondError(res, error);
    }
  });
}

function cleanId(value) {
  const id = String(value || "").trim();
  if (!id) {
    const error = new Error("?id= is required");
    error.code = "BAD_REQUEST";
    throw error;
  }
  return id;
}
