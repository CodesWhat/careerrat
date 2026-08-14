import { extractCompBand } from "../scoring/sourced-scanner.mjs";

const COMP_REVIEW_FLAGS = new Set(["comp-unposted", "comp-uncertain", "top-of-band-only"]);
const HARD_CUT_PREFIXES = ["cut-risk"];
const HARD_CUT_FLAGS = new Set(["excluded-company"]);

function trimString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function proposalCompany(seed, resolution) {
  return {
    name: trimString(resolution?.companyName || seed?.name),
    domain: trimString(resolution?.companyDomain || seed?.domain_hint),
  };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  const output = [];
  for (const value of values) {
    const text = trimString(value);
    if (text && !output.includes(text)) output.push(text);
  }
  return output;
}

function companyKey(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");
}

function companyMatches(values, company) {
  const keys = new Set([companyKey(company.name), companyKey(company.domain)].filter(Boolean));
  return list(values).some((value) => keys.has(companyKey(value)));
}

function ruleFlags(offer) {
  return list(offer?.ruleFlags)
    .map((flag) => trimString(flag))
    .filter(Boolean);
}

function hasHardCutFlag(offer) {
  const flags = ruleFlags(offer);
  return flags.some(
    (flag) =>
      HARD_CUT_FLAGS.has(flag) || HARD_CUT_PREFIXES.some((prefix) => flag.startsWith(prefix))
  );
}

function hasRequiredOfferFields(offer) {
  return Boolean(offer?.company && offer?.title && offer?.url);
}

function minimumBase(context) {
  const floor = Number(context?.compensationFloors?.minimum_base ?? context?.minimum_base);
  return Number.isFinite(floor) ? floor : null;
}

function offerTextForComp(offer) {
  return [offer?.comp, offer?.bodyText, offer?.description, offer?.rawText]
    .filter(Boolean)
    .join("\n");
}

function compStateForOffer(offer, floor) {
  const flags = ruleFlags(offer);
  if (flags.includes("comp-below-floor")) return "below-floor";
  if (flags.includes("comp-uncertain")) return "uncertain";
  if (flags.includes("top-of-band-only")) return "top-of-band-only";
  if (flags.includes("comp-unposted")) return "unposted";
  if (floor === null) return "clears-floor";

  const band = extractCompBand(offerTextForComp(offer));
  if (!band) return "unposted";
  if (band.max < floor) return "below-floor";
  if (band.min < floor) return "top-of-band-only";
  return "clears-floor";
}

function compReviewReason(state) {
  if (state === "unposted") return "comp-unposted";
  if (state === "uncertain") return "comp-uncertain";
  if (state === "top-of-band-only") return "top-of-band-only";
  if (state === "below-floor") return "comp-below-floor";
  return "";
}

function jdCaptureSummary(capturedOffers) {
  const offers = list(capturedOffers);
  if (offers.length === 0) return { status: "missing", capturedCount: 0 };
  const hasBody = offers.some((offer) => Number(offer.bodyChars || 0) > 0);
  return {
    status: hasBody ? "captured" : "partial",
    capturedCount: offers.length,
  };
}

function scanSummary({
  status,
  scanResult,
  matchingOffers,
  compStatus,
  reviewReasons,
  rejectReasons,
}) {
  const summary = {
    status,
    currentRoleCount: list(scanResult?.offers).length,
    matchingRoleCount: list(matchingOffers).length,
    errors: list(scanResult?.errors),
  };
  if (compStatus) summary.compStatus = compStatus;
  if (list(reviewReasons).length) summary.reviewReasons = list(reviewReasons);
  if (list(rejectReasons).length) summary.rejectReasons = list(rejectReasons);
  return summary;
}

function rejectedResult({
  seed,
  resolution,
  scanResult,
  proposalId,
  version,
  reason,
  rejectReasons,
  status = reason,
}) {
  const company = proposalCompany(seed, resolution);
  const reasons = unique(rejectReasons.length ? rejectReasons : [reason]);
  return {
    rejected: {
      proposalId,
      company,
      why: trimString(seed?.why),
      roleFamily: trimString(seed?.role_family_hint),
      roleSeen: "",
      careersUrl: trimString(resolution?.careersUrl || resolution?.jobBoardUrl),
      jobBoardUrl: trimString(resolution?.jobBoardUrl),
      atsProvider: trimString(resolution?.atsProvider),
      classification: "rejected",
      confidenceTier: "rejected",
      provenance: list(resolution?.provenance),
      scanSummary: scanSummary({
        status,
        scanResult,
        matchingOffers: [],
        rejectReasons: reasons,
      }),
      jdCapture: { status: "not-captured", capturedCount: 0 },
      proposedAction: "reject",
      reviewReasons: [],
      rejectReasons: reasons,
      capturedOffers: [],
      version,
      reason,
    },
  };
}

