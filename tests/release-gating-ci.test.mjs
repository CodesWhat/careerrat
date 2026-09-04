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
import { fileURLToPath } from "node:url";

import YAML from "yaml";

// installedNpmConfigVersion and resolveNpmConfigDefinitionsPath aren't
// called from this file directly — the empty-COREPACK_HOME regression
// further down imports them itself, inside a freshly spawned node
// process, so it exercises the exact same helper module this file uses.
import {
  computeNpmValueOptions,
  loadNpmConfigDefinitions,
} from "./helpers/npm-cli-definitions.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
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

// The exact @npmcli/config version each pinned npm release bundles (checked
// against that release's own installed node_modules/@npmcli/config/
// package.json, not just its package.json's "^" dependency range, which is
// looser than what actually ships). Kept as a hardcoded, offline map instead
// of a live `npm view` lookup so this suite never needs network access; the
// version-pin regression below fails the moment the `packageManager` pin
// moves to an npm release not yet listed here, until this map (and the
// @npmcli/config devDependency in package.json) are updated to match.
const NPM_BUNDLED_NPMCLI_CONFIG_VERSION = {
  "12.0.2": "11.0.1",
};

// Codex review /tmp/codex-305-r12.md (finding 1): npm 12.0.2 resolves
// several other command spellings to `ci` before ever comparing the
// parsed command against the literal string "ci" — a `run:` line using
// one of them installed with lifecycle scripts unguarded while every
// check here still passed, since isExecutableNpmCiSegment only ever
// accepted the exact token "ci". Verified against the published
// npm@12.0.2 package's own lib/utils/cmd-list.js: its `aliases` table
// maps `clean-install`, `ic`, `install-clean`, and `isntall-clean` (a
// deliberate npm typo alias, not a mistake in this list) directly to
// canonical command "ci". The abbreviation chains built from `commands`
// (`insta`, `instal`, ...) resolve to "install" instead and are
// correctly excluded. Kept next to NPM_BUNDLED_NPMCLI_CONFIG_VERSION so a
// future npm bump prompts re-checking this set against that release's
// own cmd-list.js.
const NPM_CI_COMMAND_ALIASES = new Set(["clean-install", "ic", "install-clean", "isntall-clean"]);

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
// next time the pin moves. See ./helpers/npm-cli-definitions.mjs for
// loadNpmConfigDefinitions and computeNpmValueOptions themselves (a
// plain devDependency require, not a filesystem probe) — moved there
// (Codex review /tmp/codex-305-r12.md, finding 2) so the empty-COREPACK_HOME
// regression further down can import and exercise the real loader from a
// freshly spawned process.
const { definitions: NPM_DEFINITIONS, shorthands: NPM_SHORTHANDS } = loadNpmConfigDefinitions();

const NPM_VALUE_OPTIONS = computeNpmValueOptions(NPM_DEFINITIONS);

// Codex review /tmp/codex-305-r11.md (finding 2): the option-token loop
// below only ever consulted each definition's own `short` field (a
// single-letter shortcut for that same flag, e.g. `-w` for `--workspace`).
// npm also defines a separate table of *standalone* aliases
// (@npmcli/config's `shorthands` export, definitions/index.js) that expand
// to a completely different flag, sometimes with a value already baked in:
// `reg` -> `['--registry']` (rename only, still value-taking) and
// `enjoy-by` -> `['--before']` (same shape) let `npm --reg URL ci` and
// `npm --enjoy-by DATE ci` walk straight past the old loop, since neither
// `--reg` nor `--enjoy-by` was ever a key in `definitions.js` itself, so
// the loop treated them as bare (non-consuming) flags and stopped one
// token too early — landing on the option's value ("URL"/"DATE") instead
// of the `ci` that followed it, and failing the whole match. Other aliases
// bake their value directly into the expansion instead of taking a
// separate token at all (`d` -> `['--loglevel', 'info']`, so `-d` alone
// consumes nothing further from argv).
//
// Fix: before classifying an option token, look it up (stripped of its
// leading dash(es), since npm's alias table itself has no dashes) in this
// same `shorthands` export and, if it matches, classify the *expansion*
// instead: a single-element expansion is a plain rename, so whether it
// consumes a following value token is decided by NPM_VALUE_OPTIONS same as
// any other flag; a multi-element expansion already supplies its value, so
// it consumes nothing further.
function expandNpmShorthand(token) {
  const bareName = token.replace(/^--?/, "");
  return NPM_SHORTHANDS[bareName] ?? null;
}

