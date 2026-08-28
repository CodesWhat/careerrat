// discovery-route.mjs — supervised app orchestration for the post-onboarding
// discovery pipeline. This is deliberately not a hidden batch runner:
// research-boards is a visible validated-source chat. Company discovery stays on
// the app-owned proposal path, and search-jobs stops at sourced/review state.

import { WORKSPACE_THREAD_ID } from "../core/agent/workspace-thread.mjs";
import { DISCOVERY_PIPELINE, recordDiscoveryCompletion } from "../core/agent-guidance.mjs";
import { dbExists } from "../core/db/connection.mjs";
import {
  companyProposalBatchGet,
  companyProposalBatchLatest,
} from "../core/db/verbs/company-discovery.mjs";
import {
  candidateConfigGet,
  publicIntelReviewDecision,
  publicIntelReviewList,
  publicIntelStateGet,
  publicIntelSyncPreview,
  sourceConfigGet,
} from "../core/db/verbs.mjs";
import { companyDiscoveryCadenceState } from "../core/discovery/company-discovery-cadence.mjs";
import { startCompanyDiscoveryOperation } from "../core/discovery/company-operation.mjs";
import { applyCompanyProposalDecision } from "../core/discovery/company-proposal-decisions.mjs";
import { createCompanyProposalBatch } from "../core/discovery/company-proposals.mjs";
import { scanPublicIntelSeeds } from "../core/discovery/scanner-cascade.mjs";
import { buildSearchPromptContext } from "../core/search/search-prompts.mjs";
import { loadAgentGuidanceSnapshot } from "../core/tracker/agent-guidance-snapshot.mjs";
import { prepareQuickStartSourcing } from "./onboard-route.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

export const DISCOVERY_CHAT_SKILLS = [
  "research-boards",
  "research-company",
  "research-comp",
  "company-health",
];

const DISCOVERY_STEP_NOTES = {
  "research-boards":
    "Run research-boards, add deterministically validated public boards, and leave only ambiguous sources for review.",
  "research-company":
    "Run research-company for the requested company and compose a cited workspace/research/<slug>.md artifact.",
  "research-comp":
    "Run research-comp for the requested role and location and compose a cited workspace/research/comp-bench-*.md artifact.",
  "company-health":
    "Run company-health for the requested company, score a role-scoped rating, and persist it to the tracker.",
};

const COMPANY_PROPOSAL_BODY_MAX_BYTES = 1024 * 1024;
const PUBLIC_INTEL_BODY_MAX_BYTES = 1024 * 1024;

function readReadinessLocks({ repoRoot, env }) {
  const pathCtx = { repoRoot, env };
  if (!dbExists(pathCtx)) {
    return {
      readiness: null,
      missing: null,
      locks: { gateReady: false, applyReady: false },
    };
  }
  const setup = candidateConfigGet(pathCtx).setup || {};
  const readiness = setup.readiness || {};
  return {
    readiness,
    missing: setup.missing || {},
    locks: {
      gateReady: readiness.gate_ready === true,
      applyReady: readiness.apply_ready === true,
    },
  };
}

export function normalizeDiscoveryGuidance(guidance) {
  const nextSkill = String(guidance?.nextSkill || "").trim();
  if (!DISCOVERY_CHAT_SKILLS.includes(nextSkill)) return null;
  return {
    nextSkill,
    message: guidance?.message || `Ask your agent to run ${nextSkill} next.`,
    ctaLabel: guidance?.ctaLabel || `Run ${nextSkill}`,
  };
}

function normalizeFirstSearchGuidance(guidance) {
  if (String(guidance?.nextSkill || "").trim() !== "search-jobs") return null;
  return {
    nextSkill: "search-jobs",
    message: guidance?.message || "Discovery is complete. Run the first search next.",
    ctaLabel: guidance?.ctaLabel || "Run first search",
  };
}

export function findActiveDiscoveryChat(chatRuntime, skillFilter = null) {
  if (skillFilter) return chatRuntime.findBySkill(skillFilter) || null;
  for (const skill of DISCOVERY_CHAT_SKILLS) {
    const session = chatRuntime.findBySkill(skill);
    if (session) return session;
  }
  return null;
}

