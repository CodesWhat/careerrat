import { assessCompensationFloors } from "../profile/compensation.mjs";
import {
  extractCompensationBands,
  resolveCompensationEvidence,
} from "../scoring/sourced-scanner.mjs";

const COMP_REVIEW_FLAGS = new Set([
  "comp-unposted",
  "comp-uncertain",
  "top-of-band-only",
  "annual-earnings-overlap",
  "annual-earnings-unverified",
]);
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

// Trailing legal-entity words stripped from a company NAME key so "Acme" and
// "Acme, Inc." / "Acme LLC" / "Acme Corporation" collide on the same key.
// Domains never reach this: a bare domain has no "-"-separated tokens, so the
// pop loop below (which requires more than one token) never fires for them.
// Without this, an excluded_companies entry entered as a short form ("Acme")
// would never match a discovered listing's full legal name — the exclusion
// list and the comparison side would use inconsistent normalization, letting
// an excluded company slip through as a "new" proposal.
const COMPANY_LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
  "llp",
  "lp",
  "pllc",
  "pbc",
  "ag",
  "sa",
  "bv",
  "nv",
  "kk",
  "oy",
  "ab",
]);

function companyKey(value) {
  const slug = trimString(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "")
    // A trailing "." (e.g. from "Acme Inc.") must not make the key differ from
    // the period-less form ("Acme Inc") — both must slug to the same key.
    .replace(/\.+$/, "");
  const parts = slug.split("-");
  while (parts.length > 1 && COMPANY_LEGAL_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join("-");
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

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function offerTextForComp(offer) {
  const evidence = resolveCompensationEvidence(offer);
  return [
    evidence.baseComp ? `Base pay: ${evidence.baseComp}` : "",
    evidence.annualEarningsComp ? `Annual earnings: ${evidence.annualEarningsComp}` : "",
    evidence.unclassifiedComp ? `Compensation: ${evidence.unclassifiedComp}` : "",
    offer?.bodyText,
    offer?.description,
    offer?.rawText,
  ]
    .filter(Boolean)
    .join("\n");
}

function compensationFloors(context) {
  return {
    minimumBase: positiveNumber(context?.compensationFloors?.minimum_base ?? context?.minimum_base),
    minimumAnnualEarnings: positiveNumber(
      context?.compensationFloors?.minimum_annual_earnings ?? context?.minimum_annual_earnings
    ),
    floorCurrency: trimString(context?.compensationFloors?.currency ?? context?.currency),
  };
}

function compStateForOffer(offer, floors) {
  const flags = ruleFlags(offer);
  const evidence = resolveCompensationEvidence(offer);
  const bands = extractCompensationBands(offerTextForComp(offer));
  const standing = assessCompensationFloors({
    baseBand: bands.base,
    annualEarningsBand: bands.annualEarnings,
    ...floors,
  });
  const rejectReasons = [];
  const reviewReasons = [];

  if (standing.base === "below") {
    rejectReasons.push("comp-below-floor");
  }
  if (standing.annualEarnings === "below") {
    rejectReasons.push("annual-earnings-below-floor");
  }

  if (floors.minimumBase !== null) {
    if (standing.base === "overlap") {
      reviewReasons.push("top-of-band-only");
    } else if (standing.base === "unknown") {
      reviewReasons.push(
        flags.includes("comp-uncertain") || evidence.unclassifiedComp || bands.base
          ? "comp-uncertain"
          : "comp-unposted"
      );
    }
  }
  if (floors.minimumAnnualEarnings !== null) {
    if (standing.annualEarnings === "overlap") {
      reviewReasons.push("annual-earnings-overlap");
    } else if (standing.annualEarnings === "unknown") {
      reviewReasons.push("annual-earnings-unverified");
    }
  }

  return {
    rejectReasons: unique(rejectReasons),
    reviewReasons: unique(reviewReasons),
    clearsFloors: rejectReasons.length === 0 && reviewReasons.length === 0,
  };
}

function jdCaptureSummary(capturedOffers) {
  const offers = list(capturedOffers);
  if (offers.length === 0) return { status: "missing", capturedCount: 0 };
  const hasPartialBody = offers.some(
    (offer) => Number(offer.bodyChars || 0) === 0 || offer.bodyPartial === true
  );
  return {
    status: hasPartialBody ? "partial" : "captured",
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

function genericPublicProposal({ seed, resolution, scanResult, proposalId, version }) {
  const reviewReasons = ["generic-public-source"];
  const publicUrl = trimString(resolution?.jobBoardUrl || resolution?.careersUrl);
  return {
    proposal: {
      proposalId,
      company: proposalCompany(seed, resolution),
      why: trimString(seed?.why || "Public company careers page ready to add as a source."),
      roleFamily: trimString(seed?.role_family_hint),
      roleSeen: "",
      careersUrl: trimString(resolution?.careersUrl),
      jobBoardUrl: publicUrl,
      atsProvider: "",
      classification: "generic_public",
      confidenceTier: "borderline",
      provenance: list(resolution?.provenance),
      scanSummary: scanSummary({
        status: "generic-public-source",
        scanResult,
        matchingOffers: [],
        reviewReasons,
      }),
      jdCapture: { status: "not-applicable", capturedCount: 0 },
      proposedAction: "approve-public-source",
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
  const floors = compensationFloors(context);
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

  const hasVerifiedPublicUrl =
    resolution?.ok !== false && Boolean(resolution?.jobBoardUrl || resolution?.careersUrl);
  const genericPublic =
    hasVerifiedPublicUrl &&
    (resolution?.status === "generic_public" ||
      resolution?.classification === "generic_public" ||
      resolution?.classification === "unsupported_public" ||
      resolution?.cacheOnly === true ||
      !resolution?.atsProvider);
  if (genericPublic) {
    return genericPublicProposal({ seed, resolution, scanResult, proposalId, version });
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

  const compStates = offers.map((offer) => compStateForOffer(offer, floors));
  if (compStates.every((state) => state.rejectReasons.length > 0)) {
    const rejectReasons = unique(compStates.flatMap((state) => state.rejectReasons));
    const reason = rejectReasons[0];
    return rejectedResult({
      seed,
      resolution,
      scanResult,
      proposalId,
      version,
      reason,
      rejectReasons,
      status: reason,
    });
  }

  const viableOffers = offers.filter((offer, index) => {
    if (compStates[index].rejectReasons.length > 0) return false;
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
  const hasClearComp = viableOffers.some((offer) => compStateForViableOffer(offer).clearsFloors);
  const reviewReasons = [];

  if (!hasClearComp) {
    for (const offer of viableOffers) {
      for (const reason of compStateForViableOffer(offer).reviewReasons) {
        if (COMP_REVIEW_FLAGS.has(reason) && !reviewReasons.includes(reason)) {
          reviewReasons.push(reason);
        }
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
    : compStateForViableOffer(viableOffers[0]).reviewReasons[0] || "";

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
        compStatus,
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
