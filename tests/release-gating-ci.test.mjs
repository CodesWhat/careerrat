import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  binLink: "Materialize dependency bin links (scripts already ran; this only links)",
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
// Codex review /tmp/codex-305-r7.md (finding 1): this reinstall now also
// keeps `--no-bin-links`, so a scriptless, unreviewed package's own `bin`
// entry (invisible to allowScripts, which only walks lifecycle scripts)
// can't land on PATH ahead of an approved package's postinstall. Bin links
// are materialized afterward, once scripts are done running, by the
// separate `npm rebuild --ignore-scripts` step below.
const EXPECTED_STRICT_REINSTALL_RUN =
  "npm ci --strict-allow-scripts --no-dangerously-allow-all-scripts --no-ignore-scripts --no-bin-links";
const EXPECTED_BIN_LINK_RUN = "npm rebuild --ignore-scripts";
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
  const { step: binLink, index: binLinkIndex } = findStep(steps, STEP_NAMES.binLink, jobId);

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
  assert.equal(
    binLink.run,
    EXPECTED_BIN_LINK_RUN,
    `${jobId}: bin-link step must be exactly "${EXPECTED_BIN_LINK_RUN}"`
  );
  assert.ok(
    activateIndex < stagingIndex &&
      stagingIndex < checkerIndex &&
      checkerIndex < strictIndex &&
      strictIndex < binLinkIndex,
    `${jobId}: expected activation, then staging install, then checker, then strict reinstall, then the bin-link step, in that order`
  );
}

// Codex review /tmp/codex-305-r7.md (finding 4): discovers every job with an
// *executable* `npm ci` — not one hardcoded list — so a new job with its own
// unguarded install is caught instead of silently skipped. A step is a full
// line, or a chained `;`/`&&`/`(` boundary, or the start of a line inside a
// multiline `run:` block; a line that's a pure `#`-comment is stripped first
// so a comment mentioning "npm ci" doesn't count as one running.
const EXECUTABLE_NPM_CI_PATTERN = /(?:^|[;&|(])\s*npm ci\b/gm;

function stripBashComments(run) {
  return run
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

function countExecutableNpmCi(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    if (typeof step?.run !== "string") continue;
    const matches = stripBashComments(step.run).match(EXECUTABLE_NPM_CI_PATTERN);
    if (matches) count += matches.length;
  }
  return count;
}

function discoverJobsWithExecutableNpmCi(workflow) {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => countExecutableNpmCi(job.steps) > 0)
    .map(([jobId]) => jobId);
}

// Shared by the real-workflow discovery test and its negative cases: proves
// both that the discovered jobs run the exact approved sequence in order
// (assertInstallSequence) and that no *other* `npm ci` exists anywhere else
// in the job.
function assertAllNpmCiJobsAreGated(workflow) {
  const jobIds = discoverJobsWithExecutableNpmCi(workflow);
  assert.ok(jobIds.length > 0, "expected at least one job with an executable npm ci");
  for (const jobId of jobIds) {
    const job = workflow.jobs[jobId];
    assertInstallSequence(job.steps, jobId);
    const total = countExecutableNpmCi(job.steps);
    assert.equal(
      total,
      2,
      `${jobId}: expected exactly 2 executable "npm ci" invocations (staging install + strict reinstall), found ${total}`
    );
  }
}

// Codex review /tmp/codex-305-r5.md (finding 2): windows-latest defaults to
// PowerShell, where `set -euo pipefail` is a syntax error. The old check
// matched `shell:\s*bash` against the step's raw text, which would also
// match a comment saying `# shell: bash`. This checks the parsed step's
// actual `shell` property.
//
// Codex review /tmp/codex-305-r7.md (finding 2): the old check only caught
// the multiline `set -euo pipefail` activation step; it missed the
// checker step's `"$TRUSTED_NODE" ...` bash-only variable interpolation,
// which parses as an empty-string invocation under PowerShell's own `$VAR`
// syntax and fails before packaging. Every step in the install sequence
// (activation, staging install, checker, strict reinstall, bin-link) uses
// Bash syntax, so all of them are checked here, identified by the same
// step names assertInstallSequence looks up rather than re-deriving a
// pattern from each step's `run` text.
const BASH_SYNTAX_STEP_NAMES = new Set([
  STEP_NAMES.activate,
  STEP_NAMES.stagingInstall,
  STEP_NAMES.checker,
  STEP_NAMES.strictReinstall,
  STEP_NAMES.binLink,
]);

