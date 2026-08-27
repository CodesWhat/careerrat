import { createHash } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { loadAIPreferences } from "../ai/ai-preferences.mjs";
import { callAI, resolveAIRoute } from "../ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../ai/operation-policy.mjs";
import { companyProposalBatchGet } from "../db/verbs/company-discovery.mjs";
import { COMPANY_DISCOVERY_BATCH_MAX } from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";
import { companyDiscoveryFingerprint } from "./company-discovery-cadence.mjs";
import { createCompanyProposalBatch } from "./company-proposals.mjs";
import { normalizeManualCompanySeeds } from "./company-seeds.mjs";

export const COMPANY_DISCOVERY_OPERATION_KIND = "company.discovery";

const COMPANY_CONTEXT_MAX_BYTES = 1_048_576;
const COMPANY_CONTEXT_SNAPSHOT_MAX_BYTES = 36_000;

function makeError(message, code = "COMPANY_DISCOVERY_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestedCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return COMPANY_DISCOVERY_BATCH_MAX;
  return Math.max(1, Math.min(parsed, COMPANY_DISCOVERY_BATCH_MAX));
}

function manualSeedInput(input = {}) {
  const seeds = input.manualSeeds || input.manual_seeds || input.companies || input.seeds || [];
  if (!Array.isArray(seeds)) throw makeError("manualSeeds must be an array", "VALIDATION_FAILED");
  return seeds.slice(0, COMPANY_DISCOVERY_BATCH_MAX);
}

function discoveryTrigger(input = {}) {
  const kind = String(input.trigger?.kind || "").trim();
  const id = String(input.trigger?.id || "").trim();
  return kind === "search-run" && id ? { kind, id: id.slice(0, 160) } : null;
}

function capManualSeed(seed) {
  return {
    ...seed,
    name: seed.name.slice(0, 200),
    domain_hint: seed.domain_hint.slice(0, 500),
    why: seed.why.slice(0, 500),
    role_family_hint: seed.role_family_hint.slice(0, 200),
    source_hint: seed.source_hint.slice(0, 200),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, stableValue(value[key])])
  );
}

function contextDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeCompanyDiscoveryContext(context = {}) {
  const serialized = JSON.stringify(stableValue(context));
  if (Buffer.byteLength(serialized, "utf8") > COMPANY_CONTEXT_MAX_BYTES) {
    throw makeError(
      "CareerRat has too much saved search history to start company discovery safely.",
      "COMPANY_DISCOVERY_CONTEXT_TOO_LARGE"
    );
  }
  const contextSnapshot = brotliCompressSync(Buffer.from(serialized, "utf8")).toString("base64");
  if (Buffer.byteLength(contextSnapshot, "utf8") > COMPANY_CONTEXT_SNAPSHOT_MAX_BYTES) {
    throw makeError(
      "CareerRat has too much saved search history to start company discovery safely.",
      "COMPANY_DISCOVERY_CONTEXT_TOO_LARGE"
    );
  }
  return { contextSnapshot, contextDigest: contextDigest(serialized) };
}

export function decodeCompanyDiscoveryContext(request = {}) {
  const snapshot = String(request.contextSnapshot || "").trim();
  const expectedDigest = String(request.contextDigest || "").trim();
  if (!snapshot || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw makeError("company discovery context is missing", "APP_OPERATION_REQUEST_INVALID");
  }
  try {
    const serialized = brotliDecompressSync(Buffer.from(snapshot, "base64"), {
      maxOutputLength: COMPANY_CONTEXT_MAX_BYTES,
    }).toString("utf8");
    if (contextDigest(serialized) !== expectedDigest) {
      throw makeError("company discovery context changed", "APP_OPERATION_REQUEST_INVALID");
    }
    const context = JSON.parse(serialized);
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw makeError("company discovery context is invalid", "APP_OPERATION_REQUEST_INVALID");
    }
    return context;
  } catch (error) {
    if (error?.code === "APP_OPERATION_REQUEST_INVALID") throw error;
    throw makeError("company discovery context is invalid", "APP_OPERATION_REQUEST_INVALID");
  }
}

export function parseCompanyDiscoveryOperationRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw makeError("company discovery input must be an object", "BAD_REQUEST");
  }
  const manualSeeds = normalizeManualCompanySeeds(manualSeedInput(input)).map(capManualSeed);
  const request = String(input.discoveryRequest || input.discovery_request || input.request || "")
    .trim()
    .slice(0, 500);
  const trigger = discoveryTrigger(input);
  return {
    manualSeeds,
    requestedCount: requestedCount(input.requestedCount || input.requested_count),
    ...(request ? { discoveryRequest: request } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

export function resolveCompanyDiscoveryExecutionPlan({ repoRoot, env = process.env } = {}) {
  const route = resolveAIRoute(env, { repoRoot });
  const runtimeId = aiRuntimeIdForRoute(route);
  if (!runtimeId) return null;
  return resolveAIExecutionPlan({
    operation: "research.web",
    runtimeId,
    preferences: loadAIPreferences({ repoRoot, env }),
  });
}

export function companyDiscoveryResultRef(batchId) {
  const id = String(batchId || "").trim();
  if (!id) throw makeError("company discovery did not create a proposal batch");
  return { type: "company-proposal-batch", id };
}

export function companyDiscoveryBatchId(requestDigest) {
  const digest = String(requestDigest || "").trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw makeError("company discovery request digest is invalid", "APP_OPERATION_REQUEST_INVALID");
  }
  return `cpb_${digest.slice(0, 12)}`;
}

export function createCompanyDiscoveryOperationKind({
  repoRoot,
  env = process.env,
  createBatch = createCompanyProposalBatch,
  resolveExecutionPlan = () => resolveCompanyDiscoveryExecutionPlan({ repoRoot, env }),
  buildSeedContext = buildCompanySeedContext,
  fetchImpl,
  resolveCompanyBoard,
  scanCompaniesImpl,
  seedCall,
  now,
} = {}) {
  return {
    parseRequest(input) {
      const context = buildSeedContext({ repoRoot, env });
      return {
        ...parseCompanyDiscoveryOperationRequest(input),
        contextFingerprint: companyDiscoveryFingerprint(context),
        ...encodeCompanyDiscoveryContext(context),
      };
    },
    resolveExecutionPlan,
    async execute({ operation, request, executionPlan, signal, reportProgress }) {
      const seedContext = decodeCompanyDiscoveryContext(request);
      const batchId = companyDiscoveryBatchId(operation.requestDigest);
      const existingBatch = companyProposalBatchGet({ repoRoot, env, batchId }).batch;
      if (existingBatch) return { resultRef: companyDiscoveryResultRef(batchId) };
      const operationSeedCall =
        seedCall ||
        ((options) =>
          callAI({
            ...options,
            useExecutionPlanRoute: Boolean(executionPlan),
          }));
      await reportProgress({
        phase: "starting",
        completed: 0,
        total: request.requestedCount,
        message: "CareerRat is finding companies that fit your search.",
      });
      const result = await createBatch({
        repoRoot,
        env,
        body: request,
        batchId,
        seedContext,
        executionPlan,
        signal,
        reportProgress,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(resolveCompanyBoard ? { resolveCompanyBoard } : {}),
        ...(scanCompaniesImpl ? { scanCompaniesImpl } : {}),
        seedCall: operationSeedCall,
        ...(now ? { now } : {}),
      });
      if (result?.body?.ok === false) {
        throw makeError(
          result.body.error?.message || "CareerRat couldn't find company suggestions. Try again.",
          result.body.code || "COMPANY_DISCOVERY_FAILED"
        );
      }
      return { resultRef: companyDiscoveryResultRef(result?.data?.batchId) };
    },
  };
}

// Workspace Ask uses this exact hook instead of constructing a second company
// discovery path. The manager owns dedupe, retries, cancellation, and the
// frozen provider route before any company work starts.
export function startCompanyDiscoveryOperation({ appOperations, input = {} } = {}) {
  if (!appOperations || typeof appOperations.start !== "function") {
    throw makeError(
      "company discovery operation manager is unavailable",
      "APP_OPERATION_UNAVAILABLE"
    );
  }
  return Promise.resolve(
    appOperations.start({ kind: COMPANY_DISCOVERY_OPERATION_KIND, input })
  ).then((started) => {
    const requestDigest = String(started?.operation?.requestDigest || "").trim();
    return {
      ...started,
      ...(requestDigest ? { batchId: companyDiscoveryBatchId(requestDigest) } : {}),
    };
  });
}
