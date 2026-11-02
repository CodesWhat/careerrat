import { undoWorkspaceKnowledge } from "../core/agent/knowledge-history.mjs";
import { workspaceThreadOpen } from "../core/agent/workspace-thread.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

function sendError(res, error) {
  const status =
    error?.code === "NO_DATABASE"
      ? 409
      : Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
        ? error.status
        : ["BAD_REQUEST", "KNOWLEDGE_REVERT_INVALID"].includes(error?.code)
          ? 400
          : 500;
  sendJson(res, status, {
    ok: false,
    error:
      status === 500
        ? "CareerRat couldn't read that saved change."
        : error?.message || "CareerRat couldn't read that saved change.",
    code: error?.code,
  });
}

export function mountWorkspaceReviewRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  revertKnowledgeImpl = undoWorkspaceKnowledge,
} = {}) {
  addRoute("GET", "/api/workspace/thread", (_req, res) => {
    try {
      sendJson(res, 200, { ok: true, data: workspaceThreadOpen({ repoRoot, env }) });
    } catch (error) {
      sendError(res, error);
    }
  });
  addRoute("POST", "/api/workspace/knowledge/revert", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, 1024 * 1024);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["messageId", "index"].includes(key)) ||
        typeof body.messageId !== "string" ||
        !body.messageId.trim() ||
        body.messageId.length > 500 ||
        !Number.isSafeInteger(body.index) ||
        body.index < 0
      ) {
        const error = new Error("A saved message and artifact index are required.");
        error.code = "BAD_REQUEST";
        throw error;
      }
      const result = await revertKnowledgeImpl({
        repoRoot,
        env,
        messageId: body.messageId,
        index: body.index,
      });
      sendJson(res, 200, { ok: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });
}
