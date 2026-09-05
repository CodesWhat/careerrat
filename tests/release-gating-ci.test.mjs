// Threat model for the workflow-discovery classifier below
// (splitShellSegments, isExecutableNpmCiSegment, derefNpmCommand,
// discoverJobsWithExecutableNpmCi, and friends): it exists to catch an
// accidental, unguarded `npm ci` a maintainer adds to a `run:` step on
// ci-verify.yml, a workflow file that only changes through ordinary,
// human-reviewed pull requests. It is not a sandbox against a hostile edit
// to that workflow — a `run:` step already executes arbitrary shell, so
// anyone who can edit ci-verify.yml at all can run any command they like
// regardless of how thorough this classifier is (an `eval`, a decoded
// script, a binary that itself shells out to npm, ...). Its job is
// catching the honest-maintainer mistake, not defending against a
// malicious one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

// loadNpmConfigDefinitions, installedNpmConfigVersion, and
// resolveNpmConfigDefinitionsPath aren't called from this file directly —
// parseNpmArgv (below) already calls loadNpmConfigDefinitions itself, and
// the empty-COREPACK_HOME regression further down imports all three itself,
// inside a freshly spawned node process, so it exercises the exact same
// helper module this file uses.
import { parseNpmArgv } from "./helpers/npm-cli-definitions.mjs";

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
// accepted the exact token "ci".
//
// Codex review /tmp/codex-305-r13.md (finding 2): a four-entry exact-alias
// set still missed the rest of npm's own resolution: npm normalizes
// camelCase to kebab-case before matching anything, resolves an
// unambiguous *prefix* of the combined commands+aliases list (so
// `install-cl`, a prefix of the alias `install-clean`, still resolves to
// `ci`), and even a typo like `isntall-cl` resolves the same way, because
// npm derives its abbreviation table from the same alias keys and
// forwards a resolved alias through `aliases` again in case the
// abbreviation itself lands on another alias rather than a canonical
// command. `installClean` (camelCase) is the same evasion in a different
// spelling. None of that is exact-alias matching; it's npm's own `deref`
// (lib/utils/cmd-list.js). Fix: reproduce `deref`'s exact steps —
// camelCase-to-kebab normalization, an exact command, an exact alias
// (itself followed recursively, since an abbreviation can resolve onto
// another alias), then a unique-prefix match over commands and aliases
// together — rather than a hand-picked alias set that can only ever cover
// the spellings someone thought to add.
//
// npm12CommandList.commands and .aliases are copied verbatim from the
// published npm@12.0.2 package's own lib/utils/cmd-list.js (fetched from
// https://registry.npmjs.org/npm/-/npm-12.0.2.tgz, `commands` and
// `aliases` exports), the same release this repo's package.json pins via
// `packageManager`. A future npm bump must refresh both arrays from that
// release's own cmd-list.js, the same discipline
// NPM_BUNDLED_NPMCLI_CONFIG_VERSION already requires for @npmcli/config.
const npm12CommandList = {
  commands: [
    "access",
    "approve-scripts",
    "audit",
    "bugs",
    "cache",
    "ci",
    "completion",
    "config",
    "dedupe",
    "deny-scripts",
    "deprecate",
    "diff",
    "dist-tag",
    "docs",
    "doctor",
    "edit",
    "exec",
    "explain",
    "explore",
    "find-dupes",
    "fund",
    "get",
    "help",
    "help-search",
    "init",
    "install",
    "install-ci-test",
    "install-scripts",
    "install-test",
    "link",
    "ll",
    "login",
    "logout",
    "ls",
    "org",
    "outdated",
    "owner",
    "pack",
    "patch",
    "ping",
    "pkg",
    "prefix",
    "profile",
    "prune",
    "publish",
    "query",
    "rebuild",
    "repo",
    "restart",
    "root",
    "run",
    "sbom",
    "search",
    "set",
    "stage",
    "start",
    "stop",
    "team",
    "test",
    "token",
    "trust",
    "undeprecate",
    "uninstall",
    "unpublish",
    "update",
    "version",
    "view",
    "whoami",
  ],
  aliases: {
    author: "owner",
    home: "docs",
    issues: "bugs",
    info: "view",
    show: "view",
    find: "search",
    add: "install",
    unlink: "uninstall",
    remove: "uninstall",
    rm: "uninstall",
    r: "uninstall",
    un: "uninstall",
    rb: "rebuild",
    list: "ls",
    ln: "link",
    create: "init",
    i: "install",
    it: "install-test",
    cit: "install-ci-test",
    u: "update",
    up: "update",
    c: "config",
    s: "search",
    se: "search",
    tst: "test",
    t: "test",
    ddp: "dedupe",
    v: "view",
    "run-script": "run",
    "clean-install": "ci",
    "clean-install-test": "install-ci-test",
    x: "exec",
    why: "explain",
    la: "ll",
    verison: "version",
    ic: "ci",
    innit: "init",
    in: "install",
    ins: "install",
    inst: "install",
    insta: "install",
    instal: "install",
    isnt: "install",
    isnta: "install",
    isntal: "install",
    isntall: "install",
    "install-clean": "ci",
    "isntall-clean": "ci",
    hlep: "help",
    "dist-tags": "dist-tag",
    upgrade: "update",
    udpate: "update",
    rum: "run",
    sit: "install-ci-test",
    urn: "run",
    ogr: "org",
  },
};

