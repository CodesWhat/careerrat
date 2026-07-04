import { createHash } from "node:crypto";
import { companyProposalBatchPut } from "../db/verbs/company-discovery.mjs";
import { scanCompanies } from "../scoring/sourced-scanner.mjs";
import {
  COMPANY_DISCOVERY_BATCH_MAX,
  resolveCompanyBoard as defaultResolveCompanyBoard,
} from "./company-board-resolver.mjs";
import { buildCompanyProposal } from "./company-proposal-gate.mjs";

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

function normalizeSeed(raw) {
  const name = String(raw?.name || "").trim();
  if (!name) return null;
  const seed = {
    name,
    domain_hint: String(raw?.domain_hint || raw?.domainHint || "").trim(),
    why: String(raw?.why || "").trim(),
    role_family_hint: String(raw?.role_family_hint || raw?.roleFamilyHint || "").trim(),
    confidence: String(raw?.confidence || "manual").trim(),
    source_hint: String(raw?.source_hint || raw?.sourceHint || "manual").trim(),
  };
  for (const key of ["job_board_url", "careers_url"]) {
    if (raw?.[key]) seed[key] = String(raw[key]).trim();
  }
  return seed;
}

function manualSeedsFromBody(body = {}) {
  const seeds = body.manualSeeds || body.manual_seeds || body.companies || body.seeds || [];
  if (!Array.isArray(seeds)) {
    throw makeError("manualSeeds must be an array");
  }
  if (seeds.length > COMPANY_DISCOVERY_BATCH_MAX) {
    throw makeError(`manual seed batch exceeds maximum of ${COMPANY_DISCOVERY_BATCH_MAX}`);
  }
  return seeds.map(normalizeSeed).filter(Boolean);
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
  now = new Date(),
} = {}) {
  const seeds = manualSeedsFromBody(body);
  if (seeds.length === 0) {
    throw makeError("manualSeeds are required when no AI seed route is configured", {
      code: "NO_AI_ROUTE",
      status: 501,
    });
  }

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
    meta: { version: batch.version },
  };
}
