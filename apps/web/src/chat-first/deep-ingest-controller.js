const EMPTY_LIST = [];
const DEEP_INGEST_REASONS = Object.freeze({
  defer: "Review later",
  reject: "Not relevant to my work",
});

function list(value) {
  return Array.isArray(value) ? value : EMPTY_LIST;
}

function proposalPayload(row) {
  const payload = row?.proposal?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

function proposalSummary(row) {
  const payload = proposalPayload(row);
  for (const field of [
    "summary",
    "claim",
    "description",
    "boundary",
    "signal",
    "sample",
    "body",
    "text",
  ]) {
    const value = payload[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return (
    Object.values(payload)
      .find((value) => typeof value === "string" && value.trim())
      ?.trim() || ""
  );
}

function firstWords(value, count = 9) {
  const words = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const text = words.slice(0, count).join(" ");
  return words.length > count ? `${text}…` : text;
}

function proposalTitle(row, summary) {
  const title = proposalPayload(row).title;
  return typeof title === "string" && title.trim() ? title.trim() : firstWords(summary);
}

function proposalQuote(row) {
  const quote = row?.proposal?.supportingQuote;
  return typeof quote === "string" ? quote : "";
}

function isReviewable(row) {
  const validation = row?.proposal?.validation?.status;
  return (
    validation !== "source_scanned" &&
    validation !== "blocked" &&
    row?.proposal?.status !== "manual_fallback"
  );
}

function sourceLabel(source) {
  const url = source?.metadata?.url || source?.url;
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return source?.label || url;
    }
  }
  const path = source?.metadata?.repoPath || source?.repoPath;
  if (path) return String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path);
  const name = source?.name || source?.fileName || source?.label;
  if (name) return name;
  const preview = firstWords(source?.textPreview, 6);
  return preview ? `Pasted notes: ${preview}` : "Pasted notes";
}

function sourceStatusLabel(source, hasProposals) {
  if (hasProposals) return "Proposals drafted";
  if (source?.status === "proposal_ready") return "Ready to analyze";
  if (["captured", "scanning"].includes(source?.status)) return "Reading source";
  if (["failed", "manual_fallback"].includes(source?.status)) return "Needs attention";
  return "Saved locally";
}

function confirmedCount(state) {
  if (Number.isFinite(Number(state?.counts?.confirmed))) return Number(state.counts.confirmed);
  return Object.values(state?.confirmed || {}).reduce(
    (total, rows) => total + list(rows).length,
    0
  );
}

export function buildDeepIngestProposalItem(row, edits = {}) {
  const summary = edits.summary ?? proposalSummary(row);
  return {
    ...proposalPayload(row),
    ...edits,
    sourceId: row.sourceId,
    title: edits.title ?? proposalTitle(row, summary),
    summary,
    supportingQuote: edits.supportingQuote ?? proposalQuote(row),
  };
}

export function buildDeepIngestReview(state) {
  if (!state) {
    return {
      evidenceItems: ["Your confirmed evidence stays local"],
      lastSession: null,
      counts: { sources: 0, proposals: 0, reviewQueue: 0, confirmed: 0, openGaps: 0 },
      sources: [],
      proposals: [],
    };
  }
  const allProposals = list(state.proposals);
  const queueRows = Array.isArray(state.reviewQueue)
    ? state.reviewQueue
    : allProposals.filter((row) => row?.status === "review_needed");
  const reviewRows = queueRows.filter(isReviewable);
  const cards = reviewRows.map((row) => {
    const summary = proposalSummary(row);
    return {
      ...row,
      raw: row,
      title: proposalTitle(row, summary),
      summary,
      supportingQuote: proposalQuote(row),
    };
  });
  const sources = list(state.sources).map((source) => {
    const hasProposals = allProposals.some(
      (row) => row?.sourceId === source?.id && isReviewable(row)
    );
    return {
      ...source,
      raw: source,
      label: sourceLabel(source),
      statusLabel: sourceStatusLabel(source, hasProposals),
      canAnalyze: source?.status === "proposal_ready" && !hasProposals,
    };
  });
  const counts = {
    sources: Number(state?.counts?.sources ?? sources.length),
    proposals: Number(state?.counts?.proposals ?? allProposals.length),
    reviewQueue: cards.length,
    confirmed: confirmedCount(state),
    openGaps: Number(state?.counts?.openGaps ?? list(state.openGaps).length),
  };
  const evidenceItems = [
    counts.confirmed ? `${counts.confirmed} confirmed items` : null,
    counts.reviewQueue ? `${counts.reviewQueue} ready to review` : null,
    counts.sources ? `${counts.sources} source${counts.sources === 1 ? "" : "s"} saved` : null,
  ].filter(Boolean);
  return {
    evidenceItems: evidenceItems.length ? evidenceItems : ["Your confirmed evidence stays local"],
    lastSession: sources[0]?.label || null,
    counts,
    sources,
    proposals: cards,
  };
}

export async function captureSourceAndRefresh({ api, kind, value }) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error("Add some material before saving it.");
  const payload =
    kind === "repo"
      ? /^https?:\/\//i.test(clean)
        ? { targetShape: "auto", sourceKind: "repo", url: clean }
        : { targetShape: "auto", sourceKind: "repo", repoPath: clean }
      : { targetShape: "auto", sourceKind: "paste", text: clean };
  const result = await api.submitDeepIngestSource(payload);
  const view = await api.getDeepIngestState();
  return { result, view };
}

export async function buildProposalsAndRefresh({ api, source }) {
  const result = await api.buildDeepIngestProposals({
    sourceId: source.id,
    targetShape: source.targetShape || "auto",
  });
  const view = await api.getDeepIngestState();
  return { result, view };
}

export async function decideProposalAndRefresh({ api, proposal, decision, edits = {}, reason }) {
  const payload = {
    proposalId: proposal.id,
    expectedVersion: proposal.version,
    decision,
  };
  const resolvedReason = reason || DEEP_INGEST_REASONS[decision];
  if (resolvedReason) payload.reason = resolvedReason;
  if (["save_edits", "confirm"].includes(decision)) {
    payload.edits = { items: [buildDeepIngestProposalItem(proposal, edits)] };
  }
  const result = await api.decideDeepIngestProposal(payload);
  const view = await api.getDeepIngestState();
  return { result, view };
}