function unsupportedCacheProposal({ seed, resolution, scanResult, proposalId, version }) {
  const reviewReasons = ["unsupported-public-cache"];
  return {
    proposal: {
      proposalId,
      company: proposalCompany(seed, resolution),
      why: trimString(seed?.why || "Unsupported public careers page cached for review."),
      roleFamily: trimString(seed?.role_family_hint),
      roleSeen: "",
      careersUrl: trimString(resolution?.careersUrl),
      jobBoardUrl: trimString(resolution?.jobBoardUrl),
      atsProvider: "",
      classification: "unsupported_public",
      confidenceTier: "borderline",
      provenance: list(resolution?.provenance),
      scanSummary: scanSummary({
        status: "unsupported-public-cache",
        scanResult,
        matchingOffers: [],
        reviewReasons,
      }),
      jdCapture: { status: "not-applicable", capturedCount: 0 },
      proposedAction: "cache-only",
      reviewReasons,
      rejectReasons: [],
      capturedOffers: [],
      version,
    },
  };
}

export function buildCompanyProposal({
  seed,
  resolution,
  scanResult,
  context,
  capturedOffers,
  proposalId,
  version = 1,
} = {}) {
  const company = proposalCompany(seed, resolution);
  const floor = minimumBase(context);
  const offers = list(scanResult?.offers).filter(hasRequiredOfferFields);

  if (companyMatches(context?.trackedCompanies, company)) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "already-tracked",
      rejectReasons: ["already-tracked"],
    });
  }
  if (companyMatches(context?.excludedCompanies, company)) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "excluded-company",
      rejectReasons: ["excluded-company"],
    });
  }
  if (
    companyMatches(context?.applications, company) ||
    companyMatches(context?.sourcedCompanies, company)
  ) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "already-in-play",
      rejectReasons: ["already-in-play"],
    });
  }

  const unsupportedCache =
    resolution?.classification === "unsupported_public" ||
    resolution?.cacheOnly === true ||
    (!resolution?.atsProvider && Boolean(resolution?.careersUrl));
  if (unsupportedCache) {
    return unsupportedCacheProposal({ seed, resolution, scanResult, proposalId, version });
  }

  if (!resolution?.atsProvider || !resolution?.jobBoardUrl) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "unsupported-without-cache",
      rejectReasons: ["unsupported-without-cache"],
      status: "unsupported-company-board",
    });
  }

  if (offers.length === 0) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "no-current-role-signal",
      rejectReasons: ["no-current-role-signal"],
      status: "no-matching-roles",
    });
  }

  const compStates = offers.map((offer) => compStateForOffer(offer, floor));
  if (compStates.every((state) => state === "below-floor")) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "comp-below-floor",
      rejectReasons: ["comp-below-floor"],
      status: "comp-below-floor",
    });
  }

  const viableOffers = offers.filter((offer, index) => {
    if (compStates[index] === "below-floor") return false;
    if (hasHardCutFlag(offer)) return false;
    return offer.gate !== "likely-cut";
  });

  if (viableOffers.length === 0) {
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason: "no-current-role-signal",
      rejectReasons: ["no-current-role-signal"],
      status: "no-matching-roles",
    });
  }

  const captured = list(capturedOffers).filter((offer) =>
    viableOffers.some((candidate) => candidate.url === offer.url)
  );
  const jdCapture = jdCaptureSummary(captured);
  const compStateForViableOffer = (offer) => compStates[offers.indexOf(offer)];
  const hasClearComp = viableOffers.some(
    (offer) => compStateForViableOffer(offer) === "clears-floor"
  );
  const reviewReasons = [];

  if (!hasClearComp) {
    for (const offer of viableOffers) {
      const reason = compReviewReason(compStateForViableOffer(offer));
      if (COMP_REVIEW_FLAGS.has(reason) && !reviewReasons.includes(reason)) {
        reviewReasons.push(reason);
      }
    }
  }
  if (
    viableOffers.some((offer) => offer.gate === "review") &&
    !reviewReasons.includes("scanner-review")
  ) {
    reviewReasons.push("scanner-review");
  }
  if (jdCapture.status !== "captured" && !reviewReasons.includes("jd-capture-partial")) {
    reviewReasons.push("jd-capture-partial");
  }

  const confidenceTier = reviewReasons.length ? "borderline" : "high-confidence";
  const proposedAction = confidenceTier === "high-confidence" ? "approve-supported-ats" : "review";
  const roleSeen = trimString(viableOffers[0]?.title);
  const compStatus = hasClearComp
    ? "clears-floor"
    : compStates.find((state) => state !== "below-floor") || "";

  return {
    proposal: {
      proposalId,
      company,
      why: trimString(seed?.why || "Manual seed resolved to a supported ATS board."),
      roleFamily: trimString(seed?.role_family_hint),
      roleSeen,
      careersUrl: resolution.careersUrl || resolution.jobBoardUrl,
      jobBoardUrl: resolution.jobBoardUrl,
      atsProvider: resolution.atsProvider,
      classification: "supported_ats",
      confidenceTier,
      provenance: list(resolution.provenance),
      scanSummary: scanSummary({
        status: "matching-roles-found",
        scanResult,
        matchingOffers: viableOffers,
        compStatus: floor === null ? "" : compStatus,
        reviewReasons,
      }),
      jdCapture,
      proposedAction,
      reviewReasons,
      rejectReasons: [],
      capturedOffers: captured,
      version,
    },
  };
}
