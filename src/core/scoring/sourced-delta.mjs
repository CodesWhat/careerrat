import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import { postingIdentityKeys } from "./sourced-identity.mjs";
import { extractReqId } from "./sourced-scanner.mjs";

export function loadSnapshot(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const offers = Array.isArray(data) ? data : Array.isArray(data.offers) ? data.offers : [];
  return {
    path,
    label: data.source || basename(path),
    generatedAt: data.generatedAt || null,
    offers,
    raw: data,
  };
}

export function latestSnapshotPair({
  dir = userPath({}, "workspace/scan-results"),
  source = "",
  baselineOk = false,
} = {}) {
  const needle = source.toLowerCase();
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = []; // no scan-results dir yet → falls through to the clean "need two snapshots" error
  }
  const files = entries
    .filter((file) => file.endsWith(".json"))
    .filter((file) => !needle || file.toLowerCase().includes(needle))
    .map((file) => join(dir, file))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  if (files.length === 1 && baselineOk) {
    return {
      previous: null,
      current: files[0],
      files,
      baseline: true,
    };
  }
  if (files.length < 2) {
    throw new Error(
      `Need at least two snapshot files in ${dir}${source ? ` matching "${source}"` : ""}`
    );
  }
  return {
    previous: files[files.length - 2],
    current: files[files.length - 1],
    files,
  };
}

// A single stable label for one offer, kept for callers that just want ONE
// display id (deltaId, logging). Explicit reqId wins, then a URL-derived
// provider key, then a normalized-URL/company+title fallback: the FIRST
// match, in that order. Diffing/dedupe use offerIdentityKeys below instead:
// this single-label reduction is exactly what let a posting carried both
// directly (URL-derived key) and through an aggregator (its own reqId)
// report as two different postings (CR-29 round 3).
export function offerIdentity(offer) {
  if (offer?.reqId) return String(offer.reqId).toLowerCase();
  const req = extractReqId(offer?.url || offer?.hiringCafeUrl || "");
  if (req.id) return req.id.toLowerCase();
  const url = normalizeUrl(offer?.url || offer?.hiringCafeUrl || "");
  if (url) return `url:${url}`;
  const company = normalizeText(offer?.company);
  const title = normalizeText(offer?.title || offer?.role);
  return company && title ? `role:${company}::${title}` : "";
}

// The full identity-key SET for one offer, used for every diff/dedupe
// membership check below (previous-vs-current, and repo seenIds). Unlike
// offerIdentity, this keeps every key a posting resolves to: an aggregator's
// own reqId (e.g. hiringcafe:x) AND a URL-derived provider key (e.g.
// Workday's tenant-scoped requisition id) when postingIdentityKeys says they
// diverge, so two representations of the same posting match by
// INTERSECTION instead of only agreeing when one happens to win the
// single-label reduction above. Kept in the same raw (unprefixed) shape
// offerIdentity has always produced, since seenIds (buildOfferIdentitySet's
// callers, and callers that pass their own seenIds) is an external contract
// built on that shape.
export function offerIdentityKeys(offer) {
  const keys = new Set();
  // postingIdentityKeys only looks at row.url/row.link: snapshot offers
  // (unlike DB rows) can carry ONLY hiringCafeUrl with no outbound url at
  // all, so fall back to it for identity purposes exactly like offerIdentity
  // above already does; offer.url still wins whenever it's present.
  const withUrlFallback = offer?.url ? offer : { ...offer, url: offer?.hiringCafeUrl };
  for (const key of postingIdentityKeys(withUrlFallback)) {
    if (key.startsWith("req:")) keys.add(key.slice(4));
  }
  const url = normalizeUrl(offer?.url || offer?.hiringCafeUrl || "");
  if (url) keys.add(`url:${url}`);
  if (keys.size) return [...keys];
  const company = normalizeText(offer?.company);
  const title = normalizeText(offer?.title || offer?.role);
  return company && title ? [`role:${company}::${title}`] : [];
}

export function buildOfferIdentitySet(offers = []) {
  const set = new Set();
  for (const offer of offers) for (const key of offerIdentityKeys(offer)) set.add(key);
  return set;
}

