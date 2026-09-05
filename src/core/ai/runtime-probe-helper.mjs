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
// Protocol: argv is [exe, ...args, "--timeout-ms", ms], optionally followed
// by a trailing "--windows-verbatim-arguments" flag. That flag mirrors
// runtimeProcessInvocation's own windowsVerbatimArguments option: it's set
// for .cmd/.bat runtimes whose args are already cmd-escaped into a single
// `/c "..."` payload, and it has to reach this process's own spawn call
// below or Node re-quotes that already-escaped payload a second time,
// corrupting it before cmd.exe ever sees it. Exactly one JSON object is
// written to this process's own stdout before it exits, of the shape
// { stdout, stderr, status, timedOut }.
//
// The kill primitive (killProcessTreeByPid) already branches on platform, so
// this file's own logic never needs to: it's exercised identically by the
// real win32 production path and by a macOS unit test that spawns a
// resistant fake runtime and expects the same tree-confirmed-gone behavior,
// just through SIGKILL on a process group instead of taskkill /T /F.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CLEANUP_DEADLINE_MS, KILL_TIMEOUT_MS } from "./runtime-probe-constants.mjs";
import { killProcessTreeByPid } from "./runtime-process.mjs";

const MAX_PROBE_BYTES = 64 * 1024;

const WINDOWS_VERBATIM_FLAG = "--windows-verbatim-arguments";

function parseArgv(argv) {
  let end = argv.length;
  let windowsVerbatimArguments = false;
  if (argv[end - 1] === WINDOWS_VERBATIM_FLAG) {
    windowsVerbatimArguments = true;
    end -= 1;
  }
  const flagIndex = argv.lastIndexOf("--timeout-ms", end - 1);
  if (flagIndex < 1 || flagIndex !== end - 2) return null;
  const timeoutMs = Number(argv[flagIndex + 1]);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return { exe: argv[0], args: argv.slice(1, flagIndex), timeoutMs, windowsVerbatimArguments };
}

function report(payload) {
  process.stdout.write(JSON.stringify(payload));
}