// Codex review /tmp/codex-305-r13.md (finding 2): reproduces the `abbrev`
// package's own algorithm (already vendored transitively — it's `nopt`'s
// own dependency, see node_modules/abbrev — but not declared directly by
// this repo, so it's reproduced here rather than imported off a path
// nothing in package.json actually pins) exactly as npm's own
// lib/utils/cmd-list.js calls it: `abbrev(commands.concat(Object.keys(
// aliases)))` computes, for every string in that combined list, the
// shortest prefix that identifies it uniquely among all of them (plus the
// string itself, mapped to itself). A prefix shared by two or more
// entries — `install-c`, a prefix of both `install-ci-test` and the alias
// `install-clean` — is deliberately absent from the result, exactly as
// npm's own CLI leaves it unresolved rather than guessing.
function computeAbbreviations(list) {
  const sorted = [...list].sort((a, b) => (a === b ? 0 : a > b ? 1 : -1));
  const abbreviations = {};
  let prev = "";
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1] ?? "";
    if (current === next) continue;
    let nextMatches = true;
    let prevMatches = true;
    let sharedLength = 0;
    for (; sharedLength < current.length; sharedLength += 1) {
      const char = current[sharedLength];
      nextMatches = nextMatches && char === next[sharedLength];
      prevMatches = prevMatches && char === prev[sharedLength];
      if (!nextMatches && !prevMatches) {
        sharedLength += 1;
        break;
      }
    }
    prev = current;
    if (sharedLength === current.length) {
      abbreviations[current] = current;
      continue;
    }
    for (let end = sharedLength, prefix = current.slice(0, end); end <= current.length; end += 1) {
      abbreviations[prefix] = current;
      prefix += current[end] ?? "";
    }
  }
  return abbreviations;
}

// Codex review /tmp/codex-305-r13.md (finding 2): reproduces npm's own
// `deref` (lib/utils/cmd-list.js) step for step: normalize camelCase to
// kebab-case, then an exact command, then an exact alias, then (since an
// abbreviation can itself land on another alias, e.g. `install-cl` ->
// `install-clean` -> `ci`) follow the alias table again in a loop until it
// stops resolving to a further alias, and only fall back to the
// unique-prefix abbreviation table if none of those matched. Returns
// `undefined` for an ambiguous or unrecognized command word, exactly as
// npm's own CLI does (it then prints "Unknown command" rather than running
// anything).
function derefNpmCommand(commandWord) {
  if (!commandWord) return undefined;
  const kebabCased = /[A-Z]/.test(commandWord)
    ? commandWord.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`)
    : commandWord;
  if (npm12CommandList.commands.includes(kebabCased)) return kebabCased;
  if (npm12CommandList.aliases[kebabCased]) return npm12CommandList.aliases[kebabCased];
  const abbreviations = computeAbbreviations(
    npm12CommandList.commands.concat(Object.keys(npm12CommandList.aliases))
  );
  let resolved = abbreviations[kebabCased];
  while (resolved && npm12CommandList.aliases[resolved]) {
    resolved = npm12CommandList.aliases[resolved];
  }
  return resolved;
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
//
// Codex review /tmp/codex-305-r13.md (finding 1): a plain regex `.split`
// over the raw run text has no idea a character sits inside a quoted
// string, so `npm --registry "https://registry.example/a?x=1&y=2" ci`'s
// embedded `&` cut the string in half mid-quote, corrupting the segment
// tokenizeShellWords was then handed; and the regex's char class included
// an opening `(` but never a closing `)`, so a subshelled `(npm ci)` split
// into `npm ci)` — a segment whose last token is the four-character string
// "ci)", which never equals "ci". Fix: a quote- and escape-aware scanner
// (splitShellSegments, below) that only treats `&&`, `||`, `;`, `|`, a
// newline, `(`, or `)` as a segment boundary when none of them sit inside
// a single- or double-quoted string or right after a backslash escape —
// the same quoting rules tokenizeShellWords applies to each resulting
// segment's own tokens — and drops the parentheses themselves instead of
// gluing them onto whatever token follows, so a subshell's contents
// surface as ordinary, unwrapped segments.
const SHELL_SEGMENT_BOUNDARY_CHARS = new Set([";", "|", "&", "(", ")"]);

function splitShellSegments(text) {
  const segments = [];
  let current = "";
  let quote = null; // null, "'", or '"'
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quote === "'") {
      // Single quotes are fully literal in bash: no escape sequence closes
      // or interrupts them, only the matching quote itself.
      current += char;
      if (char === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      // Inside double quotes, bash recognizes a backslash escape only
      // before \" \\ \$ or a backtick; any other character (including one
      // of the boundary characters above) is entirely literal.
      if (char === "\\" && '"\\$`'.includes(text[i + 1])) {
        current += char + text[i + 1];
        i += 2;
        continue;
      }
      current += char;
      if (char === '"') quote = null;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i += 1;
      continue;
    }
    // Outside quotes, a backslash escapes the very next character: that
    // character can't be a boundary, even if it would otherwise be one.
    if (char === "\\" && i + 1 < text.length) {
      current += char + text[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n" || SHELL_SEGMENT_BOUNDARY_CHARS.has(char)) {
      // A doubled `&&` or `||` is one logical boundary, not two.
      if ((char === "&" || char === "|") && text[i + 1] === char) i += 1;
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  segments.push(current);
  return segments;
}

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

// Codex review /tmp/codex-305-r14.md (finding 2): the old prefix stripper
// ran a regex over the segment's raw text, before any quoting-aware
// tokenization happened at all. `\S*` after a `NAME=` doesn't know a space
// can sit inside a quoted assignment value, so
// `NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" npm ci` matched
// the wrong amount of text and never reached `npm`; a raw-text regex also
// has no notion of "the first *word* of this segment", so `if npm ci; then
// echo ok; fi` (a control word, not a wrapper command, ahead of `npm`) and
// `time npm ci` (a wrapper never in the old three-name list) both left
// `tokens[0] !== "npm"` and were invisible to discovery. Fix: tokenize the
// segment first (tokenizeShellWords, quote- and escape-aware), then peel
// prefixes off the resulting *token array* — an assignment token, a shell
// control word, or a transparent wrapper command — in a loop, so chained
// forms keep resolving and a value hiding inside a quoted token can never
// be mistaken for a boundary. See unwrapToCommandTokens, below.
//
// Shell keywords that can precede a command word without changing which
// command actually runs (`if npm ci; then ...; fi` still runs `npm ci`).
const SHELL_CONTROL_WORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "}",
]);

