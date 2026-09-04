// Durable, cross-process ownership record for the in-app Claude installer
// (the guided-setup route's native `curl | bash` run). The route's
// activeGuidedSetups Set is only a same-mount fast path: it lives in memory,
// so a crash or a normal app relaunch loses it entirely while the detached
// installer process group it was guarding can still be alive underneath the
// new mount. This module is the fallback that survives that gap: a small
// JSON file under the CareerRat home directory naming the installer's
// process-group leader pid, checked with process.kill(-pid, 0) before a new
// guided-setup request is ever admitted.
//
// The record is acquired in two phases so a durable claim exists from the
// moment a request is admitted, not just once a process is actually
// spawned: reserveGuidedSetupOwnership writes an exclusive, pid-less
// reservation at admission time (before any probing or spawn), and
// confirmGuidedSetupOwnershipPid rewrites it with the spawned process-group
// leader's pid, keyed to the same generation the reservation returned. A
// crash between those two phases (spawn started but the app died before the
// pid was recorded) still leaves a durable, if pid-less, record behind
// instead of nothing at all; the stale bound below is what eventually
// reclaims it.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

// No installer legitimately runs this long. A record older than this bound
// is reclaimable even when a pid it names still answers on process-group
// liveness, since that pid could be an unrelated process the OS has since
// handed the same, since-reused, process-group id, and even when the record
// never made it past the pid-less reservation stage (a crash between
// admission and spawn).
const STALE_RECORD_MAX_AGE_MS = 30 * 60 * 1000;

// Bounded retries for reserveGuidedSetupOwnership's reclaim-and-retry loop,
// purely as a backstop against looping forever if the filesystem itself is
// misbehaving (a reclaim that reports success but doesn't actually clear the
// exclusive-create conflict). Ordinary admission, including every reclaim
// path below, settles within one or two iterations.
const RESERVE_MAX_ATTEMPTS = 5;

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

// Best-effort process start-time identity, so a process-group id the OS has
// since reused for an unrelated process doesn't read as "still the
// installer". `ps -o lstart=` is available on both macOS and Linux; win32,
// a missing `ps`, or an already-gone pid just mean identity can't be
// verified here, and admission falls back to group liveness plus the stale
// bound instead of hard-failing.
function processStartIdentity(pid, platform = process.platform) {
  if (platform === "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    if (result.error || result.status !== 0) return null;
    const value = String(result.stdout || "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function validOwnershipRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.runtimeId !== "string" || !value.runtimeId) return null;
  if (typeof value.generation !== "string" || !value.generation) return null;
  if (typeof value.startedAt !== "string" || !value.startedAt) return null;
  const pid = value.pid;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0)) return null;
  const pidStartedAt =
    typeof value.pidStartedAt === "string" && value.pidStartedAt ? value.pidStartedAt : null;
  return {
    runtimeId: value.runtimeId,
    pid: pid === null ? null : pid,
    generation: value.generation,
    startedAt: value.startedAt,
    pidStartedAt,
  };
}

function recordIsStale(record, now) {
  const startedAtMs = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAtMs)) return true;
  return now().getTime() - startedAtMs > STALE_RECORD_MAX_AGE_MS;
}

// Whether `record` still names a genuinely in-progress guided setup:
//   - A record older than the stale bound is never alive, regardless of
//     what answers on its pid: no installer legitimately runs that long, so
//     this is what reclaims both a reservation whose spawn never got a pid
//     recorded (a crash between admission and spawn) and a process-group id
//     the OS has since reused for an unrelated process.
//   - A pid-less record (reserved, not yet spawned) is alive as long as it
//     isn't stale; there's no process to check liveness against yet.
//   - A recorded pid is alive only if its process group still answers, and,
//     when a start-time identity was captured for it, that identity still
//     matches, closing the specific reused-pid gap group liveness alone
//     can't catch.
function recordIsAlive(record, platform, now) {
  if (recordIsStale(record, now)) return false;
  if (record.pid === null) return true;
  if (!processGroupAlive(record.pid, platform)) return false;
  if (record.pidStartedAt && processStartIdentity(record.pid, platform) !== record.pidStartedAt) {
    return false;
  }
  return true;
}