// Exported so tests can drive the actual spawn-and-report logic directly,
// with a stubbed spawnImpl, instead of only ever exercising it through a
// real child process's argv and stdout. That's what proves
// windowsVerbatimArguments reaches this function's own spawn call, not just
// that it survives argv parsing.
export function runProbe(
  { exe, args, timeoutMs, windowsVerbatimArguments = false },
  {
    spawnImpl = spawn,
    killTreeImpl = killProcessTreeByPid,
    killTimeoutMs = KILL_TIMEOUT_MS,
    cleanupDeadlineMs = CLEANUP_DEADLINE_MS,
  } = {}
) {
  return new Promise((resolve) => {
    let child;
    try {
      // This helper is itself launched with ELECTRON_RUN_AS_NODE=1 so
      // process.execPath (CareerRat.exe in the packaged desktop) runs it as
      // Node instead of another GUI instance — see installed-runtimes.mjs's
      // spawnSyncImpl call. That flag is scoped to getting *this* process
      // running as Node; the runtime it spawns below is a real target
      // binary, not another Electron host in disguise, and must not inherit
      // it (Electron-shelled runtimes would themselves be forced into
      // Node-run mode by an inherited ELECTRON_RUN_AS_NODE).
      const runtimeEnv = { ...process.env };
      delete runtimeEnv.ELECTRON_RUN_AS_NODE;
      child = spawnImpl(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: runtimeEnv,
        // Mirrors the async probe path in installed-runtimes.mjs: a detached
        // child becomes its own process-group leader on POSIX (pgid === pid),
        // which is what lets killProcessTreeByPid's group SIGKILL below reach
        // a descendant the runtime forks. Windows has no such distinction;
        // detached is a no-op there and the tree kill goes through taskkill
        // /t against the root pid instead.
        detached: process.platform !== "win32",
        windowsHide: true,
        // The caller (installedRuntimeExecutionIdentity, via
        // runtimeProcessInvocation) already cmd-escaped its `/c "..."`
        // payload for .cmd/.bat runtimes. Without this, Node's own argument
        // quoting re-escapes that payload a second time before handing it to
        // CreateProcess, corrupting it. A no-op everywhere else.
        windowsVerbatimArguments,
      });
    } catch {
      resolve({ stdout: "", stderr: "", status: null, timedOut: false, cleanupFailed: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let cleanupTimer = null;
    // Sticky once a tree-kill attempt reports failure: descendants may still
    // be alive and unconfirmed even if the direct child (child.on("close"))
    // goes on to exit right afterward, whether from its own fallback SIGKILL
    // landing or from anything else. Once true this never flips back to
    // false — only a tree kill that actually reported success ever leaves it
    // false in the first place.
    let treeKillFailed = false;

    const finish = (status, { cleanupFailed = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({ stdout, stderr, status, timedOut, cleanupFailed: cleanupFailed || treeKillFailed });
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
    // timedOut in the reported payload. Also what makes the cleanup deadline
    // below a no-op on the common path: finish() is idempotent, so if this
    // fires first the deadline timer's own finish() call later is dropped.
    // The direct child closing is never proof descendants are gone too when
    // the tree kill itself failed, which is exactly what treeKillFailed above
    // guards against here.
    child.on("close", (status) => finish(status));

    timer = setTimeout(
      () => {
        timedOut = true;
        // killTreeImpl reports whether the kill attempt itself succeeded
        // (taskkill exited 0 on Windows, within its own bounded killTimeoutMs).
        // If it didn't — taskkill blocked, unavailable, or itself timed out
        // — fall back to killing the direct child so the root process at
        // least has a second chance to die, even though any descendants it
        // forked may now be orphaned. That failure is recorded in
        // treeKillFailed and never cleared by anything that happens next.
        const killed = killTreeImpl(child.pid, { timeoutMs: killTimeoutMs });
        if (!killed) {
          treeKillFailed = true;
          try {
            child.kill?.("SIGKILL");
          } catch {
            // The process already exited between the tree-kill attempt and
            // this fallback.
          }
        }
        // Neither cleanup path is guaranteed to produce a confirmed exit
        // (child.on("close") firing) — a fallback SIGKILL can itself be
        // ignored or fail silently. Cap how long this waits for that
        // confirmation before settling anyway, so a stuck cleanup can't hang
        // the probe (and the caller's spawnSync) indefinitely.
        cleanupTimer = setTimeout(() => {
          // The deadline fired: nothing confirmed this process (or its
          // descendants) actually exited. Don't let this helper linger on a
          // wedged runtime waiting for streams that may never end — drop the
          // piped stdio and unref the child so this helper process itself
          // can still exit even if the runtime tree can't be confirmed gone.
          try {
            child.stdout?.destroy?.();
          } catch {
            // Best-effort; the stream may already be gone.
          }
          try {
            child.stderr?.destroy?.();
          } catch {
            // Best-effort; the stream may already be gone.
          }
          child.unref?.();
          if (treeKillFailed) {
            // One last-ditch retry before giving up on confirming the tree
            // is actually dead: the same platform-appropriate primitive
            // (taskkill /T /F on win32, a process-group SIGKILL on POSIX)
            // killTreeImpl already runs, bounded the same way. A Windows Job
            // Object would give a real kill-on-close guarantee here instead
            // of a best-effort retry; this repo ships no native addon to
            // create one, so this is what's available.
            killTreeImpl(child.pid, { timeoutMs: killTimeoutMs });
          }
          finish(null, { cleanupFailed: true });
        }, cleanupDeadlineMs);
        cleanupTimer.unref?.();
      },
      Math.max(1, timeoutMs)
    );
    timer.unref?.();
  });
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed) {
    report({ stdout: "", stderr: "", status: null, timedOut: false });
    process.exitCode = 1;
    return;
  }
  report(await runProbe(parsed));
}

// Guarded so importing this module for its runProbe export (the test suite
// does exactly that, to drive the spawn-and-report logic directly with a
// stubbed spawnImpl) never also runs the CLI entrypoint against the
// importer's own argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
