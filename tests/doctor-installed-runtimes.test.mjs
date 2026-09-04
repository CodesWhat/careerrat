// Tests for doctor.mjs's "Installed AI runtimes" block (src/cli/doctor.mjs),
// which reuses installed-runtimes.mjs's own registry/detector
// (detectInstalledRuntimes) rather than re-implementing detection. Detection
// itself never spawns a binary — it only checks what's on disk — so these
// tests fake the registry's search space with a throwaway temp directory (via
// the PATH and CAREERRAT_RUNTIME_SEARCH_DIRS overrides installed-runtimes.mjs
// already supports for exactly this purpose) instead of depending on
// whatever CLIs happen to be installed on the machine running the suite.
//
// One narrow exception: validating a cached verification for the selected
// runtime does spawn that one binary with `--version`, so its live version
// can be compared against the cached one (Codex review — Doctor used to
// accept a cache whose version had drifted). Tests that exercise that path
// use writeVersionedFakeBinary so the fake executable actually answers
// `--version` with the version the cache expects; every other test's fake
// binary answers "fake", which never parses as a version.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INSTALLED_RUNTIME_DEFINITIONS } from "../src/core/ai/installed-runtimes.mjs";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CLAUDE_BOUNDARY_MINIMUM_VERSION = INSTALLED_RUNTIME_DEFINITIONS.find(
  (definition) => definition.id === "claude"
).minimumBoundaryVersion;

function tempHome() {
  return mkdtempSync(join(tmpdir(), "careerrat-doctor-runtimes-home-"));
}

function tempFakeRegistry() {
  return mkdtempSync(join(tmpdir(), "careerrat-doctor-runtimes-registry-"));
}

function writeFakeBinary(registryDir, name, contents = "#!/bin/sh\necho fake\n") {
  const path = join(registryDir, name);
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
  return path;
}

// A fake binary whose `--version` output (any args, this ignores them)
// actually parses to `version` — for tests that need the cache matcher's
// live version read to land on a specific, known value instead of the
// unparseable "fake" the default fake binary answers with.
function writeVersionedFakeBinary(registryDir, name, version) {
  const path = join(registryDir, name);
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

// No PATH entries at all and CAREERRAT_RUNTIME_SEARCH_DIRS pointed at the
// same empty directory: findInstalledExecutable has nowhere to find any of
// the registry's binaries, so every runtime detects as unavailable
// regardless of what's actually on the host running this test.
function fakeRegistryEnv(registryDir) {
  return { PATH: registryDir, CAREERRAT_RUNTIME_SEARCH_DIRS: registryDir };
}

function runDoctorJson(home, extraEnv) {
  const result = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs"), "--json"], {
    cwd: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home, ...extraEnv },
    encoding: "utf8",
  });
  assert.ok(result.stdout, result.stderr || "doctor produced no stdout");
  return JSON.parse(result.stdout);
}

