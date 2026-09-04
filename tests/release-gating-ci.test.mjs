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
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const require = createRequire(import.meta.url);

// npm's own boolean-flag type shapes (@npmcli/config's Definition.type):
// either the bare `Boolean` constructor, or an array whose only non-`null`
// member is `Boolean` (npm uses `null` in a type array to mean "also
// accepts being unset", e.g. `workspaces`'s `[null, Boolean]` — still a
// standalone flag, not a value-taking one). Anything else in the type
// (String, Number, Array, an enumerated set of string literals like
// `install-strategy`'s `['hoisted', 'nested', 'shallow', 'linked']`, ...)
// means the option consumes a value. Verified against the pinned npm
// 12.0.2's own node_modules/@npmcli/config/lib/definitions/definitions.js:
// `foreground-scripts: { type: Boolean }` (pure), `workspaces: { type:
// [null, Boolean] }` (pure, confirmed boolean-only in practice: `npm test
// --workspaces` never consumes a following token as its value), `omit:
// { type: [Array, 'dev', 'optional', 'peer'] }` (value-taking).
function isPureBooleanOptionType(type) {
  if (type === Boolean || type === null) return true;
  if (Array.isArray(type)) return type.every((t) => t === Boolean || t === null);
  return false;
}

// Corepack's own default cache location (sources/folderUtils.ts,
// getCorepackHomeFolder/getInstallFolder in the installed corepack CLI):
// $COREPACK_HOME, else a platform cache root ($XDG_CACHE_HOME or
// %LOCALAPPDATA% or ~/.cache, ~/AppData/Local on win32) joined with
// "node/corepack", then versioned install folder "v1". This is where the
// "Activate the repository-pinned npm release" step (STEP_NAMES.activate)
// actually leaves the pinned npm release on every dependency job's runner
// once `corepack enable npm` + the first `npm --version` call have
// activated it — npm itself is never a dependency of this repo, so this is
// the only place "the pinned npm" exists on disk in CI.
function corepackNpmDefinitionsPath(npmVersion) {
  const cacheRoot =
    process.env.COREPACK_HOME ??
    join(
      process.env.XDG_CACHE_HOME ??
        process.env.LOCALAPPDATA ??
        join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
      "node/corepack"
    );
  return join(
    cacheRoot,
    "v1/npm",
    npmVersion,
    "node_modules/@npmcli/config/lib/definitions/definitions.js"
  );
}

// Reads the exact pinned npm version off package.json's `packageManager`
// field (the same field the workflow's own activation step reads and
// verifies against, EXPECTED_NPM in ci-verify.yml) rather than trusting
// whatever `npm --version` happens to resolve to on this machine.
function pinnedNpmVersion() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
  if (!match) {
    throw new Error(
      `release-gating-ci.test.mjs: package.json's packageManager ("${pkg.packageManager}") must ` +
        "pin an exact npm version (npm@X.Y.Z) to locate its option definitions"
    );
  }
  return match[1];
}

