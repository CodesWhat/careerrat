import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { userPath } from "../paths/workspace.mjs";
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

export function buildOfferIdentitySet(offers = []) {
  return new Set(offers.map(offerIdentity).filter(Boolean));
}

export function diffSnapshotOffers({ current = [], previous = [], seenIds = new Set() }) {
  const previousIds = buildOfferIdentitySet(previous);
  const currentIds = buildOfferIdentitySet(current);
  const repoSeen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);

  const newOffers = [];
  const carriedOffers = [];
  for (const offer of current) {
    const id = offerIdentity(offer);
    const enriched = { ...offer, deltaId: id, repoDuplicate: id ? repoSeen.has(id) : false };
    if (id && previousIds.has(id)) carriedOffers.push(enriched);
    else newOffers.push(enriched);
  }

  const removedOffers = previous
    .map((offer) => ({ ...offer, deltaId: offerIdentity(offer) }))
    .filter((offer) => offer.deltaId && !currentIds.has(offer.deltaId));

  return { current, previous, newOffers, carriedOffers, removedOffers };
}

export function summarizeDelta(delta) {
  return {
    current: delta.current.length,
    previous: delta.previous.length,
    newSincePrevious: delta.newOffers.length,
    newAfterRepoDedupe: delta.newOffers.filter((offer) => !offer.repoDuplicate).length,
    carried: delta.carriedOffers.length,
    removed: delta.removedOffers.length,
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
