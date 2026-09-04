import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import YAML from "yaml";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function loadWorkflow() {
  return YAML.parse(await source(".github/workflows/ci-verify.yml"));
}

// Every job that installs from the lockfile (as opposed to structure-guards
// and qlty, which don't).
const DEPENDENCY_JOB_IDS = [
  "tests",
  "web-build",
  "website-build",
  "windows-package-smoke",
  "browser-application-prep",
  "knip",
];

const STEP_NAMES = {
  activate: "Activate the repository-pinned npm release",
  stagingInstall: "Install dependencies (scripts held back until allowScripts is checked)",
  checker: "Check allowScripts coverage (root package.json vs package-lock.json)",
  strictReinstall: "Run approved install scripts (fails closed on anything unreviewed)",
};

// Codex review /tmp/codex-305-r6.md (finding 1): `npm ci --ignore-scripts`
// still creates dependency bin links, and `npm run check:install-scripts`
// prepends node_modules/.bin to PATH, so a dependency shipping a bin named
// `node` could shadow the real interpreter and run before the checker ever
// validates anything. `--no-bin-links` stops the links from being created,
// and invoking the checker through the setup-node-resolved absolute path
// (captured into $TRUSTED_NODE by the activation step, before any install)
// means the checker never does a PATH lookup for `node` at all.
const EXPECTED_STAGING_INSTALL_RUN = "npm ci --ignore-scripts --no-bin-links";
const EXPECTED_CHECKER_RUN = '"$TRUSTED_NODE" scripts/check-install-scripts.mjs';
// Codex review /tmp/codex-305-r5.md (finding 4): `--strict-allow-scripts`
// alone does not neutralize `dangerously-allow-all-scripts` or
// `ignore-scripts`; either override defeats the gate without changing this
// command, so both explicit negations are part of the exact expected string.
const EXPECTED_STRICT_REINSTALL_RUN =
  "npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts --no-ignore-scripts";
const TRUSTED_NODE_CAPTURE_LINE = 'echo "TRUSTED_NODE=$(command -v node)" >> "$GITHUB_ENV"';

// Locates a step by its exact `name:` field — a structural lookup against
// the parsed workflow, not a text search — and returns both the step and
// its position in the job's `steps` array. Throws if the job has no such
// step, which is itself a real finding (a renamed or removed step).
function findStep(steps, name, jobId) {
  const index = steps.findIndex((step) => step?.name === name);
  assert.notEqual(index, -1, `${jobId}: expected a step named "${name}"`);
  return { step: steps[index], index };
}

// Codex review /tmp/codex-305-r6.md (finding 2): the old checks matched
// command *prefixes* with regexes, so they still passed for
// `npm ci --ignore-scripts --no-ignore-scripts`, a strict reinstall with
// `--dangerously-allow-all-scripts` appended, or a trailing `|| true` —
// npm applies the later, conflicting flag, and a trailing `|| true` erases
// the exit code, so each of those defeats the gate while still matching a
// prefix regex. This asserts the exact, complete `run` string for every
// step in the install sequence, plus step order, against a job's already
// structurally-parsed `steps` array. It's shared by the real-workflow test
// below and by the negative-case tests, which mutate an in-memory clone of
// the parsed job and assert this throws.
function assertInstallSequence(steps, jobId) {
  const { step: activate, index: activateIndex } = findStep(steps, STEP_NAMES.activate, jobId);
  const { step: stagingInstall, index: stagingIndex } = findStep(
    steps,
    STEP_NAMES.stagingInstall,
    jobId
  );
  const { step: checker, index: checkerIndex } = findStep(steps, STEP_NAMES.checker, jobId);
  const { step: strictReinstall, index: strictIndex } = findStep(
    steps,
    STEP_NAMES.strictReinstall,
    jobId
  );

  assert.match(
    activate.run ?? "",
    /corepack enable npm\b/,
    `${jobId}: expected \`corepack enable npm\`, not a bare Corepack activation`
  );
  assert.doesNotMatch(
    activate.run ?? "",
    /corepack enable(?!\s+npm\b)/,
    `${jobId}: \`corepack enable\` without the explicit \`npm\` argument does not activate the pinned npm`
  );
  assert.match(
    activate.run ?? "",
    /actual_npm="npm@\$\(npm --version\)"/,
    `${jobId}: expected the activation step to assert the activated npm version`
  );
  assert.ok(
    typeof activate.run === "string" && activate.run.includes(TRUSTED_NODE_CAPTURE_LINE),
    `${jobId}: activation step must capture the setup-node-resolved node path into $TRUSTED_NODE, before any install runs`
  );
  assert.equal(
    stagingInstall.run,
    EXPECTED_STAGING_INSTALL_RUN,
    `${jobId}: staging install must be exactly "${EXPECTED_STAGING_INSTALL_RUN}"`
  );
  assert.equal(
    checker.run,
    EXPECTED_CHECKER_RUN,
    `${jobId}: checker step must invoke the trusted node binary directly by path, not through \`npm run\` (which prepends node_modules/.bin to PATH)`
  );
  assert.equal(
    strictReinstall.run,
    EXPECTED_STRICT_REINSTALL_RUN,
    `${jobId}: strict reinstall must be exactly "${EXPECTED_STRICT_REINSTALL_RUN}"`
  );
  assert.ok(
    activateIndex < stagingIndex && stagingIndex < checkerIndex && checkerIndex < strictIndex,
    `${jobId}: expected activation, then staging install, then checker, then strict reinstall, in that order`
  );
}

