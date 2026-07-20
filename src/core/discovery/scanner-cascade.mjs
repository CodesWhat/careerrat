// scanner-cascade.mjs — deterministic public-intel scanner cascade.

import {
  publicBoardIntelUpsert,
  publicCareersPageUpsert,
  publicCompanyIntelUpsert,
  publicIntelReviewItemUpsert,
  publicIntelStateGet,
} from "../db/verbs/public-intel.mjs";
import {
  COMPANY_DISCOVERY_BATCH_MAX,
  normalizeCompanyKey,
  resolveCompanyBoard,
} from "./company-board-resolver.mjs";
import { extractPublicCareersPage } from "./public-page-extractor.mjs";
import { extractAmbiguousPublicCareersPage } from "./public-scanner-ai.mjs";

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" || typeof now === "number") return new Date(now).toISOString();
  return new Date().toISOString();
}

function slug(value) {
  return normalizeCompanyKey(value || "public-company") || "public-company";
}

function companyKeyFor(seed = {}, resolution = {}) {
  return (
    resolution.companyKey ||
    seed.companyKey ||
    slug(resolution.companyName || seed.name || resolution.companyDomain || seed.domain)
  );
}

function companyNameFor(seed = {}, resolution = {}) {
  return String(
    resolution.companyName || seed.name || resolution.companyKey || seed.companyKey || ""
  ).trim();
}

