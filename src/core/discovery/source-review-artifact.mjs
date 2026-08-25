const DISCOVERY_FENCE = /```careerrat:discovery\s*\r?\n([\s\S]*?)\r?\n```/g;
const PERSISTED_TABLE_HEADER = "| # | Board | Source type | Why relevant | Status |";
const PERSISTED_TABLE_DIVIDER = /^\|\s*---\s*\|\s*---\s*\|\s*---\s*\|\s*---\s*\|\s*---\s*\|$/;
const PERSISTED_TABLE_ROW =
  /^\|\s*(\d{1,2})\s*\|\s*\[([^\][|]{1,240})\]\(([^)\s|]{1,4000})\)\s*\|\s*([a-z-]{1,40})\s*\|\s*([^|\r\n]{1,1000})\s*\|\s*([^|\r\n]{1,1000})\s*\|$/;
const SOURCE_TYPES = new Set(["url-query", "rss", "browser"]);
const SOURCE_STATUSES = new Set(["proposed", "rejected"]);
const SOURCE_CONFIDENCE = new Set(["high", "borderline"]);

function cleanString(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= max ? text : "";
}

function publicHttpUrl(value) {
  const text = cleanString(value, 4_000);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function stableHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function normalizeCandidate(value) {
  const label = cleanString(value?.label, 240);
  const url = publicHttpUrl(value?.url);
  const sourceType = cleanString(value?.sourceType, 40);
  const why = cleanString(value?.why, 1_000);
  const status = cleanString(value?.status, 40);
  if (!label || !url || !SOURCE_TYPES.has(sourceType) || !why || !SOURCE_STATUSES.has(status)) {
    return null;
  }
  if (status === "proposed") {
    const confidence = cleanString(value?.confidence, 40);
    if (!SOURCE_CONFIDENCE.has(confidence) || value?.rejectionReason) return null;
    return { label, url, sourceType, why, status, confidence };
  }
  const rejectionReason = cleanString(value?.rejectionReason, 1_000);
  if (!rejectionReason || value?.confidence) return null;
  return { label, url, sourceType, why, status, rejectionReason };
}

export function normalizeSourceReviewArtifact(value) {
  if (value?.kind !== "source_review" || !Array.isArray(value.candidates)) return null;
  if (value.candidates.length < 1 || value.candidates.length > 20) return null;
  const candidates = value.candidates.map(normalizeCandidate);
  if (candidates.some((candidate) => !candidate)) return null;
  if (new Set(candidates.map((candidate) => candidate.url)).size !== candidates.length) return null;

  const identity = candidates
    .map((candidate) =>
      [
        candidate.label,
        candidate.url,
        candidate.sourceType,
        candidate.status,
        candidate.confidence || candidate.rejectionReason,
      ].join("\u001f")
    )
    .join("\u001e");
  const id = `source-review-${stableHash(identity)}`;
  const identified = candidates.map((candidate) => ({
    ...candidate,
    id: `${id}:source:${stableHash(candidate.url)}`,
    kind: "source_proposal",
  }));
  const proposalCount = identified.filter((candidate) => candidate.status === "proposed").length;
  const highConfidenceCount = identified.filter(
    (candidate) => candidate.status === "proposed" && candidate.confidence === "high"
  ).length;
  const borderlineCount = identified.filter(
    (candidate) => candidate.status === "proposed" && candidate.confidence === "borderline"
  ).length;
  const rejectedCount = identified.length - proposalCount;

  return {
    id,
    kind: "source_review",
    step: "research-boards",
    candidates: identified,
    screenedCount: identified.length,
    proposalCount,
    highConfidenceCount,
    borderlineCount,
    rejectedCount,
    completion: {
      id: `${id}:complete`,
      kind: "discovery_complete",
      step: "research-boards",
    },
  };
}

function sourceReviewSummary(review) {
  const count = Number(review?.proposalCount) || 0;
  return `I found ${count} useful source${count === 1 ? "" : "s"}. Nothing has been added yet.`;
}

export function hasPersistedSourceReviewTable(value) {
  return String(value || "")
    .split(/\r?\n/)
    .some((line) => line.trim() === PERSISTED_TABLE_HEADER);
}

function parsePersistedStatus(value) {
  if (value === "NEW") return { status: "proposed", confidence: "high" };
  const borderline = /^NEW \(borderline: ([^)]+)\)$/.exec(value);
  if (borderline && cleanString(borderline[1], 500)) {
    return { status: "proposed", confidence: "borderline" };
  }
  const rejected = /^REJECTED: (.+)$/.exec(value);
  const rejectionReason = cleanString(rejected?.[1], 1_000);
  return rejectionReason ? { status: "rejected", rejectionReason } : null;
}