// Codex review /tmp/codex-305-r5.md (finding 2): windows-latest defaults to
// PowerShell, where `set -euo pipefail` is a syntax error. The old check
// matched `shell:\s*bash` against the step's raw text, which would also
// match a comment saying `# shell: bash`. This checks the parsed step's
// actual `shell` property.
function assertPipefailStepsUseBashShell(job, jobId) {
  const pipefailSteps = job.steps.filter(
    (step) => typeof step?.run === "string" && step.run.trimStart().startsWith("set -euo pipefail")
  );
  assert.ok(
    pipefailSteps.length > 0,
    `${jobId}: expected at least one multiline \`set -euo pipefail\` step`
  );
  for (const step of pipefailSteps) {
    assert.equal(
      step.shell,
      "bash",
      `${jobId}: step "${step.name}" runs \`set -euo pipefail\` on windows-latest and must declare \`shell: bash\` structurally, or it runs under PowerShell and fails`
    );
  }
}

test("real Chromium application preparation and rendered UI geometry are an explicit required CI context", async () => {
  const [workflow, protection, liveApply, liveVisual] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
    source("tests/playwright-live.test.mjs"),
    source("tests/playwright-app-visual.test.mjs"),
  ]);
  const job = workflow.slice(
    workflow.indexOf("  browser-application-prep:"),
    workflow.indexOf("  qlty:")
  );

  assert.match(job, /name:\s*browser-application-prep/);
  assert.match(job, /CAREERRAT_LIVE_BROWSER:\s*["']?1/);
  assert.match(job, /playwright install --with-deps chromium/);
  assert.match(job, /npm run build --workspace apps\/web/);
  assert.match(job, /tests\/playwright-live\.test\.mjs/);
  assert.match(job, /tests\/playwright-live-dropdowns\.test\.mjs/);
  assert.match(job, /tests\/playwright-app-visual\.test\.mjs/);
  assert.match(job, /output\/playwright/);
  assert.doesNotMatch(job, /ANTHROPIC|OPENAI|CLAUDE|CODEX/);
  assert.match(protection, /"context": "browser-application-prep"/);
  assert.match(liveApply, /assert\.notEqual\(result\.state, "applied"\)/);
  assert.match(liveApply, /clicked\.includes\("Submit application"\), false/);
  assert.match(liveVisual, /getComputedStyle/);
  assert.match(liveVisual, /boundingBox/);
  assert.match(liveVisual, /page\.screenshot/);
});

