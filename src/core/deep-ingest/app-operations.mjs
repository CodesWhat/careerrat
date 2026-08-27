import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { loadAIPreferences } from "../ai/ai-preferences.mjs";
import { resolveAIRoute } from "../ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../ai/operation-policy.mjs";
import {
  deepIngestPreparedSourceRollback,
  deepIngestProposalSetPut,
  deepIngestScannedSourcePersist,
  deepIngestSourceCreate,
  deepIngestSourceGet,
  deepIngestStateGet,
} from "../db/verbs/deep-ingest.mjs";
import { userPath } from "../paths/workspace.mjs";
import { proposeAutoFromSource } from "./proposals/auto.mjs";
import { proposeEvidenceFromSource } from "./proposals/evidence.mjs";
import { proposeGapsFromSource } from "./proposals/gaps.mjs";
import { proposeHonestyFromSource } from "./proposals/honesty.mjs";
import { proposeRoleSignalsFromSource } from "./proposals/role-signals.mjs";
import { proposeStoriesFromSource } from "./proposals/stories.mjs";
import { proposeWritingVoiceFromSource } from "./proposals/voice.mjs";
import {
  DEEP_INGEST_TARGET_SHAPES,
  laneForTargetShape,
  normalizeDeepIngestSource,
} from "./source-normalize.mjs";
import { scanDeepIngestSource } from "./source-scanner.mjs";

export const DEEP_INGEST_SOURCE_SCAN_KIND = "deep-ingest-source-scan";
export const DEEP_INGEST_PROPOSAL_BUILD_KIND = "deep-ingest-proposal-build";

const UPLOAD_DIR = "workspace/deep-ingest/sources";
const DEFAULT_PROPOSAL_BUILDERS = Object.freeze({
  evidence: proposeEvidenceFromSource,
  story: proposeStoriesFromSource,
  honesty_boundary: proposeHonestyFromSource,
  writing_voice: proposeWritingVoiceFromSource,
  role_signal: proposeRoleSignalsFromSource,
  gap: proposeGapsFromSource,
  auto: proposeAutoFromSource,
  paste: proposeGapsFromSource,
  link: proposeGapsFromSource,
});