// Locates npm's real @npmcli/config option definitions and returns the set
// of `--flag`/`-shortFlag` tokens that consume a separate value token, per
// isPureBooleanOptionType above. Tries, in order: a real node_modules/npm
// (if npm is ever added as a project dependency), a hoisted
// node_modules/@npmcli/config (if some other devDependency ever pulls it
// in as a sibling package), then corepack's own install cache for the
// exact pinned version (the actual case in this repo today — see
// corepackNpmDefinitionsPath above). Throws instead of silently falling
// back to a partial list when none resolve: a partial, hand-maintained set
// is the exact bug this replaces (Codex review /tmp/codex-305-r10.md,
// finding 2), so a missing pinned npm must fail this test loudly rather
// than quietly re-introduce it.
function loadNpmValueTakingFlags() {
  const npmVersion = pinnedNpmVersion();
  const attempts = [
    () =>
      require.resolve("npm/node_modules/@npmcli/config/lib/definitions/definitions.js", {
        paths: [fileURLToPath(new URL("..", import.meta.url))],
      }),
    () =>
      require.resolve("@npmcli/config/lib/definitions/definitions.js", {
        paths: [fileURLToPath(new URL("..", import.meta.url))],
      }),
    () => {
      const p = corepackNpmDefinitionsPath(npmVersion);
      if (!existsSync(p)) {
        throw new Error(`no corepack-cached npm@${npmVersion} at ${p}`);
      }
      return p;
    },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const definitionsPath = attempt();
      const definitions = require(definitionsPath);
      const flags = new Set();
      for (const [key, def] of Object.entries(definitions)) {
        if (isPureBooleanOptionType(def.type)) continue;
        flags.add(`--${key}`);
        for (const short of [].concat(def.short ?? [])) {
          flags.add(`-${short}`);
        }
      }
      if (flags.size === 0) {
        throw new Error(`${definitionsPath} loaded but produced no value-taking options`);
      }
      return flags;
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(
    `release-gating-ci.test.mjs: could not load npm@${npmVersion}'s own option definitions from ` +
      `node_modules/npm, a hoisted @npmcli/config, or corepack's install cache; refusing to fall ` +
      `back to a hand-maintained partial list. Tried:\n  ${errors.join("\n  ")}`
  );
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
//
// Codex review /tmp/codex-305-r8.md (finding 2): the previous version of this
// pattern matched only the literal, single-spaced substring "npm ci" right
// after a boundary character. `corepack npm ci`, `command npm ci`, `env
// FOO=1 npm ci`, `npm --foreground-scripts ci`, and even doubled whitespace
// (`npm  ci`) all evade it, so a job could add one of those forms and every
// assertion here would keep passing while the install ran with no gate at
// all. This now splits each step's run text into individual shell commands,
// normalizes whitespace, strips prefixes that don't change what actually
// executes, and only then checks whether what's left is an npm-ci
// invocation (allowing npm options between `npm` and `ci`, but not an
// unrelated subcommand like `npm run ci`).
const COMMAND_SPLIT_PATTERN = /[;&|(]+|\n/g;

// Codex review /tmp/codex-305-r9.md (finding 1): a backslash immediately
// before a line ending (LF or CRLF) is bash's own line-continuation syntax,
// joining the next physical line onto the current logical one. Before this,
// `npm \` on one line and `  ci` on the next were two separate segments —
// neither containing both `npm` and `ci` — so a continued `npm ci` was
// invisible to discovery entirely. Applied before comment-stripping and
// command-splitting so the joined logical line is what both operate on.
const LINE_CONTINUATION_PATTERN = /\\\r?\n[ \t]*/g;

function joinLineContinuations(run) {
  return run.replace(LINE_CONTINUATION_PATTERN, " ");
}

// Leading prefixes that don't change whether `npm ci` actually runs, so they
// have to be peeled off before matching: a bare environment-variable
// assignment (`FOO=1 npm ci`), the `env` builtin (`env FOO=1 npm ci`), the
// `command` builtin (`command npm ci`, often used to bypass a shell
// alias/function), and `corepack` (`corepack npm ci`, which forwards
// straight to the pinned npm). Applied in a loop so chained forms (`env
// FOO=1 command corepack npm ci`) resolve too.
const LEADING_PREFIX_PATTERN = /^(?:(?:env|command|corepack)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)/;

// Codex review /tmp/codex-305-r9.md (finding 1): npm global options can take
// their value as a SEPARATE token (`npm --prefix . ci`, `npm --workspace
// apps/web ci`), not just attached via `=` (`--prefix=.`). A regex matching
// only `--key=value` flags never consumes the separate value token, so it
// never reaches `ci` and misses the invocation entirely.
//
// Codex review /tmp/codex-305-r10.md (finding 2): the nine-entry hand list
// that used to live here only covered the options this repo's workflow
// happened to use. Any other npm 12 global option that takes a
// separate-token value hid an unguarded `npm ci` just as completely:
// `npm --omit dev ci` walks the option-token loop, doesn't recognize
// `--omit` as value-taking, so the loop stops at "dev" (no leading `-`),
// and the trailing check compares "dev" against "ci" instead of ever
// reaching the real `ci` token. `npm --install-strategy hoisted ci`,
// `npm --location project ci`, and `npm --allow-git root ci` are the same
// evasion shape. A hand list can't be complete by construction; it can
// only be complete by accident until the next option that isn't on it.
//
// Fix: load the *real* value-taking option set from the pinned npm's own
// @npmcli/config definitions (npm's own source of truth for which options
// take a value, `type` !== a purely-boolean shape) instead of
// hand-listing it, so a future npm option is covered automatically the
// next time the pin moves. See loadNpmValueTakingFlags below for where
// "the pinned npm" is actually found on disk (it's never a project
// dependency here) and the deliberate hard failure when it can't be.
const NPM_VALUE_OPTIONS = loadNpmValueTakingFlags();

function stripBashComments(run) {
  return run
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

// Collapses whitespace, then repeatedly strips a leading env-assignment /
// `env` / `command` / `corepack` prefix until none remain.
function normalizeCommandSegment(segment) {
  let normalized = segment.replace(/\s+/g, " ").trim();
  for (;;) {
    const stripped = normalized.replace(LEADING_PREFIX_PATTERN, "").trim();
    if (stripped === normalized) return normalized;
    normalized = stripped;
  }
}

// Codex review /tmp/codex-305-r9.md (finding 1): argv-aware replacement for
// the old `NPM_CI_INVOCATION_PATTERN` regex, which could only recognize a
// `--key=value` flag and never consumed a separate-token option value. Walks
// whitespace-separated tokens: `npm`, then any run of option tokens (each
// consuming its own separate value token when it's a known value-taking
// option, per NPM_VALUE_OPTIONS), then requires `ci` as the next bare token.
// A subcommand like "run" in `npm run ci` isn't option-shaped (no leading
// `-`), so the walk stops there and the final check against "ci" fails.
function isExecutableNpmCiSegment(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "npm") return false;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const token = tokens[i];
    if (token.includes("=")) {
      i += 1;
    } else if (NPM_VALUE_OPTIONS.has(token)) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return tokens[i] === "ci";
}

function countExecutableNpmCi(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    if (typeof step?.run !== "string") continue;
    const segments = stripBashComments(joinLineContinuations(step.run)).split(
      COMMAND_SPLIT_PATTERN
    );
    for (const segment of segments) {
      if (isExecutableNpmCiSegment(normalizeCommandSegment(segment))) count++;
    }
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

// Codex review /tmp/codex-305-r8.md (finding 2): the discovery pattern used
// to match only the literal, single-spaced substring "npm ci". Each of these
// forms is a real, common way to invoke npm ci that the old pattern missed
// entirely, so a job (or an extra pre-gate step in an already-gated job)
// using one of them would run completely unguarded while every check here
// stayed green. Every case below is checked twice: once as a brand-new job
// (proving dynamic discovery still finds it) and once as an extra step
// spliced in before the activation step of an already-gated job (proving
// the exact-count check still catches it, the same shape as the "extra npm
// ci inserted before the activation step" case above).
//
// Codex review /tmp/codex-305-r9.md (finding 1): the separate-valued-option
// and line-continuation cases below are the same evasion shape, added after
// the argv-aware rewrite. `npm --prefix . ci` and `npm --workspace apps/web
// ci` take their option's value as its own token, which the old
// `--key=value`-only regex could never consume; a backslash immediately
// before a line ending is bash's own continuation syntax, joining `npm \`
// and the next line into one logical `npm ci`, which the old per-line split
// never reassembled. `npm run ci` (an unrelated subcommand, not tested in
// this loop) must keep failing to match; isExecutableNpmCiSegment's own unit
// shape guarantees that, since "run" never starts with `-`.
//
// Codex review /tmp/codex-305-r10.md (finding 2): the four cases below are
// the same separate-valued-option evasion, but for options the old
// nine-entry hand list didn't cover at all (`--omit`, `--install-strategy`,
// `--location`, `--allow-git`), proving the dynamically-loaded flag set
// (loadNpmValueTakingFlags) actually closes the gap a hand list can't.
for (const [label, run] of [
  ["corepack npm ci", "corepack npm ci"],
  ["command npm ci", "command npm ci"],
  ["env FOO=1 npm ci", "env FOO=1 npm ci"],
  ["npm --foreground-scripts ci", "npm --foreground-scripts ci"],
  ["doubled whitespace", "npm   ci"],
  ["npm --prefix . ci", "npm --prefix . ci"],
  ["npm --workspace apps/web ci", "npm --workspace apps/web ci"],
  ["a backslash line continuation", "npm \\\n  ci"],
  ["npm --omit dev ci", "npm --omit dev ci"],
  ["npm --install-strategy hoisted ci", "npm --install-strategy hoisted ci"],
  ["npm --location project ci", "npm --location project ci"],
  ["npm --allow-git root ci", "npm --allow-git root ci"],
]) {
  test(`negative case: a new job running "${label}" is caught by dynamic discovery`, async () => {
    const workflow = await loadWorkflow();
    const mutated = structuredClone(workflow);
    mutated.jobs["new-unguarded-job"] = {
      "runs-on": "ubuntu-latest",
      steps: [{ name: "Install dependencies", run }],
    };
    assert.throws(() => assertAllNpmCiJobsAreGated(mutated));
  });

  test(`negative case: an extra pre-gate step running "${label}" defeats the exact-count check`, async () => {
    const workflow = await loadWorkflow();
    const mutated = structuredClone(workflow);
    mutated.jobs.tests.steps = [{ name: "Sneaky pre-install", run }, ...mutated.jobs.tests.steps];
    assert.throws(() => assertAllNpmCiJobsAreGated(mutated));
  });
}

test("[codex-305-r10] isExecutableNpmCiSegment recognizes every dynamically-loaded value-taking npm option, and still rejects npm run ci", () => {
  // Direct unit-level check on the segment matcher itself (the workflow-level
  // loop above only ever exercises it indirectly, through YAML fixtures).
  // The four new forms prove loadNpmValueTakingFlags actually replaced the
  // old nine-entry hand list rather than just adding to it: none of `--omit`,
  // `--install-strategy`, `--location`, or `--allow-git` were in that list.
  // `npm run ci` is kept as a direct, permanent negative case per the tenth
  // review's fix note ("keep the npm run ci negative case") since it was
  // previously only guaranteed by the function's shape, never asserted.
  for (const run of [
    "npm --omit dev ci",
    "npm --install-strategy hoisted ci",
    "npm --location project ci",
    "npm --allow-git root ci",
  ]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
  assert.equal(isExecutableNpmCiSegment("npm run ci"), false);
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
  //
  // The fixture root approves "approved-pkg" via allowScripts. CI's pinned
  // npm 12.0.2 blocks (warns and skips, exit 0) any install script not
  // covered by allowScripts by default, whether or not
  // `--strict-allow-scripts` is passed — that flag only changes the warning
  // into a hard failure, per ci-verify.yml's own comment on the strict
  // reinstall step. Without this approval, npm 12.0.2 never runs
  // "approved-pkg"'s postinstall at all, so the fixture's own sanity
  // assertion (the approved postinstall ran) fails before it ever reaches
  // the PATH-shadowing behavior under test. The key uses the `file:` spec
  // form npm's own matcher requires for a non-registry dependency
  // (script-allowed.js's matchFileOrDir): a bare `name@version` key never
  // matches a file/directory node regardless of the name and version being
  // otherwise correct.
  const root = mkdtempSync(join(tmpdir(), "bin-shadow-integration-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "bin-shadow-integration-fixture",
          version: "1.0.0",
          private: true,
          allowScripts: { "approved-pkg@file:vendor/approved-pkg": true },
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

test("fixture: a workspace postinstall that resolves and runs a scriptless dependency's own bin entry survives the full strict-mode reinstall", () => {
  // Codex review /tmp/codex-305-r8.md (finding 1). `apps/docs`'s postinstall
  // used to be the bare string `fumadocs-mdx`, which only works when npm has
  // already created a node_modules/.bin symlink for it. The strict reinstall
  // step (ci-verify.yml's "Run approved install scripts") keeps
  // --no-bin-links through the whole sequence — bin links are materialized
  // afterward by a separate `npm rebuild --ignore-scripts` step, see the
  // fixture above — so a bare `fumadocs-mdx` failed with command-not-found
  // on every clean CI run, before that rebuild step ever got a chance to run.
  //
  // This reproduces the fix's actual mechanism (resolve the dependency's own
  // declared `bin` entry off its package.json and run it directly with the
  // current Node interpreter, the same approach apps/docs/scripts/
  // postinstall.mjs now uses for fumadocs-mdx) end to end against the real
  // npm CLI already resolved on PATH, through the exact sequence
  // ci-verify.yml runs: staging install, then the full
  // `--strict-allow-scripts --no-dangerously-allow-all-scripts
  // --no-ignore-scripts --no-bin-links` reinstall. `bin-provider` here has no
  // lifecycle script of its own (only `fumadocs-mdx`-style bare bin
  // resolution is under test), and `docs-fixture`'s own postinstall is a
  // workspace member's own script, which arborist's unreviewedScripts walk
  // never gates (isWorkspace nodes are skipped, "managed by the workspace
  // owner") — so no allowScripts entry is needed for either, matching how
  // apps/docs's real postinstall runs today.
  const root = mkdtempSync(join(tmpdir(), "docs-postinstall-fixture-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify(
        {
          name: "strict-bin-resolve-fixture",
          version: "1.0.0",
          private: true,
          workspaces: ["packages/*"],
        },
        null,
        2
      )
    );

    const docsFixtureDir = join(root, "packages", "docs-fixture");
    mkdirSync(docsFixtureDir, { recursive: true });
    writeFileSync(
      join(docsFixtureDir, "package.json"),
      JSON.stringify(
        {
          name: "docs-fixture",
          version: "1.0.0",
          private: true,
          dependencies: { "bin-provider": "file:../../vendor/bin-provider" },
          scripts: { postinstall: "node ./postinstall.mjs" },
        },
        null,
        2
      )
    );
    writeFileSync(
      join(docsFixtureDir, "postinstall.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'import { spawnSync } from "node:child_process";',
        'import { dirname, join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "",
        'const pkgJsonPath = fileURLToPath(import.meta.resolve("bin-provider/package.json"));',
        'const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));',
        'const binPath = join(dirname(pkgJsonPath), pkg.bin["bin-provider"]);',
        'const result = spawnSync(process.execPath, [binPath], { stdio: "inherit" });',
        "if (result.error) throw result.error;",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n")
    );

    const binProviderDir = join(root, "vendor", "bin-provider");
    mkdirSync(binProviderDir, { recursive: true });
    writeFileSync(
      join(binProviderDir, "package.json"),
      JSON.stringify(
        { name: "bin-provider", version: "1.0.0", bin: { "bin-provider": "./cli.js" } },
        null,
        2
      )
    );
    const cliPath = join(binProviderDir, "cli.js");
    writeFileSync(
      cliPath,
      '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.CLI_RAN_MARKER, "ran");\n'
    );
    chmodSync(cliPath, 0o755);

    const cliRanMarker = join(root, "cli-ran.marker");
    const binDotBinEntry = join(root, "node_modules", ".bin", "bin-provider");
    const env = { ...process.env, CLI_RAN_MARKER: cliRanMarker };

    // Fixture setup only: generate a real lockfile for the workspace.
    const lock = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: root,
      env,
    });
    assert.equal(lock.status, 0, `npm install --package-lock-only failed: ${lock.stderr}`);

    // Step 1: the workflow's staging install (scripts and bin-links off).
    const stage = spawnSync("npm", ["ci", "--ignore-scripts", "--no-bin-links"], {
      cwd: root,
      env,
    });
    assert.equal(stage.status, 0, `staging npm ci failed: ${stage.stderr}`);
    assert.equal(existsSync(cliRanMarker), false, "no postinstall should have run yet");
    assert.equal(
      existsSync(binDotBinEntry),
      false,
      "the staging install must not create bin links"
    );

    // Step 2: the workflow's actual strict reinstall command, in full,
    // including --strict-allow-scripts — the flag combination the fourth
    // and fifth reviews established doesn't neutralize --no-bin-links, and
    // that the checker's own allowScripts policy still has to tolerate.
    const strict = spawnSync(
      "npm",
      [
        "ci",
        "--strict-allow-scripts",
        "--no-dangerously-allow-all-scripts",
        "--no-ignore-scripts",
        "--no-bin-links",
      ],
      { cwd: root, env }
    );
    assert.equal(
      strict.status,
      0,
      `strict reinstall must succeed with the docs-style postinstall present: ${strict.stderr}`
    );
    assert.equal(
      existsSync(binDotBinEntry),
      false,
      "the strict reinstall must not create bin links either"
    );
    assert.equal(
      existsSync(cliRanMarker),
      true,
      "the workspace postinstall must have resolved and run bin-provider's own bin entry " +
        "without any node_modules/.bin link existing"
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