export function buildDiscoveryKickoff({
  skill,
  message,
  source = "Continue discovery",
  candidateContext,
} = {}) {
  return [
    source,
    `Current next discovery skill: ${skill}.`,
    message || "Continue the CareerRat discovery pipeline from the current workspace state.",
    candidateContext && Object.keys(candidateContext).length
      ? `Outbound-safe candidate context: ${JSON.stringify(candidateContext)}`
      : null,
    `Pipeline order: ${DISCOVERY_PIPELINE.join(" -> ")}.`,
    DISCOVERY_STEP_NOTES[skill] || "Run only the current discovery step.",
    "The user's explicit discovery request authorizes deterministically validated public source writes. Keep only ambiguous or unsupported sources reviewable.",
    "Do not run evaluate-job, tailor-application, apply-job, fill forms, or submit applications from this handoff.",
    "If gate/apply setup is incomplete, stop with sourced or review items queued instead of guessing.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildDiscoveryCandidateContext({
  candidateContext,
  sourceConfig,
  companyConfig,
} = {}) {
  const configuredSources = (Array.isArray(sourceConfig?.searches) ? sourceConfig.searches : [])
    .map((source) => {
      const entry = {};
      for (const key of ["label", "url", "rssUrl", "target", "provider", "source_type"]) {
        const value = String(source?.[key] ?? "").trim();
        if (value) entry[key] = value;
      }
      if (typeof source?.enabled === "boolean") entry.enabled = source.enabled;
      return Object.keys(entry).length ? entry : null;
    })
    .filter(Boolean);
  const configuredCompanies = (
    Array.isArray(companyConfig?.tracked_companies) ? companyConfig.tracked_companies : []
  )
    .map((company) => {
      const name = String(company?.name || "").trim();
      const url = String(company?.careers_url || company?.url || "").trim();
      return name && url ? { name, url } : null;
    })
    .filter(Boolean);
  return {
    ...(candidateContext && typeof candidateContext === "object" ? candidateContext : {}),
    configured_sources: configuredSources,
    configured_companies: configuredCompanies,
  };
}

function outboundCandidateContext({ repoRoot, env }) {
  try {
    const config = candidateConfigGet({ repoRoot, env });
    const sourceConfig = sourceConfigGet({ repoRoot, env, name: "search-sources" }).data;
    const companyConfig = sourceConfigGet({ repoRoot, env, name: "sourced-scan" }).data;
    const targeting = config.targeting || {};
    return buildDiscoveryCandidateContext({
      candidateContext: {
        ...buildSearchPromptContext({ repoRoot, env, config }),
        keep_signals: Array.isArray(targeting.keep_signals) ? targeting.keep_signals : [],
        cut_signals: Array.isArray(targeting.cut_signals) ? targeting.cut_signals : [],
        tracked_companies: Array.isArray(targeting.tracked_companies)
          ? targeting.tracked_companies
          : [],
      },
      sourceConfig,
      companyConfig,
    });
  } catch {
    return null;
  }
}

export async function startExplicitDiscoveryChat({
  repoRoot,
  env = process.env,
  chatRuntime,
  skill,
  request,
} = {}) {
  if (!DISCOVERY_CHAT_SKILLS.includes(skill)) {
    const error = new Error(`Unsupported discovery skill: ${skill || "missing"}`);
    error.code = "SKILL_NOT_ALLOWED";
    error.status = 400;
    throw error;
  }
  return startOrReuseDiscoveryChat({
    chatRuntime,
    guidance: {
      nextSkill: skill,
      message:
        String(request || "").trim() ||
        `Run ${skill} from the candidate's current workspace context.`,
      ctaLabel: `Run ${skill}`,
    },
    candidateContext: outboundCandidateContext({ repoRoot, env }),
    source: "The user started this discovery step from Ask.",
  });
}

function statusForStartError(err) {
  switch (err?.code) {
    case "SKILL_REQUIRED":
    case "SKILL_NOT_ALLOWED":
      return 400;
    case "NO_AI_ROUTE":
    case "SDK_NOT_INSTALLED":
      return 501;
    case "DUPLICATE_SESSION":
      return 409;
    case "MAX_SESSIONS":
      return 429;
    default:
      return 500;
  }
}

async function startOrReuseDiscoveryChat({ chatRuntime, guidance, source, candidateContext }) {
  const normalized = normalizeDiscoveryGuidance(guidance);
  if (!normalized) {
    return {
      chat: null,
      activeDiscoveryChat: null,
      locked: true,
      message: "No supervised discovery step is ready.",
    };
  }

  const active = findActiveDiscoveryChat(chatRuntime, normalized.nextSkill);
  if (active) {
    return {
      chat: { ...active, reused: true },
      activeDiscoveryChat: active,
      reused: true,
    };
  }

  try {
    const chat = await chatRuntime.startSession({
      skill: normalized.nextSkill,
      input: buildDiscoveryKickoff({
        skill: normalized.nextSkill,
        message: normalized.message,
        source,
        candidateContext,
      }),
    });
    return { chat, activeDiscoveryChat: chat, reused: false };
  } catch (err) {
    if (err?.code === "DUPLICATE_SESSION" && err.chatId) {
      const chat = {
        chatId: err.chatId,
        skill: normalized.nextSkill,
        state: "running",
        reused: true,
      };
      return { chat, activeDiscoveryChat: chat, reused: true };
    }
    err.status = statusForStartError(err);
    throw err;
  }
}

