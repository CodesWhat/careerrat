import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const VERIFIED_RUNTIME_CAPABILITIES = Object.freeze({
  completion: true,
  structuredOutput: true,
  appWorkflows: true,
  exactRead: true,
  publicWeb: true,
  liveActivity: true,
  resumable: true,
});

export function verifiedRuntimeEvidence(
  path,
  {
    realPath = path,
    version = "0.149.1",
    binaryFingerprint = "a".repeat(64),
    capabilities = VERIFIED_RUNTIME_CAPABILITIES,
  } = {}
) {
  return { path, realPath, version, binaryFingerprint, capabilities };
}

export function createVerifiedRuntimeExecutable({ root, runtimeId, version = "0.149.1" }) {
  const path = `${root}/bin/${runtimeId}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, "utf8");
  chmodSync(path, 0o755);
  const realPath = realpathSync(path);
  const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
  const evidence = verifiedRuntimeEvidence(path, { realPath, version, binaryFingerprint });
  return {
    path,
    evidence,
    runtime: {
      id: runtimeId,
      name: runtimeId === "claude" ? "Claude Code" : "Codex",
      available: true,
      capabilitiesVerified: true,
      ...evidence,
    },
  };
}

export function verifiedInstalledExecutionPlan(
  operation,
  {
    runtimeId = "codex",
    path = `/fixture/${runtimeId}`,
    requested = { quality: "automatic", reasoning: "automatic" },
    resolved = {},
  } = {}
) {
  const quality = operation === "structured.extraction" ? "balanced" : "best";
  const reasoning = operation === "coach.deep" ? "high" : "medium";
  return {
    policyVersion: 1,
    operation,
    runtimeId,
    adapterVersion: 1,
    requested,
    resolved: {
      quality,
      reasoning,
      model: runtimeId === "claude" ? "opus" : "gpt-5.6-sol",
      modelSource: "alias",
      effort: reasoning,
      speedTier: null,
      ...resolved,
    },
    installedRuntime: verifiedRuntimeEvidence(path),
    fallback: null,
  };
}
