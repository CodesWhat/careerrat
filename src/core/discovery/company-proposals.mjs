import { createHash } from "node:crypto";
import { companyProposalBatchPut } from "../db/verbs/company-discovery.mjs";
import { scanCompanies } from "../scoring/sourced-scanner.mjs";
import {
  COMPANY_DISCOVERY_BATCH_MAX,
  resolveCompanyBoard as defaultResolveCompanyBoard,
} from "./company-board-resolver.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";
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
}) {
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
    const scanResult = await scanCompaniesImpl(scanConfig, { fetchImpl });
    const proposalId = stableId("cpp", [batchId, seed.name, String(index), createdAt]);
    return buildCompanyProposal({
      seed,
      resolution,
      scanResult,
      proposalId,
      version: 1,
    });
  } catch (err) {
    return {
      rejected: {
        company: { name: seed.name, domain: seed.domain_hint || "" },
        reason: err.code || "proposal-generation-failed",
        rejectReasons: [err.message],
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
  buildSeedContext = buildCompanySeedContext,
  generateSeeds = generateCompanySeeds,
  seedCall,
  now = new Date(),
} = {}) {
  const manualSeeds = manualSeedsFromBody(body);
  const context = buildSeedContext({ repoRoot, env });
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
      createdAt,
    });
    if (result.proposal) proposals.push(result.proposal);
    if (result.rejected) rejected.push(result.rejected);
  }

  const batch = {
    batchId,
    status: "pending",
    createdAt,
    version: 1,
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