function quickStartGuidance(body, liveGuidance) {
  if (String(liveGuidance?.nextSkill || "").trim()) {
    return normalizeFirstSearchGuidance(liveGuidance) || normalizeDiscoveryGuidance(liveGuidance);
  }
  const preparedGuidance = {
    nextSkill: body?.nextSkill,
    message: body?.nextMessage,
    ctaLabel: body?.nextSkill ? `Run ${body.nextSkill}` : null,
  };
  return (
    normalizeFirstSearchGuidance(preparedGuidance) || normalizeDiscoveryGuidance(preparedGuidance)
  );
}

function locksFromPrepared(body) {
  return (
    body?.locks || {
      gateReady: body?.readiness?.gate_ready === true,
      applyReady: body?.readiness?.apply_ready === true,
    }
  );
}

function publicCompanyDiscoveryState(state) {
  if (!state || typeof state !== "object") return null;
  return Object.fromEntries(
    ["status", "due", "reason", "dueAt", "batchId", "pendingCount"]
      .filter((key) => state[key] !== undefined)
      .map((key) => [key, state[key]])
  );
}

function discoveryRouteError(res, err, fallbackCode) {
  const status = err.status || fallbackCode;
  sendJson(res, status, {
    ok: false,
    code: err.code || (status === 400 ? "BAD_REQUEST" : "COMPANY_DISCOVERY_FAILED"),
    error: { message: err.message },
  });
}

function publicIntelError(res, err, fallbackCode = 500) {
  const status = err.status || fallbackCode;
  sendJson(res, status, {
    ok: false,
    code: err.code || (status === 400 ? "BAD_REQUEST" : "PUBLIC_INTEL_FAILED"),
    error: { message: err.message },
  });
}

function publicIntelData(result, fallback = {}) {
  if (result?.data !== undefined) return result;
  if (result?.items !== undefined)
    return { ok: result.ok !== false, data: { items: result.items } };
  if (result?.preference !== undefined) {
    return { ok: result.ok !== false, data: { preference: result.preference } };
  }
  if (result?.item !== undefined) return { ok: result.ok !== false, data: { item: result.item } };
  return { ok: result?.ok !== false, data: fallback };
}

function defaultPublicIntelReviewDecision({ repoRoot, env, body, companyAtsUpsertImpl, now }) {
  return publicIntelReviewDecision({
    repoRoot,
    env,
    itemId: body?.itemId,
    expectedVersion: body?.expectedVersion,
    action: body?.action,
    patch: body?.patch || {},
    companyAtsUpsertImpl,
    now,
  });
}

