import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import {
  buildProposal,
  FACT_REFUSAL,
  MAX_RULES_PER_SESSION,
} from "../src/core/profile/correction-rules.mjs";
import { applyTuiUndo } from "../src/core/tui/history.mjs";
import { readJobs } from "../src/core/tui/jobs.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("facts are refused as rules", () => {
  for (const rule of [
    "I led a team of eight at Acme",
    "Has 12 years of experience",
    "The candidate holds a degree in nursing",
    "Worked at Initech from 2019",
    "Earns $150k",
  ]) {
    const r = buildProposal({ session: "s", kind: "prefer", rule, quote: "that's wrong" });
    assert.equal(r.ok, false, rule);
    assert.equal(r.reason, "fact", rule);
    assert.equal(r.error, FACT_REFUSAL);
  }
});

test("a style rule needs the verbatim quote and a valid kind", () => {
  const ok = buildProposal({
    session: "s",
    kind: "avoid",
    rule: "Don't open with 'I am writing to'",
    quote: "never start with I am writing to",
  });
  assert.equal(ok.ok, false, "first-person pronoun trips the fact filter");
  const good = buildProposal({
    session: "s",
    kind: "avoid",
    rule: "Open cover letters with the role, not a greeting line",
    quote: "stop opening with a greeting line",
  });
  assert.equal(good.ok, true);
  assert.match(good.proposal.id, /^rule-[0-9a-f]{8}$/);
  assert.equal(good.proposal.quote, "stop opening with a greeting line");
  assert.equal(
    buildProposal({ session: "s", kind: "avoid", rule: "Be brief", quote: "" }).reason,
    "no-quote"
  );
  assert.equal(
    buildProposal({ session: "s", kind: "nope", rule: "Be brief", quote: "x" }).reason,
    "bad-kind"
  );
});

test("at most five per session, duplicates refused", () => {
  const existing = [];
  for (let n = 1; n <= MAX_RULES_PER_SESSION; n++) {
    const r = buildProposal({
      session: "s",
      kind: "prefer",
      rule: `Prefer short sentences, variant ${n}`,
      quote: `q${n}`,
      existing,
    });
    assert.equal(r.ok, true);
    existing.push(r.proposal);
  }
  const sixth = buildProposal({
    session: "s",
    kind: "prefer",
    rule: "Prefer short sentences, variant 6",
    quote: "q6",
    existing,
  });
  assert.equal(sixth.reason, "session-cap");
  const other = buildProposal({
    session: "t",
    kind: "prefer",
    rule: "Prefer short sentences, variant 6",
    quote: "q6",
    existing,
  });
  assert.equal(other.ok, true);
  assert.equal(
    buildProposal({
      session: "s",
      kind: "prefer",
      rule: "Prefer short sentences, variant 1",
      quote: "q1",
      existing,
    }).reason,
    "duplicate"
  );
});

test("accept-by-id writes the rule through a recorded Undo; facts and a second accept are refused", (t) => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-rules-"));
  const ctx = {
    repoRoot: root,
    env: {
      CAREERRAT_HOME: home,
      HOME: home,
      PATH: process.env.PATH,
      CAREERRAT_NO_UPDATE_CHECK: "1",
    },
  };
  candidateSetupInitialize(ctx);
  t.after(() => {
    closeAll();
    rmSync(home, { recursive: true, force: true });
  });
  const cli = (args, expected = 0) => {
    const r = spawnSync(
      process.execPath,
      [join(root, "bin/careerrat.mjs"), "rules", ...args, "--json"],
      {
        env: ctx.env,
        encoding: "utf8",
      }
    );
    assert.equal(r.status, expected, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const styleAvoid = () => candidateConfigGet(ctx).honesty?.style?.avoid || [];
  const rule = "Open with the role and one result, not a greeting";

  const dry = cli([
    "propose",
    "--kind",
    "avoid",
    "--rule",
    rule,
    "--quote",
    "stop starting with hello",
    "--session",
    "s1",
  ]);
  assert.equal(dry.dryRun, true);
  assert.equal(cli(["list"]).proposals.length, 0);

  const refused = cli(
    [
      "propose",
      "--kind",
      "prefer",
      "--rule",
      "I have 9 years of experience",
      "--quote",
      "mention my years",
      "--session",
      "s1",
      "--write",
    ],
    2
  );
  assert.equal(refused.reason, "fact");

  const proposed = cli([
    "propose",
    "--kind",
    "avoid",
    "--rule",
    rule,
    "--quote",
    "stop starting with hello",
    "--session",
    "s1",
    "--write",
  ]);
  const id = proposed.proposal.id;
  assert.equal(proposed.proposal.quote, "stop starting with hello");
  assert.deepEqual(styleAvoid(), [], "a proposal alone writes nothing");

  assert.equal(cli(["accept", id]).dryRun, true);
  assert.deepEqual(styleAvoid(), []);
  cli(["accept", id, "--write"]);
  assert.deepEqual(styleAvoid(), [rule]);
  assert.equal(cli(["list"]).proposals[0].status, "accepted");
  cli(["accept", id, "--write"], 2);

  const changes = readJobs(ctx).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].entry.path, "style.avoid");
  assert.equal(applyTuiUndo({ ...ctx, preview: changes[0] }).operationResult.ok, true);
  assert.deepEqual(styleAvoid(), []);
});
