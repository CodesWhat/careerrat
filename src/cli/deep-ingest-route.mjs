import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { requireDb } from "../core/db/connection.mjs";
import {
  deepIngestConfirmedItemRemove,
  deepIngestConfirmedItemUpdate,
  deepIngestConfirmedItemUpsert,
  deepIngestConfirmProposal,
  deepIngestLaneSetState,
  deepIngestProposalDecision,
  deepIngestProposalPut,
  deepIngestScannedSourcePersist,
  deepIngestSourceGet,
  deepIngestSourceRemove,
  deepIngestStateGet,
} from "../core/db/verbs.mjs";
import {
  DEEP_INGEST_PROPOSAL_BUILD_KIND,
  DEEP_INGEST_SOURCE_SCAN_KIND,
  prepareDeepIngestSourceScan,
  rollbackPreparedDeepIngestSourceScan,
} from "../core/deep-ingest/app-operations.mjs";
import { proposeAutoFromSource } from "../core/deep-ingest/proposals/auto.mjs";
import { proposeEvidenceFromSource } from "../core/deep-ingest/proposals/evidence.mjs";
import { proposeGapsFromSource } from "../core/deep-ingest/proposals/gaps.mjs";
import { proposeHonestyFromSource } from "../core/deep-ingest/proposals/honesty.mjs";
import { proposeRoleSignalsFromSource } from "../core/deep-ingest/proposals/role-signals.mjs";
import { proposeStoriesFromSource } from "../core/deep-ingest/proposals/stories.mjs";
import { proposeWritingVoiceFromSource } from "../core/deep-ingest/proposals/voice.mjs";
import { evaluateDeepIngestReadiness } from "../core/deep-ingest/readiness.mjs";
import {
  DEEP_INGEST_JSON_BODY_MAX_BYTES,
  DEEP_INGEST_TARGET_SHAPES,
  DEEP_INGEST_UPLOAD_MAX_BYTES,
  laneForTargetShape,
  normalizeDeepIngestSource,
} from "../core/deep-ingest/source-normalize.mjs";
import { scanDeepIngestSource as defaultScanDeepIngestSource } from "../core/deep-ingest/source-scanner.mjs";
import { buildDeepIngestViewModel } from "../core/deep-ingest/view-model.mjs";
import { userPath } from "../core/paths/workspace.mjs";
import { sanitizeUploadFilename } from "./onboard-route.mjs";
import { readJsonBodyCapped, readRawBodyCapped, sendJson } from "./skill-run-route.mjs";

export { DEEP_INGEST_JSON_BODY_MAX_BYTES, DEEP_INGEST_UPLOAD_MAX_BYTES };

const DEFAULT_PROPOSAL_BUILDERS = {
  evidence: proposeEvidenceFromSource,
  story: proposeStoriesFromSource,
  honesty_boundary: proposeHonestyFromSource,
  writing_voice: proposeWritingVoiceFromSource,
  role_signal: proposeRoleSignalsFromSource,
  gap: proposeGapsFromSource,
  auto: proposeAutoFromSource,
  paste: proposeGapsFromSource,
  link: proposeGapsFromSource,
};

const DEEP_INGEST_UPLOAD_DIR = "workspace/deep-ingest/sources";

function ownedUploadPath({ repoRoot, env, artifactPath }) {
  const raw = String(artifactPath || "")
    .trim()
    .replaceAll("\\", "/");
  if (
    !raw.startsWith(`${DEEP_INGEST_UPLOAD_DIR}/`) ||
    raw === `${DEEP_INGEST_UPLOAD_DIR}/` ||
    isAbsolute(raw) ||
    /^[A-Za-z]:\//.test(raw)
  ) {
    return null;
  }

  const uploadRoot = resolve(userPath({ repoRoot, env }, DEEP_INGEST_UPLOAD_DIR));
  const candidate = resolve(userPath({ repoRoot, env }, raw));
  const candidateRelative = relative(uploadRoot, candidate);
  if (!candidateRelative || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) {
    return null;
  }

  try {
    const realRoot = realpathSync(uploadRoot);
    const realParent = realpathSync(dirname(candidate));
    const parentRelative = relative(realRoot, realParent);
    if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) return null;
  } catch {
    // A missing artifact or parent is already clean. The lexical confinement
    // check above still prevents resolving an arbitrary path.
  }

  return candidate;
}

function removeOwnedUploadArtifact({ repoRoot, env, artifactPath }) {
  const path = ownedUploadPath({ repoRoot, env, artifactPath });
  if (!path) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return false;
  }
}

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

