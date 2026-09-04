import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import {
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
    capabilities,
    versionBoundaryState,
    testedMinimumVersion,
    checkedAt,
  };
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
