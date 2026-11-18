// Company-name matching shared by discovery's already-tracked, excluded and
// prompt-dedupe checks. One key function so "A & B" and "A and B", and
// "Acme" and "Acme, Inc.", land on the same key everywhere they're compared.
//
// This is NOT the board-resolver's persisted cache key
// (company-board-resolver.mjs normalizeCompanyKey): stored cache keys must
// keep resolving, so that algorithm stays as it is.

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

function list(value) {
  return Array.isArray(value) ? value : [];
}

// A bare domain keeps its dots and never has its suffix stripped (it has no
// "-"-separated tokens), so "acme.com" and "acme.io" stay distinct from each
// other and from the name "Acme".
export function companyMatchKey(value) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/&/g, " and ")
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

export function companyMatchesAny(values, company) {
  const keys = new Set(
    [companyMatchKey(company?.name), companyMatchKey(company?.domain)].filter(Boolean)
  );
  return list(values).some((value) => keys.has(companyMatchKey(value)));
}
