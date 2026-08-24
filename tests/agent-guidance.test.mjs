import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildAgentGuidance,
  readDiscoveryCompletions,
  recordDiscoveryCompletion,
} from "../src/core/agent-guidance.mjs";

const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function discoveryGuidance(completedDiscoverySteps = []) {
  return buildAgentGuidance({
    searchReadiness: { exists: true, valid: true, enabled: 3, withLastRun: 0 },
    companyAtsReadiness: { valid: true, configured: false },
    discoveryCompleted: completedDiscoverySteps,
  });
}

test("completed discovery steps advance guidance without pretending they were skipped", () => {
  assert.equal(discoveryGuidance().nextSkill, "research-boards");
  assert.equal(discoveryGuidance(["research-boards"]).nextSkill, "discover-companies");
  assert.equal(
    discoveryGuidance(["research-boards", "discover-companies"]).nextSkill,
    "search-jobs"
  );
});

test("a missing Claude skill shim does not override runtime-neutral agent guidance", () => {
  const guidance = buildAgentGuidance({
    skillsNotDiscoverable: ["research-boards"],
    searchReadiness: { exists: true, valid: true, enabled: 3, withLastRun: 0 },
    companyAtsReadiness: { valid: true, configured: false },
  });

  assert.equal(guidance.nextSkill, "research-boards");
  assert.match(guidance.message, /Ask your agent to run research-boards next/);
});

test("discovery completion is durable and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-agent-guidance-"));
  roots.push(root);

  const first = recordDiscoveryCompletion({ root, step: "research-boards" });
  const second = recordDiscoveryCompletion({ root, step: "research-boards" });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.deepEqual(readDiscoveryCompletions({ root }), ["research-boards"]);
});