// Codex review /tmp/codex-305-r15.md (the one finding): blindly stripping
// every dash-prefixed token in front of a wrapper's command (the prior
// approach) can't tell a wrapper's own option operand from the wrapped
// command itself. `env -u npm ci` has `npm` as `-u`'s operand (the
// variable being unset) and `ci` as the real command `env` runs — not
// `npm ci` at all — while `env -u NODE_OPTIONS npm ci`, `time -p npm ci`,
// `command -p npm ci`, `exec -c npm ci`, and `nohup -- npm ci` all reach a
// real `npm ci` that a blind strip missed because it never accounted for
// an option consuming its own operand token. Fix: give each wrapper an
// explicit table of its own options — which ones take an operand (as a
// following token, or attached with `=`), which take none, and which mean
// the wrapper isn't executing anything at all (`command -v`/`-V`) — so an
// option's operand is only ever consumed as that option's own operand,
// never mistaken for the wrapped command.
const WRAPPER_OPTION_TABLES = {
  env: {
    operand: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
    operandAttachable: new Set(["--unset", "--chdir"]),
    flag: new Set(["-i", "--ignore-environment", "-0", "-v", "--null", "--debug"]),
    allowsAssignments: true,
  },
  time: {
    operand: new Set(["-f", "--format", "-o", "--output"]),
    operandAttachable: new Set(["--format", "--output"]),
    flag: new Set(["-p", "-a", "-v", "-q"]),
  },
  command: {
    flag: new Set(["-p"]),
    // `-v`/`-V` describe the command instead of running it, so anything
    // after one is inert, not a clean install.
    notExecuting: new Set(["-v", "-V"]),
  },
  exec: {
    operand: new Set(["-a"]),
    flag: new Set(["-c", "-l"]),
  },
  nohup: {},
  nice: {
    operand: new Set(["-n", "--adjustment"]),
    operandAttachable: new Set(["--adjustment"]),
  },
};

const ASSIGNMENT_TOKEN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isAssignmentToken(token) {
  return typeof token === "string" && ASSIGNMENT_TOKEN_PATTERN.test(token);
}

// `nice`'s legacy niceness form (`nice -10 npm ci`): a bare dash followed
// only by digits, distinct from every named option any wrapper defines.
const NICE_LEGACY_ADJUSTMENT_PATTERN = /^-\d+$/;