export function mountDiscoveryRoutes({
  addRoute,
  repoRoot,
  env = process.env,
  chatRuntime,
  prepareQuickStart = prepareQuickStartSourcing,
  loadAgentGuidance = loadAgentGuidanceSnapshot,
  fetchImpl = fetch,
  resolveCompanyBoard,
  scanCompaniesImpl,
  gateProposal,
  seedCall,
  now,
  companyAtsUpsertImpl,
  sourcedUpsertBatchImpl,
  publicIntelStateGetImpl = publicIntelStateGet,
  publicIntelScanImpl = scanPublicIntelSeeds,
  publicIntelReviewListImpl = publicIntelReviewList,
  publicIntelReviewDecisionImpl = defaultPublicIntelReviewDecision,
  publicIntelSyncPreviewImpl = publicIntelSyncPreview,
  companyDiscoveryCadenceImpl = companyDiscoveryCadenceState,
  workspaceAgentRuntime,
  appOperations,
}) {
  addRoute("GET", "/api/discovery/public-intel/state", (_req, res) => {
    try {
      const result = publicIntelData(publicIntelStateGetImpl({ repoRoot, env }));
      sendJson(res, 200, { ok: result.ok !== false, data: result.data });
    } catch (err) {
      publicIntelError(res, err, err.code === "NO_DATABASE" ? 409 : 500);
    }
  });

  addRoute("POST", "/api/discovery/public-intel/scan", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, PUBLIC_INTEL_BODY_MAX_BYTES);
    } catch (err) {
      publicIntelError(res, err, err.status || 400);
      return;
    }

    try {
      const result = publicIntelData(
        await publicIntelScanImpl({
          repoRoot,
          env,
          body,
          fetchImpl,
          resolveCompanyBoard,
          now,
          companyAtsUpsertImpl,
        })
      );
      sendJson(res, 200, { ok: result.ok !== false, data: result.data });
    } catch (err) {
      publicIntelError(res, err, err.status || 500);
    }
  });

  addRoute("GET", "/api/discovery/public-intel/review", (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const status = url.searchParams.get("status") || "pending";
      const result = publicIntelData(publicIntelReviewListImpl({ repoRoot, env, status }));
      sendJson(res, 200, { ok: result.ok !== false, data: result.data });
    } catch (err) {
      publicIntelError(res, err, err.code === "NO_DATABASE" ? 409 : 500);
    }
  });

  addRoute("POST", "/api/discovery/public-intel/review-decisions", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, PUBLIC_INTEL_BODY_MAX_BYTES);
    } catch (err) {
      publicIntelError(res, err, err.status || 400);
      return;
    }

    try {
      const result = publicIntelData(
        await publicIntelReviewDecisionImpl({
          repoRoot,
          env,
          body,
          companyAtsUpsertImpl,
          now,
        })
      );
      sendJson(res, 200, { ok: result.ok !== false, data: result.data });
    } catch (err) {
      publicIntelError(res, err, err.status || 500);
    }
  });

  addRoute("GET", "/api/discovery/public-intel/sync-preview", (_req, res) => {
    try {
      const result = publicIntelData(publicIntelSyncPreviewImpl({ repoRoot, env }));
      sendJson(res, 200, { ok: result.ok !== false, data: result.data });
    } catch (err) {
      publicIntelError(res, err, err.code === "NO_DATABASE" ? 409 : 500);
    }
  });

  addRoute("POST", "/api/discovery/company-proposals", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
    } catch (err) {
      sendJson(res, err.status || 400, {
        ok: false,
        code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
        error: { message: err.message },
      });
      return;
    }

    try {
      const discoveryBody = body?.trigger
        ? body
        : { ...(body && typeof body === "object" ? body : {}), requestedByUser: true };
      if (appOperations) {
        const started = await startCompanyDiscoveryOperation({
          appOperations,
          input: discoveryBody,
        });
        const {
          request: _request,
          ownerId: _ownerId,
          fence: _fence,
          ...operation
        } = started.operation;
        const active = ["queued", "running"].includes(operation.status);
        sendJson(res, active ? 202 : 200, {
          ok: true,
          reused: started.reused,
          operation,
        });
        return;
      }
      const result = await createCompanyProposalBatch({
        repoRoot,
        env,
        body: discoveryBody,
        fetchImpl,
        resolveCompanyBoard,
        scanCompaniesImpl,
        seedCall,
        now,
        companyAtsUpsertImpl,
      });
      if (result.body) {
        sendJson(res, result.status || 500, result.body);
        return;
      }
      sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
    } catch (err) {
      sendJson(res, err.status || 500, {
        ok: false,
        code: err.code || "COMPANY_PROPOSAL_FAILED",
        error: { message: err.message },
      });
    }
  });

  addRoute("GET", "/api/discovery/company-proposals", (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const batchId = String(url.searchParams.get("id") || "").trim();
      const statusParam = String(url.searchParams.get("status") || "pending").trim();
      const status = statusParam === "all" ? null : statusParam || "pending";
      const result = batchId
        ? companyProposalBatchGet({ repoRoot, env, batchId })
        : companyProposalBatchLatest({ repoRoot, env, status });
      sendJson(res, 200, {
        ok: true,
        data: { batch: result.batch },
        meta: { ...(batchId ? { batchId } : { status }), found: Boolean(result.batch) },
      });
    } catch (err) {
      discoveryRouteError(res, err, err.code === "NO_DATABASE" ? 409 : 500);
    }
  });

  addRoute("POST", "/api/discovery/company-proposal-decisions", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
    } catch (err) {
      discoveryRouteError(res, err, err.status || 400);
      return;
    }

    try {
      const result = await applyCompanyProposalDecision({
        repoRoot,
        env,
        body,
        fetchImpl,
        resolveCompanyBoard,
        scanCompaniesImpl,
        gateProposal,
        now,
        companyAtsUpsertImpl,
        sourcedUpsertBatchImpl,
      });
      sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
    } catch (err) {
      discoveryRouteError(res, err, err.status || 500);
    }
  });

  addRoute("GET", "/api/discovery/state", (_req, res) => {
    let locks = { readiness: null, missing: null, locks: { gateReady: false, applyReady: false } };
    let companyDiscovery = null;
    try {
      locks = readReadinessLocks({ repoRoot, env });
    } catch {
      // Discovery state is a UI affordance; no-DB and corrupt setup degrade to
      // locks rather than making the whole app page fail.
    }
    try {
      companyDiscovery = publicCompanyDiscoveryState(
        companyDiscoveryCadenceImpl({ repoRoot, env, now: typeof now === "function" ? now() : now })
      );
    } catch {
      // A missing or incomplete DB cannot block the rest of discovery state.
    }
    const guidance = normalizeDiscoveryGuidance(loadAgentGuidance({ root: repoRoot, env }));
    const activeDiscoveryChat = findActiveDiscoveryChat(chatRuntime);
    sendJson(res, 200, {
      ok: true,
      pipeline: DISCOVERY_PIPELINE,
      guidance,
      activeDiscoveryChat,
      companyDiscovery,
      ...locks,
    });
  });

  addRoute("POST", "/api/discovery/complete", async (req, res) => {
    try {
      const body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
      const step = String(body?.step || "").trim();
      const completion = recordDiscoveryCompletion({
        root: repoRoot,
        env,
        step,
      });
      if (!completion.ok) {
        sendJson(res, 400, completion);
        return;
      }
      if (
        step === "research-boards" &&
        typeof workspaceAgentRuntime?.executeIntent === "function"
      ) {
        await workspaceAgentRuntime.executeIntent({
          intent: {
            type: "company.discover",
            entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
            input: {
              request: "Continue post-onboarding discovery from validated job boards.",
            },
          },
        });
      }
      sendJson(res, 200, { ok: true, completion });
    } catch (err) {
      discoveryRouteError(res, err, err.status || 400);
    }
  });

  addRoute("POST", "/api/discovery/quick-start", async (_req, res) => {
    const prepared = prepareQuickStart({ repoRoot, env });
    if (prepared.status !== 200) {
      sendJson(res, prepared.status, prepared.body);
      return;
    }

    const guidance = quickStartGuidance(prepared.body, loadAgentGuidance({ root: repoRoot, env }));
    if (guidance?.nextSkill === "search-jobs") {
      sendJson(res, 200, {
        ...prepared.body,
        locks: locksFromPrepared(prepared.body),
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        readyForFirstSearch: true,
        chat: null,
        activeDiscoveryChat: findActiveDiscoveryChat(chatRuntime),
      });
      return;
    }
    try {
      const handoff = await startOrReuseDiscoveryChat({
        chatRuntime,
        guidance,
        candidateContext: outboundCandidateContext({ repoRoot, env }),
        source: [
          "Quick Start prepared source config from DB-backed onboarding.",
          prepared.body.nextMessage,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      sendJson(res, 200, {
        ...prepared.body,
        locks: locksFromPrepared(prepared.body),
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        ...handoff,
      });
    } catch (err) {
      if ((err.status || 500) === 501) {
        sendJson(res, 501, { ok: false, error: err.message });
        return;
      }
      sendJson(res, 200, {
        ...prepared.body,
        locks: locksFromPrepared(prepared.body),
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        chat: null,
        activeDiscoveryChat: null,
        chatError: err.message,
      });
    }
  });

  addRoute("POST", "/api/discovery/next", async (_req, res) => {
    const rawGuidance = loadAgentGuidance({ root: repoRoot, env });
    const firstSearchGuidance = normalizeFirstSearchGuidance(rawGuidance);
    if (firstSearchGuidance) {
      sendJson(res, 200, {
        ok: true,
        pipeline: DISCOVERY_PIPELINE,
        guidance: firstSearchGuidance,
        readyForFirstSearch: true,
        chat: null,
        activeDiscoveryChat: findActiveDiscoveryChat(chatRuntime),
      });
      return;
    }
    const guidance = normalizeDiscoveryGuidance(rawGuidance);
    if (!guidance) {
      sendJson(res, 200, {
        ok: true,
        locked: true,
        pipeline: DISCOVERY_PIPELINE,
        guidance: rawGuidance || null,
        chat: null,
        activeDiscoveryChat: findActiveDiscoveryChat(chatRuntime),
      });
      return;
    }

    try {
      const handoff = await startOrReuseDiscoveryChat({
        chatRuntime,
        guidance,
        candidateContext: outboundCandidateContext({ repoRoot, env }),
        source: "Continue discovery from the app.",
      });
      sendJson(res, 200, {
        ok: true,
        pipeline: DISCOVERY_PIPELINE,
        guidance,
        ...handoff,
      });
    } catch (err) {
      sendJson(res, err.status || 500, { ok: false, error: err.message });
    }
  });
}
