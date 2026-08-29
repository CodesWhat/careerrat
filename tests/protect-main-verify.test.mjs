// tests/protect-main-verify.test.mjs
// Exercises scripts/protect-main.sh's drift detection against actually-drifted
// rulesets. The script's whole job is noticing that live branch protection has
// stopped matching what the file declares; a guard whose detection has only
// ever been run against a matching ruleset has never demonstrated the one thing
// it exists to do.
//
// The script's compare_ruleset() is split out from its fetch for exactly this
// reason, and the file returns early when sourced, so each case here runs the
// real comparison over fixture JSON with no network and no `gh` auth.
//
// The fixture is the source-controlled desired ruleset with the no-op defaults
// GitHub adds on read and its server-assigned ids stripped. It does not claim
// the live ruleset has already been changed. Each case mutates one field of the
// passing shape, so negative cases differ by exactly the drift under test.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/protect-main.sh", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/protect-main/live-ruleset.json", import.meta.url)
);

const MATCHING = readFileSync(FIXTURE, "utf8");

// compare_ruleset() shells out to jq (canonicalize() is `jq -S ...`), so every
// test below needs jq on PATH to run at all. Detect presence rather than
// assume it: this only checks whether the binary exists (`which`), it never
// invokes jq's functionality from the test itself. Skip honestly instead of
// failing red on environments without jq installed.
const HAS_JQ = (() => {
  try {
    execFileSync("which", ["jq"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const JQ_SKIP = HAS_JQ ? false : "requires jq on PATH (compare_ruleset() shells out to it)";

// Source the script (loading DESIRED + the functions, running nothing) and call
// compare_ruleset with the given JSON on stdin. Returns the exit status plus
// both streams, since the pass path writes to stdout and every drift report
// writes to stderr.
function compare(rulesetJson) {
  const driver = `set -uo pipefail
. "$PROTECT_MAIN_SH"
compare_ruleset "$(cat)"
`;
  try {
    const stdout = execFileSync("bash", ["-c", driver], {
      input: rulesetJson,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PROTECT_MAIN_SH: SCRIPT },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || ""),
    };
  }
}

// A fresh deep copy of the fixture with one edit applied, so each drift case is
// a single-field mutation of the ruleset that passes. Done in JS rather than by
// shelling out to jq: the script needs jq, a test doesn't, and adding an
// unlisted binary to the repo's dependency surface for test convenience is a
// bad trade.
function mutate(edit) {
  const ruleset = JSON.parse(MATCHING);
  edit(ruleset, {
    rule: (type) => ruleset.rules.find((r) => r.type === type),
    checks: () =>
      ruleset.rules.find((r) => r.type === "required_status_checks").parameters
        .required_status_checks,
  });
  return JSON.stringify(ruleset, null, 2);
}

function setChecks(ruleset, next) {
  ruleset.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks =
    next;
}

test("a ruleset matching the file passes and names every enforced check", { skip: JQ_SKIP }, () => {
  const { status, stdout } = compare(MATCHING);
  assert.equal(status, 0);
  assert.match(stdout, /live protection on .* matches/);
  // The context most likely to go missing, and the one whose spaces and
  // parentheses break naive word-splitting.
  assert.match(stdout, /analyze \(javascript-typescript\)/);
});

test("a required check removed live is reported as protection weaker than the file claims", {
  skip: JQ_SKIP,
}, () => {
  const { status, stderr } = compare(
    mutate((rs, at) =>
      setChecks(
        rs,
        at.checks().filter((c) => c.context !== "knip")
      )
    )
  );
  assert.equal(status, 1);
  assert.match(stderr, /DRIFT/);
  assert.match(stderr, /DECLARED HERE BUT NOT ENFORCED LIVE[\s\S]*- knip/);
});

test("a check enforced live but absent from the file warns that re-creating would remove it", {
  skip: JQ_SKIP,
}, () => {
  // The portwing failure this guard was written for: the file declares FEWER
  // gates than are live, so re-applying it silently drops the difference.
  const { status, stderr } = compare(
    mutate((rs, at) => setChecks(rs, [...at.checks(), { context: "CodeQL" }]))
  );
  assert.equal(status, 1);
  assert.match(stderr, /would REMOVE these[\s\S]*- CodeQL/);
});

test("enforcement downgraded from active to evaluate is drift", { skip: JQ_SKIP }, () => {
  const { status, stderr } = compare(
    mutate((rs) => {
      rs.enforcement = "evaluate";
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /"enforcement": "active"/);
  assert.match(stderr, /"enforcement": "evaluate"/);
});

test("required approvals dropped from 2 to 1 is drift", { skip: JQ_SKIP }, () => {
  const { status, stderr } = compare(
    mutate((_rs, at) => {
      at.rule("pull_request").parameters.required_approving_review_count = 1;
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /"required_approving_review_count": 2/);
  assert.match(stderr, /"required_approving_review_count": 1/);
});

test("a bypass actor added live is drift", { skip: JQ_SKIP }, () => {
  // Nobody is allowed to bypass. An actor appearing here is the quietest way
  // for protection to stop meaning anything, since every rule still reads as
  // enabled.
  const { status, stderr } = compare(
    mutate((rs) => {
      rs.bypass_actors = [{ actor_id: 1, actor_type: "OrganizationAdmin" }];
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /DRIFT/);
  assert.match(stderr, /OrganizationAdmin/);
});

test("server-populated no-op defaults are not reported as drift", { skip: JQ_SKIP }, () => {
  // The API returns `required_reviewers: []` and a disabled
  // `dismissal_restriction` on every GET whether or not anything set them.
  // Comparing those raw reports drift on a byte-correct ruleset, and a guard
  // that cries wolf on every run stops being read.
  const { status } = compare(
    mutate((_rs, at) => {
      const params = at.rule("pull_request").parameters;
      delete params.required_reviewers;
      delete params.dismissal_restriction;
    })
  );
  assert.equal(status, 0);
});

test("required checks in a different order are not drift", { skip: JQ_SKIP }, () => {
  // Ordering is not meaningful to GitHub and does vary between the API's
  // response and the file. Only membership matters.
  const { status } = compare(mutate((rs, at) => setChecks(rs, [...at.checks()].reverse())));
  assert.equal(status, 0);
});

test("a drift report reaches the remediation advice, not just the diff", { skip: JQ_SKIP }, () => {
  // This asserts on output printed AFTER the `diff | sed` pipeline, which is
  // the whole point. The script runs under `set -euo pipefail`, and diff exits
  // 1 whenever the inputs differ, which on this code path is guaranteed. So
  // the pipeline's status was 1, set -e fired, and compare_ruleset died right
  // after printing the diff, swallowing everything below it.
  //
  // The swallowed text is the part that matters most: it's the warning NOT to
  // delete the ruleset and re-create it, which drops main to zero protection
  // and restores only what this file happens to declare. The guard was
  // withholding its most dangerous-action warning at exactly the moment it
  // fired. Every other test here asserts on text printed BEFORE the diff,
  // which is why they all passed while this was broken.
  const { status, stderr } = compare(
    mutate((rs, at) =>
      setChecks(
        rs,
        at.checks().filter((c) => c.context !== "knip")
      )
    )
  );
  assert.equal(status, 1);
  assert.match(stderr, /full diff/);
  assert.match(stderr, /Do NOT delete the ruleset/);
  assert.match(stderr, /rulesets\/\{id\}\/history/);
});
