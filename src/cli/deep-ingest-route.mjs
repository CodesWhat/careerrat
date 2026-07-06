import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { requireDb } from "../core/db/connection.mjs";
import {
  deepIngestConfirmProposal,
  deepIngestLaneSetState,
  deepIngestProposalDecision,
  deepIngestProposalPut,
  deepIngestSourceCreate,
  deepIngestStateGet,
} from "../core/db/verbs.mjs";
import {
  DEEP_INGEST_JSON_BODY_MAX_BYTES,
  DEEP_INGEST_UPLOAD_MAX_BYTES,
  laneForTargetShape,
  normalizeDeepIngestSource,
} from "../core/deep-ingest/source-normalize.mjs";
import { scanDeepIngestSource as defaultScanDeepIngestSource } from "../core/deep-ingest/source-scanner.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { sanitizeUploadFilename } from "./onboard-route.mjs";
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

export { DEEP_INGEST_JSON_BODY_MAX_BYTES, DEEP_INGEST_UPLOAD_MAX_BYTES };

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (err?.code === "VERSION_CONFLICT" || err?.code === "NOT_FOUND") return 409;
  if (err?.status) return err.status;
  return 400;
}

function respondError(res, err) {
  sendJson(res, statusForError(err), { ok: false, error: err?.message || String(err) });
}

function ensureDb(repoRoot, env) {
  requireDb({ repoRoot, env });
}

export function mountDeepIngestRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  scanSource = defaultScanDeepIngestSource,
}) {
  addRoute("GET", "/api/deep-ingest/state", (_req, res) => {
    try {
      const data = deepIngestStateGet({ repoRoot, env });
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/sources", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
      normalizeDeepIngestSource(body);
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const scanned = await scanSource({ input: body, fetchImpl });
      const data = persistScannedSource({ repoRoot, env, scanned });
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/sources/upload", async (req, res) => {
    const targetShape = queryParam(req, "targetShape") || "";
    const name = String(queryParam(req, "name") || "").trim();
    if (!name) {
      sendJson(res, 400, { ok: false, error: "?name=<filename> is required" });
      return;
    }

    let bytes;
    try {
      ensureDb(repoRoot, env);
      bytes = await readRawBodyCapped(req, DEEP_INGEST_UPLOAD_MAX_BYTES);
    } catch (err) {
      respondError(res, err);
      return;
    }
    if (!bytes.length) {
      sendJson(res, 400, { ok: false, error: "request body is empty" });
      return;
    }

    const safeName = sanitizeUploadFilename(name);
    const relPath = `workspace/deep-ingest/sources/${Date.now()}-${safeName}`;
    const absPath = userPath({ repoRoot, env }, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, bytes);

    try {
      const input = {
        targetShape,
        sourceKind: "file",
        fileName: safeName,
        bytes,
        artifactPath: relPath,
      };
      normalizeDeepIngestSource(input);
      const scanned = await scanSource({ input, fetchImpl });
      const data = persistScannedSource({ repoRoot, env, scanned });
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/proposal-decisions", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      const decision = String(body?.decision || "").trim();
      const result =
        decision === "confirm"
          ? deepIngestConfirmProposal({
              repoRoot,
              env,
              proposalId: body?.proposalId,
              expectedVersion: body?.expectedVersion,
              edits: body?.edits || {},
            })
          : deepIngestProposalDecision({
              repoRoot,
              env,
              proposalId: body?.proposalId,
              expectedVersion: body?.expectedVersion,
              decision,
              reason: body?.reason,
            });
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/lane-states", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      const result = deepIngestLaneSetState({
        repoRoot,
        env,
        lane: body?.lane,
        status: body?.status,
        reason: body?.reason,
      });
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      respondError(res, err);
    }
  });
}

function persistScannedSource({ repoRoot, env, scanned }) {
  const created = deepIngestSourceCreate({
    repoRoot,
    env,
    input: {
      id: scanned.source.id,
      targetShape: scanned.source.targetShape,
      sourceKind: scanned.source.sourceKind || scanned.source.kind,
      status: scanned.status,
      label: scanned.source.label,
      artifactPath: scanned.source.artifactPath,
      metadata: {
        ...(scanned.source.metadata || {}),
        files: scanned.files || undefined,
        truncated: scanned.truncated === true,
        reason: scanned.reason || undefined,
      },
      textLength:
        scanned.source.textLength ||
        scanned.chunks?.reduce((sum, chunk) => sum + chunk.text.length, 0) ||
        0,
      textPreview: scanned.chunks?.[0]?.text?.slice(0, 240) || null,
      chunks: scanned.chunks || [],
    },
  });

  let proposal = null;
  if (scanned.proposal) {
    proposal = deepIngestProposalPut({
      repoRoot,
      env,
      sourceId: created.source.id,
      targetShape: scanned.proposal.targetShape || scanned.source.targetShape,
      lane: scanned.proposal.lane || laneForTargetShape(scanned.source.targetShape),
      proposal: scanned.proposal,
    });
  }

  return {
    source: created.source,
    outcome: {
      ...scanned.outcome,
      sourceId: created.source.id,
      reason: scanned.reason || scanned.outcome?.reason || null,
    },
    chunks: scanned.chunks || [],
    state: deepIngestStateGet({ repoRoot, env }),
    ...(proposal ? { proposal } : {}),
    ...(scanned.manualFallback ? { manualFallback: scanned.manualFallback } : {}),
    ...(scanned.gap ? { gap: scanned.gap } : {}),
    ...(scanned.deferred ? { deferred: scanned.deferred } : {}),
    ...(scanned.notAvailable ? { notAvailable: scanned.notAvailable } : {}),
    ...(scanned.error ? { error: scanned.error } : {}),
  };
}