function normalizePersistedSourceReviewTable(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const headerIndex = lines.indexOf(PERSISTED_TABLE_HEADER);
  if (headerIndex < 0 || !PERSISTED_TABLE_DIVIDER.test(lines[headerIndex + 1] || "")) return null;

  const candidates = [];
  let lineIndex = headerIndex + 2;
  while (lineIndex < lines.length && lines[lineIndex].startsWith("|")) {
    const match = PERSISTED_TABLE_ROW.exec(lines[lineIndex]);
    if (!match || Number(match[1]) !== candidates.length + 1) return null;
    const status = parsePersistedStatus(match[6].trim());
    if (!status) return null;
    candidates.push({
      label: match[2].trim(),
      url: match[3].trim(),
      sourceType: match[4].trim(),
      why: match[5].trim(),
      ...status,
    });
    lineIndex += 1;
  }
  if (candidates.length < 1 || candidates.length > 20) return null;

  const footer = lines.slice(lineIndex).filter(Boolean);
  if (footer.length !== 4) return null;
  const screened = /^BOARDS FOUND: (\d{1,2}) screened$/.exec(footer[0]);
  const proposed =
    /^PROPOSED \(new\): (\d{1,2}) \((\d{1,2}) high-confidence, (\d{1,2}) borderline\/medium\)$/.exec(
      footer[1]
    );
  const rejected = /^REJECTED: (\d{1,2})(?: \(reasons?: [^)]+\))?$/.exec(footer[2]);
  if (!screened || !proposed || !rejected || !/^AUTO-ADDED: none(?: \([^)]+\))?$/.test(footer[3])) {
    return null;
  }

  const proposalCount = candidates.filter((candidate) => candidate.status === "proposed").length;
  const highConfidenceCount = candidates.filter(
    (candidate) => candidate.status === "proposed" && candidate.confidence === "high"
  ).length;
  const borderlineCount = candidates.filter(
    (candidate) => candidate.status === "proposed" && candidate.confidence === "borderline"
  ).length;
  const rejectedCount = candidates.length - proposalCount;
  if (
    Number(screened[1]) !== candidates.length ||
    Number(proposed[1]) !== proposalCount ||
    Number(proposed[2]) !== highConfidenceCount ||
    Number(proposed[3]) !== borderlineCount ||
    Number(rejected[1]) !== rejectedCount
  ) {
    return null;
  }
  return normalizeSourceReviewArtifact({ kind: "source_review", candidates });
}

export function parsePersistedSourceReviewTable(value) {
  const review = normalizePersistedSourceReviewTable(value);
  return {
    text: review
      ? sourceReviewSummary(review)
      : "I couldn't prepare the source review. Run it again.",
    artifacts: review ? [review] : [],
  };
}

export function parseSourceReviewOutput(value) {
  const text = String(value || "");
  const artifacts = [];
  for (const match of text.matchAll(DISCOVERY_FENCE)) {
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const review = normalizeSourceReviewArtifact(parsed);
    if (review) artifacts.push(review);
  }
  const review = artifacts.at(-1) || null;
  return {
    text: review
      ? sourceReviewSummary(review)
      : "I couldn't prepare the source review. Run it again.",
    artifacts: review ? [review] : [],
  };
}
