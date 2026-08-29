// Values from the maintainer's real candidate workspace that must never reach a
// tracked file. Assembled from fragments so this list cannot match itself, and
// so a careless grep of the repo does not surface them either.
//
// Two consumers, one list:
//   - tests/release-safety.test.mjs scans tracked source and the built
//     apps/web/dist for any of these.
//   - scripts/lib/live-search-receipts.mjs drops matching rows out of release
//     evidence. A live search legitimately turns up public postings from
//     companies on this list, and committing one trips the guard above even
//     though nothing personal leaked.
//
// This file is itself excluded from that scan; adding a sentinel here without
// keeping that exclusion in place makes the guard fail on its own source.
export const PERSONAL_SENTINELS = [
  ["Scott", "Benson"].join(" "),
  "Bloomfield",
  "$" + "145K",
  "145" + "000",
  "sctt" + "bnsn",
  ["Work", "OS"].join(""),
  ["work", "os"].join(""),
  "Pw" + "C",
  "pwc",
  "workos" + ".com",
  "pwc" + ".com",
  "shopify" + ".com",
  ["Anna", "Meyer"].join(" "),
  ["Robert", "Choe"].join(" "),
  ["Alex", "Aberg"].join(" "),
  ["Juniper", "Square"].join(" "),
  "Sabri" + "na",
  "225" + "000",
  "220" + "000",
  "225" + "K",
];

export function containsPersonalSentinel(value) {
  const haystack = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return PERSONAL_SENTINELS.some((sentinel) => haystack.includes(sentinel));
}
