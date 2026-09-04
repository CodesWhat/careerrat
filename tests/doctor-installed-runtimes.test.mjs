// Tests for doctor.mjs's "Installed AI runtimes" block (src/cli/doctor.mjs),
// which reuses installed-runtimes.mjs's own registry/detector
// (detectInstalledRuntimes) rather than re-implementing detection. Detection
// never spawns a binary — it only checks what's on disk — so these tests
// fake the registry's search space with a throwaway temp directory (via the
// PATH and CAREERRAT_RUNTIME_SEARCH_DIRS overrides installed-runtimes.mjs
// already supports for exactly this purpose) instead of depending on
// whatever CLIs happen to be installed on the machine running the suite. No
// real binary is ever spawned by doctor here.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeInstalledRuntimeSelection } from "../src/core/ai/runtime-selection.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

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
    const claudePath = writeFakeBinary(registry, "claude");
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
