// tests/protect-tags-verify.test.mjs
// Exercises scripts/protect-tags.sh's drift detection against actually-drifted
// rulesets, the same discipline tests/protect-main-verify.test.mjs applies to
// scripts/protect-main.sh. The script's whole job is noticing that live tag
// protection has stopped matching what the file declares; a guard whose
// detection has only ever been run against a matching ruleset has never
// demonstrated the one thing it exists to do.
//
// The script's compare_ruleset() is split out from its fetch for exactly this
// reason, and the file returns early when sourced, so each case here runs the
// real comparison over fixture JSON with no network and no `gh` auth.
//
// The fixture is the target live ruleset shape (rulesets.md / drydock 20945202 /
// portwing 20957972 pattern) with server-assigned ids stripped. Each case
// mutates one field of it, which is what makes the negative cases credible: they
// differ from the passing case by exactly the drift being tested and nothing
// else.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/protect-tags.sh", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/protect-tags/live-ruleset.json", import.meta.url)
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
. "$PROTECT_TAGS_SH"
compare_ruleset "$(cat)"
`;
  try {
    const stdout = execFileSync("bash", ["-c", driver], {
      input: rulesetJson,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PROTECT_TAGS_SH: SCRIPT },
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
    rules: () => ruleset.rules,
  });
  return JSON.stringify(ruleset, null, 2);
}

test("a ruleset matching the file passes and names every enforced rule", { skip: JQ_SKIP }, () => {
  const { status, stdout } = compare(MATCHING);
  assert.equal(status, 0);
  assert.match(stdout, /live protection on .* matches/);
  assert.match(stdout, /deletion/);
  assert.match(stdout, /update/);
  assert.match(stdout, /non_fast_forward/);
});

test("a rule removed live is reported as protection weaker than the file claims", {
  skip: JQ_SKIP,
}, () => {
  const { status, stderr } = compare(
    mutate((rs) => {
      rs.rules = rs.rules.filter((r) => r.type !== "update");
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /DRIFT/);
  assert.match(stderr, /DECLARED HERE BUT NOT ENFORCED LIVE[\s\S]*- update/);
});

test("required_signatures added live warns that re-creating would remove it", {
  skip: JQ_SKIP,
}, () => {
  // Mirrors the protect-main.sh case where the live ruleset carries a context
  // absent from the file: if someone later adds required_signatures by hand
  // (the exact thing this repo deliberately does NOT want, per rulesets.md's
  // walked-back signature rule), the guard must flag it as drift rather than
  // silently accept the live extra rule as fine.
  const { status, stderr } = compare(
    mutate((rs, at) => {
      at.rules().push({ type: "required_signatures" });
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /would REMOVE these[\s\S]*- required_signatures/);
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

test("the ref_name target changing is drift", { skip: JQ_SKIP }, () => {
  const { status, stderr } = compare(
    mutate((rs) => {
      rs.conditions.ref_name.include = ["refs/tags/*"];
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /refs\/tags\/v\*/);
});

test("rules in a different order are not drift", { skip: JQ_SKIP }, () => {
  // Ordering is not meaningful to GitHub and does vary between the API's
  // response and the file. Only membership matters.
  const { status } = compare(mutate((rs, at) => (rs.rules = [...at.rules()].reverse())));
  assert.equal(status, 0);
});

test("a drift report reaches the remediation advice, not just the diff", { skip: JQ_SKIP }, () => {
  // Same regression class the protect-main.sh equivalent test guards: the
  // script runs under `set -euo pipefail`, and diff exits 1 whenever the
  // inputs differ (guaranteed on this code path), so a bare pipeline would
  // trip set -e and cut off the remediation text below the diff — including
  // the warning NOT to delete the ruleset and re-create it, which is the most
  // dangerous-action warning the guard has.
  const { status, stderr } = compare(
    mutate((rs) => {
      rs.rules = rs.rules.filter((r) => r.type !== "update");
    })
  );
  assert.equal(status, 1);
  assert.match(stderr, /full diff/);
  assert.match(stderr, /Do NOT delete the ruleset/);
  assert.match(stderr, /rulesets\/\{id\}\/history/);
});