// Consumes exactly the given wrapper's own options — and, for `env`, its
// leading `NAME=value` assignments — off the front of `tokens`, looping so
// any order or repetition of them resolves. Stops at `--` (end of
// options, consumed) or the first token that isn't one of the wrapper's
// own — which is the wrapped command word, left untouched for the caller.
// `notExecuting` options (`command -v`/`-V`) return `tokens` completely
// unconsumed, head and all, so the caller's `tokens[0] !== "npm"` check
// fails on the option itself rather than treating whatever follows it as
// an executed command.
function stripWrapperOptions(wrapperName, tokens) {
  const table = WRAPPER_OPTION_TABLES[wrapperName];
  let remaining = tokens;
  for (;;) {
    const head = remaining[0];
    if (head === undefined) return remaining;
    if (head === "--") return remaining.slice(1);
    if (table.notExecuting?.has(head)) return remaining;
    if (table.flag?.has(head)) {
      remaining = remaining.slice(1);
      continue;
    }
    if (table.operand?.has(head)) {
      remaining = remaining.slice(2);
      continue;
    }
    const equalsIndex = head.indexOf("=");
    if (equalsIndex !== -1 && table.operandAttachable?.has(head.slice(0, equalsIndex))) {
      remaining = remaining.slice(1);
      continue;
    }
    if (wrapperName === "nice" && NICE_LEGACY_ADJUSTMENT_PATTERN.test(head)) {
      remaining = remaining.slice(1);
      continue;
    }
    if (table.allowsAssignments && isAssignmentToken(head)) {
      remaining = remaining.slice(1);
      continue;
    }
    return remaining;
  }
}

// Repeatedly strips a leading assignment token, shell control word,
// `corepack` (which forwards straight to the pinned npm release with no
// options of its own), or one of the option-bearing wrappers above (each
// already split into its own token by tokenizeShellWords, so a value
// hiding inside a quoted token can never be mistaken for one) off the
// front of an already-tokenized segment, until only the real command word
// and its own arguments remain. Chained forms (`time env FOO=1 npm ci`)
// resolve because the loop keeps going until nothing further peels off.
function unwrapToCommandTokens(tokens) {
  let remaining = tokens;
  for (;;) {
    const head = remaining[0];
    if (head === undefined) return remaining;
    if (isAssignmentToken(head) || SHELL_CONTROL_WORDS.has(head)) {
      remaining = remaining.slice(1);
      continue;
    }
    if (head === "corepack") {
      remaining = remaining.slice(1);
      continue;
    }
    if (Object.hasOwn(WRAPPER_OPTION_TABLES, head)) {
      remaining = stripWrapperOptions(head, remaining.slice(1));
      continue;
    }
    return remaining;
  }
}

// Codex review /tmp/codex-305-r9.md (finding 1): npm global options can take
// their value as a SEPARATE token (`npm --prefix . ci`, `npm --workspace
// apps/web ci`), not just attached via `=` (`--prefix=.`). A regex matching
// only `--key=value` flags never consumes the separate value token, so it
// never reaches `ci` and misses the invocation entirely.
//
// Codex review /tmp/codex-305-r10.md through /tmp/codex-305-r12.md: a hand
// list of value-taking flags, then a hand-derived shorthand-expansion step,
// then a hand-derived grouped-short-option expansion step, were each added
// on top of the last to close one more evasion shape npm's own option
// parsing already covers (a full value-taking-option set derived from real
// definitions, standalone shorthand aliases, POSIX-style grouped short
// options). Each fix closed the shape it was written for and left the next
// one open.
//
// Codex review /tmp/codex-305-r13.md (findings 3 and 4): two shapes an
// always-value-taking/never-value-taking split can't model at all, no
// matter how the value-taking set is derived: `foreground-scripts` is
// `type: Boolean` but still consumes an explicit `true`/`false` token when
// one is given (`npm --foreground-scripts true ci`), and `-ca`/`-call` are
// each an *exact*, multi-letter option name in their own right (`-ca` is a
// real shorthand, not "the boolean `-c` glommed with the boolean `-a`"),
// so a grouped-short expander that assumes every multi-letter single-dash
// token must be one-character-per-flag expands the wrong thing and never
// reaches `ci`. npm's own CLI gets every one of these right because it
// never re-derives option classification by hand at all — every npm
// command line, including `ci` itself, is parsed by handing the exact same
// `types`/`shorthands` definitions this module already loads straight to
// `nopt`, npm's own argument parser (already in the lockfile as
// @npmcli/config's own parser dependency; pinned here as a direct, exact
// devDependency at that same version — see package.json). Fix: stop
// re-deriving option classification by hand in every shape it can take,
// and call the real parser with the real definitions instead. See
// ./helpers/npm-cli-definitions.mjs's parseNpmArgv for the loader/parser
// call itself (kept there, alongside loadNpmConfigDefinitions, so the
// empty-COREPACK_HOME regression further down can import and exercise it
// from a freshly spawned process).

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

// Collapses whitespace. Prefix stripping (assignments, control words,
// transparent wrappers) happens later, token-wise, inside
// isExecutableNpmCiSegment itself (see unwrapToCommandTokens) — never here,
// against raw text, where a quoted value can hide a space a naive regex
// would mistake for a token boundary.
function normalizeCommandSegment(segment) {
  return segment.replace(/\s+/g, " ").trim();
}

