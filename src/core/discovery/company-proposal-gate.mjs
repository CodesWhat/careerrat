function proposalCompany(seed, resolution) {
  return {
    name: String(resolution?.companyName || seed?.name || "").trim(),
    domain: String(resolution?.companyDomain || seed?.domain_hint || "").trim(),
  };
}

function matchingOffers(scanResult) {
  return (Array.isArray(scanResult?.offers) ? scanResult.offers : []).filter(
    (offer) => offer && offer.gate !== "likely-cut"
  );
}

export function buildCompanyProposal({
  seed,
  resolution,
  scanResult,
  proposalId,
  version = 1,
} = {}) {
  const matches = matchingOffers(scanResult);
  const errors = Array.isArray(scanResult?.errors) ? scanResult.errors : [];
  const company = proposalCompany(seed, resolution);

  if (!resolution?.atsProvider || !resolution?.jobBoardUrl) {
    return {
      rejected: {
        company,
        reason: "unsupported-company-board",
        rejectReasons: ["No supported ATS board resolved."],
      },
    };
  }

  if (matches.length === 0) {
    return {
      rejected: {
        company,
        jobBoardUrl: resolution.jobBoardUrl,
        atsProvider: resolution.atsProvider,
        reason: "no-current-role-signal",
        rejectReasons: ["No current matching roles were found."],
        scanSummary: {
          status: "no-matching-roles",
          currentRoleCount: Array.isArray(scanResult?.offers) ? scanResult.offers.length : 0,
          matchingRoleCount: 0,
          errors,
        },
      },
    };
  }

  const roleSeen = matches[0]?.title || "";
  return {
    proposal: {
      proposalId,
      company,
      why: String(seed?.why || "Manual seed resolved to a supported ATS board.").trim(),
      roleFamily: String(seed?.role_family_hint || "").trim(),
      roleSeen,
      careersUrl: resolution.careersUrl || resolution.jobBoardUrl,
      jobBoardUrl: resolution.jobBoardUrl,
      atsProvider: resolution.atsProvider,
      classification: "supported-ats",
      confidenceTier: "high-confidence",
      provenance: Array.isArray(resolution.provenance) ? resolution.provenance : [],
      scanSummary: {
        status: "matching-roles-found",
        currentRoleCount: Array.isArray(scanResult?.offers) ? scanResult.offers.length : 0,
        matchingRoleCount: matches.length,
        errors,
      },
      jdCapture: {
        status: matches.some((offer) => String(offer.bodyText || offer.description || "").trim())
          ? "captured-in-proposal-state"
          : "partial",
      },
      proposedAction: "approve-supported-ats",
      reviewReasons: [],
      rejectReasons: [],
      capturedOffers: matches,
      version,
    },
  };
}
