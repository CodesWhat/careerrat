import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";
import { INSTALLED_RUNTIME_DEFINITIONS } from "./installed-runtimes.mjs";

export const INSTALLED_RUNTIME_SELECTION_RELPATH = ".internal/ai-runtime.json";

const ALLOWED_RUNTIME_IDS = new Set(INSTALLED_RUNTIME_DEFINITIONS.map(({ id }) => id));

export function loadInstalledRuntimeSelection({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  if (!existsSync(path)) return { runtimeId: null, providerFallback: false };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      runtimeId: ALLOWED_RUNTIME_IDS.has(value?.runtimeId) ? value.runtimeId : null,
      providerFallback: value?.providerFallback === true,
    };
  } catch {
    return { runtimeId: null, providerFallback: false };
  }
}

export function writeInstalledRuntimeSelection({
  repoRoot,
  env = process.env,
  runtimeId = null,
  providerFallback = false,
} = {}) {
  if (runtimeId !== null && !ALLOWED_RUNTIME_IDS.has(runtimeId)) {
    throw new Error(`unsupported installed AI runtime: ${runtimeId}`);
  }
  const path = userPath({ repoRoot, env }, INSTALLED_RUNTIME_SELECTION_RELPATH);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    `${JSON.stringify({ runtimeId, providerFallback: providerFallback === true }, null, 2)}\n`,
    "utf8"
  );
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
  return { ok: true, path };
}

