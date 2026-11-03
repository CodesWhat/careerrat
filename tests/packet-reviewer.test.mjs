// CR106: the reviewer has no write tools, and every accepted edit passes CR103.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReviewEdits, REVIEWER_TOOLS, reviewArtifact } from "../src/core/packet/reviewer.mjs";

const CONTEXT = {
  sourceResume: { text: "Northwind Labs. Cut dispatch delays by 40% across 12 depots with Excel." },
  profile: { candidate: { full_name: "Jordan Rivera" } },
  evidence: { claims: [] },
  app: { company: "Acme Freight", role: "Dispatch Manager" },
};
const DRAFT = "I cut dispatch delays by 40% across 12 depots. I worked with Excel.";

test("the reviewer is granted no tools and runs through the one-shot bounded call", async () => {
  assert.deepEqual([...REVIEWER_TOOLS], []);
  assert.ok(Object.isFrozen(REVIEWER_TOOLS));
  let seen;
  await reviewArtifact({
    context: CONTEXT,
    text: DRAFT,
    runAI: async (options) => {
      seen = options;
      return { body: { ok: true, ai: { used: true }, data: { edits: [] } } };
    },
  });
  for (const key of ["tools", "allowedTools", "mcpServers"]) assert.equal(seen[key], undefined);
  assert.equal(seen.labels.action, "review-artifact");
});

test("an edit that stays inside the sources is accepted", () => {
  const result = applyReviewEdits({
    text: DRAFT,
    context: CONTEXT,
    edits: [{ find: "I worked with Excel.", replace: "I used Excel daily.", reason: "tighter" }],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.text, "I cut dispatch delays by 40% across 12 depots. I used Excel daily.");
});

test("an edit adding a number, tool or name is rejected and the text is untouched", async () => {
  const result = await reviewArtifact({
    context: CONTEXT,
    text: DRAFT,
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: {
          edits: [
            { find: "40%", replace: "65%", reason: "stronger" },
            { find: "Excel", replace: "Excel and Tableau", reason: "more tools" },
            { find: "12 depots", replace: "12 depots for Globex", reason: "name drop" },
            { find: "not in the draft", replace: "x", reason: "bad find" },
          ],
        },
      },
    }),
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 4);
  assert.equal(result.text, DRAFT);
});

test("a failed review leaves the draft as it was", async () => {
  const result = await reviewArtifact({
    context: CONTEXT,
    text: DRAFT,
    runAI: async () => ({ body: { ok: false, code: "NO_AI_ROUTE" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, DRAFT);
});
