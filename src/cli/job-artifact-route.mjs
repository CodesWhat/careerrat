import { readJobDescriptionArtifact } from "../core/jobs/job-description.mjs";
import { sendJson } from "./skill-run-route.mjs";

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(error) {
  if (error?.code === "BAD_REQUEST") return 400;
  if (error?.code === "NOT_FOUND" || error?.code === "JD_FILE_MISSING") return 404;
  if (error?.code === "NO_DATABASE" || error?.code === "JD_NOT_CAPTURED") return 409;
  if (error?.code === "UNSAFE_ARTIFACT_PATH") return 422;
  if (error?.code === "JD_TOO_LARGE") return 413;
  return 500;
}

export function mountJobArtifactRoutes({ addRoute, repoRoot, env = process.env } = {}) {
  addRoute("GET", "/api/jobs/job-description", (req, res) => {
    try {
      const data = readJobDescriptionArtifact({
        repoRoot,
        env,
        source: queryParam(req, "source"),
        id: queryParam(req, "id"),
      });
      sendJson(res, 200, { ok: true, data });
    } catch (error) {
      sendJson(res, statusForError(error), {
        ok: false,
        code: error?.code || "JOB_DESCRIPTION_ERROR",
        error: { message: error?.message || "Could not open the job description." },
      });
    }
  });
}
