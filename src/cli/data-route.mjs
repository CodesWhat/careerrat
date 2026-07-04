// data-route.mjs — the HTTP surface for M6's sqlite data layer, mounted by
// tracker-dev.mjs the same way mountOnboardRoutes/mountPacketRoutes/
// mountSkillRunRoute are: `addRoute` is the mount point, exact-string
// method+path dispatch (no :params), query-string ids (see queryParam below).
//
// Every write route here is a thin shim over the SAME lib functions
// src/cli/data.mjs's CLI verbs call (decision 6: one shared write path — the
// route just builds the same options object from a parsed JSON body instead
// of from argv).
//
// Response shape: { ok, meta: { version, lastUpdatedAt }, data }.
// Status codes: 400 validation, 404 unknown id, 409 only for "no database yet"
// (NoDatabaseError — decision 7's fail-closed contract surfacing over HTTP).
import { requireDb } from "../core/db/connection.mjs";
import {
  appRegisterArtifact,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
  calendarBusyUpsert,
  candidateApplicationLimitUpsert,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  commAppendMessage,
  commMarkSent,
  sourcedPromote,
  sourcedUpsertBatch,
} from "../core/db/verbs.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB, same cap the other JSON-body routes use.

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "NOT_FOUND") return 404;
  return 400; // every other failure here is a caller/body validation problem
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

function readMeta(db) {
  const row = db.prepare("SELECT version, last_updated_at FROM meta WHERE id = 1").get();
  return { version: row?.version ?? null, lastUpdatedAt: row?.last_updated_at ?? null };
}

// Every verb result already carries its own `meta: {version, lastUpdatedAt}`
// (from bumpMeta) — hoist that to the response envelope's top-level `meta`
// and put everything else under `data`.
function respondVerbResult(res, result) {
  const { meta, ...data } = result;
  sendJson(res, 200, { ok: true, meta: meta || { version: null, lastUpdatedAt: null }, data });
}

function respondCandidateResult(res, pathCtx, data) {
  let meta = { version: null, lastUpdatedAt: null };
  try {
    meta = readMeta(requireDb(pathCtx));
  } catch {
    // candidate init creates the db; if metadata is still unavailable, the
    // payload is still the authoritative setup response.
  }
  sendJson(res, 200, { ok: true, meta, data });
}

async function readBody(req) {
  return readJsonBodyCapped(req, MAX_BODY_BYTES);
}