function companyDomainFor(seed = {}, resolution = {}) {
  if (resolution.companyDomain) return resolution.companyDomain;
  if (seed.domain) return seed.domain;
  const url =
    resolution.careersUrl || resolution.jobBoardUrl || seed.careersUrl || seed.jobBoardUrl;
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function firstUrl(seed = {}, resolution = {}) {
  return (
    resolution.careersUrl ||
    resolution.jobBoardUrl ||
    seed.careersUrl ||
    seed.jobBoardUrl ||
    seed.domain ||
    ""
  );
}

function publicCompanyRecord({ seed, resolution, observedAt, freshnessStatus = "fresh" }) {
  const companyKey = companyKeyFor(seed, resolution);
  return {
    id: `company-${companyKey}`,
    companyKey,
    companyName: companyNameFor(seed, resolution),
    companyDomain: companyDomainFor(seed, resolution),
    careersUrl:
      resolution.careersUrl || seed.careersUrl || resolution.jobBoardUrl || seed.jobBoardUrl || "",
    provider: resolution.atsProvider || "custom",
    confidence: resolution.confidence || "low",
    provenance: resolution.provenance || [],
    firstSeenAt: observedAt,
    lastVerifiedAt: observedAt,
    freshnessStatus,
  };
}

function publicBoardRecord({ seed, resolution, observedAt, sourceKind }) {
  const companyKey = companyKeyFor(seed, resolution);
  const boardUrl = resolution.jobBoardUrl || resolution.careersUrl || "";
  return {
    id: `board-${companyKey}-${slug(resolution.atsProvider || sourceKind || "custom")}`,
    companyKey,
    boardUrl,
    atsProvider: resolution.atsProvider || "custom",
    sourceKind,
    confidence: resolution.confidence || "low",
    provenance: resolution.provenance || [],
    firstSeenAt: observedAt,
    lastVerifiedAt: observedAt,
  };
}

function publicPageRecord({ seed, resolution, extraction, observedAt }) {
  const companyKey = companyKeyFor(seed, resolution);
  return {
    id: `page-${companyKey}-${slug(extraction.metadata?.inputHash || extraction.extractionStatus)}`,
    companyKey,
    url: extraction.metadata?.url || firstUrl(seed, resolution),
    extractionStatus: extraction.extractionStatus,
    inputHash: extraction.metadata?.inputHash || "",
    confidence: extraction.metadata?.confidence || resolution.confidence || "low",
    publicSignals: extraction.metadata?.publicSignals || [],
    provenance: extraction.metadata?.provenance || resolution.provenance || [],
    firstSeenAt: observedAt,
    lastVerifiedAt: observedAt,
  };
}

function noAi() {
  return { used: false, eligible: false };
}

async function persistSupportedAts({ repoRoot, env, seed, resolution, observedAt, now }) {
  publicCompanyIntelUpsert({
    repoRoot,
    env,
    record: publicCompanyRecord({ seed, resolution, observedAt }),
    now,
  });
  publicBoardIntelUpsert({
    repoRoot,
    env,
    record: publicBoardRecord({ seed, resolution, observedAt, sourceKind: "supported_ats" }),
    now,
  });
}

async function persistMetadataFound({
  repoRoot,
  env,
  seed,
  resolution,
  extraction,
  observedAt,
  now,
}) {
  const metadata = extraction.metadata || {};
  const nextResolution = {
    ...resolution,
    jobBoardUrl: metadata.jobBoardUrl,
    atsProvider: metadata.atsProvider,
    confidence: metadata.confidence || "high",
    provenance: metadata.provenance || resolution.provenance || [],
  };
  publicCompanyIntelUpsert({
    repoRoot,
    env,
    record: publicCompanyRecord({ seed, resolution: nextResolution, observedAt }),
    now,
  });
  publicBoardIntelUpsert({
    repoRoot,
    env,
    record: publicBoardRecord({
      seed,
      resolution: nextResolution,
      observedAt,
      sourceKind: "supported_ats",
    }),
    now,
  });
  publicCareersPageUpsert({
    repoRoot,
    env,
    page: publicPageRecord({ seed, resolution, extraction, observedAt }),
    now,
  });
}

async function persistMetadataOnly({
  repoRoot,
  env,
  seed,
  resolution,
  extraction,
  observedAt,
  now,
}) {
  publicCompanyIntelUpsert({
    repoRoot,
    env,
    record: publicCompanyRecord({ seed, resolution, observedAt, freshnessStatus: "metadata_only" }),
    now,
  });
  publicCareersPageUpsert({
    repoRoot,
    env,
    page: publicPageRecord({ seed, resolution, extraction, observedAt }),
    now,
  });
}

function reviewItem({ seed, resolution, extraction, observedAt }) {
  const companyKey = companyKeyFor(seed, resolution);
  return {
    id: `review-${companyKey}-${slug(extraction.metadata?.inputHash || "ambiguous")}`,
    status: "pending",
    reason: "ambiguous_public_page",
    companyKey,
    companyName: companyNameFor(seed, resolution),
    careersUrl: extraction.metadata?.url || firstUrl(seed, resolution),
    candidates: extraction.metadata?.candidates || [],
    publicSignals: extraction.metadata?.publicSignals || [],
    confidence: extraction.metadata?.confidence || "low",
    provenance: extraction.metadata?.provenance || resolution.provenance || [],
    firstSeenAt: observedAt,
    version: 1,
  };
}

function safeExtraction(extraction = {}) {
  const { usableText: _usableText, ...safe } = extraction;
  return safe;
}

async function defaultValidateAiCandidate({ candidate, extraction }) {
  const candidateUrl = String(candidate?.url || "").trim();
  if (!candidateUrl) return { ok: false, reason: "missing-url" };
  const observed = new Set(
    (extraction.metadata?.candidates || []).map((item) => String(item.url || ""))
  );
  if (!observed.has(candidateUrl)) return { ok: false, reason: "not-observed-in-public-page" };
  return { ok: true, reason: "observed-in-public-page" };
}

export async function scanPublicIntelSeed({
  repoRoot,
  env,
  seed = {},
  fetchImpl = fetch,
  resolveHost,
  resolveCompanyBoard: resolveImpl = resolveCompanyBoard,
  aiCall,
  validateAiCandidate = defaultValidateAiCandidate,
  now = new Date(),
} = {}) {
  const observedAt = nowIso(now);
  const resolution = await resolveImpl({
    repoRoot,
    env,
    seed,
    fetchImpl,
    now,
  });

  if (resolution.status === "supported_ats") {
    await persistSupportedAts({ repoRoot, env, seed, resolution, observedAt, now });
    return {
      ok: true,
      status: "supported_ats",
      classification: "supported_ats",
      ai: noAi(),
      reviewItem: null,
      data: { resolution },
    };
  }

  const targetUrl = firstUrl(seed, resolution);
  if (!targetUrl) {
    return {
      ok: true,
      status: resolution.status || "unsupported_public_no_result",
      classification: "unsupported_public",
      ai: noAi(),
      reviewItem: null,
      data: { resolution },
    };
  }

  const extraction = await extractPublicCareersPage({
    url: targetUrl,
    fetchImpl,
    resolveHost,
    now,
  });
  if (extraction.extractionStatus === "metadata_found") {
    await persistMetadataFound({ repoRoot, env, seed, resolution, extraction, observedAt, now });
    return {
      ok: true,
      status: "metadata_found",
      classification: "custom_public_metadata",
      ai: noAi(),
      reviewItem: null,
      data: { resolution, extraction: safeExtraction(extraction) },
    };
  }

  await persistMetadataOnly({ repoRoot, env, seed, resolution, extraction, observedAt, now });
  if (extraction.reviewRequired) {
    const model = await extractAmbiguousPublicCareersPage({
      pageUrl: extraction.metadata?.url || targetUrl,
      pageText: extraction.usableText || "",
      root: repoRoot,
      env,
      call: aiCall,
      now,
    });
    let deterministicValidation = { ok: false, reason: "no-model-candidate" };
    if (model.ok && model.data?.candidates?.length) {
      deterministicValidation = await validateAiCandidate({
        candidate: model.data.candidates[0],
        extraction,
        resolution,
        seed,
      });
    }
    const item = {
      ...reviewItem({ seed, resolution, extraction, observedAt }),
      modelAssisted: Boolean(model.ai?.used),
      modelStatus: model.status || "review_needed",
      modelReviewReason: model.data?.reviewReason || model.error?.message || undefined,
      deterministicValidation,
    };
    const written = publicIntelReviewItemUpsert({ repoRoot, env, item, now }).item;
    return {
      ok: true,
      status: "review_needed",
      classification: "ambiguous_public_page",
      ai: model.ai || noAi(),
      deterministicValidation,
      publicWriteApproved: false,
      reviewItem: written,
      data: { resolution, extraction: safeExtraction(extraction), model: model.data || null },
    };
  }

  return {
    ok: true,
    status: extraction.extractionStatus,
    classification: extraction.extractionStatus,
    ai: noAi(),
    reviewItem: null,
    data: { resolution, extraction: safeExtraction(extraction) },
  };
}

export async function scanPublicIntelSeeds({
  repoRoot,
  env,
  body = {},
  fetchImpl = fetch,
  resolveHost,
  resolveCompanyBoard: resolveImpl = resolveCompanyBoard,
  now = new Date(),
} = {}) {
  const seeds = Array.isArray(body?.seeds) ? body.seeds : [];
  if (!seeds.length) {
    const err = new Error("public-intel scan requires at least one seed");
    err.code = "BAD_REQUEST";
    err.status = 400;
    throw err;
  }
  if (seeds.length > COMPANY_DISCOVERY_BATCH_MAX) {
    const err = new Error(
      `public-intel scan accepts at most ${COMPANY_DISCOVERY_BATCH_MAX} seeds per request`
    );
    err.code = "BAD_REQUEST";
    err.status = 400;
    throw err;
  }

  const results = [];
  for (const seed of seeds) {
    results.push(
      await scanPublicIntelSeed({
        repoRoot,
        env,
        seed,
        fetchImpl,
        resolveHost,
        resolveCompanyBoard: resolveImpl,
        aiCall: body?.aiCall,
        now,
      })
    );
  }
  return {
    ok: true,
    data: {
      scanned: results.length,
      reviewCreated: results.filter((item) => item.reviewItem).length,
      results,
      state: publicIntelStateGet({ repoRoot, env }).data,
    },
  };
}
