import assert from "node:assert/strict";
import { test } from "node:test";

import { CAREER_OPS_PROVIDER_PARITY } from "../src/core/providers/provider-parity.mjs";
import { results } from "./fixtures/career-ops/helpers.mjs";

const providerIds = CAREER_OPS_PROVIDER_PARITY.filter(
  (provider) => provider.status === "implemented"
).map((provider) => provider.id);

for (const providerId of providerIds) {
  test(`Career Ops contract: ${providerId}`, async () => {
    const before = results();
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await import(`./fixtures/career-ops/providers/${providerId}.conformance.mjs`);
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
    assert.ok(after.passed > before.passed, `${providerId} ran no upstream assertions`);
  });
}