// Codex review /tmp/codex-305-r12.md (finding 1): grouped short options
// (POSIX-style glomming of several single-character flags onto one dash,
// e.g. `-dC .` for `-d -C .`) evaded expandNpmShorthand entirely, since
// "dC" is never itself a key in npm's shorthands table — only "d" and "C"
// are. npm's own parser (nopt's resolveShort, in the nopt version
// @npmcli/config bundles) accepts this form specifically when EVERY
// character of the token (after its single leading dash) is itself a
// single-character shorthand key, and expands it by concatenating each
// character's own expansion in order: `-dC` becomes `--loglevel info
// --prefix`, the exact three-token sequence isExecutableNpmCiSegment
// below splices back into the stream and re-walks, so each piece gets
// the same single/multi-element handling as any other shorthand
// expansion (see expandNpmShorthand's own comment above) without needing
// separate consumption logic here.
function expandGroupedShortOptions(token) {
  if (!/^-[^-]/.test(token) || token.length < 3) return null;
  const characters = token.slice(1).split("");
  if (!characters.every((char) => Object.hasOwn(NPM_SHORTHANDS, char))) return null;
  return characters.flatMap((char) => NPM_SHORTHANDS[char]);
}

// Codex review /tmp/codex-305-r12.md (finding 1): the option-token loop
// used to split each segment on bare whitespace
// (`segment.split(/\s+/).filter(Boolean)`), so a quoted option value
// containing a space (`npm --enjoy-by "2020-01-01 00:00" ci`) split into
// two separate tokens ("2020-01-01" and "00:00"), leaving `ci` one token
// further away than the option-token loop expects and failing the whole
// match. This is a small POSIX-ish word-splitter, not a shell: it
// understands single quotes (fully literal, no escapes), double quotes
// (backslash escapes only `\`, `"`, `$`, and a backtick, per POSIX —
// anything else after a backslash inside double quotes keeps the
// backslash literally), and a bare backslash outside quotes escaping
// whatever character follows it. It performs no expansion at all — no
// `$VAR`, no globs, no command substitution — because none of those
// change *whether* the invocation is `npm ci`, only what an option's
// value resolves to at runtime, which is out of scope for this gate.
function tokenizeShellWords(segment) {
  const tokens = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  while (i < segment.length) {
    const char = segment[i];
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      i += 1;
      continue;
    }
    if (char === "'") {
      hasToken = true;
      const end = segment.indexOf("'", i + 1);
      const close = end === -1 ? segment.length : end;
      current += segment.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (char === '"') {
      hasToken = true;
      i += 1;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === "\\" && '"\\$`'.includes(segment[i + 1])) {
          current += segment[i + 1];
          i += 2;
        } else {
          current += segment[i];
          i += 1;
        }
      }
      i += 1; // skip the closing quote (or step past the end if unterminated)
      continue;
    }
    if (char === "\\" && i + 1 < segment.length) {
      current += segment[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }
    current += char;
    hasToken = true;
    i += 1;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

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
//
// Codex review /tmp/codex-305-r11.md (finding 2): before consulting
// NPM_VALUE_OPTIONS directly, first expand the token through npm's own
// standalone shorthand table (expandNpmShorthand above) — a bare rename
// (`--reg` -> `--registry`) is then classified exactly like the real flag
// it stands for, and an alias whose expansion already bakes in a value
// (`-d` -> `--loglevel info`) consumes nothing further from argv, since
// nothing about it came from a separate token in the actual command line.
//
// Codex review /tmp/codex-305-r12.md (finding 1): rather than special-case
// how many tokens each *kind* of expansion consumes (single-element vs.
// multi-element, as the old inline arithmetic did), a matched expansion
// — whether from a plain shorthand or from expandGroupedShortOptions'
// grouped form — is spliced back into the token stream in place of the
// token it replaced, and the loop re-walks from the same index. This is
// the same mechanism npm's own parser (nopt) uses: it lets a multi-element
// expansion's own baked-in words resolve themselves on the next pass
// (`--loglevel` immediately followed by its own `info`) and lets a
// trailing single-element rename fall through to the ordinary
// NPM_VALUE_OPTIONS check and consume whatever real token follows it,
// without this loop needing to know which case it's in up front. The
// parsed command is then resolved through npm's own command aliases
// (NPM_CI_COMMAND_ALIASES) before comparing against "ci", so
// `npm clean-install`/`npm ic` are recognized exactly like `npm ci`.
function isExecutableNpmCiSegment(segment) {
  const tokens = tokenizeShellWords(segment);
  if (tokens[0] !== "npm") return false;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const token = tokens[i];
    if (token.includes("=")) {
      i += 1;
      continue;
    }
    const expansion = expandNpmShorthand(token) ?? expandGroupedShortOptions(token);
    if (expansion) {
      tokens.splice(i, 1, ...expansion);
      continue;
    }
    if (NPM_VALUE_OPTIONS.has(token)) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const command = tokens[i];
  return command === "ci" || NPM_CI_COMMAND_ALIASES.has(command);
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
// (computeNpmValueOptions, over the real @npmcli/config definitions) closes
// the gap a hand list can't.
//
// Codex review /tmp/codex-305-r11.md (finding 2): `--reg` and `--enjoy-by`
// are npm's own *standalone* aliases for `--registry` and `--before` (see
// expandNpmShorthand) — neither is a key in `definitions.js` itself, so
// they evaded the option-token loop entirely until it started expanding
// through npm's `shorthands` table first.
//
// Codex review /tmp/codex-305-r12.md (finding 1): three more evasion
// shapes, all still executing the real `npm ci` while defeating the old
// classifier. `npm clean-install` and `npm ic` are npm's own command
// aliases (see NPM_CI_COMMAND_ALIASES) — no `ci` token ever appears, so
// the old literal `tokens[i] === "ci"` check could never match either
// one. `npm -dC . ci` is a grouped short option (`-d` and `-C` glommed
// onto one dash; see expandGroupedShortOptions) that the old loop
// treated as a single unrecognized token and gave up on one token too
// early. `npm --enjoy-by "2020-01-01 00:00" ci` is the shell-quoting
// evasion (see tokenizeShellWords) — the old bare `.split(/\s+/)`
// split the quoted value's internal space into two tokens, landing on
// "00:00" instead of the real `ci` two tokens later.
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
  ["npm --reg URL ci", "npm --reg https://registry.example.com ci"],
  ["npm --enjoy-by DATE ci", "npm --enjoy-by 2020-01-01 ci"],
  ["npm clean-install", "npm clean-install"],
  ["npm ic", "npm ic"],
  ["npm -dC . ci", "npm -dC . ci"],
  ["npm --enjoy-by quoted DATE ci", 'npm --enjoy-by "2020-01-01 00:00" ci'],
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

test("[codex-305-r11] isExecutableNpmCiSegment expands npm's own standalone shorthand aliases before classifying", () => {
  // `--reg` and `--enjoy-by` are rename-only aliases (their expansion is a
  // single element, `['--registry']`/`['--before']`) for two definitions
  // that do take a value, so both must still consume their following
  // token and reach the real `ci`.
  for (const run of ["npm --reg https://registry.example.com ci", "npm --enjoy-by 2020-01-01 ci"]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
  // `-d` is npm's alias for `--loglevel info` — a multi-element expansion
  // that already bakes its value in, so it must consume nothing further
  // from argv; `ci` right after it is still the next real token, not `-d`'s
  // value.
  assert.equal(isExecutableNpmCiSegment("npm -d ci"), true);
});

test("[codex-305-r12] isExecutableNpmCiSegment resolves npm's own command aliases to ci", () => {
  // Verified against the published npm@12.0.2 package's own
  // lib/utils/cmd-list.js `aliases` table (see NPM_CI_COMMAND_ALIASES):
  // all four resolve to canonical command "ci", not to a bare "ci" token
  // anywhere in the run string.
  for (const run of ["npm clean-install", "npm ic", "npm install-clean", "npm isntall-clean"]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
});

test("[codex-305-r12] isExecutableNpmCiSegment expands grouped short options letter by letter", () => {
  // `-dC .` gloms `-d` (multi-element: `--loglevel info`, self-contained)
  // and `-C` (single-element rename for `--prefix`, value-taking) onto one
  // dash. Both must resolve in order, with `-C`'s expansion still
  // consuming the real `.` token, to reach the real `ci`.
  assert.equal(isExecutableNpmCiSegment("npm -dC . ci"), true);
  // A grouped token where every character is a real single-char shorthand
  // but the group itself doesn't end on a value-taking expansion (`-f` is
  // the boolean `--force`) must not swallow an unrelated following token.
  assert.equal(isExecutableNpmCiSegment("npm -gf ci"), true);
  // Not every multi-letter, single-dash token is a valid grouped option —
  // "-xz" has no shorthand keys "x" or "z" at all, so expandGroupedShortOptions
  // must decline it (returning null, not a bogus partial expansion) and
  // fall through to ordinary, non-consuming option handling, which still
  // finds "ci" as the very next token.
  assert.equal(isExecutableNpmCiSegment("npm -xz ci"), true);
});

test("[codex-305-r12] isExecutableNpmCiSegment tokenizes shell quoting instead of splitting on bare whitespace", () => {
  // A double-quoted option value containing a space must stay one token,
  // so the option-token loop consumes exactly one value token (not two)
  // and still reaches the real `ci` right after it.
  assert.equal(isExecutableNpmCiSegment('npm --enjoy-by "2020-01-01 00:00" ci'), true);
  // Single quotes are fully literal (no backslash escapes inside them),
  // and a backslash outside quotes escapes the very next character.
  assert.equal(isExecutableNpmCiSegment("npm --enjoy-by '2020-01-01 00:00' ci"), true);
  assert.equal(isExecutableNpmCiSegment("npm --enjoy-by 2020-01-01\\ 00:00 ci"), true);
});

// Codex review /tmp/codex-305-r11.md (finding 1): keeps the @npmcli/config
// devDependency pin (package.json) honest against the npm version actually
// pinned in `packageManager`. This is deliberately offline — no `npm view`
// call — so the suite never needs network access; a future npm bump must
// update NPM_BUNDLED_NPMCLI_CONFIG_VERSION and the devDependency together,
// or this fails.
test("[codex-305-r11] the @npmcli/config devDependency is pinned to the exact version the pinned npm release bundles", () => {
  const npmVersion = pinnedNpmVersion();
  const expectedVersion = NPM_BUNDLED_NPMCLI_CONFIG_VERSION[npmVersion];
  assert.ok(
    expectedVersion,
    `release-gating-ci.test.mjs: no recorded bundled @npmcli/config version for npm@${npmVersion}; ` +
      "add one to NPM_BUNDLED_NPMCLI_CONFIG_VERSION (check that npm release's own installed " +
      "node_modules/@npmcli/config/package.json) before moving the packageManager pin"
  );
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    pkg.devDependencies["@npmcli/config"],
    expectedVersion,
    `package.json's @npmcli/config devDependency must be pinned to the exact version ` +
      `(${expectedVersion}) that npm@${npmVersion} bundles, not a range or a different version`
  );
});

// Codex review /tmp/codex-305-r11.md (finding 1): proves the loader
// (loadNpmConfigDefinitions) genuinely no longer depends on a pre-populated
// Corepack cache. Spawns a fresh node process, with $COREPACK_HOME pointed
// at a brand-new empty directory, that requires the exact module this file
// loads its option/shorthand tables from — the same failure mode the
// macOS desktop-release job hit (bundled `npm ci` then `release:pretag`,
// with Corepack never invoked) is reproduced directly here instead of only
// being asserted about.
//
// Codex review /tmp/codex-305-r12.md (finding 2): the spawned child used
// to `require()` the definitions module directly, by its own hardcoded
// path literal — a completely separate resolution from
// loadNpmConfigDefinitions, so a future regression inside that function
// (e.g. reintroducing a Corepack-cache probe) could still pass this test
// even though the real loader under test was never exercised. The child
// now imports tests/helpers/npm-cli-definitions.mjs — the same module
// this file itself imports loadNpmConfigDefinitions from — and calls the
// real loadNpmConfigDefinitions, then asserts the resolved path landed
// inside this project's own node_modules/@npmcli/config (not some other
// copy on the machine) and that the resolved version matches the pin map
// entry for the currently-pinned npm release.
test("[codex-305-r12] the loader still works with COREPACK_HOME pointed at an empty directory, importing the real helper under test", () => {
  const emptyCorepackHome = mkdtempSync(join(tmpdir(), "empty-corepack-home-"));
  const helperUrl = new URL("./helpers/npm-cli-definitions.mjs", import.meta.url).href;
  const script = [
    `import { loadNpmConfigDefinitions, resolveNpmConfigDefinitionsPath, installedNpmConfigVersion } from ${JSON.stringify(helperUrl)};`,
    "const { definitions } = loadNpmConfigDefinitions();",
    "process.stdout.write(JSON.stringify({",
    "  definitionCount: Object.keys(definitions).length,",
    "  resolvedPath: resolveNpmConfigDefinitionsPath(),",
    "  version: installedNpmConfigVersion(),",
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, COREPACK_HOME: emptyCorepackHome },
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `expected the real loader to succeed with an empty COREPACK_HOME, got: ${result.stderr}`
  );
  const output = JSON.parse(result.stdout);
  assert.ok(
    output.definitionCount > 0,
    "expected the real loader to return npm's own option definitions"
  );
  const projectNpmcliConfigDir = fileURLToPath(
    new URL("../node_modules/@npmcli/config/", import.meta.url)
  );
  assert.ok(
    output.resolvedPath.startsWith(projectNpmcliConfigDir),
    `expected the loader to resolve under this project's own ${projectNpmcliConfigDir}, got: ${output.resolvedPath}`
  );
  const npmVersion = pinnedNpmVersion();
  assert.equal(
    output.version,
    NPM_BUNDLED_NPMCLI_CONFIG_VERSION[npmVersion],
    `expected the resolved @npmcli/config version to equal the pin map entry for npm@${npmVersion}`
  );
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