// Codex review /tmp/codex-305-r9.md through /tmp/codex-305-r12.md: this used
// to be a hand-written argv walk — recognizing `--key=value`, then a
// dynamically-loaded value-taking-option set, then npm's standalone
// shorthand aliases, then POSIX-style grouped short options, each layered
// on top of the last as a new evasion shape surfaced. See the comment above
// npm12CommandList (Codex review /tmp/codex-305-r13.md, finding 2) and the
// one above the old `NPM_DEFINITIONS`/`NPM_SHORTHANDS` destructure (finding
// 3) for the two shapes that kept being possible no matter how the hand
// walk was extended.
//
// Fix: parse with the real parser instead of re-deriving its behavior.
// `parseNpmArgv` (./helpers/npm-cli-definitions.mjs) hands the tokens after
// `npm` straight to `nopt` with npm's own real option definitions and
// shorthand table, so every one of `--key=value`, a separate-token value,
// a boolean option that still consumes an explicit `true`/`false`, a
// standalone shorthand alias (plain rename or one that bakes in its own
// value), and a grouped or exact-named short option all resolve exactly as
// npm's own CLI resolves them — because it's the same parser. Whatever
// `nopt` leaves in `argv.remain` after consuming every option and its
// value is the same positional argv npm's own CLI would see, and
// `remain[0]` is the command word npm would resolve next. `derefNpmCommand`
// then reproduces npm's own `deref` (cmd-list.js) to resolve that word —
// including an alias, an abbreviation, or a camelCase spelling — to a
// canonical command, so `npm clean-install`, `npm ic`, `npm install-cl`,
// and `npm installClean` are all recognized exactly like `npm ci`, and an
// unrelated subcommand (`npm run ci`, where `remain[0]` is `"run"`, not a
// bare `ci` anywhere in the tokens) still fails to match. `tokens[0]` is
// checked for `"npm"` only after unwrapToCommandTokens has peeled off any
// leading assignment, control word, or transparent wrapper (Codex review
// /tmp/codex-305-r14.md, finding 2) — a raw-text prefix regex applied
// before tokenization can't tell a quoted value's embedded space from a
// real token boundary, and has no notion of "the first word" at all.
//
// Codex review /tmp/codex-305-r14.md (finding 1): `derefNpmCommand` can
// resolve a command word to `"install-ci-test"`, not just `"ci"` — that's
// npm's own canonical name for the `cit`/`clean-install-test`/`sit`
// command family, which npm's own implementation runs by calling `ci`
// internally (with `--ci` mode plus a `test` run-script appended). A
// classifier that only ever accepted the exact canonical command `"ci"`
// missed all four spellings of that family, even though every one of them
// executes the same lifecycle-script-bearing install `ci` does. Fix:
// accept either canonical command as a clean install.
const CLEAN_INSTALL_COMMANDS = new Set(["ci", "install-ci-test"]);

function isExecutableNpmCiSegment(segment) {
  const tokens = unwrapToCommandTokens(tokenizeShellWords(segment));
  if (tokens[0] !== "npm") return false;
  const parsed = parseNpmArgv(tokens.slice(1));
  return CLEAN_INSTALL_COMMANDS.has(derefNpmCommand(parsed.argv.remain[0]));
}

