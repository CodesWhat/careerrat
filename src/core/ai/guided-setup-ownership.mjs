// Durable, cross-process ownership record for the in-app Claude installer
// (the guided-setup route's native `curl | bash` run). The route's
// activeGuidedSetups Set is only a same-mount fast path: it lives in memory,
// so a crash or a normal app relaunch loses it entirely while the detached
// installer process group it was guarding can still be alive underneath the
// new mount. This module is the fallback that survives that gap: a small
// JSON file under the CareerRat home directory naming the installer's
// process-group leader pid, checked with process.kill(-pid, 0) before a new
// guided-setup request is ever admitted.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../paths/workspace.mjs";

const GUIDED_SETUP_LOCK_RELPATH = ".internal/ai-runtime-guided-setup.lock.json";

function lockPath({ repoRoot, env = process.env } = {}) {
  return userPath({ repoRoot, env }, GUIDED_SETUP_LOCK_RELPATH);
}

// Group liveness, not just the leader pid: process.kill(-pid, 0) targets the
// whole process group the same way the installer's own SIGTERM/SIGKILL does
// (see runtime-process.mjs's killRuntimeProcess), so a resistant descendant
// the leader forked still counts as "in progress". win32 has no POSIX
// process-group signaling, so this is always false there; the guided-setup
// route itself already refuses every request on a non-darwin platform before
// any of this module runs, so that branch is a defensive no-op rather than
// a currently reachable path.
function processGroupAlive(pid, platform = process.platform) {
  if (platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is owned by another user/session.
    // Treat that as "alive" rather than silently reclaiming a lock this
    // process cannot actually confirm is free. Anything else (ESRCH, or a
    // malformed pid) means the group is gone.
    return error?.code === "EPERM";
  }
}

function validOwnershipRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.runtimeId !== "string" || !value.runtimeId) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.startedAt !== "string" || !value.startedAt) return null;
  return { runtimeId: value.runtimeId, pid: value.pid, startedAt: value.startedAt };
}

export function readGuidedSetupOwnership({ repoRoot, env = process.env } = {}) {
  const path = lockPath({ repoRoot, env });
  if (!existsSync(path)) return null;
  try {
    return validOwnershipRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Removes the record. When `pid` is given, only removes it if the record on
// disk still names that pid: a newer request may already have reclaimed and
// overwritten it, and an older request's cleanup must never delete someone
// else's live ownership.
export function clearGuidedSetupOwnership({ repoRoot, env = process.env, pid } = {}) {
  const path = lockPath({ repoRoot, env });
  if (Number.isSafeInteger(pid)) {
    const current = readGuidedSetupOwnership({ repoRoot, env });
    if (current && current.pid !== pid) return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function writeGuidedSetupOwnership({
  repoRoot,
  env = process.env,
  runtimeId,
  pid,
  now = () => new Date(),
}) {
  const path = lockPath({ repoRoot, env });
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const record = { runtimeId, pid, startedAt: now().toISOString() };
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temp file is disposable; a race with our own rename above can
        // legitimately leave nothing here to remove.
      }
    }
  }
  return record;
}

export function guidedSetupInProgressError() {
  const error = new Error("Claude Code setup is already running. Wait for it to finish.");
  error.code = "RUNTIME_GUIDED_SETUP_IN_PROGRESS";
  return error;
}

// Admission check + reclaim, in one pass: returns null when the caller may
// proceed (nothing on record, the record is malformed, or the recorded
// process group is confirmed dead, in which case the stale record is removed
// here so the reclaim is durable, not just an in-memory decision), or the
// RUNTIME_GUIDED_SETUP_IN_PROGRESS error when a live group already owns it.
export function admitGuidedSetupOwnership({
  repoRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  const record = readGuidedSetupOwnership({ repoRoot, env });
  if (!record) {
    clearGuidedSetupOwnership({ repoRoot, env });
    return null;
  }
  if (processGroupAlive(record.pid, platform)) {
    return guidedSetupInProgressError();
  }
  clearGuidedSetupOwnership({ repoRoot, env, pid: record.pid });
  return null;
}