function readGuidedSetupOwnership({ repoRoot, env = process.env } = {}) {
  const path = lockPath({ repoRoot, env });
  if (!existsSync(path)) return null;
  try {
    return validOwnershipRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function guidedSetupInProgressError() {
  const error = new Error("Claude Code setup is already running. Wait for it to finish.");
  error.code = "RUNTIME_GUIDED_SETUP_IN_PROGRESS";
  return error;
}

function writeOwnershipRecordAtomically(path, record) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
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

// Removes the record. When `generation` is given, only removes it if the
// record on disk still names that generation: a newer request may already
// have reclaimed and overwritten it, and an older request's cleanup must
// never delete someone else's live ownership. With no generation, removes
// whatever is currently on disk unconditionally, only used for a record
// this module has already decided is not a live claim (malformed JSON, or
// confirmed dead/stale).
export function clearGuidedSetupOwnership({ repoRoot, env = process.env, generation } = {}) {
  const path = lockPath({ repoRoot, env });
  if (typeof generation === "string" && generation) {
    const current = readGuidedSetupOwnership({ repoRoot, env });
    if (current && current.generation !== generation) return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// Low-level, unconditional writer. Used internally by
// confirmGuidedSetupOwnershipPid (which already holds the reservation and
// only ever rewrites its own generation) and directly by tests that need to
// plant a raw record standing in for a prior mount or process's ownership,
// without going through the two-phase reserve/confirm flow a real
// guided-setup request uses.
export function writeGuidedSetupOwnership({
  repoRoot,
  env = process.env,
  runtimeId,
  pid = null,
  generation = randomUUID(),
  startedAt,
  platform = process.platform,
  now = () => new Date(),
}) {
  const path = lockPath({ repoRoot, env });
  const pidStartedAt = pid === null ? null : processStartIdentity(pid, platform);
  return writeOwnershipRecordAtomically(path, {
    runtimeId,
    pid,
    generation,
    pidStartedAt,
    startedAt: startedAt || now().toISOString(),
  });
}

// Admission + acquisition, in one atomic pass: creates the durable
// reservation (pid: null, a fresh generation) the moment a guided-setup
// request is admitted, before any probing or spawn happens. Exclusive
// create (the `wx` flag) means two concurrent admissions can never both
// write the file; the loser falls through to the same liveness/staleness
// check as a normal admission against an existing record, and either
// reclaims a dead/stale/malformed record and retries, or reports the
// conflict. Returns `{ generation }` on success (the fence value
// confirmGuidedSetupOwnershipPid and clearGuidedSetupOwnership use to only
// ever act on this request's own reservation), or `{ error }` when a live
// claim already exists.
export function reserveGuidedSetupOwnership({
  repoRoot,
  env = process.env,
  platform = process.platform,
  runtimeId,
  now = () => new Date(),
}) {
  const path = lockPath({ repoRoot, env });
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt += 1) {
    const generation = randomUUID();
    const body = `${JSON.stringify(
      { runtimeId, pid: null, generation, pidStartedAt: null, startedAt: now().toISOString() },
      null,
      2
    )}\n`;
    try {
      writeFileSync(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(path, 0o600);
      return { generation };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readGuidedSetupOwnership({ repoRoot, env });
      if (existing && recordIsAlive(existing, platform, now)) {
        return { error: guidedSetupInProgressError() };
      }
      if (existing) {
        clearGuidedSetupOwnership({ repoRoot, env, generation: existing.generation });
      } else {
        // Malformed JSON: no generation to key the removal off, so unlink
        // whatever is on disk directly.
        try {
          unlinkSync(path);
        } catch {
          // Already gone, or another reclaim beat us to it either way.
        }
      }
    }
  }
  return { error: guidedSetupInProgressError() };
}

// Rewrites the reservation with the spawned process-group leader's pid once
// startInstalledRuntimeGuidedSetup's onStart callback reports it, keyed to
// the same generation reserveGuidedSetupOwnership handed back and preserving
// its original startedAt: only the request that actually holds the
// reservation can move it from "reserved" to "running", so a stale confirm
// from an old, already-cleared request can never stomp a newer reservation,
// and the stale-bound check keeps measuring from when the setup was first
// admitted rather than resetting every time a pid is confirmed.
export function confirmGuidedSetupOwnershipPid({
  repoRoot,
  env = process.env,
  platform = process.platform,
  generation,
  pid,
} = {}) {
  const current = readGuidedSetupOwnership({ repoRoot, env });
  if (!current || current.generation !== generation) return false;
  writeGuidedSetupOwnership({
    repoRoot,
    env,
    runtimeId: current.runtimeId,
    pid,
    generation,
    startedAt: current.startedAt,
    platform,
  });
  return true;
}