test("doctor --json reports every registry runtime as not installed against an empty fake registry", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    assert.ok(Array.isArray(data.installedRuntimes) && data.installedRuntimes.length > 0);
    for (const runtime of data.installedRuntimes) {
      assert.equal(runtime.status, "not installed", `${runtime.id} should be not installed`);
      assert.equal(runtime.version, null);
      assert.equal(runtime.boundaryProbePassed, false);
      assert.equal(runtime.boundaryProbeCheckedAt, null);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test("doctor text output prints not-installed lines for a fully empty fake registry", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const result = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
    });
    assert.match(result.stdout, /Installed AI runtimes:/);
    assert.match(result.stdout, /- claude \(Claude Code\): not installed\./);
    assert.match(result.stdout, /- droid \(Droid\): not installed\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test("doctor --json reports a detected-but-unverified supported engine with no cached version or boundary state", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    writeFakeBinary(registry, "claude");
    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude, "expected a claude entry in installedRuntimes");
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null);
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(claude.boundaryProbeCheckedAt, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test("doctor --json reports a diagnostics-only runtime as such even when detected", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    // gemini is a real registry entry that is not a CareerRat-supported
    // engine (installed-runtimes.mjs's INSTALLED_RUNTIME_DEFINITIONS omits
    // `supported: true` for it) — diagnostics only.
    writeFakeBinary(registry, "gemini");
    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const gemini = data.installedRuntimes.find((r) => r.id === "gemini");
    assert.ok(gemini, "expected a gemini entry in installedRuntimes");
    assert.equal(gemini.status, "diagnostics only");
    assert.equal(gemini.version, null);
    assert.equal(gemini.boundaryProbePassed, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test("doctor --json surfaces cached version and a passed boundary probe only when the persisted verification still matches the detected binary", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    const checkedAt = new Date().toISOString();
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        testedMinimumVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
        checkedAt,
      },
    });

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, "9.9.9");
    assert.equal(claude.boundaryProbePassed, true);
    assert.equal(claude.boundaryProbeCheckedAt, checkedAt);

    const text = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
    }).stdout;
    assert.match(
      text,
      /- claude \(Claude Code\): supported engine, installed v9\.9\.9, boundary probe passed \(checked/
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex review: the cache matcher checked id, path, realPath, and
// fingerprint but never the runtime's current live version, so an
// unchanged launcher that delegates to an updated payload — same path,
// same realPath, same binaryFingerprint, different actual version — could
// keep reporting a stale cached version and a passed boundary probe
// forever. The router (call-ai.mjs's resolveAIRoute) already rejects this
// case by comparing the cached version against a fresh read; Doctor's
// cache matcher now does the same fresh read via the shared
// installedRuntimeVerificationCurrent predicate.
test("doctor reports an unknown cache, never a stale version, when the cached version disagrees with the selected runtime's live version", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    const checkedAt = new Date().toISOString();
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        // Same path, same realPath, same binaryFingerprint as the binary
        // installed right now — only the cached version disagrees with
        // what the launcher actually reports when run live.
        version: "1.0.0",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        testedMinimumVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
        checkedAt,
      },
    });

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null, "a changed live version must invalidate the cache");
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(claude.boundaryProbeCheckedAt, null);

    const text = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
    }).stdout;
    assert.match(text, /- claude \(Claude Code\): supported engine, installed version unknown/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex review: the cache matcher compared runtime id, realPath, and
// fingerprint but not the detected launcher path, while the AI execution
// router (call-ai.mjs's resolveAIRouteForExecutionPlan) requires the
// launcher path to match too. Two PATH aliases that both resolve (via
// realpath) to the identical binary must not let Doctor report a passed
// cache the router would reject.
//
// Codex adversarial finding (round 5): a passed cache here would only ever
// be wrong in a way that matters if it also let the mismatched-path binary
// get executed. The binary is side-effecting (it writes a marker file when
// run) so this proves that too, not just the reported status fields — if
// the path comparison in doctor.mjs's nonExecutingIdentityMatchesCache ever
// moves after the version spawn, the marker starts appearing.
test("doctor treats a cached verification as stale when the detected launcher path is a different alias of the same binary", () => {
  const home = tempHome();
  const targetDir = tempFakeRegistry();
  const registryA = tempFakeRegistry();
  const registryB = tempFakeRegistry();
  const markerDir = mkdtempSync(join(tmpdir(), "careerrat-doctor-path-alias-no-exec-"));
  const markerFile = join(markerDir, "executed.marker");
  try {
    // One real binary. Two PATH aliases (symlinks in two different
    // directories) both resolve it via realpath to the identical file, so
    // realPath and binaryFingerprint are indistinguishable between them —
    // only the launcher path detection actually finds differs. It writes a
    // marker file if run, so a doctor run that invokes it (instead of
    // treating the path mismatch as disqualifying) is provable.
    const targetPath = writeFakeBinary(
      targetDir,
      "claude-real",
      `#!/bin/sh\necho executed > "${markerFile}"\necho fake\n`
    );
    const realPath = realpathSync(targetPath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    const claudePathA = join(registryA, "claude");
    const claudePathB = join(registryB, "claude");
    symlinkSync(targetPath, claudePathA);
    symlinkSync(targetPath, claudePathB);

    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePathA,
        realPath,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        testedMinimumVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
        checkedAt: new Date().toISOString(),
      },
    });

    // Detection now finds claude via registry B's alias instead of the
    // registry A alias the cache above was written for.
    const data = runDoctorJson(home, fakeRegistryEnv(registryB));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null, "a different launcher path must invalidate the cache");
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(claude.boundaryProbeCheckedAt, null);
    assert.equal(
      existsSync(markerFile),
      false,
      "doctor must never execute a binary whose launcher path mismatches the cache"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(registryA, { recursive: true, force: true });
    rmSync(registryB, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

// Codex review: persisted versionBoundaryState carried no record of which
// policy floor it was tested against. If a CareerRat update raises the
// minimum boundary version while the runtime binary (and its realPath,
// fingerprint, and launcher path) stay unchanged, a cache written under the
// old, lower floor must not keep reporting as passed against the new one.
test("doctor reports an unknown boundary probe, never passed, when the cached testedMinimumVersion is behind the current policy", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    const checkedAt = new Date().toISOString();
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        // Tested against an older, lower minimum than the policy currently
        // in force — the binary itself never changed.
        testedMinimumVersion: "0.0.1",
        checkedAt,
      },
    });

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    // Version and checkedAt still surface — the binary genuinely matches —
    // only the boundary verdict itself is downgraded to unknown.
    assert.equal(claude.version, "9.9.9");
    assert.equal(claude.boundaryProbeCheckedAt, checkedAt);
    assert.equal(claude.boundaryProbePassed, false);

    const text = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
    }).stdout;
    assert.match(
      text,
      /- claude \(Claude Code\): supported engine, installed v9\.9\.9, boundary probe unknown \(checked/
    );
    assert.doesNotMatch(text, /boundary probe passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

test("doctor --json treats a cached verification as stale once the on-disk binary no longer matches its fingerprint", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeFakeBinary(registry, "claude", "#!/bin/sh\necho original\n");
    const realPath = realpathSync(claudePath);
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        // Fingerprint deliberately does not match the binary's real
        // contents below, standing in for a binary that changed since the
        // last real probe.
        binaryFingerprint: "a".repeat(64),
        capabilities: {},
        checkedAt: new Date().toISOString(),
      },
    });
    // Rewrite the binary's contents so its real fingerprint definitely
    // cannot match the stale cached one above.
    writeFakeBinary(registry, "claude", "#!/bin/sh\necho changed\n");

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null);
    assert.equal(claude.boundaryProbePassed, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex adversarial finding: Doctor persisted a cached verification whose
// version-boundary probe was genuinely indeterminate (ambiguous `--version`
// output) but still reported "boundary probe passed" from the mere presence
// of a matching cache entry. A changed realPath is a separate, already-
// covered staleness path (the fingerprint test above); this covers the
// distinct case where the cache DOES match the on-disk binary but its
// recorded boundary state was never conclusive.
test("doctor --json reports an indeterminate cached boundary probe as unknown, never passed", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    const checkedAt = new Date().toISOString();
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "indeterminate",
        checkedAt,
      },
    });

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.boundaryProbePassed, false);

    const text = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
    }).stdout;
    assert.match(
      text,
      /- claude \(Claude Code\): supported engine, installed v9\.9\.9, boundary probe unknown \(checked/
    );
    assert.doesNotMatch(text, /boundary probe passed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex next-steps: a changed realPath with an otherwise-matching fingerprint
// must still be treated as no cached verification at all — the identity
// check requires BOTH to match, not just content. Fabricating a mismatched
// realPath (rather than physically relocating the binary) isolates that one
// field.
//
// Codex adversarial finding (round 5): the binary is side-effecting (it
// writes a marker file when run) so a doctor run that skips straight to the
// version spawn without checking realPath first is provable, not just
// assumed from the reported fields staying null.
test("doctor --json treats a cached verification as stale when only realPath has changed, even with a matching fingerprint", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  const markerDir = mkdtempSync(join(tmpdir(), "careerrat-doctor-realpath-mismatch-no-exec-"));
  const markerFile = join(markerDir, "executed.marker");
  try {
    const claudePath = writeFakeBinary(
      registry,
      "claude",
      `#!/bin/sh\necho executed > "${markerFile}"\necho fake\n`
    );
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        // Deliberately a different path than the binary's real one, with
        // the correct fingerprint for that (different) binary's contents.
        realPath: `${realPath}-relocated`,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        checkedAt: new Date().toISOString(),
      },
    });

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null);
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(claude.boundaryProbeCheckedAt, null);
    assert.equal(
      existsSync(markerFile),
      false,
      "doctor must never execute a binary whose realPath mismatches the cache"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

// Codex review: cached verification is only ever validated for the
// currently selected runtime (installedRuntimeCachedVerification rejects any
// other id outright), so a normal Doctor run must not read the binary
// content of any other detected runtime either. A FIFO stands in for an
// unselected runtime's binary: it passes the executable-bit check detection
// uses to find it, but a content read against it (as eager fingerprinting
// would attempt) blocks forever with no writer connected. If Doctor ever
// regresses back to hashing every detected executable, this hangs until
// spawnSync's timeout kills it instead of completing.
test("doctor does not read the binary content of an unselected runtime", (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is POSIX-only");
    return;
  }
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    const binaryFingerprint = createHash("sha256").update(readFileSync(realPath)).digest("hex");
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        binaryFingerprint,
        capabilities: {},
        versionBoundaryState: "at_or_above",
        checkedAt: new Date().toISOString(),
      },
    });

    const codexFifo = join(registry, "codex");
    const mkfifoResult = spawnSync("mkfifo", [codexFifo]);
    if (mkfifoResult.status !== 0) {
      t.skip("mkfifo unavailable on this host");
      return;
    }
    chmodSync(codexFifo, 0o755);

    const result = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs"), "--json"], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(
      result.signal,
      null,
      "doctor must not hang reading an unselected runtime's binary content"
    );
    assert.ok(result.stdout, result.stderr || "doctor produced no stdout");
    const data = JSON.parse(result.stdout);
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.equal(claude.version, "9.9.9");
    const codex = data.installedRuntimes.find((r) => r.id === "codex");
    assert.equal(codex.status, "supported engine");
    assert.equal(codex.version, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex adversarial finding (round 7): the previous FIFO regression only
// covers an unselected runtime, which fingerprintId already skips reading
// regardless of file type. The cached *selected* runtime's binary is the
// one detection is asked to fingerprint, and discovery's executable-bit
// check (X_OK) passes for a FIFO exactly the same as for a real binary — so
// replacing the selected launcher path with an executable FIFO that has no
// writer connected used to block a normal (non guidance-only) Doctor run
// forever the moment it tried to read the file for hashing. Both
// fingerprinting call sites doctor.mjs's normal path can reach —
// detectInstalledRuntimes and installedRuntimeExecutionIdentity — share the
// one runtimeBinaryFingerprint helper, so this proves the fix at the one
// place it lives: open nonblocking, fstat the descriptor, and refuse to
// read anything that isn't a regular file.
test("doctor completes within a bounded timeout and reports an executable FIFO selected runtime as unverified", (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is POSIX-only");
    return;
  }
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    const claudeFifo = join(registry, "claude");
    const mkfifoResult = spawnSync("mkfifo", [claudeFifo]);
    if (mkfifoResult.status !== 0) {
      t.skip("mkfifo unavailable on this host");
      return;
    }
    chmodSync(claudeFifo, 0o755);

    // A cached selection pointing at the FIFO. Its fingerprint can never be
    // confirmed (the FIFO is never read), so this also proves the mismatch
    // is reported as unknown rather than treated as still current.
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudeFifo,
        realPath: realpathSync(claudeFifo),
        version: "9.9.9",
        binaryFingerprint: "a".repeat(64),
        capabilities: {},
        versionBoundaryState: "at_or_above",
        checkedAt: new Date().toISOString(),
      },
    });

    const result = spawnSync(process.execPath, [join(ROOT, "src/cli/doctor.mjs"), "--json"], {
      cwd: ROOT,
      env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
      encoding: "utf8",
      timeout: 5000,
    });

    assert.equal(
      result.signal,
      null,
      "doctor must not hang reading the selected runtime's binary content"
    );
    assert.ok(result.stdout, result.stderr || "doctor produced no stdout");
    const data = JSON.parse(result.stdout);
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude, "expected a claude entry in installedRuntimes");
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null, "an executable FIFO must never verify as a known version");
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(claude.boundaryProbeCheckedAt, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});

