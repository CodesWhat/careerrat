import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_RUN_PROMPT, firstRunPrompt } from "../src/core/tui/first-run.mjs";

const doctor = (report) => () => ({ stdout: JSON.stringify(report) });

test("an unfinished profile opens the agent on onboarding", () => {
  const prompt = firstRunPrompt({
    repoRoot: "/x",
    run: doctor({ agentGuidance: { nextSkill: "ingest-profile" } }),
  });
  assert.equal(prompt, FIRST_RUN_PROMPT);
  assert.match(prompt, /ingest-profile/);
});

test("a finished profile leaves the agent chat empty", () => {
  assert.equal(
    firstRunPrompt({
      repoRoot: "/x",
      run: doctor({ agentGuidance: { nextSkill: "search-jobs" } }),
    }),
    null
  );
});

test("an unreadable doctor report never blocks the agent", () => {
  assert.equal(firstRunPrompt({ repoRoot: "/x", run: () => ({ stdout: "not json" }) }), null);
  assert.equal(
    firstRunPrompt({
      repoRoot: "/x",
      run: () => {
        throw new Error("spawn failed");
      },
    }),
    null
  );
});