function countExecutableNpmCi(steps) {
  let count = 0;
  for (const step of steps ?? []) {
    if (typeof step?.run !== "string") continue;
    const segments = splitShellSegments(stripBashComments(joinLineContinuations(step.run)));
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

test("windows-package-smoke filters to win32-gated cases before building the installer", async () => {
  const workflow = await source(".github/workflows/ci-verify.yml");
  const job = workflow.slice(
    workflow.indexOf("  windows-package-smoke:"),
    workflow.indexOf("  browser-application-prep:")
  );
  const testStepIndex = job.search(
    /node --test --test-name-pattern "\\\[win32\\\]" tests\/installed-runtime\.test\.mjs tests\/doctor-installed-runtimes\.test\.mjs/
  );
  const distWindowsIndex = job.indexOf("npm run dist:windows --workspace apps/desktop");
  assert.notEqual(testStepIndex, -1, "the win32 test-name-pattern filter must be present");
  assert.notEqual(distWindowsIndex, -1, "the dist:windows step must be present");
  assert.ok(
    testStepIndex < distWindowsIndex,
    "the filtered installed-runtime identity tests must run before dist:windows"
  );
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
// `--location`, `--allow-git`).
//
// Codex review /tmp/codex-305-r11.md (finding 2): `--reg` and `--enjoy-by`
// are npm's own *standalone* aliases for `--registry` and `--before` —
// neither is a key in `definitions.js` itself.
//
// Codex review /tmp/codex-305-r12.md (finding 1): three more evasion
// shapes. `npm clean-install` and `npm ic` are npm's own command aliases
// (see npm12CommandList) — no `ci` token ever appears. `npm -dC . ci` is a
// grouped short option (`-d` and `-C` glommed onto one dash). `npm
// --enjoy-by "2020-01-01 00:00" ci` is the shell-quoting evasion (see
// tokenizeShellWords).
//
// All of the above are now resolved by handing the real tokens to the
// real parser (parseNpmArgv, over nopt and npm's own definitions) and
// resolving the resulting command word through npm's own deref
// (derefNpmCommand, over npm12CommandList) — see the comments above
// isExecutableNpmCiSegment and npm12CommandList (Codex review
// /tmp/codex-305-r13.md) for why a hand-rolled classifier could never
// close every one of these shapes at once.
//
// Codex review /tmp/codex-305-r14.md (finding 1): npm's `install-ci-test`
// command family (`cit`, `clean-install-test`, `sit`, and the canonical
// name itself) runs `ci` internally, so all four count as a clean install
// even though none of them spell the token `ci` anywhere. Covered here at
// the workflow level (a new job, and an extra pre-gate step) for every
// spelling; a direct classifier-level check lives in its own test below.
//
// Codex review /tmp/codex-305-r14.md (finding 2): prefix handling used to
// run a raw-text regex ahead of tokenization, so it had no notion of "the
// first word" and no idea a quoted value could contain a space. A quoted
// assignment value with an embedded space
// (`NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" npm ci`), a
// shell control word ahead of the command (`if npm ci; then echo ok; fi`),
// and a wrapper never in the old three-name list (`time npm ci`) each left
// `npm` out of reach. Fixed by unwrapToCommandTokens operating on the
// already-tokenized segment instead.
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
  ["npm cit", "npm cit"],
  ["npm clean-install-test", "npm clean-install-test"],
  ["npm sit", "npm sit"],
  ["npm install-ci-test", "npm install-ci-test"],
  [
    "a quoted NODE_OPTIONS assignment with an embedded space",
    'NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" npm ci',
  ],
  ["an if/then/fi control-flow wrapper", "if npm ci; then echo ok; fi"],
  ["the time builtin", "time npm ci"],
  // Codex review /tmp/codex-305-r15.md: option-bearing wrapper forms a
  // blind dash-strip missed because it never told a wrapper's own option
  // operand apart from the wrapped command — see WRAPPER_OPTION_TABLES and
  // stripWrapperOptions above.
  ["env with a short unset option", "env -u NODE_OPTIONS npm ci"],
  ["env with a chdir option", "env -C . npm ci"],
  ["time with the -p option", "time -p npm ci"],
  ["command with the -p option", "command -p npm ci"],
  ["exec with the -c option", "exec -c npm ci"],
  ["nohup with an explicit end-of-options marker", "nohup -- npm ci"],
  ["nice with a long adjustment option", "nice -n 10 npm ci"],
  ["nice with the legacy numeric adjustment form", "nice -10 npm ci"],
  ["nested time and env wrappers", "time env FOO=1 npm ci"],
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
  // The four new forms prove the real parser (parseNpmArgv, over nopt and
  // npm's own definitions) recognizes options a hand-picked list never
  // could: none of `--omit`, `--install-strategy`, `--location`, or
  // `--allow-git` were in the original nine-entry hand list, and none need
  // a special case now, since nopt classifies them off the real
  // definitions. `npm run ci` is kept as a direct, permanent negative case
  // since `remain[0]` is `"run"`, not `"ci"`, and `derefNpmCommand("run")`
  // resolves to the canonical command `"run"`, not `"ci"`.
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

test("[codex-305-r11] isExecutableNpmCiSegment resolves npm's own standalone shorthand aliases before classifying", () => {
  // `--reg` and `--enjoy-by` are rename-only shorthand aliases (npm's own
  // `shorthands` table expands them to `['--registry']`/`['--before']`) for
  // two definitions that do take a value; nopt resolves the alias and
  // consumes the following token as that value, reaching the real `ci`.
  for (const run of ["npm --reg https://registry.example.com ci", "npm --enjoy-by 2020-01-01 ci"]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
  // `-d` is npm's shorthand alias for `--loglevel info` — a multi-element
  // expansion that already bakes its value in, so nopt consumes nothing
  // further from argv for it; `ci` right after it is still the next real
  // token, not `-d`'s value.
  assert.equal(isExecutableNpmCiSegment("npm -d ci"), true);
});

test("[codex-305-r12] isExecutableNpmCiSegment resolves npm's own command aliases to ci", () => {
  // Verified against the published npm@12.0.2 package's own
  // lib/utils/cmd-list.js `aliases` table (see npm12CommandList): all four
  // resolve, through derefNpmCommand, to canonical command "ci", not to a
  // bare "ci" token anywhere in the run string.
  for (const run of ["npm clean-install", "npm ic", "npm install-clean", "npm isntall-clean"]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
});

test("[codex-305-r12] isExecutableNpmCiSegment resolves grouped short options the same way npm's own parser does", () => {
  // `-dC .` gloms `-d` (multi-element: `--loglevel info`, self-contained)
  // and `-C` (single-element rename for `--prefix`, value-taking) onto one
  // dash. nopt expands both in order, with `-C`'s expansion still
  // consuming the real `.` token, reaching the real `ci`.
  assert.equal(isExecutableNpmCiSegment("npm -dC . ci"), true);
  // A grouped token where every character is a real single-char shorthand
  // but the group itself doesn't end on a value-taking expansion (`-f` is
  // the boolean `--force`) must not swallow an unrelated following token.
  assert.equal(isExecutableNpmCiSegment("npm -gf ci"), true);
  // Not every multi-letter, single-dash token is a valid grouped option —
  // "-xz" has no shorthand keys "x" or "z" at all, so nopt treats the whole
  // token as a single unrecognized flag (consuming nothing further) and
  // still finds "ci" as the very next token.
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

// Codex review /tmp/codex-305-r13.md (finding 3): `--color` and
// `--foreground-scripts` are both `type: Boolean` definitions, but neither
// is *purely* boolean in how npm's own parser treats them: `nopt` still
// consumes an explicit `true`/`false` token that immediately follows a
// Boolean option, since a Boolean option's value can be spelled out
// instead of implied. A binary "does this option ever take a value"
// classifier gets both of these wrong no matter which way it's set: as
// value-taking, `npm --color ci` (no explicit value) wrongly consumes
// `ci` as `--color`'s value; as non-value-taking, `npm --foreground-scripts
// true ci` wrongly leaves `true` as the command word. Only asking the real
// parser gets both right, because it's the same conditional consumption
// npm's own CLI performs.
test("[codex-305-r13] isExecutableNpmCiSegment resolves a Boolean option's conditional value consumption the way nopt does", () => {
  assert.equal(isExecutableNpmCiSegment("npm --color ci"), true);
  assert.equal(isExecutableNpmCiSegment("npm --foreground-scripts true ci"), true);
});

// Codex review /tmp/codex-305-r13.md (finding 4): `-ca` and `-call` are
// each an exact, multi-letter shorthand/option spelling in their own
// right, not "every character is its own single-letter flag" the way
// `-dC` is. A grouped-short expander that expands every multi-letter
// single-dash token character-by-character, without first checking
// whether the *whole* token already names something real, expands `-ca`
// into two single-letter flags and consumes the wrong following word,
// walking straight past the real `ci`. nopt itself checks the exact,
// full-length spelling first (see its own `resolveShort`), exactly like
// npm's CLI does, so both resolve to their own real options.
test("[codex-305-r13] isExecutableNpmCiSegment resolves an exact multi-letter option name before considering it as a grouped short option", () => {
  assert.equal(isExecutableNpmCiSegment("npm -ca cert.pem ci"), true);
  assert.equal(isExecutableNpmCiSegment("npm -call x ci"), true);
});

// Codex review /tmp/codex-305-r13.md (finding 2): derefNpmCommand's own
// regressions, isolated from the option-parsing half of
// isExecutableNpmCiSegment. `install-cl` and the deliberate typo
// `isntall-cl` are both unambiguous prefixes of the alias `install-clean`
// (no other command or alias shares that prefix), which itself resolves to
// `ci`; `installClean` is the same alias spelled camelCase. An ambiguous
// prefix — `install-c` is a prefix of both the command `install-ci-test`
// and the alias `install-clean` — must resolve to nothing, exactly as
// npm's own CLI declines to guess.
test("[codex-305-r13] derefNpmCommand reproduces npm's own command-word resolution, including ambiguous prefixes", () => {
  assert.equal(derefNpmCommand("install-cl"), "ci");
  assert.equal(derefNpmCommand("isntall-cl"), "ci");
  assert.equal(derefNpmCommand("installClean"), "ci");
  assert.equal(derefNpmCommand("install-c"), undefined);
  assert.equal(isExecutableNpmCiSegment("npm install-cl"), true);
  assert.equal(isExecutableNpmCiSegment("npm isntall-cl"), true);
  assert.equal(isExecutableNpmCiSegment("npm installClean"), true);
  assert.equal(isExecutableNpmCiSegment("npm install-c"), false);
});

// Codex review /tmp/codex-305-r13.md (finding 1): splitShellSegments's own
// regressions. `(npm ci)` is a subshelled invocation: the parentheses are
// boundaries that get stripped rather than glued onto a token, so the
// inner segment is a bare "npm ci", not "npm ci)". The registry URL's
// embedded `&` (`x=1&y=2`) sits inside a double-quoted token, so it must
// not be mistaken for the `&`/`&&` operator and split the command in half.
test("[codex-305-r13] splitShellSegments treats parentheses and shell operators as boundaries only outside quotes", () => {
  assert.equal(isExecutableNpmCiSegment("(npm ci)"), false);
  assert.deepEqual(splitShellSegments("(npm ci)"), ["", "npm ci", ""]);
  assert.equal(
    isExecutableNpmCiSegment('npm --registry "https://registry.example/a?x=1&y=2" ci'),
    true
  );
});

// Codex review /tmp/codex-305-r14.md (finding 1): direct classifier-level
// check that `install-ci-test` and every one of its aliases (`cit`,
// `clean-install-test`, `sit`) count as a clean install, not just the
// canonical command `install-ci-test` written out in full — each
// dereferences to that same canonical command, which npm's own
// implementation runs by calling `ci` internally.
test("[codex-305-r14] isExecutableNpmCiSegment treats npm's install-ci-test command family as a clean install", () => {
  assert.equal(derefNpmCommand("cit"), "install-ci-test");
  assert.equal(derefNpmCommand("clean-install-test"), "install-ci-test");
  assert.equal(derefNpmCommand("sit"), "install-ci-test");
  assert.equal(derefNpmCommand("install-ci-test"), "install-ci-test");
  for (const run of ["npm cit", "npm clean-install-test", "npm sit", "npm install-ci-test"]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
});

// Codex review /tmp/codex-305-r14.md (finding 2): direct classifier-level
// checks for unwrapToCommandTokens itself. A quoted assignment value with
// an embedded space, a shell control word ahead of the command (already
// split to its own segment here — splitShellSegments, exercised separately
// below, is what turns "if npm ci; then echo ok; fi" into this segment in
// the first place), and a wrapper (`time`) never in the old three-name
// prefix list must all still resolve to the real `npm ci` underneath;
// `npm run ci` and `npm run cit` (an unrelated `run` subcommand, not the
// bare command itself) and `echo npm ci` (an unrelated command that merely
// prints the words `npm ci`) must keep failing to match.
test("[codex-305-r14] isExecutableNpmCiSegment unwraps assignments, control words, and transparent wrappers token-wise", () => {
  for (const run of [
    'NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" npm ci',
    "if npm ci",
    "time npm ci",
    "env FOO=1 npm ci",
  ]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
  assert.equal(isExecutableNpmCiSegment("npm run ci"), false);
  assert.equal(isExecutableNpmCiSegment("npm run cit"), false);
  assert.equal(isExecutableNpmCiSegment("echo npm ci"), false);
});

// Codex review /tmp/codex-305-r15.md: direct classifier-level checks for
// stripWrapperOptions itself. Each positive form has an option consuming
// its own operand ahead of the real `npm ci`; each negative form has `npm`
// itself sitting where an option's operand goes, so the wrapper's actual
// command word is something else entirely (`ci` alone, or nothing that
// runs at all).
test("[codex-305-r15] isExecutableNpmCiSegment tells a wrapper's own option operand apart from the command it wraps", () => {
  for (const run of [
    "env -u NODE_OPTIONS npm ci",
    "env -C . npm ci",
    "time -p npm ci",
    "command -p npm ci",
    "exec -c npm ci",
    "nohup -- npm ci",
    "nice -n 10 npm ci",
    "nice -10 npm ci",
    "time env FOO=1 npm ci",
  ]) {
    assert.equal(isExecutableNpmCiSegment(run), true, `expected "${run}" to be recognized`);
  }
  // `npm` is the operand of `-u`/`-v`/`-V`, not the wrapper's own command,
  // in every one of these — so none of them run `npm ci` at all.
  assert.equal(isExecutableNpmCiSegment("env -u npm ci"), false);
  assert.equal(isExecutableNpmCiSegment("command -v npm ci"), false);
  assert.equal(isExecutableNpmCiSegment("command -V npm"), false);
  assert.equal(isExecutableNpmCiSegment("env --unset=npm ci"), false);
});

// Codex review /tmp/codex-305-r13.md (finding 1): the same two forms,
// exercised through the workflow-level discovery path (a real YAML `run:`
// step, comment-stripped and normalized) rather than calling
// isExecutableNpmCiSegment directly, since splitShellSegments runs before
// isExecutableNpmCiSegment ever sees a segment.
for (const [label, run] of [
  ["a subshelled npm ci", "(npm ci)"],
  [
    "a quoted registry URL with an embedded ampersand",
    'npm --registry "https://registry.example/a?x=1&y=2" ci',
  ],
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
  // Compared through realpath on both sides: a git worktree in this repo
  // symlinks node_modules to the main checkout, so the loader's resolved
  // path is the link target, not the worktree path.
  const projectNpmcliConfigDir = realpathSync(
    fileURLToPath(new URL("../node_modules/@npmcli/config/", import.meta.url))
  );
  assert.ok(
    realpathSync(output.resolvedPath).startsWith(projectNpmcliConfigDir),
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
