import { createHash } from "node:crypto";
import { companyProposalBatchPut } from "../db/verbs/company-discovery.mjs";
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
  offersWithCapturedJobs,
  createdAt,
  context,
}) {
  const proposalId = stableId("cpp", [batchId, seed.name, String(index), createdAt]);
  try {
    const resolution = await resolveCompanyBoard({ repoRoot, env, seed, fetchImpl });
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
    const rawScanResult = await scanCompaniesImpl(scanConfig, { fetchImpl });
    const scanResult = prepareScanResult(rawScanResult, context);
    const capturedOffers = offersWithCapturedJobs({
      repoRoot,
      env,
      offers: Array.isArray(scanResult?.offers) ? scanResult.offers : [],
      savedAt: new Date(createdAt),
    });
    return buildCompanyProposal({
      seed,
      resolution,
      scanResult: { ...scanResult, offers: capturedOffers },
      context,
      capturedOffers,
      proposalId,
      version: 1,
    });
  } catch (err) {
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
  fetchImpl = fetch,
  resolveCompanyBoard = defaultResolveCompanyBoard,
  scanCompaniesImpl = scanCompanies,
  offersWithCapturedJobs = defaultOffersWithCapturedJobs,
  buildSeedContext = buildCompanySeedContext,
  generateSeeds = generateCompanySeeds,
  seedCall,
  now = new Date(),
} = {}) {
  const manualSeeds = manualSeedsFromBody(body);
  const baseContext = buildSeedContext({ repoRoot, env });
  const discoveryRequest = discoveryRequestFromBody(body);
  const context = discoveryRequest ? { ...baseContext, discoveryRequest } : baseContext;
  const seedResult = await generateSeeds({
    repoRoot,
    env,
    context,
    manualSeeds,
    requestedCount: requestedCountFromBody(body),
    call: seedCall,
    now,
  });
  if (!seedResult.body?.ok) return { status: seedResult.status, body: seedResult.body };

  const seeds = seedResult.body.data.companies;

  const createdDate = nowDate(now);
  const createdAt = createdDate.toISOString();
  const batchId = stableId("cpb", [createdAt, seeds.map((seed) => seed.name).join(",")]);
  const trigger = discoveryTriggerFromBody(body);
  const proposals = [];
  const rejected = [];

  for (const [index, seed] of seeds.entries()) {
    const result = await proposalForSeed({
      repoRoot,
      env,
      seed,
      index,
      batchId,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      offersWithCapturedJobs,
      createdAt,
      context,
    });
    if (result.proposal) proposals.push(result.proposal);
    if (result.rejected) rejected.push(result.rejected);
  }

  const batch = {
    batchId,
    status: "pending",
    createdAt,
    version: 1,
    contextFingerprint: companyDiscoveryFingerprint(context),
    ...(trigger ? { trigger } : {}),
    proposals,
    rejected,
    counts: {
      seeds: seeds.length,
      proposals: proposals.length,
      rejected: rejected.length,
    },
  };
  companyProposalBatchPut({ repoRoot, env, batch });

  return {
    data: {
      batchId,
      proposals,
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
