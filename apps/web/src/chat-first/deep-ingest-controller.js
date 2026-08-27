const EMPTY_LIST = [];
const DEEP_INGEST_OPERATION_STORAGE_KEY = "careerrat:operation:deep-ingest";
const ACTIVE_OPERATION_STATUSES = new Set(["queued", "running"]);
const DEEP_INGEST_OPERATION_KINDS = new Set([
  "deep-ingest-source-scan",
  "deep-ingest-proposal-build",
]);
const DEEP_INGEST_REASONS = Object.freeze({
  defer: "Review later",
  reject: "Not relevant to my work",
});
const DEEP_INGEST_TEXT_DECISIONS = new Map([
  ["confirm", "confirm"],
  ["confirm it", "confirm"],
  ["confirm this", "confirm"],
  ["yes", "confirm"],
  ["yes confirm", "confirm"],
  ["yes confirm it", "confirm"],
  ["yes confirm this", "confirm"],
  ["looks good", "confirm"],
  ["defer", "defer"],
  ["defer it", "defer"],
  ["defer this", "defer"],
  ["later", "defer"],
  ["review later", "defer"],
  ["review this later", "defer"],
  ["not now", "defer"],
  ["reject", "reject"],
  ["reject it", "reject"],
  ["reject this", "reject"],
  ["no", "reject"],
  ["not relevant", "reject"],
  ["skip", "reject"],
  ["skip it", "reject"],
  ["skip this", "reject"],
]);

function list(value) {
  return Array.isArray(value) ? value : EMPTY_LIST;
}

function cleanOperationId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 200 ? id : null;
}

function cleanReferenceId(value) {
  const id = String(value || "").trim();
  return id && id.length <= 240 ? id : null;
}

function savedOperationRecord(value = {}) {
  const operationId = cleanOperationId(value.operationId || value.id);
  if (!operationId) return null;
  const sourceVersion = Number(value.sourceVersion);
  const proposalIds = list(value.proposalIds).map(cleanReferenceId).filter(Boolean).slice(0, 200);
  return {
    operationId,
    ...(cleanReferenceId(value.kind) ? { kind: cleanReferenceId(value.kind) } : {}),
    ...(cleanReferenceId(value.sourceId) ? { sourceId: cleanReferenceId(value.sourceId) } : {}),
    ...(Number.isInteger(sourceVersion) && sourceVersion > 0 ? { sourceVersion } : {}),
    ...(cleanReferenceId(value.targetShape)
      ? { targetShape: cleanReferenceId(value.targetShape) }
      : {}),
    ...(cleanReferenceId(value.proposalSetId)
      ? { proposalSetId: cleanReferenceId(value.proposalSetId) }
      : {}),
    ...(proposalIds.length ? { proposalIds } : {}),
  };
}

export function resolveDeepIngestOperationStorage(scope = globalThis) {
  try {
    return scope?.localStorage || null;
  } catch {
    return null;
  }
}

export function readDeepIngestOperation(storage) {
  if (!storage) return null;
  try {
    return savedOperationRecord(JSON.parse(storage.getItem(DEEP_INGEST_OPERATION_STORAGE_KEY)));
  } catch {
    return null;
  }
}

export function rememberDeepIngestOperation(storage, operation, subject = {}) {
  const resultRef = operation?.resultRef || {};
  const record = savedOperationRecord({
    ...subject,
    operationId: operation?.id,
    kind: operation?.kind || subject.kind,
    sourceId:
      resultRef.sourceId ||
      (resultRef.type === "deep-ingest-source" && resultRef.id) ||
      subject.sourceId,
    sourceVersion: resultRef.sourceVersion || resultRef.version || subject.sourceVersion,
    targetShape: resultRef.targetShape || subject.targetShape,
    proposalSetId:
      (resultRef.type === "deep-ingest-proposal-set" && resultRef.id) || subject.proposalSetId,
    proposalIds: resultRef.proposalIds || subject.proposalIds,
  });
  if (!storage || !record) return record;
  try {
    storage.setItem(DEEP_INGEST_OPERATION_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Managed desktops and private browsing can reject local storage writes.
  }
  return record;
}

export function clearDeepIngestOperation(storage, expectedId) {
  if (!storage) return false;
  const current = readDeepIngestOperation(storage);
  if (expectedId && current?.operationId !== cleanOperationId(expectedId)) return false;
  try {
    storage.removeItem(DEEP_INGEST_OPERATION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function waitForNextRead(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Deep Ingest stopped."));
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("Deep Ingest stopped."));
      },
      { once: true }
    );
  });
}