// Codex next-steps: detection never spawns a candidate binary, it only
// checks what's on disk. A fake binary that WOULD prove itself if executed
// (by writing a marker file) makes that assertion concrete instead of just
// asserted in a comment.
test("doctor never executes a discovered runtime binary during detection", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  const markerDir = mkdtempSync(join(tmpdir(), "careerrat-doctor-no-exec-"));
  const markerFile = join(markerDir, "executed.marker");
  try {
    writeFakeBinary(registry, "claude", `#!/bin/sh\necho executed > "${markerFile}"\nexit 0\n`);

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude, "expected a claude entry in installedRuntimes");
    assert.equal(claude.status, "supported engine");
    assert.equal(existsSync(markerFile), false, "doctor must never execute the discovered binary");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

// Codex adversarial finding (round 5): the cache matcher's one live read —
// invoking the selected runtime with `--version` — used to run before path,
// realPath, and binaryFingerprint were ever compared against the cache. A
// replacement binary at the same launcher path (or a PATH-shadowed one) was
// therefore executed under the user's account even though Doctor went on to
// report the cache as stale. Detection resolves path/realPath/fingerprint
// without executing anything, so those fields must be checked against the
// cache FIRST — the live version spawn only happens once they already agree.
test("doctor never executes a replacement binary whose identity mismatches the cached verification", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  const markerDir = mkdtempSync(join(tmpdir(), "careerrat-doctor-mismatch-no-exec-"));
  const markerFile = join(markerDir, "executed.marker");
  try {
    const claudePath = writeVersionedFakeBinary(registry, "claude", "9.9.9");
    const realPath = realpathSync(claudePath);
    writeInstalledRuntimeSelection({
      repoRoot: ROOT,
      env: { CAREERRAT_HOME: home },
      runtimeId: "claude",
      providerFallback: false,
      verification: {
        path: claudePath,
        realPath,
        version: "9.9.9",
        // Fingerprint deliberately does not match the replacement binary
        // written below, standing in for an in-place replacement or a
        // PATH-shadowed executable at the same launcher path.
        binaryFingerprint: "a".repeat(64),
        capabilities: {},
        versionBoundaryState: "at_or_above",
        testedMinimumVersion: CLAUDE_BOUNDARY_MINIMUM_VERSION,
        checkedAt: new Date().toISOString(),
      },
    });

    // Replace the binary at the same launcher path with one that would
    // prove it ran, if Doctor ever invoked it.
    writeFakeBinary(registry, "claude", `#!/bin/sh\necho executed > "${markerFile}"\nexit 0\n`);

    const data = runDoctorJson(home, fakeRegistryEnv(registry));
    const claude = data.installedRuntimes.find((r) => r.id === "claude");
    assert.ok(claude);
    assert.equal(claude.status, "supported engine");
    assert.equal(claude.version, null, "an identity mismatch must invalidate the cache");
    assert.equal(claude.boundaryProbePassed, false);
    assert.equal(
      existsSync(markerFile),
      false,
      "doctor must never execute a binary whose identity mismatches the cache"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

// Closes the medium Codex finding: Doctor's "Installed AI runtimes" section
// reads and SHA-256 hashes every discovered executable on every invocation.
// The dashboard's guidance snapshot re-runs Doctor on a 30-second TTL and
// only ever needs `agentGuidance`, which never depends on installedRuntimes
// (see buildAgentGuidance's argument list in doctor.mjs) — so --guidance-only
// must skip detection entirely rather than just hiding it from the output.
test("doctor --guidance-only skips installed runtime detection entirely", () => {
  const home = tempHome();
  const registry = tempFakeRegistry();
  try {
    writeFakeBinary(registry, "claude");
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "src/cli/doctor.mjs"), "--json", "--guidance-only"],
      {
        cwd: ROOT,
        env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
        encoding: "utf8",
      }
    );
    assert.ok(result.stdout, result.stderr || "doctor produced no stdout");
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.installedRuntimes, []);
    assert.ok(data.agentGuidance, "guidance-only run must still produce agentGuidance");

    const text = spawnSync(
      process.execPath,
      [join(ROOT, "src/cli/doctor.mjs"), "--guidance-only"],
      {
        cwd: ROOT,
        env: { ...process.env, CAREERRAT_HOME: home, ...fakeRegistryEnv(registry) },
        encoding: "utf8",
      }
    ).stdout;
    assert.match(text, /Installed AI runtimes:\n- skipped \(--guidance-only\)\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
  }
});