function statusForError(err) {
  if (err?.code === "NO_DATABASE") return 409;
  if (
    err?.code === "VERSION_CONFLICT" ||
    err?.code === "NOT_FOUND" ||
    err?.code === "SOURCE_HAS_DRAFTS"
  )
    return 409;
  if (err?.status) return err.status;
  return 400;
}

function respondError(res, err) {
  sendJson(res, statusForError(err), {
    ok: false,
    error: err?.message || String(err),
    reasons: err?.reasons || undefined,
    validation: err?.validation || undefined,
  });
}

function ensureDb(repoRoot, env) {
  requireDb({ repoRoot, env });
}

function operationView(operation) {
  const { request: _request, ownerId: _ownerId, fence: _fence, ...visible } = operation || {};
  return visible;
}

function operationSubject(operation, fallback = {}) {
  const request = { ...(operation?.request || {}), ...(fallback || {}) };
  const sourceId = String(request.sourceId || fallback.sourceId || "").trim();
  const sourceVersion = Number(request.sourceVersion || fallback.sourceVersion);
  const targetShape = String(request.targetShape || fallback.targetShape || "").trim();
  return {
    ...(sourceId ? { sourceId } : {}),
    ...(Number.isInteger(sourceVersion) && sourceVersion > 0 ? { sourceVersion } : {}),
    ...(targetShape ? { targetShape } : {}),
  };
}

function sendOperation(res, started, fallbackSubject) {
  const active = ["queued", "running"].includes(started.operation.status);
  sendJson(res, active ? 202 : 200, {
    ok: true,
    data: {
      reused: started.reused,
      operation: operationView(started.operation),
      subject: operationSubject(started.operation, fallbackSubject),
    },
  });
}

function retryInputForSource({ repoRoot, env, source }) {
  const input = {
    targetShape: source.targetShape,
    sourceKind: source.sourceKind || source.kind,
  };
  const metadata = source.metadata || {};
  if (["url", "linkedin", "portfolio", "project_link"].includes(input.sourceKind)) {
    if (metadata.url) return { ...input, url: metadata.url };
  } else if (input.sourceKind === "repo") {
    if (metadata.repoPath) return { ...input, repoPath: metadata.repoPath };
    if (metadata.url) return { ...input, url: metadata.url };
  } else if (input.sourceKind === "local_path" && metadata.path) {
    return { ...input, path: metadata.path, explicit: true };
  } else if (input.sourceKind === "file") {
    const path = ownedUploadPath({ repoRoot, env, artifactPath: source.artifactPath });
    if (path) {
      return {
        ...input,
        fileName: metadata.fileName || source.label,
        bytes: readFileSync(path),
        artifactPath: source.artifactPath,
      };
    }
  }
  const error = new Error("That source can't be retried safely. Remove it and add it again.");
  error.code = "BAD_REQUEST";
  throw error;
}

