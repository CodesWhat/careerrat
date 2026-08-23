import { buildWorkspaceExport } from "../core/export/workspace-export.mjs";
import { sendJson } from "./skill-run-route.mjs";

function exportErrorStatus(error) {
  return error?.code === "NO_DATABASE" || error?.code === "EXPORT_BUSY" ? 409 : 500;
}

export function mountWorkspaceExportRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  buildExport = buildWorkspaceExport,
} = {}) {
  addRoute("GET", "/api/data/export-everything", async (_req, res) => {
    try {
      const result = await buildExport({ repoRoot, env });
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(result.buffer.length),
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(result.buffer);
    } catch (error) {
      if (error?.code === "EXPORT_BUSY") res.setHeader("Retry-After", "1");
      sendJson(res, exportErrorStatus(error), {
        ok: false,
        code: error?.code || "EXPORT_FAILED",
        error: error?.message || String(error),
      });
    }
  });
}
