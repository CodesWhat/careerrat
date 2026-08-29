import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userPath } from "../paths/workspace.mjs";

const OWNER_FILE = ".internal/app-runtime.owner";

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function inUseError(owner) {
  const error = new Error("CareerRat is already running for this workspace.");
  error.code = "WORKSPACE_RUNTIME_IN_USE";
  error.ownerPid = Number.isSafeInteger(owner?.pid) ? owner.pid : null;
  return error;
}

export function acquireWorkspaceRuntimeOwnership({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, OWNER_FILE);
  const ownerId = randomUUID();
  const candidate = join(dirname(path), `.app-runtime-${ownerId}.owner`);
  const owner = {
    id: ownerId,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(candidate, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(candidate, path);
        return {
          path,
          release() {
            const current = readOwner(path);
            if (current?.id !== ownerId) return false;
            try {
              unlinkSync(path);
              return true;
            } catch {
              return false;
            }
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = readOwner(path);
        if (processIsAlive(Number(existing?.pid))) throw inUseError(existing);
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw inUseError(existing);
        }
      }
    }
    throw inUseError(readOwner(path));
  } finally {
    try {
      unlinkSync(candidate);
    } catch {
      // The candidate is disposable and may already have been cleaned up.
    }
  }
}
