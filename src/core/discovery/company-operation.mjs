import { loadAIPreferences } from "../ai/ai-preferences.mjs";
import { resolveAIRoute } from "../ai/call-ai.mjs";
import { aiRuntimeIdForRoute, resolveAIExecutionPlan } from "../ai/operation-policy.mjs";
import { COMPANY_DISCOVERY_BATCH_MAX } from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";
import { companyDiscoveryFingerprint } from "./company-discovery-cadence.mjs";
import { createCompanyProposalBatch } from "./company-proposals.mjs";
import { normalizeManualCompanySeeds } from "./company-seeds.mjs";

export const COMPANY_DISCOVERY_OPERATION_KIND = "company.discovery";

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
      };
    },
    resolveExecutionPlan,
    async execute({ request, executionPlan, signal, reportProgress }) {
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
        executionPlan,
        signal,
        reportProgress,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(resolveCompanyBoard ? { resolveCompanyBoard } : {}),
        ...(scanCompaniesImpl ? { scanCompaniesImpl } : {}),
        ...(seedCall ? { seedCall } : {}),
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
  return appOperations.start({ kind: COMPANY_DISCOVERY_OPERATION_KIND, input });
}
