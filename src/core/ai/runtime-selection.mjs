import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import {
  installedRuntimeBoundaryPolicyMinimum,
  isSupportedInstalledRuntime,
  sanitizeInstalledRuntimeCapabilityEvidence,
} from "./installed-runtimes.mjs";

const INSTALLED_RUNTIME_SELECTION_RELPATH = ".internal/ai-runtime.json";

// Tri-state, matching classifyRuntimeVersionBoundary/probeInstalledRuntime in
// installed-runtimes.mjs. Anything that isn't one of the two conclusive
// states — including a cache written before this field existed — sanitizes
// to "indeterminate" rather than being dropped, so a missing value fails
// closed to "unknown" instead of silently reading as a passed probe.
const VERSION_BOUNDARY_STATES = new Set(["at_or_above", "below", "indeterminate"]);

function sanitizeVersionBoundaryState(value) {
  return VERSION_BOUNDARY_STATES.has(value) ? value : "indeterminate";
}

// Optional, additive breakdown behind `binaryFingerprint` (installed-runtimes.mjs's
// runtimeExecutionChainDigests): ordered `{ role, realPath, sha256 }` entries
// for every file the launcher chain resolved to at verification time.
// binaryFingerprint itself stays the single 64-hex aggregate digest it
// always was — this is purely additional, so it's fine for it to be absent
// on a verification written before it existed, or on any verification a
// caller chooses not to populate; both sanitize to null, same as a
// verification with no cached breakdown at all. Its only consumer is
// installedRuntimeExecutionMismatchRole's diagnostic, never the aggregate
// comparison that actually authorizes anything.
function sanitizeChainFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seenRoles = new Set();
  const files = [];
  for (const entry of value) {
    const role = typeof entry?.role === "string" ? entry.role.trim() : "";
    const realPath = typeof entry?.realPath === "string" ? entry.realPath.trim() : "";
    const sha256 = typeof entry?.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
    if (!role || !realPath || !/^[a-f0-9]{64}$/.test(sha256) || seenRoles.has(role)) return null;
    seenRoles.add(role);
    files.push({ role, realPath, sha256 });
  }
  return files;
}

function sanitizeVerification(value, runtimeId) {
  if (!runtimeId || !value || typeof value !== "object") return null;
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const realPath = typeof value.realPath === "string" ? value.realPath.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const binaryFingerprint =
    typeof value.binaryFingerprint === "string" ? value.binaryFingerprint.trim().toLowerCase() : "";
  const checkedAt = typeof value.checkedAt === "string" ? value.checkedAt.trim() : "";
  if (
    !path ||
    !realPath ||
    !version ||
    !/^[a-f0-9]{64}$/.test(binaryFingerprint) ||
    !checkedAt ||
    Number.isNaN(Date.parse(checkedAt))
  ) {
    return null;
  }
  const capabilities = sanitizeInstalledRuntimeCapabilityEvidence(runtimeId, value.capabilities);
  const versionBoundaryState = sanitizeVersionBoundaryState(value.versionBoundaryState);
  // The minimum version the boundary probe was actually run against, so a
  // reader can tell a cached "at_or_above" apart from one tested against a
  // since-raised policy floor. Missing on a cache written before this field
  // existed, or on a runtime with no boundary policy at all (e.g. codex) —
  // both sanitize to null rather than being treated as a match.
  const testedMinimumVersion =
    typeof value.testedMinimumVersion === "string" && value.testedMinimumVersion.trim()
      ? value.testedMinimumVersion.trim()
      : null;
  return {
    path,
    realPath,
    version,
    binaryFingerprint,
    chainFiles: sanitizeChainFiles(value.chainFiles),
    capabilities,
    versionBoundaryState,
    testedMinimumVersion,
    checkedAt,
  };
}

// Whether a cached verification still identifies the exact binary CareerRat
// is about to use right now: same runtime id, same launcher path, same
// resolved binary (realPath + fingerprint), and the same live version. A
// launcher path can stay unchanged while it delegates to an updated payload
// underneath, so version has to be checked against a fresh read of the
// runtime rather than trusted from the cache — callers get that fresh read
// from installedRuntimeExecutionIdentity() and pass it in as
// `currentIdentity`. This is the one cache-identity check both Doctor's
// cache matcher and the AI router's rehydration use, so they can no longer
// disagree about what counts as still-current.
export function installedRuntimeVerificationCurrent(runtime, verification, currentIdentity) {
  if (!runtime?.id || !verification || !currentIdentity) return false;
  return (
    verification.path === currentIdentity.path &&
    verification.realPath === currentIdentity.realPath &&
    verification.version === currentIdentity.version &&
    verification.binaryFingerprint === currentIdentity.binaryFingerprint
  );
}

// Whether a cached verification's boundary-gated capability evidence
// (exactRead, publicWeb) was tested against the runtime's *current* policy
// minimum, not a floor CareerRat has since raised. A runtime with no
// boundary policy (e.g. codex) always trusts its evidence; one with a
// policy only trusts evidence tested against exactly the minimum in force
// right now, so a policy-floor bump makes an old passing probe stop
// covering the boundary-gated capabilities until it's re-run.
export function installedRuntimeBoundaryEvidenceCurrent(runtimeId, verification) {
  const policyMinimum = installedRuntimeBoundaryPolicyMinimum(runtimeId);
  if (!policyMinimum) return true;
  return (
    Boolean(verification?.testedMinimumVersion) &&
    verification.testedMinimumVersion === policyMinimum
  );
}

// The capability evidence from a cached verification that's still safe to
// rehydrate for execution: null when the verification no longer identifies
// the runtime's current binary (installedRuntimeVerificationCurrent), and
// with the boundary-gated capabilities (exactRead, publicWeb) stripped when
// they were tested against a policy minimum CareerRat has since raised
// (installedRuntimeBoundaryEvidenceCurrent) — so a policy bump can never let
// the router keep granting exactRead/publicWeb access it would no longer
// verify from scratch.
export function trustedInstalledRuntimeCapabilityEvidence(runtime, verification, currentIdentity) {
  if (!installedRuntimeVerificationCurrent(runtime, verification, currentIdentity)) return null;
  const capabilities = verification.capabilities;
  if (!capabilities) return null;
  if (installedRuntimeBoundaryEvidenceCurrent(runtime.id, verification)) return capabilities;
  return { ...capabilities, exactRead: false, publicWeb: false };
}

export function loadInstalledRuntimeSelection({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  if (!existsSync(path)) {
    return {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
      verification: null,
    };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const runtimeId = isSupportedInstalledRuntime(value?.runtimeId) ? value.runtimeId : null;
    return {
      runtimeId,
      providerFallback: value?.providerFallback === true,
      customCommand: null,
      verification: sanitizeVerification(value?.verification, runtimeId),
    };
  } catch {
    return {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
      verification: null,
    };
  }
}

export function writeInstalledRuntimeSelection({
  repoRoot,
  env = process.env,
  runtimeId = null,
  providerFallback = false,
  verification = null,
} = {}) {
  if (runtimeId !== null && !isSupportedInstalledRuntime(runtimeId)) {
    throw new Error(`unsupported installed AI runtime: ${runtimeId}`);
  }
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  const clean = sanitizeVerification(verification, runtimeId);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify(
      {
        runtimeId,
        providerFallback: providerFallback === true,
        customCommand: null,
        verification: clean,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
  return { ok: true, path };
}
