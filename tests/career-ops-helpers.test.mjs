import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { results } from "./fixtures/career-ops/helpers.mjs";

// Upstream's shared-helper suites (tests/providers/_*.test.mjs) have no
// provider id, so tests/provider-upstream-conformance.test.mjs can't pick them
// up. They are adapted under tests/fixtures/career-ops/helpers/ and run here,
// one node test per helper, with the same assertion-counter contract.
const helperFixtures = readdirSync(new URL("./fixtures/career-ops/helpers/", import.meta.url))
  .filter((name) => name.endsWith(".conformance.mjs"))
  .map((name) => name.replace(/\.conformance\.mjs$/, ""))
  .sort();

for (const helper of helperFixtures) {
  test(`Career Ops helper contract: ${helper}`, async () => {
    const before = results();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await import(`./fixtures/career-ops/helpers/${helper}.conformance.mjs`);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const after = results();
    assert.equal(
      after.failed,
      before.failed,
      after.failureMessages.slice(before.failureMessages.length).join("\n")
    );
    assert.ok(after.passed > before.passed, `${helper} ran no upstream assertions`);
  });
}