function assertBashSyntaxStepsUseBashShell(job, jobId) {
  const bashSteps = job.steps.filter(
    (step) =>
      BASH_SYNTAX_STEP_NAMES.has(step?.name) ||
      (typeof step?.run === "string" && step.run.trimStart().startsWith("set -euo pipefail"))
  );
  assert.ok(bashSteps.length > 0, `${jobId}: expected at least one Bash-syntax step`);
  for (const step of bashSteps) {
    assert.equal(
      step.shell,
      "bash",
      `${jobId}: step "${step.name}" uses Bash syntax on windows-latest and must declare \`shell: bash\` structurally, or it runs under PowerShell and fails`
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

test("every job with an executable npm ci install is discovered and runs exactly the approved gated sequence, with no other npm ci", async () => {
  // Codex review /tmp/codex-305-r7.md (finding 4): the previous version of
  // this suite only ever looked at DEPENDENCY_JOB_IDS, a hardcoded list, so
  // a brand-new job added straight to ci-verify.yml with its own unguarded
  // `npm ci` would pass every assertion here without ever being checked.
  // This discovers every job containing an executable `npm ci` from the
  // parsed workflow itself (never DEPENDENCY_JOB_IDS), asserts the
  // discovered set matches the known list (so drift between the two is
  // itself a finding), then requires the full approved sequence AND that
  // exactly two `npm ci` invocations exist in the job (the staging install
  // and the strict reinstall) — an extra one anywhere else in the job fails
  // even though the four named steps still look correct in isolation.
  const workflow = await loadWorkflow();
  const discovered = discoverJobsWithExecutableNpmCi(workflow).sort();
  assert.deepEqual(
    discovered,
    [...DEPENDENCY_JOB_IDS].sort(),
    "the set of jobs with an executable npm ci must match the known dependency-installing jobs; " +
      "a new job with its own npm ci needs the approved sequence too"
  );
  assertAllNpmCiJobsAreGated(workflow);
});

test("every windows-latest job's Bash-syntax steps declare shell: bash structurally", async () => {
  // Codex review /tmp/codex-305-r5.md (finding 2) and /tmp/codex-305-r7.md
  // (finding 2): windows-latest defaults to PowerShell, where both a
  // multiline `set -euo pipefail` script and a bare `"$TRUSTED_NODE" ...`
  // variable interpolation are syntax errors (or silently resolve to an
  // empty PowerShell variable). Discovers windows-latest jobs from the
  // parsed `runs-on` field rather than hardcoding windows-package-smoke, so
  // a future Windows job is covered automatically.
  const workflow = await loadWorkflow();
  const windowsJobIds = Object.entries(workflow.jobs)
    .filter(([, job]) => job["runs-on"] === "windows-latest")
    .map(([jobId]) => jobId);
  assert.ok(windowsJobIds.length > 0, "expected at least one windows-latest job in ci-verify.yml");
  for (const jobId of windowsJobIds) {
    assertBashSyntaxStepsUseBashShell(workflow.jobs[jobId], jobId);
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
  assert.throws(() => assertBashSyntaxStepsUseBashShell(job, "windows-package-smoke"));
});

test("negative case: a missing shell property on the Windows checker step must be rejected", async () => {
  // Codex review /tmp/codex-305-r7.md (finding 2): this is the exact bug —
  // the checker step's `"$TRUSTED_NODE" ...` invocation had no `shell: bash`
  // at all, so it parsed as PowerShell and failed before packaging. The
  // activation step already declared `shell: bash`, so a check that only
  // ever looked at that one step never would have caught this.
  const workflow = await loadWorkflow();
  const job = structuredClone(workflow.jobs["windows-package-smoke"]);
  const { step } = findStep(job.steps, STEP_NAMES.checker, "windows-package-smoke");
  delete step.shell;
  assert.throws(() => assertBashSyntaxStepsUseBashShell(job, "windows-package-smoke"));
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
  assert.throws(() => assertBashSyntaxStepsUseBashShell(job, "windows-package-smoke"));
});

test("negative case: a new job with an unguarded npm ci is caught by dynamic discovery", async () => {
  // Codex review /tmp/codex-305-r7.md (finding 4): a job that isn't in
  // DEPENDENCY_JOB_IDS at all, with a bare `npm ci` and none of the
  // approved sequence's other steps, must still fail — discovery has to
  // find it on its own, not rely on the hardcoded list.
  const workflow = await loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs["new-unguarded-job"] = {
    "runs-on": "ubuntu-latest",
    steps: [{ name: "Install dependencies", run: "npm ci" }],
  };
  assert.throws(() => assertAllNpmCiJobsAreGated(mutated));
});

test("negative case: an extra npm ci inserted before the activation step defeats the exact-count check", async () => {
  // Codex review /tmp/codex-305-r7.md (finding 4): the four named steps
  // still exist in the right relative order, so assertInstallSequence alone
  // would pass; only the exact-count check (exactly 2 executable npm ci
  // invocations per job) catches the extra, unreviewed install ahead of the
  // gate.
  const workflow = await loadWorkflow();
  const mutated = structuredClone(workflow);
  mutated.jobs.tests.steps = [
    { name: "Sneaky pre-install", run: "npm ci" },
    ...mutated.jobs.tests.steps,
  ];
  assert.throws(() => assertAllNpmCiJobsAreGated(mutated));
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

test("fixture: a scriptless package's bin.node never reaches PATH while the strict install step runs an approved postinstall", () => {
  // Codex review /tmp/codex-305-r7.md (finding 1). A package with NO
  // install-relevant lifecycle script is invisible to allowScripts entirely
  // (arborist's collectUnreviewedScripts only walks preinstall/install/
  // postinstall/prepare, never `bin`), so a scriptless dependency shipping
  // `bin.node` sails through the checker gate unreviewed. Before this fix,
  // the strict reinstall step (ci-verify.yml's "Run approved install
  // scripts") re-enabled bin links while running approved scripts, so that
  // shim could land on PATH ahead of the real interpreter for an approved
  // package's own bare `node` postinstall call. The fix keeps
  // `--no-bin-links` through the strict reinstall and defers bin linking to
  // a separate, scripts-off `npm rebuild --ignore-scripts` step afterward.
  //
  // This runs the real npm CLI already resolved on PATH through the exact
  // `--ignore-scripts`/`--no-bin-links` sequence the workflow uses (the
  // security-relevant flags; `--strict-allow-scripts` governs a separate,
  // already-tested concern — review completeness, not PATH exposure — and
  // isn't required to reproduce this mechanism), against two local `file:`
  // dependencies, so no network access is needed.
  const root = mkdtempSync(join(tmpdir(), "bin-shadow-integration-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "bin-shadow-integration-fixture",
          version: "1.0.0",
          private: true,
          dependencies: {
            "scriptless-shim": "file:./vendor/scriptless-shim",
            "approved-pkg": "file:./vendor/approved-pkg",
          },
        },
        null,
        2
      )
    );

    const shimDir = join(root, "vendor", "scriptless-shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "package.json"),
      JSON.stringify({ name: "scriptless-shim", version: "1.0.0", bin: { node: "shim.js" } })
    );
    const shimPath = join(shimDir, "shim.js");
    writeFileSync(
      shimPath,
      '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.SHIM_MARKER, "HOSTILE");\n'
    );
    chmodSync(shimPath, 0o755);

    const approvedDir = join(root, "vendor", "approved-pkg");
    mkdirSync(approvedDir, { recursive: true });
    writeFileSync(
      join(approvedDir, "package.json"),
      JSON.stringify({
        name: "approved-pkg",
        version: "1.0.0",
        scripts: {
          postinstall:
            "node -e \"require('fs').writeFileSync(process.env.REAL_MARKER, process.execPath)\"",
        },
      })
    );

    const shimMarker = join(root, "shim-ran.marker");
    const realMarker = join(root, "postinstall-ran.marker");
    const binDotBinNode = join(root, "node_modules", ".bin", "node");
    const env = { ...process.env, SHIM_MARKER: shimMarker, REAL_MARKER: realMarker };

    // Fixture setup only (not the behavior under test): generate a real
    // lockfile for the two local file: dependencies.
    const lock = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: root,
      env,
    });
    assert.equal(lock.status, 0, `npm install --package-lock-only failed: ${lock.stderr}`);

    // Step 1: the workflow's staging install.
    const stage = spawnSync("npm", ["ci", "--ignore-scripts", "--no-bin-links"], {
      cwd: root,
      env,
    });
    assert.equal(stage.status, 0, `staging npm ci failed: ${stage.stderr}`);
    assert.equal(
      existsSync(binDotBinNode),
      false,
      "the staging install must not create node_modules/.bin/node"
    );
    assert.equal(existsSync(shimMarker), false);
    assert.equal(existsSync(realMarker), false);

    // Step 2: the workflow's strict reinstall — scripts on, bin-links still off.
    const strict = spawnSync("npm", ["ci", "--no-ignore-scripts", "--no-bin-links"], {
      cwd: root,
      env,
    });
    assert.equal(strict.status, 0, `strict npm ci failed: ${strict.stderr}`);
    assert.equal(
      existsSync(binDotBinNode),
      false,
      "the strict reinstall must not create node_modules/.bin/node either"
    );
    assert.equal(
      existsSync(shimMarker),
      false,
      "the scriptless package's hostile bin must never run"
    );
    assert.equal(existsSync(realMarker), true, "the approved postinstall must have run");
    const recordedNode = readFileSync(realMarker, "utf8");
    assert.ok(
      existsSync(recordedNode),
      `the approved postinstall's bare \`node\` must resolve to a real, existing interpreter, got "${recordedNode}"`
    );
    assert.notEqual(
      recordedNode,
      shimPath,
      "the approved postinstall's bare `node` must not resolve to the hostile shim"
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