function deepIngestFailure(cause, operation) {
  const code = String(
    operation?.error?.code || cause?.body?.code || cause?.body?.error?.code || cause?.code || ""
  );
  let message;
  if (cause?.status === 404 || code === "NOT_FOUND") {
    message = "CareerRat can't find that saved Deep Ingest run. Start it again from Deep Ingest.";
  } else if (code === "APP_OPERATION_SERVER_STOPPED" || code === "ABORTED") {
    message =
      "The app closed before Deep Ingest finished. Your source is still saved. Try it again.";
  } else if (code === "VERSION_CONFLICT" || code === "STALE_WRITE") {
    message = "That source changed while CareerRat was reading it. Try the current version again.";
  } else {
    message =
      operation?.error?.message ||
      cause?.body?.error?.message ||
      cause?.body?.error ||
      "CareerRat couldn't finish Deep Ingest. Try it again.";
  }
  const error = new Error(message);
  error.code = code || "DEEP_INGEST_FAILED";
  error.retryable = operation?.error?.retryable !== false;
  error.operation = operation || null;
  return error;
}

function exactDeepIngestResult(view, resultRef) {
  if (resultRef?.type === "deep-ingest-source") {
    const source = list(view?.sources).find(
      (row) =>
        String(row?.id || "") === String(resultRef.id || "") &&
        Number(row?.version || 1) === Number(resultRef.version || 1)
    );
    if (!source) {
      throw new Error(
        "CareerRat finished reading that source, but its saved result changed. Try the current source again."
      );
    }
    const proposals = resultRef.proposalId
      ? list(view?.proposals).filter(
          (row) =>
            String(row?.id || "") === String(resultRef.proposalId) &&
            String(row?.sourceId || "") === String(resultRef.id || "")
        )
      : [];
    if (resultRef.proposalId && proposals.length !== 1) {
      throw new Error(
        "CareerRat couldn't reload the exact source review it finished. Try it again."
      );
    }
    return { source, proposals };
  }

  if (resultRef?.type === "deep-ingest-proposal-set") {
    const requestedIds = list(resultRef.proposalIds).map(String);
    if (!cleanReferenceId(resultRef.id) || !requestedIds.length) {
      throw new Error("CareerRat didn't finish with a Deep Ingest review set. Try it again.");
    }
    const requested = new Set(requestedIds);
    const proposals = list(view?.proposals).filter((row) => requested.has(String(row?.id || "")));
    const exact = proposals.every(
      (row) =>
        String(row?.sourceId || "") === String(resultRef.sourceId || "") &&
        (!row?.proposalSetId || String(row.proposalSetId) === String(resultRef.id))
    );
    if (proposals.length !== requested.size || !exact) {
      throw new Error(
        "CareerRat couldn't reload the exact Deep Ingest review it finished. Try it again."
      );
    }
    return { source: null, proposals };
  }

  throw new Error("CareerRat didn't finish with a Deep Ingest result. Try it again.");
}

function operationEnvelope(response) {
  const value = response?.data || response || {};
  return { operation: value.operation || null, subject: value.subject || {}, response };
}

function capturePayload(kind, value) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error("Add some material before saving it.");
  return kind === "repo"
    ? /^https?:\/\//i.test(clean)
      ? { targetShape: "auto", sourceKind: "repo", url: clean }
      : { targetShape: "auto", sourceKind: "repo", repoPath: clean }
    : { targetShape: "auto", sourceKind: "paste", text: clean };
}

