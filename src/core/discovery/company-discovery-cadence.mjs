import { createHash } from "node:crypto";

import { companyProposalBatchLatest } from "../db/verbs/company-discovery.mjs";
import { buildCompanySeedContext } from "./company-context.mjs";

export const COMPANY_DISCOVERY_CADENCE_DAYS = 7;

function clone(value, fallback) {
  return value == null ? fallback : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function discoveryFingerprintInput(context = {}) {
  return {
    profileDomain: String(context.profileDomain || "").trim(),
    roleFamilies: clone(context.roleFamilies, []),
    keepSignals: clone(context.keepSignals, []),
    cutSignals: clone(context.cutSignals, []),
    excludedCompanies: clone(context.excludedCompanies, []),
    companyPreferences: clone(context.companyPreferences, {}),
    locationPosture: clone(context.locationPosture, {}),
  };
}

export function companyDiscoveryFingerprint(context = {}) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(discoveryFingerprintInput(context))))
    .digest("hex");
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function pendingProposals(batch) {
  return (Array.isArray(batch?.proposals) ? batch.proposals : []).filter(
    (proposal) => !proposal?.decision
  );
}

export function companyDiscoveryCadenceState({
  repoRoot,
  env = process.env,
  now = new Date(),
  buildContext = buildCompanySeedContext,
  latestBatch = companyProposalBatchLatest,
} = {}) {
  const context = buildContext({ repoRoot, env });
  const contextFingerprint = companyDiscoveryFingerprint(context);
  const batch = latestBatch({ repoRoot, env, status: null }).batch;
  if (!batch) {
    return {
      status: "due",
      due: true,
      reason: "never-run",
      dueAt: null,
      batchId: null,
      pendingCount: 0,
      contextFingerprint,
    };
  }

  const pending = pendingProposals(batch);
  if (pending.length) {
    return {
      status: "needs-review",
      due: false,
      reason: "pending-review",
      dueAt: null,
      batchId: batch.batchId,
      pendingCount: pending.length,
      contextFingerprint,
    };
  }

  if (!batch.contextFingerprint || batch.contextFingerprint !== contextFingerprint) {
    return {
      status: "due",
      due: true,
      reason: "targeting-changed",
      dueAt: null,
      batchId: batch.batchId,
      pendingCount: 0,
      contextFingerprint,
    };
  }

  const createdAt = dateValue(batch.createdAt);
  const dueAt = new Date(createdAt.getTime());
  dueAt.setUTCDate(dueAt.getUTCDate() + COMPANY_DISCOVERY_CADENCE_DAYS);
  if (dateValue(now).getTime() >= dueAt.getTime()) {
    return {
      status: "due",
      due: true,
      reason: "weekly-cadence",
      dueAt: dueAt.toISOString(),
      batchId: batch.batchId,
      pendingCount: 0,
      contextFingerprint,
    };
  }

  return {
    status: "current",
    due: false,
    reason: "cadence-current",
    dueAt: dueAt.toISOString(),
    batchId: batch.batchId,
    pendingCount: 0,
    contextFingerprint,
  };
}