function makeError(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalize(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function normalizedText(value) {
  return String(value || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function normalizedUrl(value) {
  const parsed = new URL(String(value || "").trim());
  parsed.hash = "";
  return parsed.toString();
}

function ownedUploadAbsolutePath({ repoRoot, env, artifactPath }) {
  const raw = String(artifactPath || "")
    .trim()
    .replaceAll("\\", "/");
  if (
    !raw.startsWith(`${UPLOAD_DIR}/`) ||
    raw === `${UPLOAD_DIR}/` ||
    isAbsolute(raw) ||
    /^[A-Za-z]:\//.test(raw)
  ) {
    return null;
  }

  const uploadRoot = resolve(userPath({ repoRoot, env }, UPLOAD_DIR));
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
    // A missing staged artifact is already clean; lexical confinement still applies.
  }
  return candidate;
}

export function removeDeepIngestOwnedUploadArtifact({ repoRoot, env, artifactPath } = {}) {
  const path = ownedUploadAbsolutePath({ repoRoot, env, artifactPath });
  if (!path) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function fileContentDigest({ repoRoot, env, input }) {
  const path = ownedUploadAbsolutePath({ repoRoot, env, artifactPath: input.artifactPath });
  if (!path || !existsSync(path)) {
    throw makeError("The uploaded Deep Ingest source is no longer available.", "NOT_FOUND");
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sourceIdentity({ repoRoot, env, input }) {
  const normalized = normalizeDeepIngestSource(input);
  const base = {
    targetShape: normalized.targetShape,
    sourceKind: normalized.sourceKind,
  };

  if (["paste", "text", "note", "recruiter_context", "job_context"].includes(base.sourceKind)) {
    const text = normalizedText(normalized.text);
    return { normalized: { ...normalized, text }, identity: { ...base, text } };
  }
  if (["url", "linkedin", "portfolio", "project_link"].includes(base.sourceKind)) {
    const url = normalizedUrl(normalized.url);
    return { normalized: { ...normalized, url }, identity: { ...base, url } };
  }
  if (base.sourceKind === "file") {
    const contentDigest = fileContentDigest({ repoRoot, env, input: normalized });
    return {
      normalized: { ...normalized, contentDigest },
      identity: {
        ...base,
        fileName: String(normalized.fileName || "")
          .trim()
          .toLowerCase(),
        contentDigest,
      },
    };
  }
  if (base.sourceKind === "repo") {
    return {
      normalized,
      identity: { ...base, repoPath: normalized.repoPath || null, url: normalized.url || null },
    };
  }
  if (base.sourceKind === "local_path") {
    return {
      normalized,
      identity: { ...base, path: normalized.path, explicit: normalized.explicit },
    };
  }
  return { normalized, identity: base };
}

export function deepIngestSourceDigest({ repoRoot, env = process.env, input } = {}) {
  return digest(sourceIdentity({ repoRoot, env, input }).identity);
}

export function deepIngestProposalSetId({ sourceId, sourceVersion, targetShape } = {}) {
  return `deep_set_${digest({
    sourceId: String(sourceId || ""),
    sourceVersion: Number(sourceVersion),
    targetShape: String(targetShape || ""),
  }).slice(0, 20)}`;
}

export function prepareDeepIngestSourceScan({ repoRoot, env = process.env, input } = {}) {
  const { normalized, identity } = sourceIdentity({ repoRoot, env, input });
  const sourceDigest = digest(identity);
  const sourceId = `deep_src_${sourceDigest.slice(0, 20)}`;
  const existing = deepIngestSourceGet({ repoRoot, env, sourceId }).source;
  if (existing) {
    if (
      normalized.sourceKind === "file" &&
      input.ownedUpload === true &&
      normalized.artifactPath &&
      normalized.artifactPath !== existing.artifactPath
    ) {
      removeDeepIngestOwnedUploadArtifact({
        repoRoot,
        env,
        artifactPath: normalized.artifactPath,
      });
    }
    return {
      created: false,
      reused: true,
      source: existing,
      request: {
        sourceId,
        sourceVersion: Number(existing.version || 1),
        sourceDigest,
        targetShape: existing.targetShape,
        sourceKind: existing.sourceKind,
      },
    };
  }

  const metadata = {
    sourceDigest,
    ...(normalized.url ? { url: normalized.url } : {}),
    ...(normalized.repoPath ? { repoPath: normalized.repoPath } : {}),
    ...(normalized.path ? { path: normalized.path, explicit: normalized.explicit === true } : {}),
    ...(normalized.fileName ? { fileName: normalized.fileName } : {}),
    ...(normalized.contentDigest ? { contentDigest: normalized.contentDigest } : {}),
    ...(input.ownedUpload === true ? { ownedUpload: true } : {}),
  };
  const sourceInput = {
    id: sourceId,
    version: 1,
    targetShape: normalized.targetShape,
    sourceKind: normalized.sourceKind,
    status: "scanning",
    label:
      String(normalized.label || "").trim() ||
      normalized.fileName ||
      normalized.url ||
      "Pasted notes",
    artifactPath: normalized.artifactPath || null,
    metadata,
    ...(normalized.text != null ? { text: normalized.text } : {}),
  };
  const previousLaneStates = deepIngestStateGet({ repoRoot, env }).laneStates;
  const source = deepIngestSourceCreate({ repoRoot, env, input: sourceInput }).source;
  return {
    created: true,
    reused: false,
    source,
    previousLaneStates: {
      source_coverage: previousLaneStates.source_coverage,
      open_gaps: previousLaneStates.open_gaps,
    },
    request: {
      sourceId,
      sourceVersion: 1,
      sourceDigest,
      targetShape: normalized.targetShape,
      sourceKind: normalized.sourceKind,
    },
  };
}

export function rollbackPreparedDeepIngestSourceScan({
  repoRoot,
  env = process.env,
  prepared,
} = {}) {
  if (!prepared?.created || !prepared.request?.sourceId) return false;
  const removed = deepIngestPreparedSourceRollback({
    repoRoot,
    env,
    sourceId: prepared.request.sourceId,
    sourceDigest: prepared.request.sourceDigest,
    previousLaneStates: prepared.previousLaneStates,
  });
  removeDeepIngestOwnedUploadArtifact({ repoRoot, env, artifactPath: removed.artifactPath });
  return removed.rolledBack;
}

function parsePreparedSourceRequest({ repoRoot, env, input }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw makeError("A prepared Deep Ingest source is required.");
  }
  const allowed = ["sourceId", "sourceVersion", "sourceDigest", "targetShape", "sourceKind"];
  const keys = Object.keys(input);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw makeError("A prepared Deep Ingest source identity is required.");
  }
  const sourceId = String(input.sourceId || "").trim();
  const sourceVersion = Number(input.sourceVersion);
  const sourceDigest = String(input.sourceDigest || "")
    .trim()
    .toLowerCase();
  const targetShape = proposalTargetShape(input.targetShape);
  const sourceKind = String(input.sourceKind || "").trim();
  if (!sourceId || !Number.isInteger(sourceVersion) || sourceVersion < 1) {
    throw makeError("A prepared Deep Ingest source identity is required.");
  }
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) {
    throw makeError("A prepared Deep Ingest source digest is required.");
  }
  const source = deepIngestSourceGet({ repoRoot, env, sourceId }).source;
  if (
    !source ||
    Number(source.version || 1) !== sourceVersion ||
    source.metadata?.sourceDigest !== sourceDigest ||
    source.targetShape !== targetShape ||
    source.sourceKind !== sourceKind
  ) {
    throw makeError(
      "The prepared Deep Ingest source no longer matches this work.",
      "VERSION_CONFLICT"
    );
  }
  return { sourceId, sourceVersion, sourceDigest, targetShape, sourceKind };
}

function sourceInputFromStored({ repoRoot, env, request }) {
  const state = deepIngestStateGet({ repoRoot, env });
  const source = state.sources.find((row) => row.id === request.sourceId);
  if (!source) throw makeError(`Deep ingest source not found: "${request.sourceId}"`, "NOT_FOUND");
  if (Number(source.version || 1) !== request.sourceVersion) {
    throw makeError("This Deep Ingest source changed before analysis started.", "VERSION_CONFLICT");
  }
  const metadata = source.metadata || {};
  const chunks = state.sourceChunks.filter((chunk) => chunk.sourceId === source.id);
  const base = { targetShape: request.targetShape, sourceKind: request.sourceKind };
  if (["paste", "text", "note", "recruiter_context", "job_context"].includes(request.sourceKind)) {
    return { ...base, text: chunks.map((chunk) => chunk.text).join("") };
  }
  if (["url", "linkedin", "portfolio", "project_link"].includes(request.sourceKind)) {
    return { ...base, url: metadata.url };
  }
  if (request.sourceKind === "file") {
    const path = ownedUploadAbsolutePath({ repoRoot, env, artifactPath: source.artifactPath });
    if (!path || !existsSync(path)) {
      throw makeError("The uploaded Deep Ingest source is no longer available.", "NOT_FOUND");
    }
    return {
      ...base,
      fileName: metadata.fileName || source.label,
      bytes: readFileSync(path),
      artifactPath: source.artifactPath,
    };
  }
  if (request.sourceKind === "repo") {
    return { ...base, repoPath: metadata.repoPath || null, url: metadata.url || null };
  }
  if (request.sourceKind === "local_path") {
    return { ...base, path: metadata.path, explicit: metadata.explicit === true };
  }
  throw makeError(`Unsupported Deep Ingest source kind: ${request.sourceKind}`);
}

function stableScannedResult({ request, storedSource, scanned }) {
  const chunks = (scanned.chunks || []).map((chunk, index) => ({
    ...chunk,
    id: `${request.sourceId}_chunk_${String(index + 1).padStart(3, "0")}`,
    sourceId: request.sourceId,
    index,
  }));
  const source = {
    ...scanned.source,
    id: request.sourceId,
    version: request.sourceVersion,
    targetShape: request.targetShape,
    sourceKind: request.sourceKind,
    artifactPath: scanned.source?.artifactPath || storedSource.artifactPath,
    metadata: {
      ...(storedSource.metadata || {}),
      ...(scanned.source?.metadata || {}),
    },
  };
  const proposal = scanned.proposal
    ? {
        ...scanned.proposal,
        id: `deep_scan_${request.sourceId}_v${request.sourceVersion}`,
        sourceId: request.sourceId,
        chunkIds: chunks.map((chunk) => chunk.id),
      }
    : null;
  return { ...scanned, source, chunks, proposal };
}

function proposalTargetShape(value) {
  const targetShape = String(value || "").trim();
  if (!DEEP_INGEST_TARGET_SHAPES.includes(targetShape)) {
    throw makeError(`targetShape must be one of ${DEEP_INGEST_TARGET_SHAPES.join(", ")}`);
  }
  return targetShape;
}

function proposalLane(row, targetShape) {
  const lane = String(row?.lane || "").trim();
  const lanes = {
    evidence: "evidence_claims",
    story: "story_bank",
    honesty: "honesty_boundaries",
    writing_voice: "writing_voice",
    role_signal: "role_signals",
    gap: "open_gaps",
  };
  if (lanes[lane]) return lanes[lane];
  return lane.endsWith("_claims") ||
    ["story_bank", "honesty_boundaries", "writing_voice", "role_signals", "open_gaps"].includes(
      lane
    )
    ? lane
    : laneForTargetShape(targetShape);
}

function defaultProposalExecutionPlan({ repoRoot, env }) {
  const route = resolveAIRoute(env, { repoRoot });
  const runtimeId = aiRuntimeIdForRoute(route);
  if (!runtimeId) return null;
  return resolveAIExecutionPlan({
    operation: "structured.extraction",
    runtimeId,
    preferences: loadAIPreferences({ repoRoot, env }),
  });
}

export function createDeepIngestAppOperationKinds({
  repoRoot,
  env = process.env,
  fetchImpl = fetch,
  scanSource = scanDeepIngestSource,
  proposalBuilders = DEFAULT_PROPOSAL_BUILDERS,
  resolveProposalExecutionPlan,
} = {}) {
  const pathCtx = { repoRoot, env };
  return {
    [DEEP_INGEST_SOURCE_SCAN_KIND]: {
      parseRequest(input) {
        return parsePreparedSourceRequest({ ...pathCtx, input });
      },
      async execute({ request, signal, reportProgress }) {
        await reportProgress({
          phase: "scanning",
          completed: 0,
          total: 2,
          message: "CareerRat is reading this source.",
        });
        signal.throwIfAborted();
        const input = sourceInputFromStored({ ...pathCtx, request });
        const scanned = await scanSource({ input, fetchImpl, signal });
        signal.throwIfAborted();
        await reportProgress({
          phase: "saving",
          completed: 1,
          total: 2,
          message: "CareerRat is saving what it found.",
        });
        const storedSource = deepIngestSourceGet({
          ...pathCtx,
          sourceId: request.sourceId,
        }).source;
        const stable = stableScannedResult({ request, storedSource, scanned });
        const persisted = deepIngestScannedSourcePersist({
          ...pathCtx,
          input: {
            id: request.sourceId,
            version: request.sourceVersion,
            targetShape: request.targetShape,
            sourceKind: request.sourceKind,
            status: stable.status,
            label: stable.source.label,
            artifactPath: stable.source.artifactPath,
            metadata: stable.source.metadata,
            textLength: stable.source.textLength || 0,
            textPreview: stable.chunks[0]?.text?.slice(0, 240) || null,
            chunks: stable.chunks,
          },
          proposalInput: stable.proposal
            ? {
                proposalId: stable.proposal.id,
                sourceVersion: request.sourceVersion,
                targetShape: request.targetShape,
                lane: stable.proposal.lane || laneForTargetShape(request.targetShape),
                proposal: stable.proposal,
              }
            : null,
        });
        return {
          resultRef: {
            type: "deep-ingest-source",
            id: request.sourceId,
            version: request.sourceVersion,
            status: persisted.source.status,
            proposalId: persisted.proposal?.id || null,
          },
        };
      },
    },
    [DEEP_INGEST_PROPOSAL_BUILD_KIND]: {
      parseRequest(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw makeError("Deep Ingest proposal input is required");
        }
        const keys = Object.keys(input);
        if (keys.some((key) => !["sourceId", "targetShape"].includes(key))) {
          throw makeError("Deep Ingest proposal work accepts only sourceId and targetShape.");
        }
        const sourceId = String(input.sourceId || "").trim();
        if (!sourceId) throw makeError("sourceId is required");
        const source = deepIngestSourceGet({ ...pathCtx, sourceId }).source;
        if (!source) throw makeError(`Deep ingest source not found: "${sourceId}"`, "NOT_FOUND");
        return {
          sourceId,
          sourceVersion: Number(source.version || 1),
          targetShape: proposalTargetShape(input.targetShape || source.targetShape),
        };
      },
      resolveExecutionPlan({ request }) {
        return resolveProposalExecutionPlan
          ? resolveProposalExecutionPlan({ request })
          : defaultProposalExecutionPlan(pathCtx);
      },
      async execute({ request, executionPlan, signal, reportProgress }) {
        const state = deepIngestStateGet(pathCtx);
        const source = state.sources.find((row) => row.id === request.sourceId);
        if (!source) {
          throw makeError(`Deep ingest source not found: "${request.sourceId}"`, "NOT_FOUND");
        }
        if (Number(source.version || 1) !== request.sourceVersion) {
          throw makeError(
            "This Deep Ingest source changed before proposals were saved.",
            "VERSION_CONFLICT"
          );
        }
        const builder =
          proposalBuilders[request.targetShape] || DEFAULT_PROPOSAL_BUILDERS[request.targetShape];
        if (typeof builder !== "function") {
          throw makeError(`No Deep Ingest proposal builder exists for ${request.targetShape}.`);
        }
        const sourceWithChunks = {
          ...source,
          chunks: state.sourceChunks.filter((chunk) => chunk.sourceId === source.id),
        };
        await reportProgress({
          phase: "extracting",
          completed: 0,
          total: 2,
          message: "CareerRat is finding useful details.",
        });
        signal.throwIfAborted();
        const built = await builder({
          source: sourceWithChunks,
          targetShape: request.targetShape,
          repoRoot,
          env,
          signal,
          executionPlan,
        });
        signal.throwIfAborted();
        const values = [
          ...(Array.isArray(built?.proposals) ? built.proposals : []),
          ...(Array.isArray(built?.gaps) ? built.gaps : []),
        ].filter((row) => row && typeof row === "object");
        if (!values.length) throw makeError("Proposal builder returned no reviewable rows.");
        await reportProgress({
          phase: "saving",
          completed: 1,
          total: 2,
          message: "CareerRat is preparing your review.",
        });
        const proposalSetId = deepIngestProposalSetId(request);
        const persisted = deepIngestProposalSetPut({
          ...pathCtx,
          sourceId: request.sourceId,
          sourceVersion: request.sourceVersion,
          targetShape: request.targetShape,
          proposalSetId,
          rows: values.map((proposal) => ({
            lane: proposalLane(proposal, request.targetShape),
            proposal,
          })),
        });
        return {
          resultRef: {
            type: "deep-ingest-proposal-set",
            id: proposalSetId,
            sourceId: request.sourceId,
            sourceVersion: request.sourceVersion,
            targetShape: request.targetShape,
            proposalIds: persisted.proposals.map((proposal) => proposal.id),
          },
        };
      },
    },
  };
}

export function withDeepIngestAppOperationKinds(existing = {}, options = {}) {
  const additions = createDeepIngestAppOperationKinds(options);
  if (existing instanceof Map) return new Map([...existing, ...Object.entries(additions)]);
  return { ...(existing || {}), ...additions };
}
