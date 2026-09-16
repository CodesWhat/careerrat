// Contact details can come from a filename or document header even when the
// resume body was not read. Accept only a nonblank transcription with at least
// one substantive claim or source section; do not impose a minimum length or
// require work experience, which would reject short and early-career resumes.
export function hasUsableResumeContent({ fullText, claims, sections } = {}) {
  if (typeof fullText !== "string" || !fullText.trim()) return false;
  const claimFacts =
    Array.isArray(claims) &&
    claims.some((claim) => typeof claim?.claim === "string" && claim.claim.trim());
  const sectionFacts = Object.values(sections || {}).some(
    (count) => Number.isFinite(count) && count > 0
  );
  return claimFacts || sectionFacts;
}