test("all deterministic product builds are declared as protected contexts", async () => {
  const [workflow, protection] = await Promise.all([
    source(".github/workflows/ci-verify.yml"),
    source("scripts/protect-main.sh"),
  ]);
  for (const context of [
    "web-build",
    "website-build",
    "windows-package-smoke",
    "browser-application-prep",
  ]) {
    assert.match(workflow, new RegExp(`name:\\s*${context}`));
    assert.match(protection, new RegExp(`"context": "${context}"`));
  }
  assert.doesNotMatch(workflow, /web-build, website-build, and windows-package-smoke[^\n]*don't/i);
  assert.doesNotMatch(workflow, /Non-gating for now/i);
});

test("every dependency-installing job activates the pinned npm, resolves a trusted node path, stages installs with scripts and bin-links disabled, checks allowScripts through that trusted node directly, then reinstalls strictly, in order", async () => {
  // Codex review /tmp/codex-305-r3.md through /tmp/codex-305-r6.md: see the
  // shared constants and assertInstallSequence() above for the history each
  // exact string encodes. This test parses the workflow as YAML and checks
  // every dependency-installing job's real, structured steps — not a text
  // search — including the web-build/website-build/windows/knip jobs, not
  // just `tests`.
  const workflow = await loadWorkflow();
  for (const jobId of DEPENDENCY_JOB_IDS) {
    const job = workflow.jobs[jobId];
    assert.ok(job, `expected a top-level "${jobId}" job in ci-verify.yml`);
    assertInstallSequence(job.steps, jobId);
  }
});

test("every windows-latest job's multiline `set -euo pipefail` step declares shell: bash structurally", async () => {
  // Codex review /tmp/codex-305-r5.md (finding 2): windows-latest defaults
  // to PowerShell, where `set -euo pipefail` is a syntax error. Discovers
  // windows-latest jobs from the parsed `runs-on` field rather than
  // hardcoding windows-package-smoke, so a future Windows job is covered
  // automatically.
  const workflow = await loadWorkflow();
  const windowsJobIds = Object.entries(workflow.jobs)
    .filter(([, job]) => job["runs-on"] === "windows-latest")
    .map(([jobId]) => jobId);
  assert.ok(windowsJobIds.length > 0, "expected at least one windows-latest job in ci-verify.yml");
  for (const jobId of windowsJobIds) {
    assertPipefailStepsUseBashShell(workflow.jobs[jobId], jobId);
  }
});

test("negative case: a trailing --no-ignore-scripts on the staging install defeats the gate and must be rejected", async () => {
  // npm applies the later, conflicting flag, so this override silently
  // undoes --ignore-scripts. A prefix-matching regex would miss it; the
  // exact-string check must not.
  const workflow = await loadWorkflow();
  const job = structuredClone(workflow.jobs.tests);
  const { step } = findStep(job.steps, STEP_NAMES.stagingInstall, "tests");
  step.run = `${step.run} --no-ignore-scripts`;
  assert.throws(() => assertInstallSequence(job.steps, "tests"));
});

test("negative case: --dangerously-allow-all-scripts appended to the strict reinstall defeats the gate and must be rejected", async () => {
  const workflow = await loadWorkflow();
  const job = structuredClone(workflow.jobs.tests);
  const { step } = findStep(job.steps, STEP_NAMES.strictReinstall, "tests");
  step.run = `${step.run} --dangerously-allow-all-scripts`;
  assert.throws(() => assertInstallSequence(job.steps, "tests"));
});

test("negative case: a trailing || true on the checker step swallows a failing exit code and must be rejected", async () => {
  const workflow = await loadWorkflow();
  const job = structuredClone(workflow.jobs.tests);
  const { step } = findStep(job.steps, STEP_NAMES.checker, "tests");
  step.run = `${step.run} || true`;
  assert.throws(() => assertInstallSequence(job.steps, "tests"));
});

test("negative case: a missing shell property on the Windows activation step must be rejected", async () => {
  const workflow = await loadWorkflow();
  const job = structuredClone(workflow.jobs["windows-package-smoke"]);
  const { step } = findStep(job.steps, STEP_NAMES.activate, "windows-package-smoke");
  delete step.shell;
  assert.throws(() => assertPipefailStepsUseBashShell(job, "windows-package-smoke"));
});

test("negative case: shell: bash present only in a comment does not satisfy the structural check", async () => {
  // The old check matched `shell:\s*bash` against a step's raw text, which
  // a comment saying `# shell: bash` would also match. This mutates the
  // real workflow *text* (comments don't survive YAML.parse, so this has
  // to happen before parsing) to replace the real `shell: bash` property
  // with a comment of the same text, then proves the structural check
  // still catches it.
  const text = await source(".github/workflows/ci-verify.yml");
  const realProperty =
    "      - name: Activate the repository-pinned npm release\n        shell: bash\n";
  const commentOnly =
    "      - name: Activate the repository-pinned npm release\n        # shell: bash (not a real key — this line proves the check isn't text-based)\n";
  assert.ok(
    text.includes(realProperty),
    "expected to find the real shell: bash property to mutate"
  );
  const mutatedText = text.replace(realProperty, commentOnly);
  const workflow = YAML.parse(mutatedText);
  const job = workflow.jobs["windows-package-smoke"];
  assert.throws(() => assertPipefailStepsUseBashShell(job, "windows-package-smoke"));
});

test("hostile fixture: a node_modules/.bin/node shim cannot intercept the checker step's trusted, absolute-path node invocation", () => {
  // Codex review /tmp/codex-305-r6.md (finding 1): proves the mechanism,
  // not just the workflow text. A hostile `node` binary placed on PATH
  // (what `npm run check:install-scripts` would produce, since npm run
  // prepends node_modules/.bin to PATH) can shadow a bare `node` call. The
  // fix is invoking the setup-node-resolved node by its captured absolute
  // path instead of relying on a PATH lookup, which this fixture shows a
  // hostile bin dir cannot intercept.
  const root = mkdtempSync(join(tmpdir(), "bin-shadow-fixture-"));
  try {
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const markerPath = join(root, "hostile-ran.marker");
    const hostileNodePath = join(binDir, "node");
    writeFileSync(hostileNodePath, `#!/bin/sh\ntouch "${markerPath}"\nexit 1\n`);
    chmodSync(hostileNodePath, 0o755);
    const shadowedPath = `${binDir}:${process.env.PATH}`;

    // Fixture sanity: on a PATH with the hostile bin dir prepended, a bare
    // `node` call (what `npm run` would issue) runs the hostile binary.
    rmSync(markerPath, { force: true });
    spawnSync("bash", ["-c", "node"], { env: { ...process.env, PATH: shadowedPath }, cwd: root });
    assert.equal(
      existsSync(markerPath),
      true,
      "fixture sanity check failed: bare `node` on a shadowed PATH must run the hostile binary"
    );

    // The fix: invoking the trusted, absolute-path node (what $TRUSTED_NODE
    // holds, captured by the activation step before any install ran) on
    // the same shadowed PATH must not touch the hostile binary at all.
    rmSync(markerPath, { force: true });
    const trustedNode = process.execPath;
    spawnSync("bash", ["-c", `"${trustedNode}" --version`], {
      env: { ...process.env, PATH: shadowedPath },
      cwd: root,
    });
    assert.equal(
      existsSync(markerPath),
      false,
      "the trusted, absolute-path node invocation must not be shadowed by a hostile node_modules/.bin/node"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paid native AI certification is separate from deterministic release gates", async () => {
  const [rootPackage, rootVerify, desktopVerify, desktopWorkflow] = await Promise.all([
    source("package.json"),
    source("scripts/verify-live-search-receipts.mjs"),
    source("apps/desktop/scripts/verify-release.mjs"),
    source(".github/workflows/desktop-release.yml"),
  ]);
  const pkg = JSON.parse(rootPackage);
  const macReleaseJob = desktopWorkflow.slice(
    desktopWorkflow.indexOf("  build-notarize-upload:"),
    desktopWorkflow.indexOf("  build-windows-upload:")
  );
  assert.equal(
    pkg.scripts?.["release:pretag"],
    "node --test tests/release-consistency.test.mjs tests/release-gating-ci.test.mjs tests/release-workflow-chain.test.mjs"
  );
  assert.equal(
    pkg.scripts?.["qa:native-search:evidence"],
    "node scripts/verify-live-search-receipts.mjs"
  );
  assert.doesNotMatch(rootVerify, /releaseVersion|EXCEPTION/);
  assert.match(rootVerify, /PASS native AI search certification evidence/);
  assert.doesNotMatch(desktopVerify, /live-search|Live-search|verifyLiveSearchReceiptDirectory/);
  assert.doesNotMatch(desktopWorkflow, /Verify current native AI search receipts/);
  assert.match(desktopWorkflow, /Verify deterministic release metadata/);
  assert.match(desktopWorkflow, /npm run release:pretag/);
  assert.doesNotMatch(
    desktopWorkflow,
    /LIVE_SEARCH_(?:SKIP|BYPASS|EXCEPTION)|skip-live-search|bypass-live-search/i
  );
  assert.doesNotMatch(macReleaseJob, /ANTHROPIC|OPENAI|CLAUDE|CODEX/);
  assert.match(macReleaseJob, /fetch-depth:\s*0/);
});