export function createDeepIngestOperationController({
  api,
  storage = resolveDeepIngestOperationStorage(),
  pollMs = 750,
  onProgress,
  onOperation,
} = {}) {
  const starts = new Map();

  function startOnce(key, start) {
    if (starts.has(key)) return starts.get(key);
    const promise = Promise.resolve()
      .then(start)
      .then((response) => {
        const started = operationEnvelope(response);
        if (started.operation?.id) {
          const record = rememberDeepIngestOperation(storage, started.operation, started.subject);
          onOperation?.(record);
        }
        return started;
      })
      .finally(() => starts.delete(key));
    starts.set(key, promise);
    return promise;
  }

  function startCapture({ kind, value } = {}) {
    const payload = capturePayload(kind, value);
    return startOnce(`source:${JSON.stringify(payload)}`, () =>
      api.submitDeepIngestSource(payload)
    );
  }

  function startProposalBuild({ source } = {}) {
    const sourceId = cleanReferenceId(source?.id);
    if (!sourceId) throw new Error("That Deep Ingest source is no longer available.");
    const payload = { sourceId, targetShape: source.targetShape || "auto" };
    return startOnce(`proposal:${JSON.stringify(payload)}`, () =>
      api.buildDeepIngestProposals(payload)
    );
  }

  function startUpload({ file, targetShape = "auto" } = {}) {
    const name = String(file?.name || "").trim();
    if (!file || !name) throw new Error("Choose a file for Deep Ingest first.");
    const shape = String(targetShape || "auto").trim() || "auto";
    const fingerprint = [name, Number(file.size || 0), Number(file.lastModified || 0), shape].join(
      ":"
    );
    return startOnce(`upload:${fingerprint}`, () =>
      api.uploadDeepIngestFile(file, { targetShape: shape })
    );
  }

  async function follow(id, { signal } = {}) {
    const exactId = cleanOperationId(id);
    if (!exactId || typeof api?.getAppOperation !== "function") {
      throw new Error(
        "CareerRat can't reload that Deep Ingest run. Start it again from Deep Ingest."
      );
    }
    let operation;
    for (;;) {
      signal?.throwIfAborted?.();
      try {
        operation = await api.getAppOperation(exactId);
      } catch (cause) {
        throw deepIngestFailure(cause);
      }
      if (operation?.kind && !DEEP_INGEST_OPERATION_KINDS.has(operation.kind)) return null;
      onProgress?.(operation);
      if (ACTIVE_OPERATION_STATUSES.has(operation?.status)) {
        await waitForNextRead(pollMs, signal);
        continue;
      }
      if (operation?.status !== "completed") throw deepIngestFailure(null, operation);
      break;
    }
    const view = await api.getDeepIngestState();
    const exact = exactDeepIngestResult(view, operation.resultRef);
    const saved = readDeepIngestOperation(storage);
    const stillCurrent = !saved || saved.operationId === exactId;
    if (saved?.operationId === exactId) {
      rememberDeepIngestOperation(storage, operation, saved);
      clearDeepIngestOperation(storage, exactId);
    }
    if (stillCurrent) onOperation?.(null);
    return { operation, resultRef: operation.resultRef, exact, view };
  }

  async function resume({ id, signal } = {}) {
    const record = readDeepIngestOperation(storage);
    const exactId = cleanOperationId(id) || record?.operationId;
    if (!exactId) return null;
    return follow(exactId, { signal });
  }

  async function retry({ id, signal } = {}) {
    const previous = readDeepIngestOperation(storage);
    const exactId = cleanOperationId(id) || previous?.operationId;
    if (!exactId || typeof api?.retryAppOperation !== "function") {
      throw new Error(
        "CareerRat can't retry that Deep Ingest run. Start it again from Deep Ingest."
      );
    }
    let response;
    try {
      response = await api.retryAppOperation(exactId);
    } catch (cause) {
      throw deepIngestFailure(cause);
    }
    const started = operationEnvelope(response);
    if (!started.operation?.id) {
      throw new Error("CareerRat couldn't start the Deep Ingest retry. Try it again.");
    }
    const record = rememberDeepIngestOperation(storage, started.operation, previous || {});
    onOperation?.(record);
    return follow(started.operation.id, { signal });
  }

  return { follow, resume, retry, startCapture, startProposalBuild, startUpload };
}