export function mountDeepIngestRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  scanSource = defaultScanDeepIngestSource,
  proposalBuilders = DEFAULT_PROPOSAL_BUILDERS,
  appOperations = null,
}) {
  addRoute("GET", "/api/deep-ingest/state", (_req, res) => {
    try {
      const data = withRouteReadiness(buildDeepIngestViewModel({ repoRoot, env }));
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

    let prepared = null;
    try {
      if (appOperations) {
        prepared = prepareDeepIngestSourceScan({ repoRoot, env, input: body });
        const started = await appOperations.start({
          kind: DEEP_INGEST_SOURCE_SCAN_KIND,
          input: prepared.request,
        });
        prepared = { ...prepared, created: false };
        sendOperation(res, started, prepared.request);
        return;
      }
      const scanned = await scanSource({ input: body, fetchImpl });
      const data = {
        ...persistScannedSource({ repoRoot, env, scanned }),
        state: deepIngestStateGet({ repoRoot, env }),
      };
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      rollbackPreparedDeepIngestSourceScan({ repoRoot, env, prepared });
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/sources/retry", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
      if (appOperations) {
        const operationId = String(body?.operationId || "").trim();
        if (!operationId) {
          const error = new Error("operationId is required to retry Deep Ingest work");
          error.code = "BAD_REQUEST";
          throw error;
        }
        const started = await appOperations.retry({ id: operationId });
        sendOperation(res, started);
        return;
      }
      const source = deepIngestSourceGet({ repoRoot, env, sourceId: body?.sourceId }).source;
      if (!source) {
        const error = new Error("Deep ingest source not found");
        error.code = "NOT_FOUND";
        throw error;
      }
      const input = retryInputForSource({ repoRoot, env, source });
      const scanned = await scanSource({ input, fetchImpl });
      scanned.source = {
        ...scanned.source,
        id: source.id,
        artifactPath: scanned.source?.artifactPath || source.artifactPath,
      };
      const data = {
        ...persistScannedSource({
          repoRoot,
          env,
          scanned,
          ownedUpload: source.metadata?.ownedUpload === true,
        }),
        state: deepIngestStateGet({ repoRoot, env }),
      };
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/sources/remove", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
      const removed = deepIngestSourceRemove({
        repoRoot,
        env,
        sourceId: body?.sourceId,
      });
      removeOwnedUploadArtifact({ repoRoot, env, artifactPath: removed.artifactPath });
      const { artifactPath: _artifactPath, ...data } = removed;
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
    const relPath = `${DEEP_INGEST_UPLOAD_DIR}/${Date.now()}-${randomUUID()}-${safeName}`;
    const absPath = userPath({ repoRoot, env }, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, bytes);

    let artifactPersisted = false;
    let prepared = null;
    try {
      const input = {
        targetShape,
        sourceKind: "file",
        fileName: safeName,
        artifactPath: relPath,
        contentDigest: createHash("sha256").update(bytes).digest("hex"),
        ownedUpload: true,
      };
      if (!appOperations) input.bytes = bytes;
      normalizeDeepIngestSource(input);
      if (appOperations) {
        prepared = prepareDeepIngestSourceScan({ repoRoot, env, input });
        const started = await appOperations.start({
          kind: DEEP_INGEST_SOURCE_SCAN_KIND,
          input: prepared.request,
        });
        prepared = { ...prepared, created: false };
        artifactPersisted = true;
        sendOperation(res, started, prepared.request);
        return;
      }
      const scanned = await scanSource({ input, fetchImpl });
      const persisted = persistScannedSource({ repoRoot, env, scanned, ownedUpload: true });
      artifactPersisted = true;
      removeOwnedUploadArtifact({
        repoRoot,
        env,
        artifactPath: persisted.replacedArtifactPath,
      });
      const { replacedArtifactPath: _replacedArtifactPath, ...persistedData } = persisted;
      const data = {
        ...persistedData,
        state: deepIngestStateGet({ repoRoot, env }),
      };
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      rollbackPreparedDeepIngestSourceScan({ repoRoot, env, prepared });
      if (!artifactPersisted) {
        removeOwnedUploadArtifact({ repoRoot, env, artifactPath: relPath });
      }
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/proposals", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      if (appOperations) {
        const started = await appOperations.start({
          kind: DEEP_INGEST_PROPOSAL_BUILD_KIND,
          input: body,
        });
        sendOperation(res, started, body);
        return;
      }
      const data = await buildAndPersistProposals({
        repoRoot,
        env,
        body,
        proposalBuilders,
      });
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
      const proposal =
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
              edits: body?.edits || {},
            });
      sendJson(res, 200, {
        ok: true,
        data: {
          proposal,
          state: buildDeepIngestViewModel({ repoRoot, env }),
        },
      });
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

  // POST /api/deep-ingest/confirmed/update — { lane, id, ...fields } edits one
  // already-confirmed row in one of the four per-lane reference tables (Library
  // drawer's Edit/Save affordance for story/voice/honesty/role_signal cards).
  // Re-runs the privacy guard only (see deepIngestConfirmedItemUpdate's own
  // comment) — never grounding/quote-matching.
  addRoute("POST", "/api/deep-ingest/confirmed/update", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const { lane, id, ...fields } = body || {};
      const result = deepIngestConfirmedItemUpdate({ repoRoot, env, lane, id, fields });
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      respondError(res, err);
    }
  });

  addRoute("POST", "/api/deep-ingest/confirmed/upsert", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const result = deepIngestConfirmedItemUpsert({
        repoRoot,
        env,
        lane: body?.lane,
        id: body?.id,
        fields: body?.fields,
      });
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      respondError(res, err);
    }
  });

  // POST /api/deep-ingest/confirmed/remove — { lane, id } deletes exactly one
  // row from the matching per-lane reference table (Library drawer's Delete
  // affordance for story/voice/honesty/role_signal cards).
  addRoute("POST", "/api/deep-ingest/confirmed/remove", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, DEEP_INGEST_JSON_BODY_MAX_BYTES);
      ensureDb(repoRoot, env);
    } catch (err) {
      respondError(res, err);
      return;
    }

    try {
      const result = deepIngestConfirmedItemRemove({
        repoRoot,
        env,
        lane: body?.lane,
        id: body?.id,
      });
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      respondError(res, err);
    }
  });
}