export function mountDataRoutes({ addRoute, repoRoot, env = process.env }) {
  const pathCtx = { repoRoot, env };

  function withDb(res, fn) {
    let db;
    try {
      db = requireDb(pathCtx);
    } catch (err) {
      respondError(res, err);
      return;
    }
    try {
      fn(db);
    } catch (err) {
      respondError(res, err);
    }
  }

  async function withBodyVerb(req, res, run) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    try {
      const result = run(body);
      respondVerbResult(res, result);
    } catch (err) {
      respondError(res, err);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  addRoute("GET", "/api/data/snapshot", (_req, res) => {
    withDb(res, (db) => {
      const counts = {
        applications: db.prepare("SELECT COUNT(*) AS n FROM applications").get().n,
        sourced: db.prepare("SELECT COUNT(*) AS n FROM sourced").get().n,
        sources: db.prepare("SELECT COUNT(*) AS n FROM sources").get().n,
        communications: db.prepare("SELECT COUNT(*) AS n FROM communications").get().n,
        activity: db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n,
      };
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: { counts } });
    });
  });

  addRoute("GET", "/api/data/applications", (req, res) => {
    withDb(res, (db) => {
      const status = queryParam(req, "status");
      const company = queryParam(req, "company");
      const clauses = [];
      const params = [];
      if (status) {
        clauses.push("status = ?");
        params.push(status);
      }
      if (company) {
        clauses.push("company = ?");
        params.push(company);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT data FROM applications ${where} ORDER BY rowid ASC`)
        .all(...params)
        .map((row) => JSON.parse(row.data));
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: rows });
    });
  });

  addRoute("GET", "/api/data/applications/one", (req, res) => {
    const id = queryParam(req, "id");
    if (!id) {
      sendJson(res, 400, { ok: false, error: "?id= is required" });
      return;
    }
    withDb(res, (db) => {
      const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
      if (!row) {
        sendJson(res, 404, { ok: false, error: `no application with id "${id}"` });
        return;
      }
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: JSON.parse(row.data) });
    });
  });

  addRoute("GET", "/api/data/sourced", (_req, res) => {
    withDb(res, (db) => {
      const rows = db
        .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
        .all()
        .map((row) => JSON.parse(row.data));
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: rows });
    });
  });

  addRoute("GET", "/api/data/communications", (_req, res) => {
    withDb(res, (db) => {
      const rows = db
        .prepare("SELECT data FROM communications ORDER BY rowid ASC")
        .all()
        .map((row) => JSON.parse(row.data));
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: rows });
    });
  });

  addRoute("GET", "/api/data/activity", (req, res) => {
    withDb(res, (db) => {
      const limitParam = queryParam(req, "limit");
      const limit = limitParam ? Number.parseInt(limitParam, 10) : null;
      const rows = db
        .prepare("SELECT data FROM activity_events ORDER BY at DESC, rowid DESC")
        .all();
      const events = rows.map((row) => JSON.parse(row.data));
      const limited = Number.isInteger(limit) && limit > 0 ? events.slice(0, limit) : events;
      sendJson(res, 200, { ok: true, meta: readMeta(db), data: limited });
    });
  });

  addRoute("GET", "/api/data/candidate/config", (_req, res) => {
    try {
      const config = candidateConfigGet(pathCtx);
      respondCandidateResult(res, pathCtx, config);
    } catch (err) {
      respondError(res, err);
    }
  });

  // -------------------------------------------------------------------------
  // Writes — thin shims over the exact CLI lib functions.
  // -------------------------------------------------------------------------

  addRoute("POST", "/api/data/candidate/init", async (req, res) => {
    try {
      await readBody(req);
      const result = candidateSetupInitialize(pathCtx);
      respondCandidateResult(res, pathCtx, result);
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/data/candidate/config", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.name || !body?.patch) throw badRequest("body.name and body.patch are required");
      return candidateConfigPatch({ ...pathCtx, name: body.name, patch: body.patch });
    });
  });

  addRoute("POST", "/api/data/candidate/evidence", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!Array.isArray(body?.claims)) throw badRequest("body.claims must be an array");
      return candidateEvidenceMerge({ ...pathCtx, claims: body.claims });
    });
  });

  addRoute("POST", "/api/data/candidate/application-limit", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.row) throw badRequest("body.row is required");
      return candidateApplicationLimitUpsert({ ...pathCtx, row: body.row });
    });
  });

  addRoute("POST", "/api/data/app/status", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id || !body?.to) throw badRequest("body.id and body.to are required");
      return appSetStatus({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/app/fields", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id || !body?.patch) throw badRequest("body.id and body.patch are required");
      return appSetFields({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/app/interview", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id || !body?.at) throw badRequest("body.id and body.at are required");
      return appScheduleInterview({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/app/artifact", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id || !body?.kind || !body?.path) {
        throw badRequest("body.id, body.kind, and body.path are required");
      }
      return appRegisterArtifact({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/sourced/upsert-batch", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!Array.isArray(body?.rows) || body.rows.length === 0) {
        throw badRequest("body.rows must be a non-empty array");
      }
      return sourcedUpsertBatch({ ...pathCtx, rows: body.rows });
    });
  });

  addRoute("POST", "/api/data/sourced/promote", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id) throw badRequest("body.id is required");
      return sourcedPromote({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/comm/message", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id || !body?.message) throw badRequest("body.id and body.message are required");
      return commAppendMessage({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/comm/send", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!body?.id) throw badRequest("body.id is required");
      return commMarkSent({ ...pathCtx, ...body });
    });
  });

  addRoute("POST", "/api/data/calendar/busy", async (req, res) => {
    await withBodyVerb(req, res, (body) => {
      if (!Array.isArray(body?.blocks) || body.blocks.length === 0) {
        throw badRequest("body.blocks must be a non-empty array");
      }
      return calendarBusyUpsert({ ...pathCtx, blocks: body.blocks, source: body.source });
    });
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.code = "BAD_REQUEST";
  return err;
}
