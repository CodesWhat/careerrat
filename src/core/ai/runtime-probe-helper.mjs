#!/usr/bin/env node
// A tiny standalone probe process for installedRuntimeExecutionIdentity's
// synchronous `--version` check on win32.
//
// installedRuntimeExecutionIdentity has to stay synchronous (Doctor and its
// other callers depend on that), so its old Windows path called spawnSync on
// the runtime directly and, on timeout, relied on killProcessTreeByPid's
// taskkill /t afterward to clean up any descendants. That ordering doesn't
// work: spawnSync's own timeout handling kills and reaps the direct child
// (cmd.exe, or the npm-shim root) before taskkill ever runs, so by the time
// the tree kill fires the root pid is already gone and taskkill has nothing
// left to walk. A hung or hostile probe could leave its descendants running.
//
// This file exists to run inside its own node process, invoked via a
// backstopped spawnSync from installedRuntimeExecutionIdentity
// (installed-runtimes.mjs). Being its own process lets it spawn the runtime
// asynchronously, so it can run the tree kill the instant its own timeout
// fires, while the root pid is still addressable, then wait for confirmed
// exit before it reports back. The parent's spawnSync just waits for this
// whole thing to finish and reads the JSON result off this process's stdout.
//
// Protocol: argv is [exe, ...args, "--timeout-ms", ms]. Exactly one JSON
// object is written to this process's own stdout before it exits, of the
// shape { stdout, stderr, status, timedOut }.
//
// The kill primitive (killProcessTreeByPid) already branches on platform, so
// this file's own logic never needs to: it's exercised identically by the
// real win32 production path and by a macOS unit test that spawns a
// resistant fake runtime and expects the same tree-confirmed-gone behavior,
// just through SIGKILL on a process group instead of taskkill /T /F.
import { spawn } from "node:child_process";
import { killProcessTreeByPid } from "./runtime-process.mjs";

const MAX_PROBE_BYTES = 64 * 1024;

function parseArgv(argv) {
  const flagIndex = argv.lastIndexOf("--timeout-ms");
  if (flagIndex < 1 || flagIndex !== argv.length - 2) return null;
  const timeoutMs = Number(argv[flagIndex + 1]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return { exe: argv[0], args: argv.slice(1, flagIndex), timeoutMs };
}

function report(payload) {
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed) {
    report({ stdout: "", stderr: "", status: null, timedOut: false });
    process.exitCode = 1;
    return;
  }
  const { exe, args, timeoutMs } = parsed;

  let child;
  try {
    child = spawn(exe, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Mirrors the async probe path in installed-runtimes.mjs: a detached
      // child becomes its own process-group leader on POSIX (pgid === pid),
      // which is what lets killProcessTreeByPid's group SIGKILL below reach
      // a descendant the runtime forks. Windows has no such distinction;
      // detached is a no-op there and the tree kill goes through taskkill
      // /t against the root pid instead.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch {
    report({ stdout: "", stderr: "", status: null, timedOut: false });
    return;
  }

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let settled = false;
  let timedOut = false;
  let timer = null;

  const finish = (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    report({ stdout, stderr, status, timedOut });
  };

  child.stdout?.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_PROBE_BYTES) stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_PROBE_BYTES) stderr += chunk.toString("utf8");
  });
  child.on("error", () => finish(null));
  // Fires once the root process itself has exited, whether that's the
  // runtime finishing on its own or the tree kill below reaching it. This is
  // the "confirmed exit" the parent process is relying on before it trusts
  // timedOut in the reported payload.
  child.on("close", (status) => finish(status));

  timer = setTimeout(
    () => {
      timedOut = true;
      killProcessTreeByPid(child.pid);
    },
    Math.max(1, timeoutMs)
  );
  timer.unref?.();
}

main();
