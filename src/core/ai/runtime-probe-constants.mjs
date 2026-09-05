// Timing bounds shared between runtime-probe-helper.mjs (which enforces them
// on itself) and installed-runtimes.mjs (which derives its own parent-side
// backstop deadline from the same numbers, so the two can never drift apart).
//
// Kept in this tiny standalone module rather than exported straight off
// runtime-probe-helper.mjs, because installed-runtimes.mjs deliberately never
// imports that file: it's spawned as its own node process by path (see
// RUNTIME_PROBE_HELPER_PATH), not imported, so it stays out of
// installed-runtimes.mjs's own module graph, and knip.json's entry list
// depends on that separation holding. This module has no such constraint —
// both sides can import it freely.

// How long killProcessTreeByPid's own bounded call (taskkill /T /F's
// spawnSync on win32) is allowed to run before runProbe treats that attempt
// as failed. Used for both the first tree-kill attempt after the probe
// timeout fires and the retry after a failed first attempt.
export const KILL_TIMEOUT_MS = 2000;

// How long runProbe waits, after a failed tree kill's direct-child fallback,
// for confirmed exit (child.on("close")) before it gives up and settles
// anyway. taskkill can be blocked or unavailable on a locked-down Windows
// host, in which case even the direct-child SIGKILL/TerminateProcess may
// never land; this caps how long the probe (and the caller's spawnSync
// waiting on it) hangs on that instead of leaving both indefinitely stuck on
// a runtime that won't die.
export const CLEANUP_DEADLINE_MS = 2000;
