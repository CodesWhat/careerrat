const COMPANY_OPERATION_STORAGE_KEY = "careerrat:operation:company-discovery";
const ACTIVE_STATUSES = new Set(["queued", "running"]);

function operationId(value) {
  const id = String(value || "").trim();
  return id ? id.slice(0, 200) : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function companyOperationError(operation) {
  const error = new Error(
    operation?.error?.message ||
      "CareerRat couldn't finish finding company suggestions. Try it again."
  );
  error.code = operation?.error?.code || "COMPANY_DISCOVERY_FAILED";
  error.operation = operation;
  return error;
}

export function resolveCompanyOperationStorage(scope = globalThis) {
  try {
    return scope?.localStorage || null;
  } catch {
    return null;
  }
}

export function rememberCompanyDiscoveryOperation(storage, operation) {
  const id = operationId(operation?.id);
  if (!storage || !id) return null;
  storage.setItem(COMPANY_OPERATION_STORAGE_KEY, id);
  return id;
}

export function readCompanyDiscoveryOperationId(storage) {
  if (!storage) return null;
  try {
    return operationId(storage.getItem(COMPANY_OPERATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearCompanyDiscoveryOperation(storage, expectedId) {
  if (!storage) return false;
  const current = readCompanyDiscoveryOperationId(storage);
  if (expectedId && current !== operationId(expectedId)) return false;
  try {
    storage.removeItem(COMPANY_OPERATION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function companyProposalArtifact(batch) {
  const batchId = String(batch?.batchId || "").trim();
  if (!batchId) return null;
  return {
    kind: "company_proposals",
    title: "Company suggestions to review",
    ...batch,
    batchId,
  };
}

export function companyDiscoveryChildFromWorkspaceResult({ operation, thread } = {}) {
  if (operation?.status !== "completed" || operation?.resultRef?.type !== "workspace-message") {
    return null;
  }
  const messageId = operationId(operation.resultRef.id);
  if (!messageId) return null;
  const message = list(thread?.messages).find(
    (candidate) => operationId(candidate?.id) === messageId
  );
  const artifact = list(message?.artifacts).find(
    (candidate) => candidate?.kind === "company_discovery_operation"
  );
  const id = operationId(artifact?.operationId);
  if (!id) return null;
  const batchId = operationId(artifact?.batchId);
  const status = String(artifact?.status || "running").trim() || "running";
  return { id, ...(batchId ? { batchId } : {}), status };
}

export function companyProposalBatchIsResolved(batch) {
  const proposals = list(batch?.proposals);
  return Boolean(batch?.batchId) && proposals.every((proposal) => Boolean(proposal?.decision));
}

export function companyOperationMayOpenReview({ launchContext, currentContext } = {}) {
  const launch = String(launchContext || "").trim();
  return Boolean(launch) && launch === String(currentContext || "").trim();
}

export function companyOperationFailure(error, { id, retry } = {}) {
  const operation = error?.operation;
  const message =
    error?.message ||
    operation?.error?.message ||
    "CareerRat couldn't finish finding company suggestions. Try it again.";
  const exactId = operationId(id || operation?.id);
  return {
    message,
    action:
      exactId && typeof retry === "function"
        ? { label: "Try again", retry: true, onRetry: () => retry(exactId) }
        : null,
    detail: String(error?.code || operation?.error?.code || "COMPANY_DISCOVERY_FAILED"),
  };
}

export async function followCompanyDiscoveryOperation({
  api,
  id,
  pollMs = 750,
  signal,
  onProgress,
} = {}) {
  const exactId = operationId(id);
  if (!exactId || typeof api?.getAppOperation !== "function") {
    throw new Error("CareerRat couldn't reload that company search.");
  }
  for (;;) {
    signal?.throwIfAborted?.();
    const operation = await api.getAppOperation(exactId);
    onProgress?.(operation);
    if (ACTIVE_STATUSES.has(operation?.status)) {
      await sleep(pollMs, signal);
      continue;
    }
    if (operation?.status !== "completed") throw companyOperationError(operation);
    const resultRef = operation.resultRef;
    if (resultRef?.type !== "company-proposal-batch" || !operationId(resultRef.id)) {
      throw new Error("CareerRat didn't finish with a company review batch. Try it again.");
    }
    const batch = await api.getCompanyProposalBatch(resultRef.id);
    if (!batch || String(batch.batchId || "") !== String(resultRef.id)) {
      throw new Error("CareerRat couldn't reload the finished company suggestions. Try it again.");
    }
    return { operation, batch };
  }
}

export async function retryCompanyDiscoveryOperation({ api, id, storage } = {}) {
  const result = await api.retryAppOperation(operationId(id));
  const operation = result?.operation;
  if (!operation?.id) throw new Error("CareerRat couldn't retry that company search.");
  rememberCompanyDiscoveryOperation(storage, operation);
  return operation;
}
