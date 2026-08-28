import { createHash } from "node:crypto";
import {
  companyBoardResolutionUpsert,
  companyProposalBatchPut,
} from "../db/verbs/company-discovery.mjs";
import { companyAtsUpsert as defaultCompanyAtsUpsert } from "../db/verbs/source-config.mjs";
import { offersWithCapturedJobs as defaultOffersWithCapturedJobs } from "../scoring/sourced-persistence.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  filterAndDedupeOffers,
  scanCompanies,
} from "../scoring/sourced-scanner.mjs";
import {
  COMPANY_DISCOVERY_BATCH_MAX,
  resolveCompanyBoard as defaultResolveCompanyBoard,
} from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";
import { companyDiscoveryFingerprint } from "./company-discovery-cadence.mjs";
import { buildCompanyProposal } from "./company-proposal-gate.mjs";
import { generateCompanySeeds } from "./company-seeds.mjs";

function makeError(message, { code = "VALIDATION_FAILED", status = 422 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function nowDate(now) {
  if (typeof now === "function") return nowDate(now());
  if (now instanceof Date) return now;
  if (typeof now === "string" || typeof now === "number") return new Date(now);
  return new Date();
}

function stableId(prefix, parts) {
  const hash = createHash("sha256")
    .update(parts.filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 12);
  return `${prefix}_${hash}`;
}

function manualSeedsFromBody(body = {}) {
  const seeds = body.manualSeeds || body.manual_seeds || body.companies || body.seeds || [];
  if (!Array.isArray(seeds)) {
    throw makeError("manualSeeds must be an array");
  }
  return seeds;
}

function requestedCountFromBody(body = {}) {
  return body.requestedCount || body.requested_count || COMPANY_DISCOVERY_BATCH_MAX;
}

function discoveryRequestFromBody(body = {}) {
  return String(body.request || body.discoveryRequest || body.discovery_request || "")
    .trim()
    .slice(0, 500);
}

function discoveryTriggerFromBody(body = {}) {
  const kind = String(body.trigger?.kind || "").trim();
  const id = String(body.trigger?.id || "").trim();
  return kind === "search-run" && id ? { kind, id: id.slice(0, 160) } : null;
}

function isExplicitDiscoveryRequest(body = {}) {
  return body.requestedByUser === true || body.requested_by_user === true;
}

function canAutoAddProposal(proposal) {
  return (
    proposal?.classification === "supported_ats" &&
    proposal?.confidenceTier === "high-confidence" &&
    proposal?.proposedAction === "approve-supported-ats" &&
    Boolean(String(proposal?.company?.name || "").trim()) &&
    Boolean(String(proposal?.jobBoardUrl || "").trim())
  );
}

function autoAddDecision({ sourceConfig, decidedAt }) {
  return {
    action: "approve-supported-ats",
    status: "approved",
    decidedAt,
    decidedBy: "explicit-discovery",
    sourceConfig: {
      status: sourceConfig.status,
      entry: sourceConfig.entry,
      total: sourceConfig.total,
    },
    sourced: { created: 0, updated: 0, rows: 0 },
  };
}

function scoringConfigFromContext(context = {}) {
  return {
    targeting: {
      role_buckets: Array.isArray(context.roleFamilies)
        ? context.roleFamilies.map((family) => ({
            name: family.name,
            priority: family.priority,
            titles: family.titles,
          }))
        : [],
      keep_signals: context.keepSignals || [],
      cut_signals: context.cutSignals || [],
      excluded_companies: context.excludedCompanies || [],
    },
    profile: {
      compensation: {
        minimum_base: context.compensationFloors?.minimum_base,
      },
      location: {
        home: context.locationPosture?.home,
        remote: context.locationPosture?.remote === true,
        remote_scope:
          context.locationPosture?.remoteScope === "worldwide" ? "worldwide" : "home-country",
        hybrid: context.locationPosture?.hybrid === true,
        onsite: context.locationPosture?.onsite === true,
        relocation: context.locationPosture?.relocation || [],
      },
    },
  };
}

function offerHasScannerGate(offer) {
  return Boolean(offer?.gate && offer?.score != null);
}

function prepareScanResult(scanResult = {}, context = {}) {
  const offers = Array.isArray(scanResult.offers) ? scanResult.offers : [];
  const unscored = offers.filter((offer) => !offerHasScannerGate(offer));
  if (unscored.length === 0) return { ...scanResult, offers };

  const scored = filterAndDedupeOffers(unscored, {
    seenUrls: new Set(),
    seenReqIds: new Set(),
    seenCompanyRoles: new Set(),
    titleFilter: buildTitleFilter(),
    locationFilter: buildLocationFilter(),
    config: scoringConfigFromContext(context),
  });
  const scoredByUrl = new Map(scored.kept.map((offer) => [offer.url, offer]));
  const preparedOffers = offers
    .map((offer) => (offerHasScannerGate(offer) ? offer : scoredByUrl.get(offer.url)))
    .filter(Boolean);

  return {
    ...scanResult,
    offers: preparedOffers,
    filteredTitle: scored.filteredTitle,
    filteredLocation: scored.filteredLocation,
    duplicates: scored.duplicates,
    possibleDuplicates: scored.possibleDuplicates,
    invalid: scored.invalid,
  };
}

async function proposalForSeed({
  repoRoot,
  env,
  seed,
  index,
  batchId,
  fetchImpl,
  resolveCompanyBoard,
  scanCompaniesImpl,
  createdAt,
  context,
  signal,
  stageResolution,
}) {
  signal?.throwIfAborted?.();
  const proposalId = stableId("cpp", [batchId, seed.name, String(index), createdAt]);
  try {
    const resolution = await resolveCompanyBoard({
      repoRoot,
      env,
      seed,
      fetchImpl,
      signal,
      stageResolution,
    });
    signal?.throwIfAborted?.();
    const scanConfig = {
      tracked_companies: [
        {
          name: resolution.companyName || seed.name,
          careers_url: resolution.jobBoardUrl || resolution.careersUrl,
          provider: resolution.atsProvider,
          api: resolution.apiUrl || undefined,
        },
      ],
    };
    const rawScanResult = await scanCompaniesImpl(scanConfig, { fetchImpl, signal });
    signal?.throwIfAborted?.();
    const scanResult = prepareScanResult(rawScanResult, context);
    return { candidate: { seed, resolution, scanResult, proposalId } };
  } catch (err) {
    if (signal?.aborted || err === signal?.reason) throw signal.reason || err;
    return {
      rejected: {
        proposalId,
        company: { name: seed.name, domain: seed.domain_hint || "" },
        classification: "rejected",
        confidenceTier: "rejected",
        reason: err.code || "proposal-generation-failed",
        rejectReasons: [err.code || err.message || "proposal-generation-failed"],
      },
    };
  }
}

export async function createCompanyProposalBatch({
  repoRoot,
  env = process.env,
  body = {},
  batchId: requestedBatchId,
  fetchImpl = fetch,
  resolveCompanyBoard = defaultResolveCompanyBoard,
  scanCompaniesImpl = scanCompanies,
  offersWithCapturedJobs = defaultOffersWithCapturedJobs,
  persistResolution = companyBoardResolutionUpsert,
  companyAtsUpsertImpl = defaultCompanyAtsUpsert,
  buildSeedContext = buildCompanySeedContext,
  seedContext,
  generateSeeds = generateCompanySeeds,
  seedCall,
  executionPlan,
  signal,
  reportProgress = async () => {},
  now = new Date(),
} = {}) {
  signal?.throwIfAborted?.();
  const manualSeeds = manualSeedsFromBody(body);
  const baseContext = seedContext || buildSeedContext({ repoRoot, env });
  const discoveryRequest = discoveryRequestFromBody(body);
  const context = discoveryRequest ? { ...baseContext, discoveryRequest } : baseContext;
  const seedResult = await generateSeeds({
    repoRoot,
    env,
    context,
    manualSeeds,
    requestedCount: requestedCountFromBody(body),
    call: seedCall,
    executionPlan,
    signal,
    now,
  });
  if (!seedResult.body?.ok) return { status: seedResult.status, body: seedResult.body };

  const seeds = seedResult.body.data.companies;

  await reportProgress({
    phase: "seeds-ready",
    completed: 0,
    total: seeds.length,
    message: `CareerRat found ${seeds.length} ${seeds.length === 1 ? "company" : "companies"} to check.`,
  });

  const createdDate = nowDate(now);
  const createdAt = createdDate.toISOString();
  const batchId =
    String(requestedBatchId || "").trim() ||
    stableId("cpb", [createdAt, seeds.map((seed) => seed.name).join(",")]);
  const trigger = discoveryTriggerFromBody(body);
  const proposals = [];
  const rejected = [];
  const candidates = [];
  const stagedResolutions = [];

  for (const [index, seed] of seeds.entries()) {
    signal?.throwIfAborted?.();
    const result = await proposalForSeed({
      repoRoot,
      env,
      seed,
      index,
      batchId,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      createdAt,
      context,
      signal,
      stageResolution: (resolution) => stagedResolutions.push(resolution),
    });
    if (result.candidate) candidates.push(result.candidate);
    if (result.rejected) rejected.push(result.rejected);
    await reportProgress({
      phase: "resolving",
      completed: index + 1,
      total: seeds.length,
      message: `Checked ${index + 1} of ${seeds.length} company boards.`,
    });
  }

  signal?.throwIfAborted?.();

  for (const candidate of candidates) {
    const capturedOffers = offersWithCapturedJobs({
      repoRoot,
      env,
      offers: Array.isArray(candidate.scanResult?.offers) ? candidate.scanResult.offers : [],
      savedAt: new Date(createdAt),
    });
    const result = buildCompanyProposal({
      ...candidate,
      scanResult: { ...candidate.scanResult, offers: capturedOffers },
      context,
      capturedOffers,
      version: 1,
    });
    if (result.proposal) proposals.push(result.proposal);
    if (result.rejected) rejected.push(result.rejected);
  }

  for (const resolution of stagedResolutions) {
    persistResolution({ repoRoot, env, resolution });
  }

  const autoAdded = [];
  let reviewProposals = proposals;
  if (isExplicitDiscoveryRequest(body)) {
    reviewProposals = [];
    for (const proposal of proposals) {
      if (!canAutoAddProposal(proposal)) {
        reviewProposals.push(proposal);
        continue;
      }
      const sourceConfig = companyAtsUpsertImpl({
        repoRoot,
        env,
        entry: {
          name: proposal.company.name,
          careers_url: proposal.jobBoardUrl,
          provider: proposal.atsProvider,
        },
      });
      const decision = autoAddDecision({ sourceConfig, decidedAt: createdAt });
      autoAdded.push({
        ...proposal,
        version: Number(proposal.version || 0) + 1,
        decision,
      });
    }
  }

  const batch = {
    batchId,
    status: reviewProposals.length ? "pending" : autoAdded.length ? "approved" : "complete",
    createdAt,
    version: 1,
    contextFingerprint: companyDiscoveryFingerprint(context),
    ...(trigger ? { trigger } : {}),
    proposals: reviewProposals,
    ...(isExplicitDiscoveryRequest(body) ? { autoAdded } : {}),
    rejected,
    counts: {
      seeds: seeds.length,
      proposals: reviewProposals.length,
      rejected: rejected.length,
      ...(isExplicitDiscoveryRequest(body) ? { autoAdded: autoAdded.length } : {}),
    },
  };
  companyProposalBatchPut({ repoRoot, env, batch });

  return {
    data: {
      batchId,
      proposals: reviewProposals,
      ...(isExplicitDiscoveryRequest(body) ? { autoAdded } : {}),
      rejected,
      counts: batch.counts,
    },
    meta: {
      version: batch.version,
      ai: seedResult.body.ai,
      manual: seedResult.body.manual,
      seedSource: seedResult.body.ai?.used ? "ai" : "manual",
    },
  };
}