function normalizedDecisionText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveDeepIngestTextDecision({ text, proposals } = {}) {
  const proposal = list(proposals)[0];
  if (!proposal) return null;
  const decision = DEEP_INGEST_TEXT_DECISIONS.get(normalizedDecisionText(text));
  return decision ? { proposal, decision } : null;
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
  if (["failed", "manual_fallback"].includes(source?.status)) {
    return "CareerRat couldn't read this source. Try again or remove it.";
  }
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
    const needsRecovery = ["failed", "manual_fallback"].includes(source?.status);
    return {
      ...source,
      raw: source,
      label: sourceLabel(source),
      statusLabel: sourceStatusLabel(source, hasProposals),
      canAnalyze: source?.status === "proposal_ready" && !hasProposals,
      canRetry: needsRecovery,
      canRemove: needsRecovery,
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

export async function captureSourceAndRefresh({
  api,
  kind,
  value,
  controller,
  storage,
  signal,
  onOperation,
}) {
  const lifecycle =
    controller || createDeepIngestOperationController({ api, storage, onOperation });
  const started = await lifecycle.startCapture({ kind, value });
  if (started.operation?.id) {
    const completed = await lifecycle.follow(started.operation.id, { signal });
    return { result: started.response, ...completed };
  }
  const view = await api.getDeepIngestState();
  return { result: started.response, view };
}

export async function buildProposalsAndRefresh({
  api,
  source,
  controller,
  storage,
  signal,
  onOperation,
}) {
  const lifecycle =
    controller || createDeepIngestOperationController({ api, storage, onOperation });
  const started = await lifecycle.startProposalBuild({ source });
  if (started.operation?.id) {
    const completed = await lifecycle.follow(started.operation.id, { signal });
    return { result: started.response, ...completed };
  }
  const view = await api.getDeepIngestState();
  return { result: started.response, view };
}

export async function uploadDeepIngestFilesAndRefresh({
  api,
  files,
  targetShape = "auto",
  controller,
  storage,
  signal,
  onOperation,
}) {
  const selected = Array.from(files || []);
  if (!selected.length) throw new Error("Choose at least one file for Deep Ingest.");
  const lifecycle =
    controller || createDeepIngestOperationController({ api, storage, onOperation });
  const completed = [];
  const results = [];
  let view = null;
  for (const file of selected) {
    const started = await lifecycle.startUpload({ file, targetShape });
    results.push(started.response);
    if (started.operation?.id) {
      const result = await lifecycle.follow(started.operation.id, { signal });
      completed.push(result);
      view = result.view;
    }
  }
  if (!view) view = await api.getDeepIngestState();
  return { results, completed, view };
}

export async function removeSourceAndRefresh({ api, source }) {
  const result = await api.removeDeepIngestSource({ sourceId: source.id });
  const view = await api.getDeepIngestState();
  return { result, view };
}

export async function retrySourceAndRefresh({
  api,
  source,
  controller,
  storage = resolveDeepIngestOperationStorage(),
  signal,
  onOperation,
}) {
  const saved = readDeepIngestOperation(storage);
  const operationId = cleanOperationId(source?.operationId) || saved?.operationId;
  if (operationId && typeof api?.retryAppOperation === "function") {
    const lifecycle =
      controller || createDeepIngestOperationController({ api, storage, onOperation });
    return lifecycle.retry({ id: operationId, signal });
  }
  const result = await api.retryDeepIngestSource({ sourceId: source.id });
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
