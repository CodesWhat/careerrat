// companyUnion.js — Lane A / R2. Every write to targeting.tracked_companies
// must be a UNION of the existing list plus newly accepted names, deduped,
// as plain strings — never a replace. Both deepMerge paths in this codebase
// (src/cli/onboard-route.mjs's deepMerge, and the config-store patch path it
// mirrors) replace any array in a patch wholesale rather than merging it
// element-wise, so a caller that posts only the new name(s) would silently
// drop every company already tracked. Callers must pre-compute the full
// resulting array with this helper before calling
// saveCandidateFile("targeting", { tracked_companies: ... }).
//
// Shared between InterviewSurface's company_add confirm-pill handler and
// FilePane's company-proposal accept action so both write the identical
// shape.
export function unionCompanyNames(existing, added) {
  const seen = new Set();
  const result = [];
  for (const raw of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(added) ? added : []),
  ]) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}
