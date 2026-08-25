import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import { INSTALLED_RUNTIME_DEFINITIONS } from "./installed-runtimes.mjs";

const INSTALLED_RUNTIME_SELECTION_RELPATH = ".internal/ai-runtime.json";

const ALLOWED_RUNTIME_IDS = new Set(INSTALLED_RUNTIME_DEFINITIONS.map(({ id }) => id));

function isKnownRuntimeId(runtimeId) {
  return ALLOWED_RUNTIME_IDS.has(runtimeId);
}

export function loadInstalledRuntimeSelection({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  if (!existsSync(path)) {
    return { runtimeId: null, providerFallback: false, customCommand: null };
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const runtimeId = isKnownRuntimeId(value?.runtimeId) ? value.runtimeId : null;
    return {
      runtimeId,
      providerFallback: value?.providerFallback === true,
      customCommand: null,
    };
  } catch {
    return { runtimeId: null, providerFallback: false, customCommand: null };
  }
}

export function writeInstalledRuntimeSelection({
  repoRoot,
  env = process.env,
  runtimeId = null,
  providerFallback = false,
} = {}) {
  if (runtimeId !== null && !isKnownRuntimeId(runtimeId)) {
    throw new Error(`unsupported installed AI runtime: ${runtimeId}`);
  }
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify(
      {
        runtimeId,
        providerFallback: providerFallback === true,
        customCommand: null,
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