function withRouteReadiness(data) {
  const readiness = evaluateDeepIngestReadiness({
    laneStates: data?.laneStates,
    requiredLanes: Array.isArray(data?.lanes)
      ? data.lanes.map((lane) => lane.key || lane.lane)
      : undefined,
  });
  return {
    ...data,
    readiness,
    todos: readiness.todos,
    gaps: readiness.gaps,
    requiredLaneCount: readiness.requiredCount,
    terminalLaneCount: readiness.terminalCount,
  };
}

async function buildAndPersistProposals({ repoRoot, env, body, proposalBuilders }) {
  const sourceId = String(body?.sourceId || "").trim();
  if (!sourceId) {
    const err = new Error("sourceId is required");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const state = deepIngestStateGet({ repoRoot, env });
  const source = state.sources.find((row) => row.id === sourceId);
  if (!source) {
    const err = new Error(`Deep ingest source not found: "${sourceId}"`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const targetShape = normalizeProposalTargetShape(body?.targetShape || source.targetShape);
  const sourceWithChunks = {
    ...source,
    chunks: state.sourceChunks.filter((chunk) => chunk.sourceId === source.id),
  };
  const builder = proposalBuilders[targetShape] || DEFAULT_PROPOSAL_BUILDERS[targetShape];
  if (typeof builder !== "function") {
    const err = new Error(`no Deep ingest proposal builder for targetShape "${targetShape}"`);
    err.code = "BAD_REQUEST";
    throw err;
  }

  const built = await builder({ source: sourceWithChunks, targetShape, repoRoot, env });
  const rows = [...proposalRowsFromBuilt(built?.proposals), ...proposalRowsFromBuilt(built?.gaps)];
  if (!rows.length) {
    const err = new Error("proposal builder returned no reviewable rows");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const proposals = rows.map((row) =>
    deepIngestProposalPut({
      repoRoot,
      env,
      sourceId: source.id,
      targetShape,
      lane: proposalLane(row, targetShape),
      proposal: row,
    })
  );

  return {
    source,
    proposals,
    builder: {
      status: built?.status || "proposal_ready",
      manual: built?.manual || null,
      ai: built?.ai || null,
    },
    state: buildDeepIngestViewModel({ repoRoot, env }),
  };
}

function normalizeProposalTargetShape(value) {
  const targetShape = String(value || "").trim();
  if (!DEEP_INGEST_TARGET_SHAPES.includes(targetShape)) {
    const err = new Error(`targetShape must be one of ${DEEP_INGEST_TARGET_SHAPES.join(", ")}`);
    err.code = "BAD_REQUEST";
    throw err;
  }
  return targetShape;
}

function proposalRowsFromBuilt(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
}

function proposalLane(row, targetShape) {
  const lane = String(row?.lane || "").trim();
  const proposalLaneMap = {
    evidence: "evidence_claims",
    story: "story_bank",
    honesty: "honesty_boundaries",
    writing_voice: "writing_voice",
    role_signal: "role_signals",
    gap: "open_gaps",
  };
  if (proposalLaneMap[lane]) return proposalLaneMap[lane];
  return lane.endsWith("_claims") ||
    ["story_bank", "honesty_boundaries", "writing_voice", "role_signals", "open_gaps"].includes(
      lane
    )
    ? lane
    : laneForTargetShape(targetShape);
}

function persistScannedSource({ repoRoot, env, scanned, ownedUpload = false }) {
  const persisted = deepIngestScannedSourcePersist({
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
        ownedUpload: ownedUpload === true || undefined,
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
    proposalInput: scanned.proposal
      ? {
          targetShape: scanned.proposal.targetShape || scanned.source.targetShape,
          lane: scanned.proposal.lane || laneForTargetShape(scanned.source.targetShape),
          proposal: scanned.proposal,
        }
      : null,
  });

  return {
    source: persisted.source,
    outcome: {
      ...scanned.outcome,
      sourceId: persisted.source.id,
      reason: scanned.reason || scanned.outcome?.reason || null,
    },
    chunks: scanned.chunks || [],
    ...(persisted.proposal ? { proposal: persisted.proposal } : {}),
    ...(scanned.manualFallback ? { manualFallback: scanned.manualFallback } : {}),
    ...(scanned.gap ? { gap: scanned.gap } : {}),
    ...(scanned.deferred ? { deferred: scanned.deferred } : {}),
    ...(scanned.notAvailable ? { notAvailable: scanned.notAvailable } : {}),
    ...(scanned.error ? { error: scanned.error } : {}),
    replacedArtifactPath: persisted.replacedArtifactPath,
  };
}
