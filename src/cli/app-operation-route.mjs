import { APP_OPERATION_LIMITS } from "../core/db/verbs.mjs";
import { createAppOperationManager } from "../core/runtime/app-operation-manager.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = APP_OPERATION_LIMITS.request + 4_096;

function makeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function statusForError(error) {
  if (error?.code === "NO_DATABASE") return 409;
  if (error?.code === "NOT_FOUND") return 404;
  if (error?.code === "APP_OPERATION_MANAGER_STOPPED") return 503;
  if (error?.code === "APP_OPERATION_PAYLOAD_TOO_LARGE") return 413;
  return 400;
}

function sendError(res, error) {
  sendJson(res, statusForError(error), {
    ok: false,
    code: error?.code || "BAD_REQUEST",
    error: { message: error?.message || "CareerRat couldn't start this work." },
  });
}

function exactBody(body, allowed, message) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw makeError("request body must be an object", "BAD_REQUEST");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key))) throw makeError(message, "BAD_REQUEST");
}

function operationView(operation) {
  if (!operation) return null;
  const { request: _request, ownerId: _ownerId, fence: _fence, ...visible } = operation;
  return visible;
}

export function mountAppOperationRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  manager,
  kinds = {},
  ownerId,
  heartbeatMs,
  leaseMs,
} = {}) {
  const appOperations =
    manager ||
    createAppOperationManager({
      repoRoot,
      env,
      kinds,
      ownerId,
      heartbeatMs,
      leaseMs,
    });

  addRoute("POST", "/api/app-operations/start", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      exactBody(body, ["kind", "input"], "App operations accept only kind and input.");
      if (!("kind" in body) || !("input" in body)) {
        throw makeError("kind and input are required", "BAD_REQUEST");
      }
      const started = await appOperations.start({ kind: body.kind, input: body.input });
      const active = ["queued", "running"].includes(started.operation.status);
      sendJson(res, active ? 202 : 200, {
        ok: true,
        reused: started.reused,
        operation: operationView(started.operation),
      });
    } catch (error) {
      if (error?.status === 413) {
        error.code = "APP_OPERATION_PAYLOAD_TOO_LARGE";
      }
      sendError(res, error);
    }
  });

  addRoute("GET", "/api/app-operations/operation", (req, res) => {
    try {
      const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
      if (!id) throw makeError("?id= is required", "BAD_REQUEST");
      sendJson(res, 200, { ok: true, operation: operationView(appOperations.get({ id })) });
    } catch (error) {
      sendError(res, error);
    }
  });

  addRoute("POST", "/api/app-operations/retry", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
      exactBody(body, ["id"], "App-operation retry accepts only id.");
      if (!body.id) throw makeError("id is required", "BAD_REQUEST");
      const started = await appOperations.retry({ id: body.id });
      const active = ["queued", "running"].includes(started.operation.status);
      sendJson(res, active ? 202 : 200, {
        ok: true,
        reused: started.reused,
        operation: operationView(started.operation),
      });
    } catch (error) {
      if (error?.status === 413) {
        error.code = "APP_OPERATION_PAYLOAD_TOO_LARGE";
      }
      sendError(res, error);
    }
  });

  return appOperations;
}
