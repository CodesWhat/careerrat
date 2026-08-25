import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import {
  isSupportedInstalledRuntime,
  sanitizeInstalledRuntimeCapabilityEvidence,
} from "./installed-runtimes.mjs";

const INSTALLED_RUNTIME_SELECTION_RELPATH = ".internal/ai-runtime.json";

function sanitizeVerification(value, runtimeId) {
  if (!runtimeId || !value || typeof value !== "object") return null;
  const path = typeof value.path === "string" ? value.path.trim() : "";
  const checkedAt = typeof value.checkedAt === "string" ? value.checkedAt.trim() : "";
  if (!path || !checkedAt || Number.isNaN(Date.parse(checkedAt))) return null;
  const capabilities = sanitizeInstalledRuntimeCapabilityEvidence(runtimeId, value.capabilities);
  return { path, capabilities, checkedAt };
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
