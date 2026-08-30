import { execFileSync } from "node:child_process";

import { LIVE_SEARCH_RECEIPT_DIRECTORY } from "./live-search-receipts.mjs";

const GIT_REPOSITORY_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

function gitEnvironmentWithoutRepositoryContext(env = process.env) {
  const isolated = { ...env };
  for (const name of GIT_REPOSITORY_ENV_VARS) delete isolated[name];
  return isolated;
}

function gitOutput(repoRoot, args, { trim = true } = {}) {
  const output = execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitEnvironmentWithoutRepositoryContext(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return trim ? output.trim() : output;
}

function resolveExpectedRevision(repoRoot, expectedRevision) {
  const requestedRevision = String(expectedRevision || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(requestedRevision)) {
    throw new Error("Expected source revision must be a full 40-character hexadecimal commit SHA.");
  }
  try {
    return gitOutput(repoRoot, [
      "rev-parse",
      "--verify",
      `${requestedRevision.toLowerCase()}^{commit}`,
    ]);
  } catch {
    throw new Error(
      `Expected source revision "${requestedRevision}" does not resolve to a commit.`
    );
  }
}

export function assertExpectedSourceRevision({ repoRoot, expectedRevision }) {
  const resolvedExpectedRevision = resolveExpectedRevision(repoRoot, expectedRevision);
  const currentRevision = gitOutput(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (currentRevision !== resolvedExpectedRevision) {
    throw new Error(
      `Expected source revision ${resolvedExpectedRevision} does not match HEAD ${currentRevision}.`
    );
  }

  const status = gitOutput(repoRoot, ["status", "--porcelain", "--untracked-files=all"], {
    trim: false,
  });
  const receiptPrefix = `${LIVE_SEARCH_RECEIPT_DIRECTORY}/`;
  const changedSourcePath = status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1))
    .find((path) => !String(path).startsWith(receiptPrefix));
  if (changedSourcePath) {
    throw new Error(
      `Native AI search evidence requires a clean source revision (${changedSourcePath}).`
    );
  }
  return currentRevision;
}
