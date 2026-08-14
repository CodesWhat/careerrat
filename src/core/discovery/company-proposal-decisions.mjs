import {
  companyProposalBatchGet,
  companyProposalBatchPatchState,
} from "../db/verbs/company-discovery.mjs";
import { companyAtsUpsert as defaultCompanyAtsUpsert } from "../db/verbs/source-config.mjs";
import { offersWithCapturedJobs as defaultOffersWithCapturedJobs } from "../scoring/sourced-persistence.mjs";
import { scanCompanies as defaultScanCompanies } from "../scoring/sourced-scanner.mjs";
import {
  resolveCompanyBoard as defaultResolveCompanyBoard,
  REFRESH_REASONS,
} from "./company-board-resolver.mjs";
import { buildCompanySeedContext as defaultBuildSeedContext } from "./company-context.mjs";
import { buildCompanyProposal as defaultGateProposal } from "./company-proposal-gate.mjs";

const DECISION_ACTIONS = new Set([
  "approve-supported-ats",
  "reject",
  "suppress",
  "refresh",
  "escalate",
]);

const FINAL_ACTIONS = new Set(["approve-supported-ats", "reject", "suppress", "escalate"]);

function makeError(message, { code = "VALIDATION_FAILED", status = 422 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function nowDate(now) {
  if (typeof now === "function") return nowDate(now());
  if (now instanceof Date) return now;
  if (typeof now === "string" || typeof now === "number") return new Date(now);
  return new Date();
}

function nowIso(now) {
  return nowDate(now).toISOString();
}

function requireText(value, field) {
  const text = String(value || "").trim();
  if (!text) {
    throw makeError(`company proposal decision requires ${field}`, {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  return text;
}

function normalizeExpectedVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw makeError("company proposal decision requires expectedVersion", {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  return version;
}

function normalizeDecisionBody(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw makeError("company proposal decision body must be an object", {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  const action = requireText(body.action, "action");
  if (!DECISION_ACTIONS.has(action)) {
    throw makeError(`unsupported company proposal decision action: ${action}`, {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  return {
    batchId: requireText(body.batchId || body.batch_id, "batchId"),
    proposalId: requireText(body.proposalId || body.proposal_id, "proposalId"),
    action,
    expectedVersion: normalizeExpectedVersion(body.expectedVersion ?? body.expected_version),
    reason: String(body.reason || "").trim(),
    note: String(body.note || "").trim(),
    // userConfirmed marks an explicit user keep/approve (e.g. onboarding's
    // Companies step Save & Next) rather than an unattended auto-gate
    // approval. It is the review the confirm-first gate exists to require,
    // so it relaxes the confidence-tier/proposedAction bar in
    // assertApprovalAllowed below — it never bypasses classification or
    // pending-state checks.
    userConfirmed: body.userConfirmed === true || body.user_confirmed === true,
  };
}

function loadBatch({ repoRoot, env, batchId }) {
  const batch = companyProposalBatchGet({ repoRoot, env, batchId }).batch;
  if (!batch) {
    throw makeError(`company proposal batch not found: ${batchId}`, {
      code: "CONFLICT",
      status: 409,
    });
  }
  return batch;
}

function findProposal(batch, proposalId) {
  const proposalIndex = list(batch.proposals).findIndex(
    (proposal) => proposal?.proposalId === proposalId
  );
  if (proposalIndex !== -1) {
    return {
      proposal: batch.proposals[proposalIndex],
      proposalIndex,
      collection: "proposals",
    };
  }

  const rejectedIndex = list(batch.rejected).findIndex(
    (proposal) => proposal?.proposalId === proposalId
  );
  if (rejectedIndex !== -1) {
    return {
      proposal: batch.rejected[rejectedIndex],
      proposalIndex: rejectedIndex,
      collection: "rejected",
    };
  }

  throw makeError(`company proposal not found: ${proposalId}`, {
    code: "CONFLICT",
    status: 409,
  });
}

function assertPendingProposal({ proposal, collection, expectedVersion, action }) {
  const currentVersion = Number(proposal?.version || 0);
  if (currentVersion !== expectedVersion) {
    throw makeError(
      `company proposal version conflict: expected ${expectedVersion}, found ${currentVersion}`,
      {
        code: "CONFLICT",
        status: 409,
      }
    );
  }
  if (collection === "rejected") {
    if (action === "approve-supported-ats") {
      throw makeError("cannot approve a rejected company proposal", {
        code: "VALIDATION_FAILED",
        status: 422,
      });
    }
    throw makeError("company proposal is already decided", {
      code: "CONFLICT",
      status: 409,
    });
  }
  if (proposal?.decision && FINAL_ACTIONS.has(proposal.decision.action)) {
    throw makeError("company proposal is already decided", {
      code: "CONFLICT",
      status: 409,
    });
  }
}

function assertApprovalAllowed(proposal, { userConfirmed = false } = {}) {
  const hasBoard =
    Boolean(String(proposal?.jobBoardUrl || "").trim()) &&
    Boolean(String(proposal?.atsProvider || "").trim());
  const isSupportedAts = proposal?.classification === "supported_ats";

  // An explicit user keep/approve (userConfirmed) IS the review the
  // confirm-first gate exists to require, so it can approve a borderline or
  // review-tier proposal without waiting on the auto-gate's confidence bar.
  // It still refuses unsupported_public proposals and anything without a
  // resolved board to approve into.
  if (userConfirmed) {
    if (isSupportedAts && hasBoard) return;
    throw makeError("only pending supported ATS proposals can be approved", {
      code: "VALIDATION_FAILED",
      status: 422,
    });
  }

  const supported =
    isSupportedAts &&
    proposal?.confidenceTier === "high-confidence" &&
    proposal?.proposedAction === "approve-supported-ats" &&
    hasBoard;
  if (!supported) {
    throw makeError("only pending high-confidence supported ATS proposals can be approved", {
      code: "VALIDATION_FAILED",
      status: 422,
    });
  }
}

function decisionRecord({ request, status, now, extra = {} }) {
  return {
    action: request.action,
    status,
    decidedAt: nowIso(now),
    ...(request.reason ? { reason: request.reason } : {}),
    ...(request.note ? { note: request.note } : {}),
    ...extra,
  };
}

function patchBatch({
  repoRoot,
  env,
  batch,
  status,
  proposals,
  rejected,
  decision,
  extraPatch = {},
}) {
  const nextProposals = list(proposals);
  const nextRejected = list(rejected);
  return companyProposalBatchPatchState({
    repoRoot,
    env,
    batchId: batch.batchId,
    expectedVersion: Number(batch.version || 0),
    status,
    patch: {
      proposals: nextProposals,
      rejected: nextRejected,
      counts: {
        ...(batch.counts || {}),
        proposals: nextProposals.length,
        rejected: nextRejected.length,
      },
      decisions: [...list(batch.decisions), decision],
      ...extraPatch,
    },
  });
}

function replaceProposal(proposals, proposalIndex, nextProposal) {
  return list(proposals).map((proposal, index) =>
    index === proposalIndex ? nextProposal : proposal
  );
}

function removeProposal(proposals, proposalIndex) {
  return list(proposals).filter((_proposal, index) => index !== proposalIndex);
}

function finalStatusForAction(action, remainingProposals) {
  if (remainingProposals.some((proposal) => !proposal?.decision)) return "pending";
  if (action === "approve-supported-ats") return "approved";
  if (action === "reject") return "rejected";
  if (action === "suppress") return "suppressed";
  if (action === "escalate") return "escalated";
  return "pending";
}

function sourceConfigSummary(result) {
  if (!result) return null;
  return {
    status: result.status,
    entry: result.entry,
    total: result.total,
  };
}

function seedFromProposal(proposal) {
  return {
    name: proposal?.company?.name || "",
    domain_hint:
      proposal?.jobBoardUrl ||
      proposal?.careersUrl ||
      proposal?.company?.domain ||
      proposal?.companyDomain ||
      "",
    why: proposal?.why || "Refresh this company proposal.",
    role_family_hint: proposal?.roleFamily || "",
    confidence: proposal?.confidenceTier === "high-confidence" ? "high" : "medium",
    source_hint: "proposal-refresh",
  };
}

function scanConfigFromResolution({ proposal, resolution }) {
  return {
    tracked_companies: [
      {
        name: resolution?.companyName || proposal?.company?.name || "",
        careers_url: resolution?.jobBoardUrl || resolution?.careersUrl || "",
        provider: resolution?.atsProvider || undefined,
        api: resolution?.apiUrl || undefined,
      },
    ],
  };
}

function hasRequiredOfferFields(offer) {
  return Boolean(offer?.company && offer?.title && offer?.url);
}

function offerBodyChars(offer) {
  const text = String(offer?.bodyText || offer?.description || offer?.rawText || "");
  return text.length;
}

function capturedOffersForRefresh({
  repoRoot,
  env,
  offers,
  existingCapturedOffers,
  offersWithCapturedJobs,
  savedAt,
}) {
  const existingByUrl = new Map(
    list(existingCapturedOffers)
      .filter((offer) => offer?.url && offer?.artifacts?.jd)
      .map((offer) => [offer.url, offer])
  );
  const captured = [];
  const toCapture = [];
  for (const offer of list(offers).filter(hasRequiredOfferFields)) {
    const existing = existingByUrl.get(offer.url);
    if (existing) {
      captured.push({
        ...offer,
        bodyText: offer.bodyText || existing.bodyText,
        bodyChars: Number.isFinite(Number(offer.bodyChars))
          ? Number(offer.bodyChars)
          : Number(existing.bodyChars || offerBodyChars(offer)),
        artifacts: { ...(offer.artifacts || {}), ...(existing.artifacts || {}) },
      });
    } else {
      toCapture.push(offer);
    }
  }
  return [
    ...captured,
    ...offersWithCapturedJobs({
      repoRoot,
      env,
      offers: toCapture,
      savedAt,
    }),
  ];
}

async function applyApproval({
  repoRoot,
  env,
  batch,
  request,
  proposal,
  proposalIndex,
  now,
  companyAtsUpsertImpl,
}) {
  const userConfirmed = request.userConfirmed === true;
  assertApprovalAllowed(proposal, { userConfirmed });
  const sourceConfig = companyAtsUpsertImpl({
    repoRoot,
    env,
    entry: {
      name: proposal.company?.name,
      careers_url: proposal.jobBoardUrl,
    },
  });
  // Approval means “track this company board”. The first-search pipeline owns
  // job publication so every offer passes the candidate's deterministic gates.
  // Publishing proposal scan samples here bypassed those gates and flooded Jobs.
  const sourced = { created: 0, updated: 0, rows: 0 };
  const decision = decisionRecord({
    request,
    status: "approved",
    now,
    extra: {
      decidedBy: userConfirmed ? "user-confirmed" : "auto-gate",
      sourceConfig: sourceConfigSummary(sourceConfig),
      sourced,
    },
  });
  const nextProposal = {
    ...clone(proposal),
    version: Number(proposal.version || 0) + 1,
    decision,
  };
  const proposals = replaceProposal(batch.proposals, proposalIndex, nextProposal);
  const patched = patchBatch({
    repoRoot,
    env,
    batch,
    status: finalStatusForAction(request.action, proposals),
    proposals,
    rejected: batch.rejected,
    decision,
  });
  return {
    data: {
      decision,
      proposal: nextProposal,
      sourceConfig: sourceConfigSummary(sourceConfig),
      sourced,
    },
    meta: { version: patched.batch.version },
  };
}

function applySimpleDecision({ repoRoot, env, batch, request, proposal, proposalIndex, now }) {
  const statusByAction = {
    reject: "rejected",
    suppress: "suppressed",
    escalate: "escalated",
  };
  const decision = decisionRecord({
    request,
    status: statusByAction[request.action],
    now,
  });
  const nextProposal = {
    ...clone(proposal),
    version: Number(proposal.version || 0) + 1,
    decision,
  };
  const proposals = replaceProposal(batch.proposals, proposalIndex, nextProposal);
  const patched = patchBatch({
    repoRoot,
    env,
    batch,
    status: finalStatusForAction(request.action, proposals),
    proposals,
    rejected: batch.rejected,
    decision,
  });
  return {
    data: {
      decision,
      proposal: nextProposal,
    },
    meta: { version: patched.batch.version },
  };
}

async function applyRefresh({
  repoRoot,
  env,
  batch,
  request,
  proposal,
  proposalIndex,
  now,
  fetchImpl,
  resolveCompanyBoard,
  scanCompaniesImpl,
  gateProposal,
  offersWithCapturedJobs,
  buildSeedContext,
}) {
  const savedAt = nowDate(now);
  const seed = seedFromProposal(proposal);
  const resolution = await resolveCompanyBoard({
    repoRoot,
    env,
    seed,
    fetchImpl,
    forceRefresh: true,
    refreshReason: REFRESH_REASONS.EXPLICIT_REFRESH,
    now: savedAt,
  });
  const canScan = Boolean(resolution?.atsProvider && resolution?.jobBoardUrl);
  const rawScanResult = canScan
    ? await scanCompaniesImpl(scanConfigFromResolution({ proposal, resolution }), { fetchImpl })
    : { offers: [], errors: [] };
  const capturedOffers = capturedOffersForRefresh({
    repoRoot,
    env,
    offers: rawScanResult.offers,
    existingCapturedOffers: proposal.capturedOffers,
    offersWithCapturedJobs,
    savedAt,
  });
  const nextVersion = Number(proposal.version || 0) + 1;
  const context = buildSeedContext({ repoRoot, env });
  const gated = gateProposal({
    seed,
    resolution,
    scanResult: { ...rawScanResult, offers: capturedOffers },
    context,
    capturedOffers,
    proposalId: proposal.proposalId,
    version: nextVersion,
  });
  const decision = decisionRecord({
    request,
    status: gated?.proposal ? "refreshed" : "rejected",
    now,
    extra: {
      refreshReason: REFRESH_REASONS.EXPLICIT_REFRESH,
    },
  });

  if (gated?.proposal) {
    const proposals = replaceProposal(batch.proposals, proposalIndex, gated.proposal);
    const patched = patchBatch({
      repoRoot,
      env,
      batch,
      status: "pending",
      proposals,
      rejected: batch.rejected,
      decision,
    });
    return {
      data: {
        decision,
        refreshedProposal: gated.proposal,
        rejected: null,
      },
      meta: { version: patched.batch.version },
    };
  }

  const rejected = {
    ...(gated?.rejected || {
      proposalId: proposal.proposalId,
      company: proposal.company,
      classification: "rejected",
      confidenceTier: "rejected",
      rejectReasons: ["refresh-rejected"],
    }),
    version: nextVersion,
  };
  const proposals = removeProposal(batch.proposals, proposalIndex);
  const rejectedList = [...list(batch.rejected), rejected];
  const patched = patchBatch({
    repoRoot,
    env,
    batch,
    status: proposals.length ? "pending" : "rejected",
    proposals,
    rejected: rejectedList,
    decision,
  });
  return {
    data: {
      decision,
      refreshedProposal: null,
      rejected,
    },
    meta: { version: patched.batch.version },
  };
}

export async function applyCompanyProposalDecision({
  repoRoot,
  env = process.env,
  body = {},
  now = new Date(),
  fetchImpl = fetch,
  resolveCompanyBoard = defaultResolveCompanyBoard,
  scanCompaniesImpl = defaultScanCompanies,
  gateProposal = defaultGateProposal,
  buildSeedContext = defaultBuildSeedContext,
  companyAtsUpsertImpl = defaultCompanyAtsUpsert,
  offersWithCapturedJobs = defaultOffersWithCapturedJobs,
} = {}) {
  const request = normalizeDecisionBody(body);
  const batch = loadBatch({ repoRoot, env, batchId: request.batchId });
  const found = findProposal(batch, request.proposalId);
  assertPendingProposal({
    proposal: found.proposal,
    collection: found.collection,
    expectedVersion: request.expectedVersion,
    action: request.action,
  });

  if (request.action === "approve-supported-ats") {
    return applyApproval({
      repoRoot,
      env,
      batch,
      request,
      proposal: found.proposal,
      proposalIndex: found.proposalIndex,
      now,
      companyAtsUpsertImpl,
    });
  }

  if (request.action === "refresh") {
    return applyRefresh({
      repoRoot,
      env,
      batch,
      request,
      proposal: found.proposal,
      proposalIndex: found.proposalIndex,
      now,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      gateProposal,
      offersWithCapturedJobs,
      buildSeedContext,
    });
  }

  return applySimpleDecision({
    repoRoot,
    env,
    batch,
    request,
    proposal: found.proposal,
    proposalIndex: found.proposalIndex,
    now,
  });
}