// Diffs `current` against `previous` with a real one-to-one (key -> owner)
// match instead of flattened key SETS (CR-29 round 13, Codex review of PR
// #304). Flattened sets only asked "does ANY previous offer hold one of this
// current offer's keys" — so a current row bridging previous posting A's
// aggregator ID and previous posting B's Workday URL matched SOME key for
// EACH, counted as one clean carry, and left BOTH A and B off the removed
// list (zero removals) even though the bridge can't actually be a
// continuation of both distinct postings at once.
//
// previousOwnerByKey below maps each identity key to the SPECIFIC previous
// offer that holds it (an index, not a boolean), so a current offer's match
// resolves to the actual SET of distinct previous owners it touches:
//   - zero owners  -> new
//   - one owner, not already claimed by an earlier current offer -> carried
//     (that previous owner is matched: excluded from removedOffers)
//   - more than one distinct owner, OR its one owner already claimed by an
//     earlier current offer -> a conflict, never a clean carry. When a
//     multi-owner bridge's owners aren't ALL already claimed, the first
//     still-unclaimed one is marked matched (one of the previous postings
//     really did keep publishing under a representation this row also
//     carries — we just can't tell WHICH, so claiming one slot rather than
//     both keeps removal counting honest about the others).
// removedOffers is then every previous offer whose index never got matched.
export function diffSnapshotOffers({ current = [], previous = [], seenIds = new Set() }) {
  const previousKeySets = previous.map(offerIdentityKeys);
  const currentKeySets = current.map(offerIdentityKeys);
  const repoSeen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);

  const previousOwnerByKey = new Map();
  previousKeySets.forEach((keys, index) => {
    for (const key of keys) if (!previousOwnerByKey.has(key)) previousOwnerByKey.set(key, index);
  });

  const newOffers = [];
  const carriedOffers = [];
  const conflictOffers = [];
  const matchedPreviousIndexes = new Set();
  const claimedPreviousIndexes = new Set();

  current.forEach((offer, index) => {
    const keys = currentKeySets[index];
    const enriched = {
      ...offer,
      deltaId: offerIdentity(offer),
      repoDuplicate: keys.some((key) => repoSeen.has(key)),
    };
    const owners = new Set();
    for (const key of keys) {
      const ownerIndex = previousOwnerByKey.get(key);
      if (ownerIndex !== undefined) owners.add(ownerIndex);
    }
    if (owners.size === 0) {
      newOffers.push(enriched);
      return;
    }
    if (owners.size === 1) {
      const [ownerIndex] = owners;
      if (!claimedPreviousIndexes.has(ownerIndex)) {
        claimedPreviousIndexes.add(ownerIndex);
        matchedPreviousIndexes.add(ownerIndex);
        carriedOffers.push(enriched);
        return;
      }
    } else {
      for (const ownerIndex of owners) {
        if (!claimedPreviousIndexes.has(ownerIndex)) {
          claimedPreviousIndexes.add(ownerIndex);
          matchedPreviousIndexes.add(ownerIndex);
          break;
        }
      }
    }
    // Either a multi-owner bridge, or its single owner was already claimed
    // by an earlier current offer — ambiguous either way.
    conflictOffers.push(enriched);
  });

  const removedOffers = previous
    .map((offer, index) => ({
      offer: { ...offer, deltaId: offerIdentity(offer) },
      index,
      keys: previousKeySets[index],
    }))
    .filter(({ index, keys }) => keys.length && !matchedPreviousIndexes.has(index))
    .map(({ offer }) => offer);

  return { current, previous, newOffers, carriedOffers, removedOffers, conflictOffers };
}

export function summarizeDelta(delta) {
  return {
    current: delta.current.length,
    previous: delta.previous.length,
    newSincePrevious: delta.newOffers.length,
    newAfterRepoDedupe: delta.newOffers.filter((offer) => !offer.repoDuplicate).length,
    carried: delta.carriedOffers.length,
    removed: delta.removedOffers.length,
    conflicts: (delta.conflictOffers || []).length,
  };
}

export function renderDeltaMarkdown({ currentPath, previousPath, delta, summary }) {
  const lines = [
    `# Sourced Delta - ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Current: \`${currentPath}\``,
    `Previous: \`${previousPath || "empty baseline (first matching snapshot)"}\``,
    "",
    "Summary:",
    `- Current snapshot: ${summary.current}`,
    `- Previous snapshot: ${summary.previous}`,
    `- New since previous: ${summary.newSincePrevious}`,
    `- New after repo dedupe: ${summary.newAfterRepoDedupe}`,
    `- Carried over: ${summary.carried}`,
    `- Removed since previous: ${summary.removed}`,
    "",
    "| Repo New? | Company | Role | Location | Source | Flags |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const offer of delta.newOffers) {
    const flags = [
      offer.repoDuplicate ? "already-seen-in-repo" : "new-to-repo",
      offer.reqId || offer.deltaId || "",
      ...(Array.isArray(offer.ruleFlags) ? offer.ruleFlags : []),
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      [
        offer.repoDuplicate ? "no" : "yes",
        escapeCell(offer.company || "Unknown"),
        `[${escapeCell(offer.title || offer.role || "Untitled")}](${offer.url || offer.hiringCafeUrl || "#"})`,
        escapeCell(offer.location || "N/A"),
        escapeCell(offer.source || "snapshot"),
        escapeCell(flags || "-"),
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |")
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

// Exported for reuse by src/core/intake/match.mjs (M9's tracker-match dedup
// logic reuses the exact same tracking-param-stripping/hash-trim rule this
// module already applies, rather than a second copy).
export function normalizeUrl(raw) {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|ref|gh_src|source)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(raw).trim();
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function escapeCell(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
